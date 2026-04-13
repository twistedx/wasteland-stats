const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const axios = require("axios");
const config = require("./config");
const adminUsers = require("./admin-users");
const discordStats = require("./discord-stats");
const tasks = require("./tasks");
const { sendWebhook, sendVacWebhook } = require("./webhook");
const auditLog = require("./audit-log");
const rcon = require("./rcon");

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

  const listBansCommand = new SlashCommandBuilder()
    .setName("list-bans")
    .setDescription("List all bans for a player by GUID")
    .addStringOption(opt =>
      opt.setName("guid")
        .setDescription("Player Arma GUID")
        .setRequired(true)
    );

  const banPlayerCommand = new SlashCommandBuilder()
    .setName("ban-player")
    .setDescription("Ban a player and kick them from game servers")
    .addStringOption(opt =>
      opt.setName("guid")
        .setDescription("Player Arma GUID")
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("reason")
        .setDescription("Ban reason")
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("duration")
        .setDescription("Duration in hours, or use 'd' suffix for days (e.g. 24, 7d). Leave empty for permanent.")
        .setRequired(false)
    );

  const unbanPlayerCommand = new SlashCommandBuilder()
    .setName("unban-player")
    .setDescription("Unban a player by ban ID")
    .addIntegerOption(opt =>
      opt.setName("ban_id")
        .setDescription("The ban ID to remove")
        .setRequired(true)
    );

  const rconReconnectCommand = new SlashCommandBuilder()
    .setName("rcon-reconnect")
    .setDescription("Reconnect to all RCON game servers");

  const rconPlayersCommand = new SlashCommandBuilder()
    .setName("rcon-players")
    .setDescription("List players currently online on game servers");

  try {
    console.log(`DiscordBot: Discord API: PUT /applications/${config.discord.clientId}/guilds/${config.discordGuildId}/commands (register commands)`);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discordGuildId),
      { body: [verifyCommand.toJSON(), ticketCommand.toJSON(), watchlistCommand.toJSON(), listBansCommand.toJSON(), banPlayerCommand.toJSON(), unbanPlayerCommand.toJSON(), rconReconnectCommand.toJSON(), rconPlayersCommand.toJSON()] }
    );
    console.log("DiscordBot: slash commands registered.");
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

    // ── /list-bans ──
    if (interaction.commandName === "list-bans") {
      const guid = interaction.options.getString("guid").trim();
      console.log(`DiscordBot: /list-bans called by ${interaction.user.username} — guid=${guid}`);

      await interaction.deferReply({ flags: 64 });

      try {
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        const res = await apiClient({ method: "GET", url: "/user/searchUserBans", data: { arma_id: guid, token: config.apiToken } });
        const bans = res.data?.bans || [];

        if (bans.length === 0) {
          return interaction.editReply({ embeds: [{ description: `No bans found for \`${guid}\``, color: 0x22c55e }] });
        }

        // Build table
        const lines = bans.map(b => {
          const duration = b.duration_hours === -1 ? "Permanent" : `${b.duration_hours}h`;
          const date = b.time_stamp ? new Date(b.time_stamp).toISOString().slice(0, 10) : "-";
          return `#${b.id} | ${(b.user_arma_name || b.banned_arma_username || "Unknown").slice(0, 15)} | ${(b.admin_name || "-").slice(0, 12)} | ${(b.reason || "-").slice(0, 20)} | ${duration} | ${date}`;
        });

        const header = "ID  | Name            | Banned By    | Reason               | Duration  | Date";
        const sep = "-".repeat(header.length);
        let output = `**${bans.length} ban(s) found for** \`${guid}\`\n\`\`\`\n${header}\n${sep}\n${lines.join("\n")}\n\`\`\``;

        // Discord 2000 char limit
        if (output.length > 1900) {
          output = output.slice(0, 1897) + "...```";
        }

        return interaction.editReply({ content: output });
      } catch (err) {
        if (err.response?.status === 404) {
          return interaction.editReply({ embeds: [{ description: `No bans found for \`${guid}\``, color: 0x22c55e }] });
        }
        console.error("DiscordBot: /list-bans error:", err.message);
        return interaction.editReply({ content: `Failed to fetch bans: ${err.response?.data?.message || err.message}` });
      }
    }

    // ── /ban-player ──
    if (interaction.commandName === "ban-player") {
      const guid = interaction.options.getString("guid").trim();
      const reason = interaction.options.getString("reason").trim();
      const durationStr = (interaction.options.getString("duration") || "").trim();
      const username = interaction.user.username;
      const discordId = interaction.user.id;

      // Check admin role
      const member = interaction.member;
      const isAdmin = member?.roles?.cache?.some(r => config.adminWriteRoleIds.includes(r.id));
      if (!isAdmin) {
        return interaction.reply({ content: "You don't have permission to ban players.", ephemeral: true });
      }

      console.log(`DiscordBot: /ban-player called by ${username} — guid=${guid} reason="${reason}" duration="${durationStr}"`);

      await interaction.deferReply();

      // Parse duration
      let durationHours = -1; // permanent by default
      if (durationStr && durationStr !== "0") {
        const match = durationStr.match(/^(\d+)(d?)$/i);
        if (!match) {
          return interaction.editReply({ content: "Invalid duration. Use a number (hours) or number + `d` (days). Examples: `24`, `7d`. Leave empty for permanent." });
        }
        const val = parseInt(match[1]);
        durationHours = match[2].toLowerCase() === "d" ? val * 24 : val;
      }

      try {
        // Ban via API
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        await apiClient.post("/user/banByArmaID/", {
          token: config.backendToken,
          arma_id: guid,
          admin_name: username,
          reason,
          duration_hours: durationHours,
        });

        // Try to get player name
        let playerName = guid;
        try {
          const statsRes = await apiClient({ method: "GET", url: "/user/getPlayerStatsByID/", data: { arma_id: guid, token: config.apiToken } });
          playerName = statsRes.data?.arma_username || statsRes.data?.username || guid;
        } catch {}

        const durationLabel = durationHours === -1 ? "Permanent" : `${durationHours} hours`;

        // Log and webhook
        auditLog.log("moderation", "Player Banned", `${playerName} (${guid}) banned by ${username} — ${reason} (${durationLabel})`, { username, discord_id: discordId });
        sendWebhook({
          title: "Player Banned",
          description: `<@${discordId}> banned **${playerName}** (\`${guid}\`)\nReason: ${reason}\nDuration: ${durationLabel}\n[View Profile](${config.siteUrl}/admin/player/${guid})`,
          color: 0xef4444,
        });

        // Kick from game servers via RCON
        let kickResult = "";
        try {
          const kicks = await rcon.kickPlayer(guid);
          kickResult = kicks.map(k => `${k.server}: ${k.result}`).join("\n");
          console.log(`DiscordBot: RCON kick results for ${guid}:`, kickResult);
        } catch (rconErr) {
          kickResult = "RCON kick failed: " + rconErr.message;
          console.error("DiscordBot: RCON kick error:", rconErr.message);
        }

        await interaction.editReply({
          content: `**${playerName}** (\`${guid}\`) has been banned.\nReason: ${reason}\nDuration: ${durationLabel}\n\n**RCON Kick:**\n${kickResult}`,
        });
      } catch (err) {
        console.error("DiscordBot: /ban-player error:", err.message);
        return interaction.editReply({ content: `Failed to ban player: ${err.response?.data?.message || err.message}` });
      }
    }

    // ── /unban-player ──
    if (interaction.commandName === "unban-player") {
      const banId = interaction.options.getInteger("ban_id");
      const username = interaction.user.username;
      const discordId = interaction.user.id;

      const member = interaction.member;
      const isAdmin = member?.roles?.cache?.some(r => config.adminWriteRoleIds.includes(r.id));
      if (!isAdmin) {
        return interaction.reply({ content: "You don't have permission to unban players.", ephemeral: true });
      }

      console.log(`DiscordBot: /unban-player called by ${username} — ban_id=${banId}`);

      await interaction.deferReply();

      try {
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        await apiClient.post("/user/removeUserBanByID/", { token: config.backendToken, ban_id: banId });

        auditLog.log("moderation", "Player Unbanned", `Ban #${banId} removed by ${username}`, { username, discord_id: discordId });
        sendWebhook({
          title: "Player Unbanned",
          description: `<@${discordId}> removed ban **#${banId}**`,
          color: 0x22c55e,
        });

        return interaction.editReply({ content: `Ban **#${banId}** has been removed.` });
      } catch (err) {
        console.error("DiscordBot: /unban-player error:", err.message);
        return interaction.editReply({ content: `Failed to unban: ${err.response?.data?.message || err.message}` });
      }
    }

    // ── /rcon-reconnect ──
    if (interaction.commandName === "rcon-reconnect") {
      const member = interaction.member;
      const isAdmin = member?.roles?.cache?.some(r => config.adminWriteRoleIds.includes(r.id));
      if (!isAdmin) {
        return interaction.reply({ content: "You don't have permission to manage RCON.", ephemeral: true });
      }

      await interaction.deferReply();

      try {
        const results = await rcon.reconnect();
        const status = results.map(r => {
          const emoji = r.status === "reconnected" ? ":white_check_mark:" : r.status === "already connected" ? ":yellow_circle:" : ":x:";
          return `${emoji} **${r.name}** — ${r.status}`;
        }).join("\n");

        return interaction.editReply({ embeds: [{ title: "RCON Reconnect", description: status || "No RCON servers configured.", color: 0x5865F2 }] });
      } catch (err) {
        console.error("DiscordBot: /rcon-reconnect error:", err.message);
        return interaction.editReply({ content: `RCON reconnect failed: ${err.message}` });
      }
    }

    // ── /rcon-players ──
    if (interaction.commandName === "rcon-players") {
      const member = interaction.member;
      const isAdmin = member?.roles?.cache?.some(r => config.adminRoleIds.includes(r.id));
      if (!isAdmin) {
        return interaction.reply({ content: "You don't have permission to view RCON players.", ephemeral: true });
      }

      await interaction.deferReply({ flags: 64 });

      try {
        const players = await rcon.getPlayers();
        if (players.length === 0) {
          return interaction.editReply({ content: "No players online or RCON not connected. Try `/rcon-reconnect`." });
        }

        // Group by server
        const byServer = {};
        players.forEach(p => {
          if (!byServer[p.server]) byServer[p.server] = [];
          byServer[p.server].push(p);
        });

        let output = "";
        for (const [server, list] of Object.entries(byServer)) {
          output += `**${server}** (${list.length} players)\n\`\`\`\n`;
          output += list.map(p => `#${String(p.number).padStart(2)} | ${p.guid} | ${p.name}`).join("\n");
          output += "\n```\n";
        }

        if (output.length > 1900) output = output.slice(0, 1897) + "...```";
        return interaction.editReply({ content: output });
      } catch (err) {
        console.error("DiscordBot: /rcon-players error:", err.message);
        return interaction.editReply({ content: `Failed to get players: ${err.message}` });
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
