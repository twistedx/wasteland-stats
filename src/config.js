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
  siteUrl: (process.env.SITE_URL || "http://localhost:3001").replace(/\/+$/, ""),
  amp: {
    url: (process.env.AMP_URL || "").replace(/\/+$/, ""),
    username: process.env.AMP_USERNAME || "",
    password: process.env.AMP_PASSWORD || "",
  },
  armaHqApiKey: process.env.ARMAHQ_API_KEY || "",
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

module.exports = config;
