const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const axios = require("axios");
const config = require("./config");
const adminUsers = require("./admin-users");
const discordStats = require("./discord-stats");
const tasks = require("./tasks");
const { sendWebhook, sendVacWebhook } = require("./webhook");
const auditLog = require("./audit-log");

let client = null;

async function init() {
  if (!config.discordBotToken) {
    console.log("DiscordBot: no bot token, skipping.");
    return;
  }

  // Register slash commands
  const rest = new REST({ version: "10" }).setToken(config.discordBotToken);
  const verifyCommand = new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Link your Discord account to your ArmaWasteland.com account")
    .addStringOption(opt =>
      opt.setName("code")
        .setDescription("The 6-character verification code from your account page")
        .setRequired(true)
    );

  const ticketCommand = new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Create a task ticket on the admin board")
    .addStringOption(opt =>
      opt.setName("title")
        .setDescription("Short title for the ticket (e.g. Fix AK-74n recoil with PBS suppressor)")
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("type")
        .setDescription("Type of ticket")
        .setRequired(false)
        .addChoices(
          { name: "Bug", value: "bug" },
          { name: "Improvement", value: "improvement" },
          { name: "Feature", value: "feature" },
          { name: "Ticket", value: "ticket" },
        )
    )
    .addStringOption(opt =>
      opt.setName("priority")
        .setDescription("Priority level")
        .setRequired(false)
        .addChoices(
          { name: "Low", value: "low" },
          { name: "Normal", value: "normal" },
          { name: "High", value: "high" },
          { name: "Critical", value: "critical" },
        )
    )
    .addStringOption(opt =>
      opt.setName("description")
        .setDescription("Optional details about the issue")
        .setRequired(false)
    );

  const watchlistCommand = new SlashCommandBuilder()
    .setName("watchlist")
    .setDescription("Add a player to the watchlist")
    .addStringOption(opt =>
      opt.setName("player")
        .setDescription("Player username to search for")
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("reason")
        .setDescription("Reason for watchlisting")
        .setRequired(false)
    );

  try {
    console.log(`DiscordBot: Discord API: PUT /applications/${config.discord.clientId}/guilds/${config.discordGuildId}/commands (register commands)`);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discordGuildId),
      { body: [verifyCommand.toJSON(), ticketCommand.toJSON(), watchlistCommand.toJSON()] }
    );
    console.log("DiscordBot: /verify, /ticket, and /watchlist commands registered.");
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
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on("clientReady", () => {
    console.log(`DiscordBot: logged in as ${client.user.tag}`);
    discordStats.init(client, config.discordGuildId);
  });

  // Track ATM deposits/withdrawals from webhook channel
  // Format: embed title "ATM Transaction", description has "Username: X\nType: Deposited 16,896\nAmount: 50362"
  if (config.atmChannelId) {
    const economyTracker = require("./economy-tracker");
    client.on("messageCreate", (message) => {
      if (message.channelId !== config.atmChannelId) return;
      if (!message.embeds?.length) return;

      const desc = message.embeds[0].description || "";
      const lines = desc.split("\n").map(l => l.trim());

      let playerName = null;
      let type = null;
      let amount = 0;

      for (const line of lines) {
        if (line.startsWith("Username:")) {
          playerName = line.replace("Username:", "").trim();
        }
        if (line.startsWith("Type:")) {
          const typeStr = line.replace("Type:", "").trim();
          if (typeStr.toLowerCase().startsWith("deposit")) {
            type = "deposit";
          } else if (typeStr.toLowerCase().startsWith("withdr") || typeStr.toLowerCase().startsWith("withdrew")) {
            type = "withdrawal";
          }
          // Extract amount from the type line: "Deposited 16,896" or "Withdrew 50,000"
          const amtMatch = typeStr.match(/([\d,]+)/);
          if (amtMatch) {
            amount = parseInt(amtMatch[1].replace(/,/g, ""), 10);
          }
        }
      }

      if (type && amount > 0) {
        economyTracker.recordTransaction(type, playerName, amount);
      }
    });
    console.log(`DiscordBot: listening for ATM transactions in channel ${config.atmChannelId}`);
  }

  // Track member joins and leaves
  client.on("guildMemberAdd", (member) => {
    if (member.user.bot) return;
    discordStats.recordMemberEvent("join", member);
  });

  client.on("guildMemberRemove", (member) => {
    if (member.user.bot) return;
    discordStats.recordMemberEvent("leave", member);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ── /verify ──
    if (interaction.commandName === "verify") {
      const code = interaction.options.getString("code").trim().toUpperCase();
      const discordId = interaction.user.id;
      console.log(`DiscordBot: /verify called by ${interaction.user.username} (${discordId}) with code=${code}`);

      await interaction.deferReply({ flags: 64 });

      try {
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
            content: `Game account linked successfully! Your Discord is now connected to your Arma player.\n\nYou can now purchase items from the store at **armawasteland.com/store**`,
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
    }

    // ── /ticket ──
    if (interaction.commandName === "ticket") {
      const title = interaction.options.getString("title").trim();
      const type = interaction.options.getString("type") || "bug";
      const priority = interaction.options.getString("priority") || "normal";
      const description = (interaction.options.getString("description") || "").trim();
      const username = interaction.user.username;
      const discordId = interaction.user.id;

      console.log(`DiscordBot: /ticket called by ${username} (${discordId}) — "${title}"`);

      await interaction.deferReply({ flags: 64 });

      try {
        // Build Discord message link from the interaction context
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        const messageLink = guildId
          ? `https://discord.com/channels/${guildId}/${channelId}/${interaction.id}`
          : null;

        const taskId = tasks.create({
          title,
          description,
          type,
          priority,
          created_by: username,
          created_by_discord_id: discordId,
          link: messageLink,
        });

        sendWebhook({
          title: "Task Created via Discord",
          description: `**${title}**\nType: ${type} | Priority: ${priority}\nCreated by: <@${discordId}>${description ? "\n" + description : ""}`,
          color: 0x5865F2,
        });

        return interaction.editReply({
          content: `Ticket **#${taskId}** created!\n\n**${title}**\nType: ${type} | Priority: ${priority}\n\nView it on the admin task board at **armawasteland.com/admin/tasks**`,
        });
      } catch (err) {
        console.error("DiscordBot: /ticket error:", err.message);
        return interaction.editReply({
          content: `Failed to create ticket: ${err.message}`,
        });
      }
    }

    // ── /watchlist ──
    if (interaction.commandName === "watchlist") {
      const playerSearch = interaction.options.getString("player").trim();
      const reason = (interaction.options.getString("reason") || "").trim();
      const username = interaction.user.username;
      const discordId = interaction.user.id;

      console.log(`DiscordBot: /watchlist called by ${username} (${discordId}) — search="${playerSearch}"`);

      await interaction.deferReply({ flags: 64 });

      try {
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        const adminApi = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });

        // Search for the player
        const searchRes = await apiClient({
          method: "GET",
          url: "/user/searchUsersByUsername/",
          data: { search: playerSearch, token: config.apiToken },
        });

        const data = searchRes.data?.users || searchRes.data?.data || searchRes.data;
        const players = Array.isArray(data) ? data : [];

        if (players.length === 0) {
          return interaction.editReply({ content: `No players found matching "${playerSearch}".` });
        }

        // Use first match
        const player = players[0];
        const armaId = player.arma_id;
        const playerName = player.username || player.arma_username || armaId;

        // Add to watchlist
        await adminApi.post("/admin/watchlist", {
          token: config.adminApiToken,
          arma_id: armaId,
          is_watchlisted: true,
        });

        // Add notes if provided
        if (reason) {
          await adminApi.post("/admin/bans/webNotes", {
            token: config.adminApiToken,
            arma_id: armaId,
            web_notes: `[${username}] ${reason}`,
          });
        }

        // Look up Steam profile
        let steamLink = "";
        try {
          const steamRes = await adminApi.get("/admin/steam-id", { params: { token: config.adminApiToken, arma_id: armaId } });
          if (steamRes.data?.steam_ids?.[0]?.steam64_id) {
            steamLink = `\n[Steam Profile](https://steamcommunity.com/profiles/${steamRes.data.steam_ids[0].steam64_id})`;
          }
        } catch {}

        auditLog.log("moderation", "Added to Watchlist", `${playerName} (${armaId}) via Discord by ${username}`, { username, discord_id: discordId });
        sendVacWebhook({
          title: "Player Added to Watchlist",
          description: `<@${discordId}> added **${playerName}** (\`${armaId}\`) to the watchlist${reason ? `\nReason: ${reason}` : ""}${steamLink}\n[View Profile](${config.siteUrl}/admin/player/${armaId})`,
          color: 0xf59e0b,
        });

        return interaction.editReply({
          content: `**${playerName}** (\`${armaId}\`) added to the watchlist.${reason ? `\nReason: ${reason}` : ""}\n\nView on the admin panel: **armawasteland.com/admin/watchlist**`,
        });
      } catch (err) {
        console.error("DiscordBot: /watchlist error:", err.message);
        return interaction.editReply({
          content: `Failed to add player to watchlist: ${err.response?.data?.message || err.message}`,
        });
      }
    }
  });

  try {
    console.log("DiscordBot: Discord API: POST /auth/login (bot login)");
    await client.login(config.discordBotToken);
  } catch (err) {
    console.error("DiscordBot: login failed:", err.message);
  }
}

function getClient() {
  return client;
}

module.exports = { init, getClient };
