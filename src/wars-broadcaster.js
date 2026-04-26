// Posts and edits a single Discord webhook message containing the current outfit-war board.
// Cron-driven (twice daily). Persists the message id at data/wars-message.json so each run edits
// the same message instead of spamming a new one. If the stored message is gone, falls back to a fresh post.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const config = require("./config");
const outfits = require("./outfits");

const STATE_FILE = path.join(__dirname, "..", "data", "wars-message.json");

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("wars-broadcaster: failed to persist state:", err.message);
  }
}

function buildEmbed(wars) {
  const ENV_FOOTER = config.environment === "production"
    ? { text: `🟢 production · ${config.siteUrl || "armawasteland.com"} · auto-updates twice daily` }
    : { text: "🔧 development · auto-updates twice daily" };

  if (!wars.length) {
    return {
      color: 0x6b7280,
      title: "⚔️ Active Outfit Wars",
      description: "_No active or pending wars right now. Declare one from your outfit page._",
      timestamp: new Date().toISOString(),
      footer: ENV_FOOTER,
    };
  }

  const lines = wars.map(w => {
    const isPending = String(w.status || "").toLowerCase() === "pending";
    const tag = isPending ? "⏳ **PENDING**" : "🔥 **ACTIVE**";
    const score = (w.challenger_score != null || w.defender_score != null)
      ? `${w.challenger_score || 0}–${w.defender_score || 0}`
      : "0–0";
    const wager = w.wager ? `💀 ${Number(w.wager).toLocaleString()}` : "Honor";
    const ends = w.ends_at ? `<t:${Math.floor(new Date(w.ends_at).getTime() / 1000)}:R>` : "—";
    return `${tag} · **[${w.challenger_tag}]** vs **[${w.defender_tag}]** · ${score} · ${wager} · ends ${ends}`;
  }).slice(0, 25); // Discord embed description hard cap is 4096 chars; 25 wars is plenty

  return {
    color: 0xef4444,
    title: `⚔️ Active Outfit Wars (${wars.length})`,
    description: lines.join("\n"),
    url: `${config.siteUrl || ""}/outfits`,
    timestamp: new Date().toISOString(),
    footer: ENV_FOOTER,
  };
}

async function broadcast() {
  if (!config.warsWebhookUrl) {
    console.warn("wars-broadcaster: WARS_WEBHOOK_URL not set, skipping broadcast.");
    return;
  }
  const wars = await outfits.getAllActiveWars();
  const embed = buildEmbed(wars);
  const state = readState();

  // Try to edit the existing message first
  if (state.messageId) {
    const editUrl = `${config.warsWebhookUrl}/messages/${state.messageId}`;
    try {
      await axios.patch(editUrl, { embeds: [embed] }, { timeout: 10000 });
      console.log(`wars-broadcaster: edited message ${state.messageId} (${wars.length} wars)`);
      return;
    } catch (err) {
      console.warn(`wars-broadcaster: edit failed (${err.response?.status || err.message}), falling back to new post`);
      // fall through to fresh post
    }
  }

  // Fresh post — capture message id with ?wait=true so Discord echoes the created message back
  try {
    const postUrl = `${config.warsWebhookUrl}?wait=true`;
    const res = await axios.post(postUrl, { embeds: [embed] }, { timeout: 10000 });
    const messageId = res.data?.id;
    if (messageId) {
      writeState({ messageId, postedAt: new Date().toISOString() });
      console.log(`wars-broadcaster: posted new message ${messageId} (${wars.length} wars)`);
    } else {
      console.warn("wars-broadcaster: posted but no message id returned (?wait=true may have been ignored)");
    }
  } catch (err) {
    console.error("wars-broadcaster: post failed:", err.response?.data || err.message);
  }
}

module.exports = { broadcast };
