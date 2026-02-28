const axios = require("axios");
const config = require("./config");

// Queue-based webhook sender — respects Discord rate limits
const queue = [];
let sending = false;
let rateLimitedUntil = 0;

async function processQueue() {
  if (sending || queue.length === 0) return;
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
      if (err.response?.status === 429) {
        const retryAfter = (err.response.data?.retry_after || 5) * 1000;
        rateLimitedUntil = Date.now() + retryAfter;
        // Put it back at the front of the queue
        queue.unshift(payload);
        console.error(`Webhook: rate limited, retrying in ${retryAfter / 1000}s`);
      } else {
        console.error("Webhook: send error", err.message);
      }
    }
  }

  sending = false;
}

function sendWebhook(embed) {
  console.log(`[Webhook] ${embed.title}: ${embed.description || ""}`);
}

function sendWebhookError(source, errorMessage) {
  console.error(`[Webhook Error] ${source}: ${errorMessage}`);
}

module.exports = { sendWebhook, sendWebhookError };
