const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const axios = require("axios");
const config = require("./config");
const adminUsers = require("./admin-users");
const discordStats = require("./discord-stats");

let client = null;

async function init() {
  if (!config.discordBotToken) {
    console.log("DiscordBot: no bot token, skipping.");
    return;
  }

  // Register the /verify slash command
  const rest = new REST({ version: "10" }).setToken(config.discordBotToken);
  const command = new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Link your Discord account to your ArmaWasteland.com account")
    .addStringOption(opt =>
      opt.setName("code")
        .setDescription("The 6-character verification code from your account page")
        .setRequired(true)
    );

  try {
    console.log(`DiscordBot: Discord API: PUT /applications/${config.discord.clientId}/guilds/${config.discordGuildId}/commands (register /verify)`);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discordGuildId),
      { body: [command.toJSON()] }
    );
    console.log("DiscordBot: /verify command registered.");
  } catch (err) {
    console.error("DiscordBot: failed to register commands:", err.message);
    return;
  }

  // Start the bot
  console.log("DiscordBot: connecting to Discord gateway with intents [Guilds, GuildMembers, GuildPresences, GuildVoiceStates]...");
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.on("ready", () => {
    console.log(`DiscordBot: logged in as ${client.user.tag}`);
    discordStats.init(client, config.discordGuildId);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "verify") return;

    const code = interaction.options.getString("code").trim().toUpperCase();
    const discordId = interaction.user.id;
    console.log(`DiscordBot: /verify called by ${interaction.user.username} (${discordId}) with code=${code}`);

    // Acknowledge immediately so Discord doesn't time out
    await interaction.deferReply({ flags: 64 }); // 64 = ephemeral

    try {
      // Try 1: Link Arma account via backend game API (in-game temp password)
      let armaLinked = false;
      try {
        console.log(`DiscordBot: trying backend verify — temp_password=${code} discord_id=${discordId}`);
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        const armaRes = await apiClient.post("/user/verifyUsersByTempPassword/", {
          temp_password: code,
          discord_id: discordId,
          token: config.apiToken,
        });
        console.log(`DiscordBot: backend verify response:`, armaRes.status, JSON.stringify(armaRes.data).slice(0, 200));
        armaLinked = true;
      } catch (armaErr) {
        console.log(`DiscordBot: backend verify failed (${armaErr.response?.status || armaErr.message}) — trying admin email verify`);
      }

      if (armaLinked) {
        return interaction.editReply({
          content: `Game account linked successfully! Your Discord is now connected to your Arma player.\n\nYou can now purchase items from the store at **armawasteland.com/build**`,
        });
      }

      return interaction.editReply({
        content: "Invalid or expired verification code. Make sure you're using the code from in-game (press Escape to find it).",
      });
    } catch (err) {
      console.error("DiscordBot: /verify error:", err.message);
      return interaction.editReply({
        content: `Something went wrong: ${err.message}. Your account may still have been linked — try logging out and back in.`,
      });
    }
  });

  try {
    console.log("DiscordBot: Discord API: POST /auth/login (bot login)");
    await client.login(config.discordBotToken);
  } catch (err) {
    console.error("DiscordBot: login failed:", err.message);
  }
}

module.exports = { init };
