const axios = require("axios");
const config = require("./config");

// Queue-based webhook sender — respects Discord rate limits
const queue = [];
let sending = false;
let rateLimitedUntil = 0;

async function processQueue() {
  if (sending || queue.length === 0) return;
  if (!config.discordWebhookUrl) return;
  sending = true;

  while (queue.length > 0) {
    // Wait if rate limited
    const wait = rateLimitedUntil - Date.now();
    if (wait > 0) {
      await new Promise(r => setTimeout(r, wait));
    }

    const payload = queue.shift();
    try {
      const res = await axios.post(config.discordWebhookUrl, payload, { timeout: 10000 });
      // Respect rate limit headers — pause if we're close to the limit
      const remaining = parseInt(res.headers?.["x-ratelimit-remaining"], 10);
      if (remaining === 0) {
        const resetAfter = parseFloat(res.headers?.["x-ratelimit-reset-after"] || "2") * 1000;
        rateLimitedUntil = Date.now() + resetAfter;
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        const retryAfter = (err.response.data?.retry_after || 5) * 1000;
        rateLimitedUntil = Date.now() + retryAfter;
        queue.unshift(payload);
        console.error(`Webhook: rate limited, retrying in ${retryAfter / 1000}s`);
      } else if (status >= 500 || !status) {
        // Transient error (503, timeout, etc.) — retry after 5s, max 3 attempts
        payload._retries = (payload._retries || 0) + 1;
        if (payload._retries <= 3) {
          rateLimitedUntil = Date.now() + 5000;
          queue.unshift(payload);
          console.error(`Webhook: ${status || 'timeout'}, retry ${payload._retries}/3 in 5s`);
        } else {
          console.error(`Webhook: failed after 3 retries — ${err.message}`);
        }
      } else {
        console.error("Webhook: send error", err.message);
      }
    }
  }

  sending = false;
}

function sendWebhook(embed) {
  console.log(`[Webhook] ${embed.title}: ${embed.description || ""}`);
  if (!config.discordWebhookUrl) return;
  queue.push({
    embeds: [{
      title: embed.title,
      description: embed.description || "",
      color: embed.color || 0x5865F2,
      timestamp: new Date().toISOString(),
    }],
  });
  processQueue();
}

function sendWebhookError(source, errorMessage) {
  console.error(`[Webhook Error] ${source}: ${errorMessage}`);
  if (!config.discordWebhookUrl) return;
  queue.push({
    embeds: [{
      title: `Error: ${source}`,
      description: errorMessage,
      color: 0xef4444,
      timestamp: new Date().toISOString(),
    }],
  });
  processQueue();
}

module.exports = { sendWebhook, sendWebhookError };
