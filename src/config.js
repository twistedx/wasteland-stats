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
};

const required = ["apiBaseUrl", "apiToken", "sessionSecret"];
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
