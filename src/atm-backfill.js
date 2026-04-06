// Backfill ATM transactions from Discord channel history
// Can be called as a script or imported as a module
const axios = require("axios");
const config = require("./config");

async function backfill(economyTracker, maxPages = 50) {
  if (!config.discordBotToken || !config.atmChannelId) {
    console.log("ATM backfill: missing bot token or channel ID");
    return { total: 0, parsed: 0 };
  }

  const TOKEN = config.discordBotToken;
  const CHANNEL = config.atmChannelId;
  let total = 0;
  let parsed = 0;
  let lastId = null;

  for (let page = 0; page < maxPages; page++) {
    try {
      const url = `https://discord.com/api/v10/channels/${CHANNEL}/messages?limit=100${lastId ? "&before=" + lastId : ""}`;
      const res = await axios.get(url, { headers: { Authorization: `Bot ${TOKEN}` }, timeout: 15000 });
      const msgs = res.data;
      if (!msgs || msgs.length === 0) break;
      total += msgs.length;
      lastId = msgs[msgs.length - 1].id;

      for (const m of msgs) {
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
      if (page % 10 === 0) console.log(`ATM backfill: page ${page + 1}, ${total} messages, ${parsed} transactions`);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error("ATM backfill error:", err.message);
      break;
    }
  }

  console.log(`ATM backfill complete: ${total} messages, ${parsed} transactions`);
  return { total, parsed };
}

module.exports = { backfill };
