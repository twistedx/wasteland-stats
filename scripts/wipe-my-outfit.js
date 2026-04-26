// Dev helper: wipe whatever outfit a discord_id is currently in (and refund local coins if you want).
// Usage:  node scripts/wipe-my-outfit.js <discord_id>
// Calls the game-server /outfit/delete endpoint to remove the outfit and all members.

const outfits = require("../src/outfits");
const axios = require("axios");
const config = require("../src/config");

const [, , discordId] = process.argv;
if (!discordId) {
  console.error("Usage: node scripts/wipe-my-outfit.js <discord_id>");
  process.exit(1);
}

(async () => {
  try {
    const mine = await outfits.getMemberOutfit(discordId);
    if (!mine) {
      console.log(`No outfit membership found for ${discordId}. Nothing to do.`);
      return;
    }
    console.log(`Found membership: outfit_id=${mine.outfit_id} tag=${mine.outfit_tag || "?"} role=${mine.role || "?"}`);

    const api = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
    const res = await api.post("/outfit/delete", { token: config.adminApiToken, id: mine.outfit_id });
    console.log("Game-server response:", res.status, res.data);
    console.log(`OK — outfit ${mine.outfit_id} deleted on game server.`);
  } catch (err) {
    console.error("Failed:", err.response?.status, err.response?.data || err.message);
    process.exit(1);
  }
})();
