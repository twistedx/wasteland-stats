const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");
const axios = require("axios");
const config = require("./config");
const adminUsers = require("./admin-users");
const discordStats = require("./discord-stats");
const tasks = require("./tasks");
const { sendWebhook, sendVacWebhook, sendPublicWebhook } = require("./webhook");
const auditLog = require("./audit-log");
const rcon = require("./rcon");

let client = null;

// ── /search-player pagination cache ──
const SEARCH_PAGE_SIZE = 10;
const SEARCH_CACHE = new Map(); // key -> { players, owner, timestamp }
const SEARCH_TTL_MS = 10 * 60 * 1000; // 10 minutes

function searchCacheKey(query) {
  return query.toLowerCase().slice(0, 50);
}

function cacheSearchResults(query, players) {
  SEARCH_CACHE.set(searchCacheKey(query), { players, timestamp: Date.now() });
  // Sweep old entries
  for (const [k, v] of SEARCH_CACHE.entries()) {
    if (Date.now() - v.timestamp > SEARCH_TTL_MS) SEARCH_CACHE.delete(k);
  }
}

function getCachedSearch(query) {
  const entry = SEARCH_CACHE.get(searchCacheKey(query));
  if (!entry) return null;
  if (Date.now() - entry.timestamp > SEARCH_TTL_MS) { SEARCH_CACHE.delete(searchCacheKey(query)); return null; }
  return entry.players;
}

function buildSearchPage(query, players, pageIdx, ownerId) {
  const totalPages = Math.max(1, Math.ceil(players.length / SEARCH_PAGE_SIZE));
  const safeIdx = Math.max(0, Math.min(pageIdx, totalPages - 1));
  const startIdx = safeIdx * SEARCH_PAGE_SIZE;
  const pagePlayers = players.slice(startIdx, startIdx + SEARCH_PAGE_SIZE);

  const lines = pagePlayers.map(p => {
    const username = p.arma_username || p.username || "Unknown";
    const armaId = p.arma_id;
    if (!armaId) return `• **${username}**`;
    return `• [**${username}**](${config.siteUrl}/admin/player/${armaId}) — \`${armaId}\``;
  });

  // Truncate raw query BEFORE encoding so we never cut mid-percent-escape
  const encodedQuery = encodeURIComponent(query.slice(0, 30));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`search_${encodedQuery}_${safeIdx - 1}_${ownerId}`).setLabel("Previous").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(safeIdx === 0),
    new ButtonBuilder().setCustomId(`search_pageinfo_0_0`).setLabel(`Page ${safeIdx + 1} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`search_${encodedQuery}_${safeIdx + 1}_${ownerId}`).setLabel("Next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(safeIdx >= totalPages - 1),
  );

  return {
    embeds: [{
      title: `Search results for "${query}"`,
      description: lines.join("\n"),
      color: 0x5865F2,
      footer: { text: `${players.length} player(s) found — click name to view profile` },
    }],
    components: totalPages > 1 ? [row] : [],
  };
}

function buildRulesEmbed(postId, count) {
  return {
    color: 0x22c55e,
    title: "📜 Server Rules Acknowledgment",
    description: `**Have you read and understand the rules?**\n\nPlease confirm you've reviewed the rules before playing. Your acknowledgment is logged for staff records.\n\n✅ Acknowledged: **${count.yes}** player${count.yes === 1 ? "" : "s"}`,
    footer: { text: "Click Yes once you've read the rules. Your response is tracked." },
  };
}

function buildRulesButtons(postId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rules_${postId}_yes`).setLabel("Yes, I've read the rules").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rules_${postId}_no`).setLabel("No, not yet").setEmoji("❌").setStyle(ButtonStyle.Secondary),
  );
}

function buildPollEmbed(poll, tally, closed = false) {
  let expiresLine = "";
  if (!closed && poll.expires_at) {
    const ts = Math.floor(new Date(poll.expires_at + "Z").getTime() / 1000);
    if (!isNaN(ts)) expiresLine = `\n\n⏳ Closes <t:${ts}:R>`;
  }
  const desc = closed
    ? `_This poll is now closed._`
    : `Let us know how you feel about this subject — your opinion matters, vote today!\n\n` +
      `✅ Yes: ${tally.yesActive}\n` +
      `❌ No: ${tally.noActive}${expiresLine}`;
  return {
    color: closed ? 0x6b7280 : 0x5865F2,
    title: `📊 Poll #${poll.id}${closed ? " — Closed" : ""}`,
    description: `**${poll.question}**\n\n${desc}`,
    footer: { text: closed ? `Closed` : `Created by ${poll.created_by_name || "?"} • Vote once per poll` },
  };
}

function buildPollButtons(pollId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`poll_${pollId}_yes`).setLabel("Yes").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`poll_${pollId}_no`).setLabel("No").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function buildDealerButtons(gameId, currentLocation, inventory) {
  const dealer = require("./arms-dealer");
  // Row 1: Buy select menu
  const buyMenu = new StringSelectMenuBuilder()
    .setCustomId(`dealermenu_${gameId}_buy`)
    .setPlaceholder("Buy goods...")
    .addOptions(dealer.COMMODITIES.map(c => ({ label: c.name, value: c.id, emoji: c.emoji })));

  // Row 2: Sell select menu (only items you own)
  const ownedItems = Object.entries(inventory).filter(([, q]) => q > 0);
  let sellRow = null;
  if (ownedItems.length > 0) {
    const sellMenu = new StringSelectMenuBuilder()
      .setCustomId(`dealermenu_${gameId}_sell`)
      .setPlaceholder("Sell goods...")
      .addOptions(ownedItems.map(([id, qty]) => {
        const c = dealer.COMMODITIES.find(x => x.id === id);
        return { label: `${c?.name || id} (${qty})`, value: id, emoji: c?.emoji };
      }));
    sellRow = new ActionRowBuilder().addComponents(sellMenu);
  }

  // Row 3: Travel buttons (other locations)
  const travelButtons = dealer.LOCATIONS
    .filter(l => l.id !== currentLocation)
    .slice(0, 5)
    .map(l => new ButtonBuilder().setCustomId(`dealer_${gameId}_travel_${l.id}`).setLabel(l.name).setEmoji(l.emoji).setStyle(ButtonStyle.Secondary));
  const travelRow = new ActionRowBuilder().addComponents(travelButtons);

  // Row 4: Utility buttons
  const utilRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dealer_${gameId}_paydebt_all`).setLabel("Pay Debt").setEmoji("💸").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dealer_${gameId}_refresh`).setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`dealer_${gameId}_end`).setLabel("Cash Out").setEmoji("🏁").setStyle(ButtonStyle.Danger),
  );

  const rows = [new ActionRowBuilder().addComponents(buyMenu)];
  if (sellRow) rows.push(sellRow);
  rows.push(travelRow, utilRow);
  return rows.slice(0, 5); // Discord max 5 rows
}

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
      opt.setName("arma_id")
        .setDescription("Player's Arma ID (GUID)")
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

  const myStatsCommand = new SlashCommandBuilder()
    .setName("my-stats")
    .setDescription("Display your own Arma Wasteland stats")
    .addStringOption(opt =>
      opt.setName("season")
        .setDescription("Which stats to show")
        .setRequired(false)
        .addChoices(
          { name: "Current Season", value: "season" },
          { name: "All Time", value: "alltime" },
        )
    );

  const playerStatsCommand = new SlashCommandBuilder()
    .setName("player-stats")
    .setDescription("Display stats for a player by GUID")
    .addStringOption(opt =>
      opt.setName("guid")
        .setDescription("Player Arma GUID")
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("season")
        .setDescription("Which stats to show")
        .setRequired(false)
        .addChoices(
          { name: "Current Season", value: "season" },
          { name: "All Time", value: "alltime" },
        )
    );

  const searchPlayerCommand = new SlashCommandBuilder()
    .setName("search-player")
    .setDescription("Search for a player by username and link to their profile")
    .addStringOption(opt =>
      opt.setName("name")
        .setDescription("Username to search for (partial match)")
        .setRequired(true)
    );

  const memberStatsCommand = new SlashCommandBuilder()
    .setName("member-stats")
    .setDescription("Look up the player profile linked to a Discord member")
    .addUserOption(opt =>
      opt.setName("user")
        .setDescription("The Discord member")
        .setRequired(true)
    );

  const dailyCommand = new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily 💀 Wasted Coins reward");

  const lottery = require("./lottery");
  const lotteryCommand = new SlashCommandBuilder()
    .setName("lottery")
    .setDescription(`Weekly Wasted Coins lottery — drawn every Friday`)
    .addSubcommand(s => s.setName("buy").setDescription(`Buy lottery tickets (${lottery.TICKET_PRICE} 💀 each, max ${lottery.MAX_TICKETS_PER_DAY}/day)`)
      .addIntegerOption(o => o.setName("count").setDescription(`How many tickets`).setRequired(true).setMinValue(1).setMaxValue(lottery.MAX_TICKETS_PER_DAY)))
    .addSubcommand(s => s.setName("info").setDescription("Current pot, your tickets, next draw"))
    .addSubcommand(s => s.setName("history").setDescription("Recent winners"));

  const skinLottery = require("./skin-lottery");
  const skinLotteryCommand = new SlashCommandBuilder()
    .setName("skin-lottery")
    .setDescription(`Weekly skin drawing — buy tickets with coins, win a random skin in-game`)
    .addSubcommand(s => s.setName("buy").setDescription(`Buy skin-lottery tickets (${skinLottery.TICKET_PRICE} 💀 each, max ${skinLottery.MAX_TICKETS_PER_DAY}/day)`)
      .addIntegerOption(o => o.setName("count").setDescription("How many tickets").setRequired(true).setMinValue(1).setMaxValue(skinLottery.MAX_TICKETS_PER_DAY)))
    .addSubcommand(s => s.setName("info").setDescription("Current pot, your tickets, next draw"))
    .addSubcommand(s => s.setName("history").setDescription("Recent skin winners"));

  const wagers = require("./kill-wagers");
  const wagerCommand = new SlashCommandBuilder()
    .setName("wager")
    .setDescription("PvP kill-count wagers — bet on who racks up more kills in 24h")
    .addSubcommand(s => s.setName("kill").setDescription(`Challenge a player (${wagers.MIN_WAGER}-${wagers.MAX_WAGER} 💀)`)
      .addUserOption(o => o.setName("user").setDescription("Who to challenge").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Coins to wager").setRequired(true).setMinValue(wagers.MIN_WAGER).setMaxValue(wagers.MAX_WAGER)))
    .addSubcommand(s => s.setName("accept").setDescription("Accept a pending wager from a player")
      .addUserOption(o => o.setName("user").setDescription("Who challenged you (leave blank if only one pending)").setRequired(false)))
    .addSubcommand(s => s.setName("decline").setDescription("Decline a pending wager from a player")
      .addUserOption(o => o.setName("user").setDescription("Who challenged you (leave blank if only one pending)").setRequired(false)))
    .addSubcommand(s => s.setName("cancel").setDescription("Cancel a pending wager you initiated")
      .addIntegerOption(o => o.setName("id").setDescription("Wager ID").setRequired(true)))
    .addSubcommand(s => s.setName("status").setDescription("Your active and recent wagers"));

  const trailCommand = new SlashCommandBuilder()
    .setName("trail")
    .setDescription("Wasteland Trails — survive the journey west to win 💀 (500 entry)")
    .addSubcommand(s => s.setName("start").setDescription("Start a new Wasteland Trails run (costs 500 💀)"))
    .addSubcommand(s => s.setName("cashout").setDescription("Cash out your current run and take the coins"))
    .addSubcommand(s => s.setName("stats").setDescription("Your Wasteland Trails run stats"));

  const dealerCommand = new SlashCommandBuilder()
    .setName("dealer")
    .setDescription("Arms Dealer — buy low, sell high, outrun the debt (500 💀 entry)")
    .addSubcommand(s => s.setName("start").setDescription("Start a new arms dealing run (costs 500 💀)"))
    .addSubcommand(s => s.setName("end").setDescription("Cash out and end your current game"))
    .addSubcommand(s => s.setName("stats").setDescription("Your arms dealer stats"));

  const gamesCommand = new SlashCommandBuilder()
    .setName("games")
    .setDescription("Browse all Wasted Coins games");

  const rulesCommand = new SlashCommandBuilder()
    .setName("rules")
    .setDescription("Post the rules acknowledgment message in this channel");

  const pollCommand = new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Community polls — only recent players count in the final tally")
    .addSubcommand(s => s.setName("create").setDescription("Create a yes/no poll")
      .addStringOption(o => o.setName("question").setDescription("The question to ask").setRequired(true))
      .addIntegerOption(o => o.setName("days").setDescription("Auto-close after N days (optional, default no expiry)").setRequired(false).setMinValue(1).setMaxValue(30)))
    .addSubcommand(s => s.setName("close").setDescription("Close a poll and show final results")
      .addIntegerOption(o => o.setName("id").setDescription("Poll ID").setRequired(true)));

  const slotsCommand = new SlashCommandBuilder()
    .setName("slots")
    .setDescription("Wasteland Slots — spin to win 💀 (250 per roll)");

  const outfitCommand = new SlashCommandBuilder()
    .setName("outfit")
    .setDescription("Mercenary outfits — form a group, wage wars, earn together (max 10 members)")
    .addSubcommand(s => s.setName("create").setDescription("Get the link to create your outfit on the website"))
    .addSubcommand(s => s.setName("info").setDescription("View an outfit's details")
      .addStringOption(o => o.setName("tag").setDescription("Outfit tag (or leave blank for your own)").setRequired(false)))
    .addSubcommand(s => s.setName("invite").setDescription("Invite a player to your outfit")
      .addUserOption(o => o.setName("user").setDescription("Who to invite").setRequired(true)))
    .addSubcommand(s => s.setName("kick").setDescription("Remove a member from your outfit")
      .addUserOption(o => o.setName("user").setDescription("Who to kick").setRequired(true)))
    .addSubcommand(s => s.setName("leave").setDescription("Leave your current outfit (30-day cooldown to rejoin any outfit)"))
    .addSubcommand(s => s.setName("promote").setDescription("Promote a Soldier to Capo")
      .addUserOption(o => o.setName("user").setDescription("Who to promote").setRequired(true)))
    .addSubcommand(s => s.setName("demote").setDescription("Demote a Capo to Soldier")
      .addUserOption(o => o.setName("user").setDescription("Who to demote").setRequired(true)))
    .addSubcommand(s => s.setName("transfer").setDescription("Transfer Don status to another member")
      .addUserOption(o => o.setName("user").setDescription("New Don").setRequired(true)))
    .addSubcommand(s => s.setName("deposit").setDescription("Deposit coins into your outfit treasury")
      .addIntegerOption(o => o.setName("coins").setDescription("Amount to deposit").setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName("distribute").setDescription("Don: distribute treasury coins to members")
      .addStringOption(o => o.setName("mode").setDescription("How to split").setRequired(true)
        .addChoices(
          { name: "Even — equal share for all members", value: "even" },
          { name: "Rank-weighted (Don gets most)", value: "rank-high" },
          { name: "Rank-weighted (Soldiers get most)", value: "rank-low" },
        ))
      .addIntegerOption(o => o.setName("amount").setDescription("Coins to distribute (blank = full treasury)").setRequired(false).setMinValue(1)))
    .addSubcommand(s => s.setName("disband").setDescription("Disband your outfit (Don only)"));

  const warCommand = new SlashCommandBuilder()
    .setName("war")
    .setDescription("Declare war between outfits — fixed 48h, winner = most coins generated in war window")
    .addSubcommand(s => s.setName("cost").setDescription("Preview the cost of declaring war on an outfit")
      .addStringOption(o => o.setName("target").setDescription("Target outfit tag").setRequired(true)))
    .addSubcommand(s => s.setName("declare").setDescription("Don: declare war on another outfit (48h, dynamic cost)")
      .addStringOption(o => o.setName("target").setDescription("Target outfit tag").setRequired(true)))
    .addSubcommand(s => s.setName("accept").setDescription("Accept a pending war declaration")
      .addIntegerOption(o => o.setName("id").setDescription("War ID").setRequired(true)))
    .addSubcommand(s => s.setName("decline").setDescription("Decline a pending war")
      .addIntegerOption(o => o.setName("id").setDescription("War ID").setRequired(true)))
    .addSubcommand(s => s.setName("cancel").setDescription("Cancel a war you declared")
      .addIntegerOption(o => o.setName("id").setDescription("War ID").setRequired(true)))
    .addSubcommand(s => s.setName("status").setDescription("Current war status and scoreboard")
      .addIntegerOption(o => o.setName("id").setDescription("War ID (or leave blank for your outfit's active war)").setRequired(false)));

  const balanceCommand = new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Check your 💀 Wasted Coins balance and streak");

  const coinsLeaderboardCommand = new SlashCommandBuilder()
    .setName("coins-leaderboard")
    .setDescription("Top 💀 Wasted Coins holders");

  const transferCashCommand = new SlashCommandBuilder()
    .setName("transfer-cash")
    .setDescription("Convert Wasted Coins into in-game ATM cash (500 coin fee per transfer)")
    .addIntegerOption(opt =>
      opt.setName("coins")
        .setDescription("How many coins to transfer (minimum 1000, fee added on top)")
        .setRequired(true)
        .setMinValue(1000)
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
      { body: [verifyCommand.toJSON(), ticketCommand.toJSON(), watchlistCommand.toJSON(), listBansCommand.toJSON(), banPlayerCommand.toJSON(), unbanPlayerCommand.toJSON(), rconReconnectCommand.toJSON(), rconPlayersCommand.toJSON(), myStatsCommand.toJSON(), playerStatsCommand.toJSON(), searchPlayerCommand.toJSON(), memberStatsCommand.toJSON(), dailyCommand.toJSON(), balanceCommand.toJSON(), coinsLeaderboardCommand.toJSON(), transferCashCommand.toJSON(), lotteryCommand.toJSON(), skinLotteryCommand.toJSON(), wagerCommand.toJSON(), trailCommand.toJSON(), slotsCommand.toJSON(), dealerCommand.toJSON(), gamesCommand.toJSON(), pollCommand.toJSON(), rulesCommand.toJSON(), outfitCommand.toJSON(), warCommand.toJSON()] }
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
    // ── Trail Game Button Interactions ──
    if (interaction.isButton() && interaction.customId.startsWith("trail_")) {
      try {
        const trail = require("./trail-game");
        const wc = require("./wasted-coins");
        const parts = interaction.customId.split("_"); // trail_{gameId}_{choiceId}
        const gameId = parseInt(parts[1], 10);
        const choiceId = parts.slice(2).join("_");

        // First button on stage 0 just advances to stage 1
        const game = trail.getActiveGame(interaction.user.id);
        if (!game || game.id !== gameId) {
          return await interaction.reply({ content: "This isn't your game or it's already over.", flags: 64 });
        }

        let result;
        if (choiceId === "begin") {
          // Stage 0 → 1 transition, no outcome roll
          trail.advanceStage(gameId, 1);
          const stage1 = trail.getStage(1);
          const row = new ActionRowBuilder().addComponents(
            ...stage1.choices.map(c => new ButtonBuilder().setCustomId(`trail_${gameId}_${c.id}`).setLabel(c.label).setEmoji(c.emoji).setStyle(ButtonStyle.Primary))
          );
          const cashOutRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`trail_${gameId}_cashout`).setLabel("Cash Out").setEmoji("💰").setStyle(ButtonStyle.Secondary).setDisabled(true),
          );
          return await interaction.update({
            embeds: [{
              color: 0xD97706,
              title: `${stage1.emoji} Stage 1: ${stage1.title}`,
              description: `${stage1.text}\n\nChoose wisely...`,
            }],
            components: [row, cashOutRow],
          });
        }

        if (choiceId === "cashout") {
          try {
            const cashResult = trail.cashOut(gameId, wc);
            return await interaction.update({
              embeds: [{
                color: 0x22c55e,
                title: "🏕️ Cashed Out!",
                description: `You survived **${cashResult.stage} stages** and walked away with **${cashResult.payout.toLocaleString()} ${wc.EMOJI}**!\n\nBalance: **${wc.getBalance(interaction.user.id).toLocaleString()} ${wc.EMOJI}**`,
              }],
              components: [],
            });
          } catch (err) {
            return await interaction.reply({ content: err.message, flags: 64 });
          }
        }

        // Process the choice
        result = trail.processChoice(gameId, choiceId, wc);

        if (!result.survived) {
          // DEAD
          return await interaction.update({
            embeds: [{
              color: 0xef4444,
              title: `💀 You Died — Stage ${result.stage + 1}/${trail.TOTAL_STAGES}`,
              description: `${result.msg}\n\n**You lost your ${trail.ENTRY_COST} ${wc.EMOJI} entry fee.**\n\nBalance: **${wc.getBalance(interaction.user.id).toLocaleString()} ${wc.EMOJI}**\n\nTry again with \`/trail start\``,
            }],
            components: [],
          });
        }

        if (result.won) {
          // WON THE WHOLE TRAIL
          return await interaction.update({
            embeds: [{
              color: 0xfbbf24,
              title: `🏆 YOU MADE IT TO OREGON! 🏆`,
              description: `${result.msg}\n\n**You survived all ${trail.TOTAL_STAGES} stages and won ${result.payout.toLocaleString()} ${wc.EMOJI}!**\n\nBalance: **${wc.getBalance(interaction.user.id).toLocaleString()} ${wc.EMOJI}**`,
            }],
            components: [],
          });
        }

        // Survived — show next stage
        const nextStage = trail.getStage(result.stage);
        const canCashOut = result.stage >= 2;
        const row = new ActionRowBuilder().addComponents(
          ...nextStage.choices.map(c => new ButtonBuilder().setCustomId(`trail_${gameId}_${c.id}`).setLabel(c.label).setEmoji(c.emoji).setStyle(ButtonStyle.Primary))
        );
        const cashOutRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`trail_${gameId}_cashout`).setLabel(`Cash Out (${trail.PAYOUT_TABLE[result.stage]} 💀)`).setEmoji("💰").setStyle(ButtonStyle.Success).setDisabled(!canCashOut),
        );

        return await interaction.update({
          embeds: [{
            color: 0x22c55e,
            title: `✅ Survived! → ${nextStage.emoji} Stage ${result.stage + 1}: ${nextStage.title}`,
            description: `*${result.msg}*\n\n${nextStage.text}\n\nChoose wisely... (cash out value: **${trail.PAYOUT_TABLE[result.stage]} ${wc.EMOJI}**)`,
          }],
          components: [row, cashOutRow],
        });

      } catch (err) {
        console.error("Trail button error:", err.message);
        try { await interaction.reply({ content: `Error: ${err.message}`, flags: 64 }); } catch {}
      }
      return;
    }

    // ── Search Player Pagination Buttons ──
    if (interaction.isButton() && interaction.customId.startsWith("search_") && interaction.customId !== "search_pageinfo_0_0") {
      try {
        const parts = interaction.customId.split("_"); // search_{encodedQuery}_{pageIdx}_{ownerId}
        const encodedQuery = parts[1];
        const pageIdx = parseInt(parts[2], 10);
        const ownerId = parts[3];
        const query = decodeURIComponent(encodedQuery);

        if (interaction.user.id !== ownerId) {
          return await interaction.reply({ content: "Only the person who ran the search can use these buttons. Run `/search-player` yourself.", flags: 64 });
        }

        const players = getCachedSearch(query);
        if (!players) {
          return await interaction.reply({ content: "This search has expired. Run `/search-player` again.", flags: 64 });
        }

        return await interaction.update(buildSearchPage(query, players, pageIdx, ownerId));
      } catch (err) {
        console.error("Search pagination error:", err.message);
        try { await interaction.reply({ content: `Error: ${err.message}`, flags: 64 }); } catch {}
      }
      return;
    }

    // ── Rules Acknowledgment Button Interactions ──
    if (interaction.isButton() && interaction.customId.startsWith("rules_")) {
      try {
        const rulesAck = require("./rules-ack");
        const parts = interaction.customId.split("_"); // rules_{postId}_{yes|no}
        const postId = parseInt(parts[1], 10);
        const response = parts[2];
        const post = rulesAck.getPost(postId);
        if (!post) return await interaction.reply({ content: "Rules post not found.", flags: 64 });

        rulesAck.recordAck(postId, interaction.user.id, interaction.user.username, response);
        const count = rulesAck.getCountForPost(postId);

        // Update the main message with new count (Yes only)
        await interaction.update({
          embeds: [buildRulesEmbed(postId, count)],
          components: [buildRulesButtons(postId)],
        });

        // Private ack to the user
        const ackMsg = response === "yes"
          ? "✅ Thanks! Your acknowledgment has been recorded."
          : "❌ Please read the rules before playing, then click Yes.";
        try {
          await interaction.followUp({ content: ackMsg, flags: 64 });
        } catch {}
      } catch (err) {
        console.error("Rules button error:", err.message);
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: `Error: ${err.message}`, flags: 64 });
          } else {
            await interaction.followUp({ content: `Error: ${err.message}`, flags: 64 });
          }
        } catch {}
      }
      return;
    }

    // ── Poll Button Interactions ──
    if (interaction.isButton() && interaction.customId.startsWith("poll_")) {
      try {
        const polls = require("./poll");
        const parts = interaction.customId.split("_"); // poll_{id}_{yes|no}
        const pollId = parseInt(parts[1], 10);
        const vote = parts[2];
        const poll = polls.getPoll(pollId);
        if (!poll) return await interaction.reply({ content: "Poll not found.", flags: 64 });
        if (poll.status !== "open") return await interaction.reply({ content: "This poll is closed.", flags: 64 });

        const existing = polls.getExistingVote(pollId, interaction.user.id);
        const isChange = existing && existing.vote !== vote;
        const isSame = existing && existing.vote === vote;

        // Check last login — multi-source fallback chain
        let lastLogin = null;
        let hasCurrentSeasonActivity = false;
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 5000 });
        try {
          const res = await apiClient.get("/user/getPlayer", { params: { discord_id: interaction.user.id, token: config.adminApiToken } });
          lastLogin = res.data?.time_stamp_last_arma_login || null;
        } catch {}
        if (!lastLogin) {
          try {
            const hist = await apiClient.get("/user/getPlayerServerHistory", { params: { discord_id: interaction.user.id, token: config.apiToken } });
            const servers = hist.data?.servers || [];
            if (servers.length > 0) {
              const times = servers.map(s => new Date(s.last_seen).getTime()).filter(t => !isNaN(t));
              if (times.length > 0) lastLogin = new Date(Math.max(...times)).toISOString();
            }
          } catch {}
        }
        // Final fallback: if current-season stats show any activity, treat as active (no exact date available)
        if (!lastLogin) {
          try {
            const stats = await apiClient({ method: "GET", url: "/user/getAllPlayerStatsByDiscordIDCurrentSeason", data: { discord_id: interaction.user.id, token: config.apiToken } });
            const d = stats.data || {};
            const act = Number(d.kill_count || 0) + Number(d.deaths || 0) + Number(d.distance_walked || 0) + Number(d.shots_fired || 0);
            if (act > 0) hasCurrentSeasonActivity = true;
          } catch {}
        }
        // Treat current-season activity as "active now" by setting lastLogin to current time
        if (!lastLogin && hasCurrentSeasonActivity) {
          lastLogin = new Date().toISOString();
        }

        polls.recordVote(pollId, interaction.user.id, interaction.user.username, vote, lastLogin);

        // Update the poll message (the one the button is on) with new tally
        const newTally = polls.getTally(pollId);
        await interaction.update({
          embeds: [buildPollEmbed(poll, newTally)],
          components: [buildPollButtons(pollId)],
        });

        // Ephemeral ack to the voter
        const ackMsg = isSame
          ? `You already voted **${vote}**. Your vote stands.`
          : isChange
            ? `✅ Changed your vote to **${vote}**.`
            : `✅ Vote recorded: **${vote}**. Thanks for voting!`;
        try {
          await interaction.followUp({ content: ackMsg, flags: 64 });
        } catch {}
      } catch (err) {
        console.error("Poll button error:", err.message);
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: `Error: ${err.message}`, flags: 64 });
          } else {
            await interaction.followUp({ content: `Error: ${err.message}`, flags: 64 });
          }
        } catch {}
      }
      return;
    }

    // ── Arms Dealer Button Interactions ──
    if (interaction.isButton() && interaction.customId.startsWith("dealer_")) {
      try {
        const dealer = require("./arms-dealer");
        const wc = require("./wasted-coins");
        const parts = interaction.customId.split("_"); // dealer_{gameId}_{action}_{param}
        const gameId = parseInt(parts[1], 10);
        const action = parts[2];
        const param = parts.slice(3).join("_");

        const game = dealer.getActiveGame(interaction.user.id);
        if (!game || game.id !== gameId) {
          return await interaction.reply({ content: "This isn't your game or it's already over.", flags: 64 });
        }
        const state = dealer.getGameState(gameId);

        if (action === "travel") {
          const result = dealer.travel(gameId, param);
          const loc = dealer.getLocation(result.location);
          let desc = "";
          if (result.event) {
            desc += `\n**${result.event}**${result.eventDetail ? ` ${result.eventDetail}` : ""}\n`;
          }
          if (result.gameOver) {
            // travel() already finalized the game — just grant coins and update UI
            if (result.payout > 0) {
              wc.addCoins(interaction.user.id, result.payout, "dealer_payout", { username: interaction.user.username, bypassCap: true, meta: { game_id: gameId, net_worth: result.netWorth, days: result.day } });
            }
            return await interaction.update({
              embeds: [{
                color: result.payout > dealer.ENTRY_COST ? 0x22c55e : 0xef4444,
                title: `🏁 Game Over — Day ${result.day}/${dealer.MAX_DAYS}`,
                description: `${desc}\nTime's up! Your goods were liquidated at market price.\n\n**Cash:** $${result.cash.toLocaleString()}\n**Goods sold:** $${result.goodsValue.toLocaleString()}\n**Debt:** -$${result.debt.toLocaleString()}\n**Net worth:** $${result.netWorth.toLocaleString()}\n\n**Payout: ${result.payout.toLocaleString()} ${wc.EMOJI}**\nBalance: **${wc.getBalance(interaction.user.id).toLocaleString()} ${wc.EMOJI}**`,
              }],
              components: [],
            });
          }
          desc += `\n${dealer.formatPriceBoard(result.prices, result.inventory)}`;
          const invCount = Object.values(result.inventory).reduce((s, n) => s + n, 0);

          return await interaction.update({
            embeds: [{
              color: 0xD97706,
              title: `${loc.emoji} Day ${result.day}/${dealer.MAX_DAYS} — ${loc.name}`,
              description: `*${loc.description}*\n\n💰 **$${result.cash.toLocaleString()}** | 📦 **${invCount}/${dealer.MAX_INVENTORY}** | 💸 Debt: **$${result.debt.toLocaleString()}**${desc}`,
            }],
            components: buildDealerButtons(gameId, result.location, result.inventory),
          });
        }

        if (action === "buy") {
          // customId: dealer_{gameId}_buy_{itemId}_{qty|max}
          const itemId = parts[3];
          const qtyParam = parts[4];
          let buyQty;
          if (qtyParam === "max") {
            const price = state.pricesObj[itemId] || 9999;
            const space = dealer.MAX_INVENTORY - Object.values(state.inventoryObj).reduce((s, n) => s + n, 0);
            buyQty = Math.min(Math.floor(state.cash / price), space);
          } else {
            buyQty = parseInt(qtyParam, 10) || 1;
          }
          if (buyQty <= 0) return await interaction.reply({ content: "Can't buy any — no cash or no space.", flags: 64 });
          const result = dealer.buy(gameId, itemId, buyQty);
          const c = dealer.COMMODITIES.find(x => x.id === itemId);
          return await interaction.reply({ content: `${c?.emoji || ""} Bought **${buyQty} ${c?.name || itemId}** for **$${result.spent.toLocaleString()}**. Cash: $${result.cash.toLocaleString()}`, flags: 64 });
        }

        if (action === "sell") {
          const itemId = parts[3];
          const owned = state.inventoryObj[itemId] || 0;
          if (owned <= 0) return await interaction.reply({ content: "You don't have any of that.", flags: 64 });
          const result = dealer.sell(gameId, itemId, owned); // sell all
          const c = dealer.COMMODITIES.find(x => x.id === itemId);
          return await interaction.reply({ content: `${c?.emoji || ""} Sold **${owned} ${c?.name || itemId}** for **$${result.earned.toLocaleString()}**. Cash: $${result.cash.toLocaleString()}`, flags: 64 });
        }

        if (action === "paydebt") {
          const amount = param === "all" ? Math.min(state.cash, state.debt) : parseInt(param, 10) || 1000;
          const result = dealer.payDebt(gameId, amount);
          return await interaction.reply({ content: `💸 Paid **$${result.paid.toLocaleString()}** toward debt. Remaining: **$${result.debt.toLocaleString()}** | Cash: **$${result.cash.toLocaleString()}**`, flags: 64 });
        }

        if (action === "refresh") {
          const loc = dealer.getLocation(state.location);
          const invCount = Object.values(state.inventoryObj).reduce((s, n) => s + n, 0);
          return await interaction.update({
            embeds: [{
              color: 0xD97706,
              title: `${loc.emoji} Day ${state.day}/${dealer.MAX_DAYS} — ${loc.name}`,
              description: `*${loc.description}*\n\n💰 **$${state.cash.toLocaleString()}** | 📦 **${invCount}/${dealer.MAX_INVENTORY}** | 💸 Debt: **$${state.debt.toLocaleString()}**\n\n${dealer.formatPriceBoard(state.pricesObj, state.inventoryObj)}`,
            }],
            components: buildDealerButtons(gameId, state.location, state.inventoryObj),
          });
        }

        if (action === "end") {
          const payout = dealer.endGame(gameId, wc);
          return await interaction.update({
            embeds: [{
              color: payout.payout > dealer.ENTRY_COST ? 0x22c55e : 0xef4444,
              title: `🏁 Cashed Out — Day ${state.day}`,
              description: `**Cash:** $${payout.cash.toLocaleString()}\n**Goods sold:** $${payout.goodsValue.toLocaleString()}\n**Debt:** -$${payout.debt.toLocaleString()}\n**Net worth:** $${payout.netWorth.toLocaleString()}\n\n**Payout: ${payout.payout.toLocaleString()} ${wc.EMOJI}**\nBalance: **${wc.getBalance(interaction.user.id).toLocaleString()} ${wc.EMOJI}**`,
            }],
            components: [],
          });
        }

      } catch (err) {
        console.error("Dealer button error:", err.message);
        try { await interaction.reply({ content: `Error: ${err.message}`, flags: 64 }); } catch {}
      }
      return;
    }

    // ── Dealer Select Menu Interactions ──
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("dealermenu_")) {
      try {
        const dealer = require("./arms-dealer");
        const wc = require("./wasted-coins");
        const parts = interaction.customId.split("_");
        const gameId = parseInt(parts[1], 10);
        const menuType = parts[2]; // "buy" or "sell"
        const itemId = interaction.values[0];

        const game = dealer.getActiveGame(interaction.user.id);
        if (!game || game.id !== gameId) {
          return await interaction.reply({ content: "This isn't your game.", flags: 64 });
        }
        const state = dealer.getGameState(gameId);

        if (menuType === "buy") {
          const price = state.pricesObj[itemId] || 9999;
          const space = dealer.MAX_INVENTORY - Object.values(state.inventoryObj).reduce((s, n) => s + n, 0);
          const maxBuy = Math.min(Math.floor(state.cash / price), space);
          if (maxBuy <= 0) return await interaction.reply({ content: "Can't afford any or no space.", flags: 64 });
          // Buy in increments: 1, 5, 10, max
          const c = dealer.COMMODITIES.find(x => x.id === itemId);
          const row = new ActionRowBuilder().addComponents(
            ...[1, 5, 10].filter(n => n <= maxBuy).map(n =>
              new ButtonBuilder().setCustomId(`dealer_${gameId}_buy_${itemId}_${n}`).setLabel(`Buy ${n}`).setStyle(ButtonStyle.Primary)
            ),
            new ButtonBuilder().setCustomId(`dealer_${gameId}_buy_${itemId}_max`).setLabel(`Buy Max (${maxBuy})`).setStyle(ButtonStyle.Success),
          );
          return await interaction.reply({ content: `${c?.emoji} **${c?.name}** — $${price.toLocaleString()} each. Max: ${maxBuy}`, components: [row], flags: 64 });
        }

        if (menuType === "sell") {
          const owned = state.inventoryObj[itemId] || 0;
          if (owned <= 0) return await interaction.reply({ content: "You don't own any.", flags: 64 });
          const result = dealer.sell(gameId, itemId, owned);
          const c = dealer.COMMODITIES.find(x => x.id === itemId);
          return await interaction.reply({ content: `${c?.emoji} Sold **${owned} ${c?.name}** for **$${result.earned.toLocaleString()}**. Cash: $${result.cash.toLocaleString()}`, flags: 64 });
        }

      } catch (err) {
        console.error("Dealer menu error:", err.message);
        try { await interaction.reply({ content: `Error: ${err.message}`, flags: 64 }); } catch {}
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.replied || interaction.deferred) return;

    try {
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
            token: config.backendToken,
          });
          console.log(`DiscordBot: backend verify response:`, armaRes.status, JSON.stringify(armaRes.data).slice(0, 200));
          armaLinked = true;
        } catch (armaErr) {
          console.log(`DiscordBot: backend verify failed (${armaErr.response?.status || armaErr.message}) — trying admin email verify`);
        }

        if (armaLinked) {
          return await interaction.editReply({
            content: `Game account linked successfully! Your Discord is now connected to your Arma player.\n\nYou can now purchase items from the store at **armawasteland.com/store**`,
          });
        }

        return await interaction.editReply({
          content: "Invalid or expired verification code. Make sure you're using the code from in-game (press Escape to find it).",
        });
      } catch (err) {
        console.error("DiscordBot: /verify error:", err.message);
        return await interaction.editReply({
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

        return await interaction.editReply({
          content: `Ticket **#${taskId}** created!\n\n**${title}**\nType: ${type} | Priority: ${priority}\n\nView it on the admin task board at **armawasteland.com/admin/tasks**`,
        });
      } catch (err) {
        console.error("DiscordBot: /ticket error:", err.message);
        return await interaction.editReply({
          content: `Failed to create ticket: ${err.message}`,
        });
      }
    }

    // ── /watchlist ──
    if (interaction.commandName === "watchlist") {
      // Admin gate — only admins can add players to the watchlist
      const isAdmin = interaction.member?.roles?.cache?.some(r => config.adminRoleIds.includes(r.id) || config.adminWriteRoleIds.includes(r.id));
      if (!isAdmin) {
        return await interaction.reply({ content: "Only admins can add players to the watchlist.", flags: 64 });
      }

      const armaId = interaction.options.getString("arma_id").trim();
      const reason = (interaction.options.getString("reason") || "").trim();
      const username = interaction.user.username;
      const discordId = interaction.user.id;

      console.log(`DiscordBot: /watchlist called by ${username} (${discordId}) — arma_id="${armaId}"`);

      await interaction.deferReply();

      // Basic GUID format validation
      if (!/^[a-f0-9-]{8,}$/i.test(armaId)) {
        return await interaction.editReply({ content: `Invalid Arma ID format. Expected a GUID like \`35758533-bc1c-4735-8dd0-02ba9e89dbb2\`.` });
      }

      try {
        const adminApi = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });

        // Look up the player's username for the embed
        let playerName = armaId;
        try {
          const pr = await adminApi.get("/user/getPlayer", { params: { arma_id: armaId, token: config.adminApiToken } });
          playerName = pr.data?.arma_username || armaId;
        } catch {}

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

        return await interaction.editReply({
          embeds: [{
            color: 0xf59e0b,
            title: "⚠️ Player Added to Watchlist",
            description: `**${playerName}** (\`${armaId}\`) is now on the watchlist.\n\nAdded by <@${discordId}>${reason ? `\n**Reason:** ${reason}` : ""}`,
          }],
        });
      } catch (err) {
        console.error("DiscordBot: /watchlist error:", err.message);
        return await interaction.editReply({
          content: `Failed to add player to watchlist: ${err.response?.data?.message || err.message}`,
        });
      }
    }

    // ── /list-bans ──
    if (interaction.commandName === "list-bans") {
      const guid = interaction.options.getString("guid").trim();
      console.log(`DiscordBot: /list-bans called by ${interaction.user.username} — guid=${guid}`);

      await interaction.deferReply();

      try {
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        const res = await apiClient({ method: "GET", url: "/user/searchUserBans", data: { arma_id: guid, token: config.apiToken } });
        const bans = res.data?.bans || [];

        if (bans.length === 0) {
          return await interaction.editReply({ embeds: [{ description: `No bans found for \`${guid}\``, color: 0x22c55e }] });
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

        return await interaction.editReply({ content: output });
      } catch (err) {
        if (err.response?.status === 404) {
          return await interaction.editReply({ embeds: [{ description: `No bans found for \`${guid}\``, color: 0x22c55e }] });
        }
        console.error("DiscordBot: /list-bans error:", err.message);
        return await interaction.editReply({ content: `Failed to fetch bans: ${err.response?.data?.message || err.message}` });
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
        return await interaction.reply({ content: "You don't have permission to ban players.", flags: 64 });
      }

      console.log(`DiscordBot: /ban-player called by ${username} — guid=${guid} reason="${reason}" duration="${durationStr}"`);

      await interaction.deferReply();

      // Parse duration
      let durationHours = -1; // permanent by default
      if (durationStr && durationStr !== "0") {
        const match = durationStr.match(/^(\d+)(d?)$/i);
        if (!match) {
          return await interaction.editReply({ content: "Invalid duration. Use a number (hours) or number + `d` (days). Examples: `24`, `7d`. Leave empty for permanent." });
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
          const pr = await apiClient.get("/user/getPlayer", { params: { arma_id: guid, token: config.adminApiToken } });
          playerName = pr.data?.arma_username || guid;
        } catch {}

        const durationLabel = durationHours === -1 ? "Permanent" : `${durationHours} hours`;

        // Log and webhook
        auditLog.log("moderation", "Player Banned", `${playerName} (${guid}) banned by ${username} — ${reason} (${durationLabel})`, { username, discord_id: discordId });
        sendWebhook({
          title: "Player Banned",
          description: `<@${discordId}> banned **${playerName}** (\`${guid}\`)\nReason: ${reason}\nDuration: ${durationLabel}\n[View Profile](${config.siteUrl}/admin/player/${guid})`,
          color: 0xef4444,
        });

        // Reconnect RCON first (connections drop silently), then kick
        let kickResult = "";
        try {
          try { await rcon.reconnect(); } catch (e) { console.warn("DiscordBot: RCON reconnect before kick failed:", e.message); }
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
        return await interaction.editReply({ content: `Failed to ban player: ${err.response?.data?.message || err.message}` });
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
        return await interaction.reply({ content: "You don't have permission to unban players.", flags: 64 });
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

        return await interaction.editReply({ content: `Ban **#${banId}** has been removed.` });
      } catch (err) {
        console.error("DiscordBot: /unban-player error:", err.message);
        return await interaction.editReply({ content: `Failed to unban: ${err.response?.data?.message || err.message}` });
      }
    }

    // ── /my-stats ──
    if (interaction.commandName === "my-stats") {
      const season = interaction.options.getString("season") || "season";
      const discordId = interaction.user.id;

      console.log(`DiscordBot: /my-stats called by ${interaction.user.username} — season=${season}`);

      // Gate: must wear the GAME server tag (primary guild badge) OR have the donator role
      if (config.myStatsGateEnabled) {
        const member = interaction.member;
        const hasDonator = member?.roles?.cache?.has(config.donatorRoleId);

        // Check primary guild badge — discord.js exposes raw user payload via toJSON()
        let hasServerTag = false;
        try {
          const raw = interaction.user.toJSON ? interaction.user.toJSON() : null;
          const primaryGuild = raw?.primary_guild || interaction.user.primaryGuild || null;
          if (primaryGuild && primaryGuild.badge === config.serverTagBadgeHash && primaryGuild.identity_enabled) {
            hasServerTag = true;
          }
        } catch (e) {
          console.warn("DiscordBot: primary guild check failed:", e.message);
        }

        if (!hasDonator && !hasServerTag) {
          return await interaction.reply({
            embeds: [{
              color: 0xef4444,
              description: "Wear the **GAME** Discord server tag or become a donator to unlock this feature!\n\nSupport the project: https://armawasteland.com/store",
            }],
            flags: 64,
          });
        }
      }

      await interaction.deferReply();

      try {
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        const endpoint = season === "alltime" ? "/user/getAllPlayerStatsByDiscordID" : "/user/getAllPlayerStatsByDiscordIDCurrentSeason/";
        const res = await apiClient({ method: "GET", url: endpoint, data: { discord_id: discordId, token: config.apiToken } });
        const stats = res.data;
        const armaId = stats?.arma_id;
        const armaName = stats?.arma_username || "Unknown";
        const deaths = Number(stats?.deaths || 0).toLocaleString();

        const description = `**Deaths:** ${deaths}\n\nSee all your stats here: [**View full profile →**](${config.siteUrl}/profile)`;

        return await interaction.editReply({
          embeds: [{
            title: armaName,
            description,
            color: 0xfe6500,
            author: { name: interaction.user.username, icon_url: interaction.user.displayAvatarURL() },
            thumbnail: { url: interaction.user.displayAvatarURL() },
            footer: { text: season === "alltime" ? "All Time" : "Current Season" },
          }],
        });
      } catch (err) {
        if (err.response?.status === 404) {
          return await interaction.editReply({ content: "Your Discord account isn't linked to an Arma account yet. Use `/verify` in-game to link it." });
        }
        console.error("DiscordBot: /my-stats error:", err.message);
        return await interaction.editReply({ content: `Failed to fetch stats: ${err.response?.data?.message || err.message}` });
      }
    }

    // ── /player-stats ──
    if (interaction.commandName === "player-stats") {
      const guid = interaction.options.getString("guid").trim();
      const season = interaction.options.getString("season") || "season";

      console.log(`DiscordBot: /player-stats called by ${interaction.user.username} — guid=${guid} season=${season}`);
      await interaction.deferReply();

      try {
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        const endpoint = season === "alltime" ? "/user/getPlayerStatsByID/" : "/user/getPlayerStatsByIDCurrentSeason/";
        const res = await apiClient({ method: "GET", url: endpoint, data: { arma_id: guid, token: config.apiToken } });
        const stats = res.data;

        const embed = buildStatsEmbed(stats, season);
        return await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        if (err.response?.status === 404) {
          return await interaction.editReply({ content: `No player found with GUID \`${guid}\`.` });
        }
        console.error("DiscordBot: /player-stats error:", err.message);
        return await interaction.editReply({ content: `Failed to fetch stats: ${err.response?.data?.message || err.message}` });
      }
    }

    // ── /search-player ──
    if (interaction.commandName === "search-player") {
      const name = interaction.options.getString("name").trim();
      console.log(`DiscordBot: /search-player called by ${interaction.user.username} — name="${name}"`);
      await interaction.deferReply();

      try {
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        const res = await apiClient({ method: "GET", url: "/user/searchUsersByUsername/", data: { search: name, token: config.apiToken } });
        const data = res.data?.users || res.data?.data || res.data;
        const players = Array.isArray(data) ? data : [];

        if (players.length === 0) {
          return await interaction.editReply({ content: `No players found matching \`${name}\`.` });
        }

        // Cache results for pagination button clicks
        cacheSearchResults(name, players);

        return await interaction.editReply(buildSearchPage(name, players, 0, interaction.user.id));
      } catch (err) {
        console.error("DiscordBot: /search-player error:", err.message);
        return await interaction.editReply({ content: `Search failed: ${err.response?.data?.message || err.message}` });
      }
    }

    // ── /member-stats ──
    if (interaction.commandName === "member-stats") {
      const target = interaction.options.getUser("user");
      console.log(`DiscordBot: /member-stats called by ${interaction.user.username} — target=${target.username} (${target.id})`);
      await interaction.deferReply();

      try {
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        const res = await apiClient({ method: "GET", url: "/user/getAllPlayerStatsByDiscordID", data: { discord_id: target.id, token: config.apiToken } });
        const stats = res.data;
        const armaId = stats?.arma_id;
        const armaName = stats?.arma_username || "Unknown";

        if (!armaId) {
          return await interaction.editReply({ content: `${target} has no linked Arma account yet.` });
        }

        return await interaction.editReply({
          embeds: [{
            title: armaName,
            description: `Linked to ${target}\n\n[**View full profile →**](${config.siteUrl}/admin/player/${armaId})`,
            color: 0xfe6500,
            thumbnail: { url: target.displayAvatarURL() },
            fields: [{ name: "Arma ID", value: `\`${armaId}\``, inline: false }],
          }],
        });
      } catch (err) {
        if (err.response?.status === 404) {
          return await interaction.editReply({ content: `${target} has no linked Arma account. They need to use \`/verify\` in-game first.` });
        }
        console.error("DiscordBot: /member-stats error:", err.message);
        return await interaction.editReply({ content: `Lookup failed: ${err.response?.data?.message || err.message}` });
      }
    }

    // ── Feature flag gate ──
    const ff = require("./feature-flags");
    const FLAG_MAP = {
      "daily": "wasted_coins", "balance": "wasted_coins", "coins-leaderboard": "wasted_coins", "transfer-cash": "wasted_coins",
      "lottery": "lottery", "skin-lottery": "skin_lottery", "wager": "kill_wagers", "trail": "wasted_coins", "slots": "wasted_coins", "dealer": "wasted_coins", "games": "wasted_coins",
      "outfit": "outfits", "war": "outfits",
    };
    const requiredFlag = FLAG_MAP[interaction.commandName];
    if (requiredFlag && !ff.isEnabled(requiredFlag)) {
      return await interaction.reply({ content: "This feature is currently disabled by an admin. Check back later.", flags: 64 });
    }

    // Gate: all economy commands require being in the Discord server
    const economyCommands = ["daily", "balance", "transfer-cash", "lottery", "skin-lottery", "wager", "trail", "slots", "dealer"];
    if (economyCommands.includes(interaction.commandName) && !interaction.guild) {
      return await interaction.reply({ content: "You must use this command in the Arma Wasteland Discord server, not in DMs.", flags: 64 });
    }

    // ── /daily ──
    if (interaction.commandName === "daily") {
      const coins = require("./wasted-coins");
      // Gate: must have a linked Arma account to prevent alt farming
      try {
        const apiCheck = axios.create({ baseURL: config.apiBaseUrl, timeout: 10000, headers: { "Content-Type": "application/json" } });
        await apiCheck({ method: "GET", url: "/user/getAllPlayerStatsByDiscordID", data: { discord_id: interaction.user.id, token: config.apiToken } });
      } catch (linkErr) {
        if (linkErr.response?.status === 404) {
          return await interaction.reply({ content: `${coins.EMOJI} You need a linked Arma account to claim daily coins. Use \`/verify\` in-game first.`, flags: 64 });
        }
      }
      try {
        const result = coins.claimDaily(interaction.user.id, interaction.user.username);
        const streakLine = result.streak > 1 ? `\n🔥 Streak: **${result.streak} days** (+${result.streakBonus} bonus)` : "";
        const cappedLine = result.capped
          ? `\n\n_Wallet capped at **${result.cap.toLocaleString()} ${coins.EMOJI}** — only ${result.reward.toLocaleString()} of ${result.attempted.toLocaleString()} credited. Spend some coins!_`
          : "";
        return await interaction.reply({
          embeds: [{
            color: 0xfe6500,
            author: { name: interaction.user.username, icon_url: interaction.user.displayAvatarURL() },
            description: `${coins.EMOJI} You claimed **${result.reward.toLocaleString()} ${coins.NAME}**!${streakLine}\n\nNew balance: **${result.newBalance.toLocaleString()} ${coins.EMOJI}**${cappedLine}\n\nUse \`/balance\` or spend them at https://armawasteland.com/profile/customize`,
          }],
        });
      } catch (err) {
        if (err.code === "COOLDOWN") {
          return await interaction.reply({ content: `${coins.EMOJI} ${err.message}`, flags: 64 });
        }
        console.error("DiscordBot: /daily error:", err.message);
        return await interaction.reply({ content: `Failed: ${err.message}`, flags: 64 });
      }
    }

    // ── /balance ──
    if (interaction.commandName === "balance") {
      const coins = require("./wasted-coins");
      coins.ensureAccount(interaction.user.id, interaction.user.username);
      const acct = coins.getAccount(interaction.user.id);
      const streak = coins.getStreak(interaction.user.id);
      const isSub = coins.isSubscriber(interaction.user.id);
      const transferCap = coins.getTransferCap(interaction.user.id);
      const transferredToday = coins.getTransferredToday(interaction.user.id);
      const transferRemaining = Math.max(0, transferCap - transferredToday);
      return await interaction.reply({
        embeds: [{
          color: 0xfe6500,
          author: { name: interaction.user.username, icon_url: interaction.user.displayAvatarURL() },
          title: `${coins.EMOJI} ${(acct.balance || 0).toLocaleString()} ${coins.NAME}`,
          fields: [
            { name: "Total Earned", value: (acct.total_earned || 0).toLocaleString(), inline: true },
            { name: "Total Spent", value: (acct.total_spent || 0).toLocaleString(), inline: true },
            { name: "Daily Streak", value: `🔥 ${streak.streak || 0} day${streak.streak === 1 ? "" : "s"}`, inline: true },
            { name: "Daily Transfer Cap", value: `${transferRemaining.toLocaleString()} / ${transferCap.toLocaleString()} remaining today${isSub ? " (subscriber 2x)" : ""}`, inline: false },
          ],
          footer: { text: "Earn with /daily • Spend at /profile/customize" },
        }],
      });
    }

    // ── /coins-leaderboard ── (web redirect)
    if (interaction.commandName === "coins-leaderboard") {
      return await interaction.reply({
        embeds: [{
          title: "🏆 Wasted Coins Leaderboard",
          color: 0xfe6500,
          description: `See the top holders, all-time earners, and weekly movement on the website.\n\n[**View Leaderboard →**](${config.siteUrl}/wasted-coins/leaderboard)`,
        }],
        flags: 64,
      });
    }

    // ── /transfer-cash ──
    if (interaction.commandName === "transfer-cash") {
      const coins = require("./wasted-coins");
      const amount = interaction.options.getInteger("coins");
      const discordId = interaction.user.id;

      await interaction.deferReply({ flags: 64 });

      try {
        const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
        let armaId = null;
        let armaUsername = null;

        // Primary: use /user/getPlayer which returns arma_id + discord_id reliably
        try {
          const lookup = await apiClient.get("/user/getPlayer", { params: { discord_id: discordId, token: config.adminApiToken } });
          armaId = lookup.data?.arma_id || null;
          armaUsername = lookup.data?.arma_username || null;
        } catch (e) {
          if (e.response?.status !== 404) console.warn("transfer-cash getPlayer err:", e.message);
        }

        // Fallback 1: stats-by-discord
        if (!armaId) {
          try {
            const lookup = await apiClient({ method: "GET", url: "/user/getAllPlayerStatsByDiscordID", data: { discord_id: discordId, token: config.apiToken } });
            armaId = lookup.data?.arma_id || null;
            armaUsername = armaUsername || lookup.data?.arma_username || null;
          } catch {}
        }

        // Fallback 2: search by username
        if (!armaId && armaUsername) {
          try {
            const search = await apiClient({ method: "GET", url: "/user/searchUsersByUsername/", data: { search: armaUsername, token: config.apiToken } });
            const users = search.data?.users || search.data?.data || search.data || [];
            const match = Array.isArray(users) ? users.find(u => (u.arma_username || "").toLowerCase() === armaUsername.toLowerCase()) || users[0] : null;
            if (match?.arma_id) armaId = match.arma_id;
          } catch {}
        }

        if (!armaId) {
          return await interaction.editReply({ content: "Couldn't find your Arma account. Use `/verify` in-game first, then try again." });
        }

        const result = await coins.transferToCash(discordId, amount, {
          armaId,
          axiosClient: apiClient,
          backendToken: config.backendToken,
          username: interaction.user.username,
        });

        return await interaction.editReply({
          embeds: [{
            color: 0x22c55e,
            title: `${coins.EMOJI} Transfer Complete`,
            description: `Sent **$${result.cashGranted.toLocaleString()}** to your in-game ATM.\n\nCoins spent: **${result.coinsTransferred.toLocaleString()}** + **${result.fee} fee** = **${result.coinsSpent.toLocaleString()} ${coins.EMOJI}**\nNew balance: **${coins.getBalance(discordId).toLocaleString()} ${coins.EMOJI}**`,
          }],
        });
      } catch (err) {
        console.error("DiscordBot: /transfer-cash error:", err.message);
        return await interaction.editReply({ content: `Transfer failed: ${err.response?.data?.message || err.message}` });
      }
    }

    // ── /lottery ──
    if (interaction.commandName === "lottery") {
      const lottery = require("./lottery");
      const wc = require("./wasted-coins");
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      if (sub === "info") {
        const pot = lottery.getCurrentPot();
        return await interaction.reply({
          embeds: [{
            color: 0xa855f7,
            title: `${wc.EMOJI} Weekly Lottery — Week of ${pot.weekId}`,
            description: `**Current Pot:** ${pot.pot.toLocaleString()} ${wc.EMOJI}  ·  **${pot.tickets.toLocaleString()} tickets** sold\n\nFull stats, your tickets, next draw time, and history are on the website.\n\n[**View Lottery →**](${config.siteUrl}/wasted-coins)`,
          }],
          flags: 64,
        });
      }

      if (sub === "buy") {
        const count = interaction.options.getInteger("count");
        try {
          const result = lottery.buyTickets(userId, interaction.user.username, count, wc);
          const pot = lottery.getCurrentPot();
          try {
            sendPublicWebhook({
              title: `${wc.EMOJI} Lottery Tickets Purchased`,
              description: `<@${userId}> bought **${result.tickets}** ticket(s) for **${result.cost.toLocaleString()} ${wc.EMOJI}**\nWeek ${result.weekId} pot is now **${pot.pot.toLocaleString()} ${wc.EMOJI}** (${pot.tickets} tickets)`,
              color: 0xa855f7,
            });
          } catch {}
          return await interaction.reply({
            embeds: [{
              color: 0x22c55e,
              description: `${wc.EMOJI} You bought **${result.tickets}** lottery ticket(s) for **${result.cost.toLocaleString()} ${wc.EMOJI}**.\nNew balance: **${result.balance.toLocaleString()} ${wc.EMOJI}**\nDraw is Friday — good luck!`,
            }],
          });
        } catch (err) {
          return await interaction.reply({ content: `Failed: ${err.message}`, flags: 64 });
        }
      }

      if (sub === "history") {
        return await interaction.reply({
          embeds: [{
            title: "📜 Lottery History",
            color: 0xa855f7,
            description: `Recent winners, payouts, and weekly stats are on the website.\n\n[**View History →**](${config.siteUrl}/wasted-coins)`,
          }],
          flags: 64,
        });
      }
    }

    // ── /skin-lottery ──
    if (interaction.commandName === "skin-lottery") {
      const sl = require("./skin-lottery");
      const wc = require("./wasted-coins");
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      if (sub === "info") {
        const pot = sl.getCurrentPot();
        return await interaction.reply({
          embeds: [{
            color: 0x8B5CF6,
            title: `${wc.EMOJI} Weekly Skin Lottery — Week of ${pot.weekId}`,
            description: `**${pot.tickets.toLocaleString()} tickets** in pool from **${pot.players}** player(s).\n\nWin a random skin from the in-game pool, granted to your account. Full pool stats, draw time, and history on the website.\n\n[**View Skin Lottery →**](${config.siteUrl}/wasted-coins)`,
          }],
          flags: 64,
        });
      }

      if (sub === "buy") {
        const count = interaction.options.getInteger("count");
        try {
          const result = sl.buyTickets(userId, interaction.user.username, count, wc);
          const pot = sl.getCurrentPot();
          try {
            sendPublicWebhook({
              title: `${wc.EMOJI} Skin Lottery Tickets Purchased`,
              description: `<@${userId}> bought **${result.tickets}** skin-lottery ticket(s) for **${result.cost.toLocaleString()} ${wc.EMOJI}**\nWeek ${result.weekId} pool now has **${pot.tickets} tickets** from ${pot.players} player(s).`,
              color: 0x8B5CF6,
            });
          } catch {}
          return await interaction.reply({
            embeds: [{
              color: 0x22c55e,
              description: `${wc.EMOJI} You bought **${result.tickets}** skin-lottery ticket(s) for **${result.cost.toLocaleString()} ${wc.EMOJI}**.\nNew balance: **${result.balance.toLocaleString()} ${wc.EMOJI}**\nDraw is Friday — win and the skin lands in your inventory automatically!`,
            }],
          });
        } catch (err) {
          return await interaction.reply({ content: `Failed: ${err.message}`, flags: 64 });
        }
      }

      if (sub === "history") {
        return await interaction.reply({
          embeds: [{
            title: "📜 Skin Lottery History",
            color: 0x8B5CF6,
            description: `Recent skin winners and weekly draws are on the website.\n\n[**View History →**](${config.siteUrl}/wasted-coins)`,
          }],
          flags: 64,
        });
      }
    }

    // ── /wager ──
    if (interaction.commandName === "wager") {
      const wagers = require("./kill-wagers");
      const wc = require("./wasted-coins");
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      if (sub === "kill") {
        const target = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        await interaction.deferReply();
        try {
          const result = await wagers.createWager(userId, interaction.user.username, target.id, target.username, amount, wc);
          try {
            sendPublicWebhook({
              title: `${wc.EMOJI} Kill Wager Issued`,
              description: `<@${userId}> challenged <@${target.id}> for **${amount.toLocaleString()} ${wc.EMOJI}** — first to gain more kills in 24 hours wins.\n\n<@${target.id}> use \`/wager accept @${interaction.user.username}\` to ante up, or \`/wager decline @${interaction.user.username}\` to pass. Expires in ${wagers.ACCEPT_WINDOW_HOURS}h.`,
              color: 0xef4444,
            });
          } catch {}
          try {
            await target.send({
              embeds: [{
                color: 0xef4444,
                title: `${wc.EMOJI} You've been challenged!`,
                description: `**${interaction.user.username}** wagered **${amount.toLocaleString()} ${wc.EMOJI}** on a 24h kill race against you.\n\nAccept: \`/wager accept @${interaction.user.username}\`\nDecline: \`/wager decline @${interaction.user.username}\`\n\nExpires in ${wagers.ACCEPT_WINDOW_HOURS} hours.`,
              }],
            });
          } catch {}
          return await interaction.editReply({
            embeds: [{
              color: 0xef4444,
              title: `${wc.EMOJI} Wager #${result.id} created`,
              description: `Challenge sent to ${target}. They have **${wagers.ACCEPT_WINDOW_HOURS}h** to accept (\`/wager accept @${interaction.user.username}\`).\nIf they don't, you'll be refunded.`,
            }],
          });
        } catch (err) {
          return await interaction.editReply({ content: `Failed: ${err.message}` });
        }
      }

      if (sub === "accept") {
        const challenger = interaction.options.getUser("user");
        await interaction.deferReply();
        try {
          let wager;
          if (challenger) {
            wager = wagers.getPendingWagerFrom(userId, challenger.id);
            if (!wager) return await interaction.editReply({ content: `No pending wager from ${challenger}. Check \`/wager status\`.` });
          } else {
            wager = wagers.getPendingWagerForTarget(userId);
            if (!wager) return await interaction.editReply({ content: "You don't have any pending wagers. Check `/wager status`." });
          }
          const result = await wagers.acceptWager(wager.id, userId, interaction.user.username, wc);
          const settleAtUnix = Math.floor(new Date(result.settleAt + "Z").getTime() / 1000);
          try {
            sendPublicWebhook({
              title: `${wc.EMOJI} Kill Wager Accepted — Race On!`,
              description: `<@${result.target}> accepted <@${result.challenger}>'s **${result.amount.toLocaleString()} ${wc.EMOJI}** kill wager.\n\nWhoever racks up the most kills by <t:${settleAtUnix}:F> wins the pot. Good hunting!`,
              color: 0xfbbf24,
            });
          } catch {}
          return await interaction.editReply({
            embeds: [{
              color: 0xfbbf24,
              description: `${wc.EMOJI} Wager vs <@${result.challenger}> is **active**! Race finishes <t:${settleAtUnix}:R>. Get out there.`,
            }],
          });
        } catch (err) {
          return await interaction.editReply({ content: `Failed: ${err.message}` });
        }
      }

      if (sub === "decline") {
        const challenger = interaction.options.getUser("user");
        await interaction.deferReply();
        try {
          let wager;
          if (challenger) {
            wager = wagers.getPendingWagerFrom(userId, challenger.id);
            if (!wager) return await interaction.editReply({ content: `No pending wager from ${challenger}.` });
          } else {
            wager = wagers.getPendingWagerForTarget(userId);
            if (!wager) return await interaction.editReply({ content: "You don't have any pending wagers." });
          }
          const result = await wagers.declineWager(wager.id, userId, wc);
          return await interaction.editReply({
            embeds: [{ color: 0x6b7280, description: `Declined wager from <@${result.challenger}>. They were refunded ${result.refund.toLocaleString()} ${wc.EMOJI}.` }],
          });
        } catch (err) {
          return await interaction.editReply({ content: `Failed: ${err.message}` });
        }
      }

      if (sub === "cancel") {
        const id = interaction.options.getInteger("id");
        try {
          const result = await wagers.cancelWager(id, userId, wc);
          return await interaction.reply({
            embeds: [{ color: 0x6b7280, description: `Cancelled wager #${id}. Refunded ${result.refund.toLocaleString()} ${wc.EMOJI}.` }],
          });
        } catch (err) {
          return await interaction.reply({ content: `Failed: ${err.message}`, flags: 64 });
        }
      }

      if (sub === "status") {
        const list = wagers.getMyWagers(userId, 8);
        if (!list.length) return await interaction.reply({ content: "No wagers yet. Use `/wager kill` to challenge someone.", flags: 64 });
        const lines = list.map(w => {
          const isMine = w.challenger_discord_id === String(userId);
          const opp = isMine ? w.target_discord_id : w.challenger_discord_id;
          const role = isMine ? "challenger" : "target";
          let extra = "";
          if (w.status === "settled") {
            if (w.winner_discord_id === String(userId)) extra = ` ✅ won ${w.payout.toLocaleString()} ${wc.EMOJI}`;
            else if (w.winner_discord_id) extra = ` ❌ lost`;
            else extra = ` 🤝 tie (refunded)`;
          }
          return `**#${w.id}** vs <@${opp}> — ${w.amount} ${wc.EMOJI} (${role}) — \`${w.status}\`${extra}`;
        });
        return await interaction.reply({
          embeds: [{ title: "Your Wagers", color: 0xfbbf24, description: lines.join("\n") }],
          flags: 64,
        });
      }
    }

    // ── /rules ──
    if (interaction.commandName === "rules") {
      const rulesAck = require("./rules-ack");
      // Admin gate — only write admins can post the rules acknowledgment
      const isAdmin = interaction.member?.roles?.cache?.some(r => config.adminRoleIds.includes(r.id) || config.adminWriteRoleIds.includes(r.id));
      if (!isAdmin) {
        return await interaction.reply({ content: "Only admins can post the rules acknowledgment.", flags: 64 });
      }
      const post = rulesAck.createPost(interaction.user.id, interaction.user.username);
      const count = rulesAck.getCountForPost(post.id);
      const msg = await interaction.reply({
        embeds: [buildRulesEmbed(post.id, count)],
        components: [buildRulesButtons(post.id)],
        fetchReply: true,
      });
      rulesAck.updatePostMessage(post.id, msg.id, msg.channelId);
      return;
    }

    // ── /poll ──
    if (interaction.commandName === "poll") {
      const polls = require("./poll");
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      if (sub === "create") {
        const question = interaction.options.getString("question").trim().slice(0, 400);
        const days = interaction.options.getInteger("days");
        const poll = polls.createPoll(question, userId, interaction.user.username, days);
        const tally = polls.getTally(poll.id);
        const msg = await interaction.reply({
          embeds: [buildPollEmbed({ id: poll.id, question, created_by_name: interaction.user.username, expires_at: poll.expiresAt }, tally)],
          components: [buildPollButtons(poll.id)],
          fetchReply: true,
        });
        polls.updatePollMessage(poll.id, msg.id, msg.channelId);
        return;
      }

      if (sub === "close") {
        const id = interaction.options.getInteger("id");
        try {
          const isAdmin = interaction.member?.roles?.cache?.some(r => config.adminRoleIds.includes(r.id) || config.adminWriteRoleIds.includes(r.id));
          const poll = polls.getPoll(id);
          if (!poll) return await interaction.reply({ content: `Poll #${id} not found.`, flags: 64 });
          if (poll.created_by_id !== userId && !isAdmin) {
            return await interaction.reply({ content: "Only the poll creator or an admin can close it.", flags: 64 });
          }
          const tally = isAdmin ? polls.adminClosePoll(id) : polls.closePoll(id, userId);

          // Edit the original poll message to show closed state
          try {
            if (poll.message_id && poll.channel_id) {
              const channel = await client.channels.fetch(poll.channel_id).catch(() => null);
              const msg = channel ? await channel.messages.fetch(poll.message_id).catch(() => null) : null;
              if (msg) {
                await msg.edit({ embeds: [buildPollEmbed(poll, tally, true)], components: [buildPollButtons(id, true)] });
              }
            }
          } catch (e) { console.warn("Poll close edit failed:", e.message); }

          return await interaction.reply({
            embeds: [{
              color: 0x22c55e,
              title: `📊 Poll #${id} Closed`,
              description: `**${poll.question}**\n\n**Final Tally (active players only):**\n✅ Yes: **${tally.yesActive}**\n❌ No: **${tally.noActive}**\n\n*Inactive responses:* ${tally.inactiveTotal} (Yes: ${tally.yesInactive} | No: ${tally.noInactive})`,
            }],
          });
        } catch (err) {
          return await interaction.reply({ content: `Failed: ${err.message}`, flags: 64 });
        }
      }
    }

    // ── /games ──
    if (interaction.commandName === "games") {
      const wc = require("./wasted-coins");
      return await interaction.reply({
        embeds: [{
          color: 0xD97706,
          title: "💀 Wasted Coins Games",
          description: "Spend your coins on games of chance and skill. Earn with `/daily`, burn them here.",
          fields: [
            {
              name: "🤠 Wasteland Trails — `/trail start`",
              value: "Survive 10 stages of bandits, disease, and desert on the journey west. Entry: **500 💀** | Grand prize: **5,000 💀** | Cash out early or push your luck. 3 runs/day.",
            },
            {
              name: "🎰 Wasteland Slots — `/slots`",
              value: "Spin 3 reels for **250 💀**. Match 2 = 1.5x, match 3 = 8x, triple 🏆 = **50x jackpot (12,500 💀)**. No daily limit.",
            },
            {
              name: "🕶️ Arms Dealer — `/dealer start`",
              value: "Buy low, sell high across 6 locations. Start with $5K cash and $3K debt (8% daily interest). Survive 20 days, outsmart the market. Entry: **500 💀** | 2 runs/day.",
            },
            {
              name: "🎲 Weekly Lottery — `/lottery buy`",
              value: "Buy tickets at **100 💀** each. One winner drawn **every Friday at 5pm EST**. Max 10 tickets/day.",
            },
            {
              name: "🎨 Skin Lottery — `/skin-lottery buy`",
              value: "Buy tickets at **250 💀** each. Winner gets a **random in-game skin**. Drawn Fridays.",
            },
            {
              name: "⚔️ Kill Wagers — `/wager kill @user`",
              value: "Challenge someone to a 24h kill race. Both ante up **100–2,500 💀**. Most kills wins the pot.",
            },
          ],
          footer: { text: "Earn coins with /daily | Check balance with /balance | Learn more at armawasteland.com/wasted-coins" },
        }],
      });
    }

    // ── /dealer ──
    if (interaction.commandName === "dealer") {
      const dealer = require("./arms-dealer");
      const wc = require("./wasted-coins");
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      if (sub === "start") {
        try {
          const game = dealer.startGame(userId, interaction.user.username, wc);
          const loc = dealer.getLocation(game.location);
          return await interaction.reply({
            embeds: [{
              color: 0xD97706,
              title: `🕶️ Arms Dealer — Day 1/${dealer.MAX_DAYS}`,
              description: `You arrive at **${loc.emoji} ${loc.name}** with **$${dealer.STARTING_CASH.toLocaleString()}** cash and **$${dealer.STARTING_DEBT.toLocaleString()}** in debt (${Math.round(dealer.INTEREST_RATE * 100)}% daily interest).\n\nBuy goods cheap, travel to sell high. Pay off your debt before it eats you alive.\n\n**Entry:** ${dealer.ENTRY_COST} ${wc.EMOJI} | **Payout:** $10 net worth = 1 ${wc.EMOJI}\n\n${dealer.formatPriceBoard(game.prices, {})}\n\nUse the buttons below to trade, travel, or cash out.`,
            }],
            components: buildDealerButtons(game.id, game.location, {}),
          });
        } catch (err) {
          return await interaction.reply({ content: `${wc.EMOJI} ${err.message}`, flags: 64 });
        }
      }

      if (sub === "end") {
        try {
          const game = dealer.getActiveGame(userId);
          if (!game) return await interaction.reply({ content: "You don't have an active game.", flags: 64 });
          const payout = dealer.endGame(game.id, wc);
          return await interaction.reply({
            embeds: [{
              color: payout.payout > dealer.ENTRY_COST ? 0x22c55e : 0xef4444,
              title: `🏁 Cashed Out — Day ${payout.days}`,
              description: `**Cash:** $${payout.cash.toLocaleString()}\n**Goods sold:** $${payout.goodsValue.toLocaleString()}\n**Debt:** -$${payout.debt.toLocaleString()}\n**Net worth:** $${payout.netWorth.toLocaleString()}\n\n**Payout: ${payout.payout.toLocaleString()} ${wc.EMOJI}**\nBalance: **${wc.getBalance(userId).toLocaleString()} ${wc.EMOJI}**`,
            }],
          });
        } catch (err) { return await interaction.reply({ content: `Failed: ${err.message}`, flags: 64 }); }
      }

      if (sub === "stats") {
        const stats = dealer.getStats(userId);
        return await interaction.reply({
          embeds: [{
            color: 0xD97706,
            title: "🕶️ Your Arms Dealer Stats",
            fields: [
              { name: "Games", value: `${stats.total}`, inline: true },
              { name: "Best Payout", value: `${stats.best.toLocaleString()} ${wc.EMOJI}`, inline: true },
              { name: "Total Earned", value: `${stats.totalPayout.toLocaleString()} ${wc.EMOJI}`, inline: true },
              { name: "Today", value: `${stats.playsToday}/${stats.maxPlays}`, inline: true },
            ],
          }],
          flags: 64,
        });
      }
    }

    // ── /trail ──
    if (interaction.commandName === "trail") {
      const trail = require("./trail-game");
      const wc = require("./wasted-coins");
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      if (sub === "start") {
        try {
          const game = trail.startGame(userId, interaction.user.username, wc);
          const stage = trail.getStage(0);
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`trail_${game.id}_begin`).setLabel("Head West!").setEmoji("🐎").setStyle(ButtonStyle.Primary),
          );
          const msg = await interaction.reply({
            embeds: [{
              color: 0xD97706,
              title: `${stage.emoji} ${stage.title}`,
              description: `${stage.text}\n\n**Entry:** ${trail.ENTRY_COST} ${wc.EMOJI} | **Stages:** ${trail.TOTAL_STAGES} | **Grand prize:** ${trail.PAYOUT_TABLE[trail.TOTAL_STAGES].toLocaleString()} ${wc.EMOJI}\n\n💀 Survive each stage by making the right choices. Cash out early or push your luck!\n\n**Payouts:** ${trail.PAYOUT_TABLE.slice(2).map((p, i) => `Stage ${i + 2}: ${p}💀`).join(" | ")}`,
            }],
            components: [row],
            fetchReply: true,
          });
          trail.updateMessageId(game.id, msg.id, msg.channelId);
          return;
        } catch (err) {
          return await interaction.reply({ content: `${wc.EMOJI} ${err.message}`, flags: 64 });
        }
      }

      if (sub === "cashout") {
        try {
          const game = trail.getActiveGame(userId);
          if (!game) return await interaction.reply({ content: "You don't have an active Wasteland Trails run.", flags: 64 });
          const result = trail.cashOut(game.id, wc);
          return await interaction.reply({
            embeds: [{
              color: 0x22c55e,
              title: "🏕️ Cashed Out",
              description: `You survived **${result.stage} stages** and cashed out with **${result.payout.toLocaleString()} ${wc.EMOJI}**!\n\nNew balance: **${wc.getBalance(userId).toLocaleString()} ${wc.EMOJI}**`,
            }],
          });
        } catch (err) { return await interaction.reply({ content: `Failed: ${err.message}`, flags: 64 }); }
      }

      if (sub === "stats") {
        const stats = trail.getStats(userId);
        return await interaction.reply({
          embeds: [{
            color: 0xD97706,
            title: "🤠 Your Wasteland Trails Stats",
            fields: [
              { name: "Runs", value: `${stats.total}`, inline: true },
              { name: "Wins", value: `${stats.wins}`, inline: true },
              { name: "Best", value: `Stage ${stats.best}/${trail.TOTAL_STAGES}`, inline: true },
              { name: "Total Payout", value: `${stats.totalPayout.toLocaleString()} ${wc.EMOJI}`, inline: true },
              { name: "Today", value: `${stats.playsToday}/${stats.maxPlays}`, inline: true },
            ],
          }],
          flags: 64,
        });
      }
    }

    // ── /slots ──
    if (interaction.commandName === "slots") {
      const wc = require("./wasted-coins");
      const userId = interaction.user.id;
      const BET = 250;

      try {
        wc.spendCoins(userId, BET, "slots_bet", { meta: { game: "slots" } });
      } catch (err) {
        return await interaction.reply({ content: `${wc.EMOJI} ${err.message}`, flags: 64 });
      }

      // 10 symbols = lower pair chance (~19% any pair vs ~38% with 7)
      const symbols = ["💀", "🔫", "💣", "🪖", "🎖️", "💰", "🏆", "🩸", "🧨", "⚙️"];
      const weights = [18, 16, 14, 12, 10, 8, 2, 8, 7, 5]; // 💀 most common, 🏆 rarest
      function spin() {
        const total = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        for (let i = 0; i < symbols.length; i++) {
          r -= weights[i];
          if (r <= 0) return symbols[i];
        }
        return symbols[0];
      }

      const r1 = spin(), r2 = spin(), r3 = spin();
      let multiplier = 0;
      let label = "";

      if (r1 === r2 && r2 === r3) {
        // Triple match
        if (r1 === "🏆") { multiplier = 50; label = "🏆 JACKPOT!!!"; }
        else if (r1 === "💰") { multiplier = 25; label = "💰 BIG WIN!"; }
        else if (r1 === "🎖️") { multiplier = 15; label = "🎖️ TRIPLE MEDALS!"; }
        else { multiplier = 8; label = "TRIPLE MATCH!"; }
      } else if (r1 === r2 || r2 === r3 || r1 === r3) {
        multiplier = 1.5;
        label = "Double!";
      }

      const winnings = Math.round(BET * multiplier);
      if (winnings > 0) {
        wc.addCoins(userId, winnings, "slots_win", { username: interaction.user.username, bypassCap: true, meta: { symbols: `${r1}${r2}${r3}`, multiplier } });
      }

      const net = winnings - BET;
      const balAfter = wc.getBalance(userId);
      const resultLine = multiplier === 0
        ? `Better luck next time! Lost **${BET} ${wc.EMOJI}**`
        : `**${label}** Won **${winnings.toLocaleString()} ${wc.EMOJI}** (${multiplier}x)!`;

      return await interaction.reply({
        embeds: [{
          color: multiplier >= 8 ? 0xfbbf24 : multiplier > 0 ? 0x22c55e : 0xef4444,
          title: `🎰  ${r1}  |  ${r2}  |  ${r3}  🎰`,
          description: `${resultLine}\n\nBalance: **${balAfter.toLocaleString()} ${wc.EMOJI}**`,
          footer: { text: `${BET} 💀 per spin` },
        }],
      });
    }

    // ── /outfit ──
    if (interaction.commandName === "outfit") {
      const outfits = require("./outfits");
      const wc = require("./wasted-coins");
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;
      await interaction.deferReply();

      if (sub === "create") {
        // Outfit creation moved to the website for a richer experience (color picker, motto, validation)
        return await interaction.editReply({
          embeds: [{
            color: 0x5865F2,
            title: "⚔️ Create Your Outfit on the Website",
            description: `Outfit creation lives at:\n\n**[${config.siteUrl}/outfits/create](${config.siteUrl}/outfits/create)**\n\nThere you can pick your name, tag, motto, and accent color in one place. Costs **5,000 ${wc.EMOJI}** and you'll be the **Don** 🎩 of a crew up to **10 members** strong.`,
            footer: { text: "After you create your outfit, come back to Discord to /outfit invite, /outfit deposit, /war declare, etc." },
          }],
        });
      }

      if (sub === "info") {
        const tag = interaction.options.getString("tag");
        let outfit;
        if (tag) {
          outfit = await outfits.getOutfitByTag(tag.toUpperCase().replace(/[\[\]]/g, ""));
        } else {
          const mine = await outfits.getMemberOutfit(userId);
          outfit = mine ? await outfits.getOutfit(mine.outfit_id) : null;
        }
        if (!outfit) {
          return await interaction.editReply({
            embeds: [{
              color: 0x5865F2,
              title: tag ? `No outfit found with tag [${tag}]` : "You're not in an outfit",
              description: `Browse all outfits, recruit, or create your own on the website.\n\n[**View All Outfits →**](${config.siteUrl}/outfits)`,
            }],
          });
        }
        return await interaction.editReply({
          embeds: [{
            color: parseInt((outfit.color || "#5865F2").replace("#", ""), 16),
            title: `[${outfit.tag}] ${outfit.name}`,
            description: `${outfit.motto || ""}\n\nFull roster, war record, treasury, and history on the website.\n\n[**View Outfit →**](${config.siteUrl}/outfits/${outfit.id})`,
          }],
        });
      }
      if (sub === "invite") {
        const target = interaction.options.getUser("user");
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine) return await interaction.editReply({ content: "You're not in an outfit." });
          const invite = await outfits.createInvite(mine.outfit_id, target.id, userId);
          const link = `${config.siteUrl}/outfits/invite/${invite.token}`;
          try {
            await target.send({
              embeds: [{
                color: 0x5865F2,
                title: `⚔️ Outfit Invite — [${invite.outfitTag}] ${invite.outfitName}`,
                description: `**${interaction.user.username}** invited you to join **[${invite.outfitTag}] ${invite.outfitName}**.\n\n**[Click here to accept →](${link})**\n\nExpires in ${outfits.INVITE_EXPIRE_HOURS}h.`,
              }],
            });
          } catch {}
          return await interaction.editReply({
            embeds: [{
              color: 0x22c55e,
              description: `Invite sent to ${target}. They need to accept at:\n${link}`,
            }],
          });
        } catch (err) {
          return await interaction.editReply({ content: `Failed: ${err.message}` });
        }
      }

      if (sub === "kick") {
        const target = interaction.options.getUser("user");
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine) return await interaction.editReply({ content: "You're not in an outfit." });
          if (!(await outfits.isDonOrCapo(mine.outfit_id, userId))) return await interaction.editReply({ content: "Only Dons/Capos can kick." });
          await outfits.removeMember(mine.outfit_id, target.id);
          return await interaction.editReply({ embeds: [{ color: 0xef4444, description: `${target} has been kicked from [${mine.outfit_tag}].` }] });
        } catch (err) {
          return await interaction.editReply({ content: `Failed: ${err.message}` });
        }
      }

      if (sub === "leave") {
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine) return await interaction.editReply({ content: "You're not in an outfit." });
          await outfits.removeMember(mine.outfit_id, userId);
          return await interaction.editReply({ embeds: [{ color: 0x6b7280, description: `You left [${mine.outfit_tag}] ${mine.outfit_name}.` }] });
        } catch (err) {
          return await interaction.editReply({ content: `Failed: ${err.message}` });
        }
      }

      if (sub === "promote") {
        const target = interaction.options.getUser("user");
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine || mine.role !== outfits.RANK_DON) return await interaction.editReply({ content: "Only the Don can promote." });
          await outfits.promoteMember(mine.outfit_id, target.id);
          return await interaction.editReply({ embeds: [{ color: 0xfbbf24, description: `${target} is now a **Capo** ${outfits.RANK_EMOJI.capo} of [${mine.outfit_tag}].` }] });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }

      if (sub === "demote") {
        const target = interaction.options.getUser("user");
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine || mine.role !== outfits.RANK_DON) return await interaction.editReply({ content: "Only the Don can demote." });
          await outfits.demoteMember(mine.outfit_id, target.id);
          return await interaction.editReply({ embeds: [{ color: 0x6b7280, description: `${target} has been demoted to **Soldier** ${outfits.RANK_EMOJI.soldier}.` }] });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }

      if (sub === "transfer") {
        const target = interaction.options.getUser("user");
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine) return await interaction.editReply({ content: "You're not in an outfit." });
          if (mine.role !== outfits.RANK_DON) return await interaction.editReply({ content: "Only the Don can transfer leadership." });
          await outfits.transferLeadership(mine.outfit_id, userId, target.id);
          return await interaction.editReply({ embeds: [{ color: 0xfbbf24, description: `${target} is now the **Don** ${outfits.RANK_EMOJI.don} of [${mine.outfit_tag}].` }] });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }

      if (sub === "deposit") {
        const coins = interaction.options.getInteger("coins");
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine) return await interaction.editReply({ content: "You're not in an outfit." });
          const newTreasury = await outfits.deposit(mine.outfit_id, userId, coins, wc);
          return await interaction.editReply({
            embeds: [{ color: 0x22c55e, description: `Deposited **${coins.toLocaleString()} ${wc.EMOJI}** into [${mine.outfit_tag}] treasury.\nTreasury balance: **${newTreasury.toLocaleString()} ${wc.EMOJI}**` }],
          });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }

      if (sub === "distribute") {
        const mode = interaction.options.getString("mode");
        const amount = interaction.options.getInteger("amount");
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine) return await interaction.editReply({ content: "You're not in an outfit." });
          const result = await outfits.distributeTreasury(mine.outfit_id, userId, mode, { amount, wastedCoins: wc });
          const modeLabel = mode === "even" ? "evenly" : mode === "rank-high" ? "weighted by rank (Don gets most)" : "weighted by rank (Soldiers get most)";
          return await interaction.editReply({
            embeds: [{
              color: 0x22c55e,
              title: `${wc.EMOJI} Treasury Distributed`,
              description: `[${mine.outfit_tag}] paid out **${result.total.toLocaleString()} ${wc.EMOJI}** ${modeLabel} to **${result.recipients}** members.`,
            }],
          });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }

      if (sub === "disband") {
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine) return await interaction.editReply({ content: "You're not in an outfit." });
          await outfits.disbandOutfit(mine.outfit_id, userId, { wastedCoins: wc });
          try {
            sendPublicWebhook({ title: "⚔️ Outfit Disbanded", description: `<@${userId}> disbanded **[${mine.outfit_tag}] ${mine.outfit_name}**.`, color: 0xef4444 });
          } catch {}
          return await interaction.editReply({ embeds: [{ color: 0xef4444, description: `[${mine.outfit_tag}] ${mine.outfit_name} has been disbanded.` }] });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }
    }

    // ── /war ──
    if (interaction.commandName === "war") {
      const outfits = require("./outfits");
      const wc = require("./wasted-coins");
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;
      await interaction.deferReply();

      if (sub === "cost") {
        const targetTag = interaction.options.getString("target").toUpperCase().replace(/[\[\]]/g, "");
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine) return await interaction.editReply({ content: "You're not in an outfit." });
          const target = await outfits.getOutfitByTag(targetTag);
          if (!target) {
            return await interaction.editReply({
              embeds: [{
                color: 0x5865F2,
                title: `No outfit found with tag [${targetTag}]`,
                description: `Browse all outfits on the website.\n\n[**View All Outfits →**](${config.siteUrl}/outfits)`,
              }],
            });
          }
          const c = await outfits.calculateWarCost(mine.outfit_id, target.id);
          return await interaction.editReply({
            embeds: [{
              color: 0xfbbf24,
              title: `War Cost: [${mine.outfit_tag}] vs [${target.tag}]`,
              description: `**${c.cost.toLocaleString()} ${wc.EMOJI}** to declare (H2H: ${c.wins}W / ${c.losses}L).\n\nFull breakdown, war history, and the **Declare War** button are on the target's outfit page.\n\n[**View [${target.tag}] →**](${config.siteUrl}/outfits/${target.id})`,
            }],
          });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }

      if (sub === "declare") {
        const targetTag = interaction.options.getString("target").toUpperCase().replace(/[\[\]]/g, "");
        try {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine) return await interaction.editReply({ content: "You're not in an outfit." });
          const target = await outfits.getOutfitByTag(targetTag);
          const result = await outfits.declareWar(mine.outfit_id, target?.id, userId, wc);
          try {
            sendPublicWebhook({
              title: "⚔️ War Declared",
              description: `**[${result.challenger.tag}] ${result.challenger.name}** declared war on **[${result.defender.tag}] ${result.defender.name}**!\n\n💰 Stake: **${result.cost.toLocaleString()} ${wc.EMOJI}** from [${result.challenger.tag}]'s treasury\n⏱️ Duration: **${outfits.WAR_DURATION_HOURS} hours**\n🏆 Winner: whichever outfit generates the most coins through gameplay\n\n[${result.defender.tag}] has ${outfits.WAR_ACCEPT_HOURS}h to respond.`,
              color: 0xef4444,
            });
          } catch {}
          return await interaction.editReply({
            embeds: [{
              color: 0xef4444,
              title: `⚔️ War #${result.id} Declared`,
              description: `[${result.challenger.tag}] vs [${result.defender.tag}] — **${outfits.WAR_DURATION_HOURS}h** war\n💰 Stake: ${result.cost.toLocaleString()} ${wc.EMOJI}\n\nAwaiting acceptance from [${result.defender.tag}].`,
            }],
          });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }

      if (sub === "accept") {
        const id = interaction.options.getInteger("id");
        try {
          const result = await outfits.acceptWar(id, userId);
          const endTs = Math.floor(new Date(result.endsAt + "Z").getTime() / 1000);
          try {
            sendPublicWebhook({
              title: "⚔️ WAR IS ON",
              description: `**[${result.challenger.tag}]** vs **[${result.defender.tag}]** — kill race starts NOW!\n\nEnds <t:${endTs}:F> (<t:${endTs}:R>). All member kills are being tracked.`,
              color: 0xfbbf24,
            });
          } catch {}
          return await interaction.editReply({
            embeds: [{ color: 0xfbbf24, description: `War #${id} is **active**! Race ends <t:${endTs}:R>. Get your outfit out there.` }],
          });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }

      if (sub === "decline") {
        const id = interaction.options.getInteger("id");
        try {
          await outfits.declineWar(id, userId);
          return await interaction.editReply({ embeds: [{ color: 0x6b7280, description: `War #${id} declined. Challenger wager refunded to their treasury.` }] });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }

      if (sub === "cancel") {
        const id = interaction.options.getInteger("id");
        try {
          await outfits.cancelWar(id, userId);
          return await interaction.editReply({ embeds: [{ color: 0x6b7280, description: `War #${id} cancelled. Wager refunded.` }] });
        } catch (err) { return await interaction.editReply({ content: `Failed: ${err.message}` }); }
      }

      if (sub === "status") {
        const id = interaction.options.getInteger("id");
        let war;
        if (id) {
          war = await outfits.getWar(id);
        } else {
          const mine = await outfits.getMemberOutfit(userId);
          if (!mine) return await interaction.editReply({ content: "You're not in an outfit." });
          war = await outfits.getActiveWarForOutfit(mine.outfit_id);
        }
        if (!war) return await interaction.editReply({ content: "No active war found." });
        const c = await outfits.getOutfit(war.challenger_outfit_id);
        const d = await outfits.getOutfit(war.defender_outfit_id);
        const scores = war.status === "active" || war.status === "settled" ? await outfits.getWarScores(war.id) : [];
        const cScores = scores.filter(s => s.outfit_id === war.challenger_outfit_id);
        const dScores = scores.filter(s => s.outfit_id === war.defender_outfit_id);
        const cTotal = cScores.reduce((s, x) => s + (x.delta || 0), 0);
        const dTotal = dScores.reduce((s, x) => s + (x.delta || 0), 0);
        const cLines = cScores.map(s => `${s.username || s.discord_id}: +${s.delta || 0}`).join("\n") || "—";
        const dLines = dScores.map(s => `${s.username || s.discord_id}: +${s.delta || 0}`).join("\n") || "—";

        return await interaction.editReply({
          embeds: [{
            color: war.status === "settled" ? 0x22c55e : 0xfbbf24,
            title: `War #${war.id} — [${c.tag}] vs [${d.tag}] (${war.status})`,
            fields: [
              { name: `[${c.tag}] (${cTotal})`, value: `\`\`\`\n${cLines}\n\`\`\``, inline: true },
              { name: `[${d.tag}] (${dTotal})`, value: `\`\`\`\n${dLines}\n\`\`\``, inline: true },
            ],
            footer: { text: war.ends_at ? `Ends: ${war.ends_at} UTC` : "" },
          }],
        });
      }
    }

    // ── /rcon-reconnect ──
    if (interaction.commandName === "rcon-reconnect") {
      const member = interaction.member;
      const isAdmin = member?.roles?.cache?.some(r => config.adminWriteRoleIds.includes(r.id));
      if (!isAdmin) {
        return await interaction.reply({ content: "You don't have permission to manage RCON.", flags: 64 });
      }

      await interaction.deferReply();

      try {
        const results = await rcon.reconnect();
        const status = results.map(r => {
          const emoji = r.status === "reconnected" ? ":white_check_mark:" : r.status === "already connected" ? ":yellow_circle:" : ":x:";
          return `${emoji} **${r.name}** — ${r.status}`;
        }).join("\n");

        return await interaction.editReply({ embeds: [{ title: "RCON Reconnect", description: status || "No RCON servers configured.", color: 0x5865F2 }] });
      } catch (err) {
        console.error("DiscordBot: /rcon-reconnect error:", err.message);
        return await interaction.editReply({ content: `RCON reconnect failed: ${err.message}` });
      }
    }

    // ── /rcon-players ──
    if (interaction.commandName === "rcon-players") {
      const member = interaction.member;
      const isAdmin = member?.roles?.cache?.some(r => config.adminRoleIds.includes(r.id));
      if (!isAdmin) {
        return await interaction.reply({ content: "You don't have permission to view RCON players.", flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });

      try {
        const players = await rcon.getPlayers();
        if (players.length === 0) {
          return await interaction.editReply({ content: "No players online or RCON not connected. Try `/rcon-reconnect`." });
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
        return await interaction.editReply({ content: output });
      } catch (err) {
        console.error("DiscordBot: /rcon-players error:", err.message);
        return await interaction.editReply({ content: `Failed to get players: ${err.message}` });
      }
    }
    } catch (err) {
      console.error(`DiscordBot: interaction error (/${interaction.commandName}):`, err.message);
    }
  });

  try {
    console.log("DiscordBot: Discord API: POST /auth/login (bot login)");
    await client.login(config.discordBotToken);
  } catch (err) {
    console.error("DiscordBot: login failed:", err.message);
  }
}

function buildStatsEmbed(stats, season, discordUser) {
  const kills = Number(stats.kill_count || 0);
  const deaths = Number(stats.deaths || 0);
  const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
  const fmt = (n) => Number(n || 0).toLocaleString();

  const lines = [
    `**Kill count:** ${fmt(kills)}`,
    `**Death count:** ${fmt(deaths)}`,
    `**K/D ratio:** ${kd}`,
    `**Distance walked:** ${(Number(stats.distance_walked || 0) / 1000).toFixed(1)} km`,
    `**Distance driven:** ${(Number(stats.distance_driven || 0) / 1000).toFixed(1)} km`,
    `**AI kills:** ${fmt(stats.ai_kills)}`,
    `**AI road kills:** ${fmt(stats.ai_roadkills)}`,
    `**Shots fired:** ${fmt(stats.shots_fired)}`,
    `**Grenades thrown:** ${fmt(stats.grenades_thrown)}`,
    `**Players died in vehicle:** ${fmt(stats.players_died_in_vehicle)}`,
    `**Bandaged self:** ${fmt(stats.bandage_self)}`,
    `**Bandaged friendlies:** ${fmt(stats.bandage_friendlies)}`,
    `**Saline self:** ${fmt(stats.saline_self)}`,
    `**Saline friendlies:** ${fmt(stats.saline_friendlies)}`,
    `**Tourniquet self:** ${fmt(stats.tourniquet_self)}`,
    `**Tourniquet friendlies:** ${fmt(stats.tourniquet_friendlies)}`,
  ];

  if (stats.mostKilledBy || stats.mostKilledby) {
    lines.push(`**Most killed by:** ${stats.mostKilledBy || stats.mostKilledby} (${fmt(stats.mostKilledByCount)})`);
  }
  if (stats.mostKilled) {
    lines.push(`**Most killed:** ${stats.mostKilled} (${fmt(stats.mostKilledCount)})`);
  }

  const playerName = stats.arma_username || stats.ArmaName || "Unknown";
  const embed = {
    title: playerName,
    description: lines.join("\n"),
    color: 0xfe6500,
    footer: { text: season === "alltime" ? "All Time Stats" : "Current Season" },
  };

  if (discordUser) {
    embed.author = { name: discordUser.username, icon_url: discordUser.displayAvatarURL() };
    embed.thumbnail = { url: discordUser.displayAvatarURL() };
  }

  return embed;
}

function getClient() {
  return client;
}

// Fetch guild membership join dates for a list of discord_ids.
// Returns a Map of discord_id → ISO joinedAt string (or null if not a member).
async function getGuildJoinDates(discordIds) {
  const result = new Map();
  if (!client?.isReady() || !config.discordGuildId) {
    for (const id of discordIds) result.set(id, null);
    return result;
  }
  const guild = client.guilds.cache.get(config.discordGuildId);
  if (!guild) {
    for (const id of discordIds) result.set(id, null);
    return result;
  }
  // Use cached member first, fetch individually for misses (rate-limit safe)
  for (const id of discordIds) {
    let member = guild.members.cache.get(id);
    if (!member) {
      try {
        member = await guild.members.fetch({ user: id, force: false });
      } catch (e) {
        // 10007 = Unknown Member (not in guild)
        result.set(id, null);
        continue;
      }
    }
    result.set(id, member?.joinedAt ? member.joinedAt.toISOString() : null);
  }
  return result;
}

module.exports = { init, getClient, getGuildJoinDates };
