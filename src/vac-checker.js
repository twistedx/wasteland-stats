const axios = require("axios");
const config = require("./config");

// Steam GetPlayerBans API — checks up to 100 Steam IDs at once
async function checkBans(steamIds) {
  if (!config.steamApiKey || steamIds.length === 0) return [];

  const totalBatches = Math.ceil(steamIds.length / 100);
  console.log(`[VAC] Starting ban check: ${steamIds.length} IDs in ${totalBatches} batch(es)`);

  const results = [];

  for (let i = 0; i < steamIds.length; i += 100) {
    const batchNum = Math.floor(i / 100) + 1;
    const batch = steamIds.slice(i, i + 100);
    console.log(`[VAC] Batch ${batchNum}/${totalBatches}: sending ${batch.length} IDs to Steam API...`);

    try {
      const res = await axios.get("https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/", {
        params: {
          key: config.steamApiKey,
          steamids: batch.join(","),
        },
        timeout: 15000,
      });

      const players = res.data?.players || [];
      const banned = players.filter(p => p.VACBanned || p.NumberOfGameBans > 0);
      console.log(`[VAC] Batch ${batchNum}/${totalBatches}: ${players.length} responses, ${banned.length} with bans`);

      for (const p of banned) {
        console.log(`[VAC]   FLAGGED: ${p.SteamId} — VAC:${p.VACBanned}(${p.NumberOfVACBans}) Game:${p.NumberOfGameBans} Days:${p.DaysSinceLastBan}`);
      }

      results.push(...players);
    } catch (err) {
      console.error(`[VAC] Batch ${batchNum}/${totalBatches} FAILED: ${err.message}`);
    }
  }

  const totalFlagged = results.filter(p => p.VACBanned || p.NumberOfGameBans > 0).length;
  console.log(`[VAC] Ban check complete: ${results.length} checked, ${totalFlagged} flagged`);
  return results;
}

// Check a single Steam ID
async function checkSingle(steamId) {
  const results = await checkBans([steamId]);
  return results[0] || null;
}

// Enrich an array of players that have steam_id with VAC ban info
async function enrichPlayers(players) {
  const withSteam = players.filter(p => p.steam_id);
  if (withSteam.length === 0) return players;

  const steamIds = withSteam.map(p => p.steam_id);
  const banData = await checkBans(steamIds);

  const banMap = new Map();
  for (const b of banData) {
    banMap.set(b.SteamId, {
      vacBanned: b.VACBanned,
      numberOfVACBans: b.NumberOfVACBans,
      daysSinceLastBan: b.DaysSinceLastBan,
      communityBanned: b.CommunityBanned,
      economyBan: b.EconomyBan !== "none",
      numberOfGameBans: b.NumberOfGameBans,
    });
  }

  return players.map(p => {
    if (p.steam_id && banMap.has(p.steam_id)) {
      return { ...p, vac: banMap.get(p.steam_id) };
    }
    return p;
  });
}

module.exports = { checkBans, checkSingle, enrichPlayers };
