const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const config = require("./config");
const adminUsers = require("./admin-users");

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
  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on("ready", () => {
    console.log(`DiscordBot: logged in as ${client.user.tag}`);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "verify") return;

    const code = interaction.options.getString("code").trim().toUpperCase();
    const discordId = interaction.user.id;
    console.log(`DiscordBot: /verify called by ${interaction.user.username} (${discordId}) with code=${code}`);

    // Check if this Discord ID is already linked
    const existingLink = adminUsers.getByDiscordId(discordId);
    if (existingLink) {
      console.log(`DiscordBot: ${discordId} already linked to ${existingLink.email}, rejecting`);
      return interaction.reply({
        content: `Your Discord account is already linked to **${existingLink.username}** (${existingLink.email}).`,
        ephemeral: true,
      });
    }

    // Redeem the verification code
    const email = adminUsers.redeemVerifyCode(code);
    if (!email) {
      console.log(`DiscordBot: code ${code} is invalid or expired`);
      return interaction.reply({
        content: "Invalid or expired verification code. Go to your account page to get a new one.",
        ephemeral: true,
      });
    }
    console.log(`DiscordBot: code ${code} redeemed for email=${email}`);

    // Link the Discord ID
    adminUsers.linkDiscord(email, discordId);
    console.log(`DiscordBot: linked ${email} -> discord ${discordId}`);

    // Fetch guild member roles and set permissions
    try {
      const member = await interaction.guild.members.fetch(discordId);
      const memberRoles = member.roles.cache.map(r => r.id);
      console.log(`DiscordBot: ${discordId} guild roles: [${memberRoles.join(",")}]`);
      console.log(`DiscordBot: config adminRoleIds=[${config.adminRoleIds.join(",")}] writeRoleIds=[${config.adminWriteRoleIds.join(",")}] blogRoleIds=[${config.blogRoleIds.join(",")}]`);

      const isAdmin = memberRoles.some(r => config.adminRoleIds.includes(r));
      const isWriteAdmin = memberRoles.some(r => config.adminWriteRoleIds.includes(r));
      const isBlogAdmin = memberRoles.some(r => config.blogRoleIds.includes(r));
      console.log(`DiscordBot: resolved isAdmin=${isAdmin} isWriteAdmin=${isWriteAdmin} isBlogAdmin=${isBlogAdmin}`);

      adminUsers.setRoles(email, { isAdmin, isWriteAdmin, isBlogAdmin });
      console.log(`DiscordBot: saved roles to DB for ${email}`);

      const roleLabels = [];
      if (isAdmin) roleLabels.push("Admin");
      if (isWriteAdmin) roleLabels.push("Write Admin");
      if (isBlogAdmin) roleLabels.push("Blog Admin");

      const rolesText = roleLabels.length > 0
        ? `\nPermissions granted: **${roleLabels.join(", ")}**`
        : "\nNo admin permissions detected.";

      console.log(`DiscordBot: verified ${email} -> ${discordId} (${interaction.user.username}) roles=[${roleLabels.join(",")}]`);

      return interaction.reply({
        content: `Account linked successfully! Your Discord is now connected to **${email}**.${rolesText}\n\nLog out and back in on the website to apply changes.`,
        ephemeral: true,
      });
    } catch (err) {
      console.error("DiscordBot: role fetch error:", err.message);
      // Link succeeded but roles failed — still linked
      console.log(`DiscordBot: link succeeded but role fetch failed for ${email} -> ${discordId}`);
      return interaction.reply({
        content: `Account linked to **${email}**, but couldn't fetch your roles. Try logging in via Discord on the website to pick up permissions.`,
        ephemeral: true,
      });
    }
  });

  try {
    await client.login(config.discordBotToken);
  } catch (err) {
    console.error("DiscordBot: login failed:", err.message);
  }
}

module.exports = { init };
