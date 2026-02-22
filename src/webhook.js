const axios = require("axios");
const config = require("./config");

function sendWebhookError(source, errorMessage) {
  if (!config.discordWebhookUrl) return;
  axios.post(config.discordWebhookUrl, {
    embeds: [{
      title: "Website Error",
      description: `**${source}**\n\`\`\`${errorMessage}\`\`\``,
      color: 0xFF3E3E,
      timestamp: new Date().toISOString(),
    }],
  }).catch(() => {});
}

module.exports = { sendWebhookError };
