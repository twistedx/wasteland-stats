// Backfill ATM transactions from Discord channel history
// Supports incremental mode — only fetches messages newer than what's already in the DB
const axios = require("axios");
const config = require("./config");

async function backfill(economyTracker, maxPages = 50) {
  if (!config.discordBotToken || !config.atmChannelId) {
    console.log("ATM backfill: missing bot token or channel ID");
    return { total: 0, parsed: 0 };
  }

  const TOKEN = config.discordBotToken;
  const CHANNEL = config.atmChannelId;

  // Get the latest timestamp we already have — only fetch newer messages
  const latestTs = economyTracker.getLatestTimestamp();
  const cutoffDate = latestTs ? new Date(latestTs) : null;
  if (cutoffDate) {
    console.log(`ATM backfill: incremental mode — fetching messages after ${latestTs}`);
  } else {
    console.log("ATM backfill: full mode — no existing data");
  }

  let total = 0;
  let parsed = 0;
  let skipped = 0;
  let lastId = null;
  let reachedExisting = false;

  for (let page = 0; page < maxPages; page++) {
    try {
      const url = `https://discord.com/api/v10/channels/${CHANNEL}/messages?limit=100${lastId ? "&before=" + lastId : ""}`;
      const res = await axios.get(url, { headers: { Authorization: `Bot ${TOKEN}` }, timeout: 15000 });
      const msgs = res.data;
      if (!msgs || msgs.length === 0) break;
      total += msgs.length;
      lastId = msgs[msgs.length - 1].id;

      for (const m of msgs) {
        // Stop if we've reached messages we already have
        if (cutoffDate && new Date(m.timestamp) <= cutoffDate) {
          reachedExisting = true;
          skipped++;
          continue;
        }

        if (!m.embeds?.length) continue;
        const desc = m.embeds[0].description || "";
        const lines = desc.split("\n").map(l => l.trim());
        let playerName = null, type = null, amount = 0;
        for (const line of lines) {
          if (line.startsWith("Username:")) playerName = line.replace("Username:", "").trim();
          if (line.startsWith("Type:")) {
            const ts = line.replace("Type:", "").trim();
            if (ts.toLowerCase().startsWith("deposit")) type = "deposit";
            else if (ts.toLowerCase().startsWith("withdr") || ts.toLowerCase().startsWith("withdrew")) type = "withdrawal";
            const am = ts.match(/([\d,]+)/);
            if (am) amount = parseInt(am[1].replace(/,/g, ""), 10);
          }
        }
        if (type && amount > 0) {
          const ts = new Date(m.timestamp).toISOString().replace("T", " ").slice(0, 19);
          economyTracker.recordTransactionAt(type, playerName, amount, ts);
          parsed++;
        }
      }

      if (page % 10 === 0) console.log(`ATM backfill: page ${page + 1}, ${total} messages, ${parsed} new transactions`);

      // If all messages in this page were older than our cutoff, stop
      if (reachedExisting && skipped >= msgs.length) {
        console.log("ATM backfill: reached existing data, stopping");
        break;
      }
      skipped = 0;

      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      if (err.response?.status === 429) {
        const retryAfter = (err.response.data?.retry_after || 5) * 1000;
        console.log(`ATM backfill: rate limited, waiting ${retryAfter / 1000}s`);
        await new Promise(r => setTimeout(r, retryAfter));
        page--;
      } else {
        console.error("ATM backfill error:", err.message);
        break;
      }
    }
  }

  console.log(`ATM backfill complete: ${total} messages checked, ${parsed} new transactions added`);
  return { total, parsed };
}

module.exports = { backfill };
