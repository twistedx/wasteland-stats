const dotenv = require("dotenv");
dotenv.config();

const config = {
  port: process.env.PORT || 3001,
  apiBaseUrl: process.env.API_BASE_URL,
  apiToken: process.env.SERVER_READ_ONLY_TOKEN,
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: process.env.DISCORD_REDIRECT_URI,
  },
  sessionSecret: process.env.SESSION_SECRET,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
  discordBotToken: process.env.DISCORD_BOT_TOKEN,
  discordGuildId: process.env.DISCORD_GUILD_ID,
  adminRoleIds: (process.env.ADMIN_ROLE_IDS || "").split(",").filter(Boolean),
  backendToken: process.env.BACKEND_TOKEN,
  adminWriteRoleIds: (process.env.ADMIN_WRITE_ROLE_IDS || "").split(",").filter(Boolean),
  blogRoleIds: (process.env.BLOG_ROLE_IDS || "").split(",").filter(Boolean),
  donatorRoleId: process.env.DONATOR_ROLE_ID || "1282418153925640402",
  serverTagBadgeHash: process.env.SERVER_TAG_BADGE_HASH || "a1a8d7066521a13ede4b94de530e98b5",
  myStatsGateEnabled: process.env.MY_STATS_GATE !== "false",
  siteUrl: (process.env.SITE_URL || "http://localhost:3001").replace(/\/+$/, ""),
  environment: (() => {
    const explicit = (process.env.APP_ENV || process.env.NODE_ENV || "").toLowerCase();
    if (explicit === "production" || explicit === "prod") return "production";
    if (explicit === "development" || explicit === "dev") return "development";
    const url = (process.env.SITE_URL || "").toLowerCase();
    if (!url || url.includes("localhost") || url.includes("127.0.0.1")) return "development";
    return "production";
  })(),
  amp: {
    url: (process.env.AMP_URL || "").replace(/\/+$/, ""),
    username: process.env.AMP_USERNAME || "",
    password: process.env.AMP_PASSWORD || "",
  },
  armaHqApiKey: process.env.ARMAHQ_API_KEY || "",
  adminApiToken: process.env.ADMIN_API_TOKEN || "",
  steamApiKey: process.env.STEAM_API_KEY || "",
  vacWebhookUrl: process.env.VAC_WEBHOOK_URL || null,
  publicWebhookUrl: process.env.PUBLIC_WEBHOOK_URL || null,
  warsWebhookUrl: process.env.WARS_WEBHOOK_URL || null,
  atmChannelId: process.env.ATM_CHANNEL_ID || "",
  whitelistedIPs: (process.env.WHITELISTED_IPS || "").split(",").filter(Boolean),
  rconServers: (() => {
    const entries = (process.env.RCON_SERVERS || "").split("|").filter(Boolean);
    Object.keys(process.env).filter(k => /^RCON_SERVER\d+$/i.test(k)).sort().forEach(k => {
      entries.push(process.env[k]);
    });
    return entries.map(s => {
      const [name, address, port, password] = s.split(",");
      return { name, address, port: parseInt(port || "2302"), password };
    });
  })(),
  watchlistWebhookUrl: process.env.WATCHLISTWH || "",
  productionSyncUrl: process.env.PRODUCTION_SYNC_URL || "",
  ssh: {
    host: process.env.SSH_HOST || "",
    port: parseInt(process.env.SSH_PORT || "22", 10),
    username: process.env.SSH_USERNAME || "",
    privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH || "",
    appPath: process.env.SSH_APP_PATH || "",
    pm2AppName: process.env.SSH_PM2_APP_NAME || "armawasteland",
  },
};

const required = ["apiBaseUrl", "apiToken", "sessionSecret", "discordBotToken", "discordGuildId"];
for (const key of required) {
  if (!config[key]) {
    throw new Error(`Missing required env var for config.${key}`);
  }
}

const requiredDiscord = ["clientId", "clientSecret", "redirectUri"];
for (const key of requiredDiscord) {
  if (!config.discord[key]) {
    throw new Error(`Missing required env var for discord.${key}`);
  }
}

if (config.ssh.pm2AppName && !/^[a-zA-Z0-9_-]+$/.test(config.ssh.pm2AppName)) {
  throw new Error("SSH_PM2_APP_NAME contains invalid characters (only alphanumeric, hyphens, underscores allowed)");
}

module.exports = config;
