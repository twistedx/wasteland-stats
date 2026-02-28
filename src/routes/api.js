const express = require("express");
const axios = require("axios");
const config = require("../config");
const { sendWebhookError } = require("../webhook");
const analytics = require("../analytics");
const metricsHistory = require("../metrics-history");
const router = express.Router();

const apiClient = axios.create({
  baseURL: config.apiBaseUrl,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

// In-memory cache
let cachedStats = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchDetailedStats(username) {
  try {
    // Get arma_id from username
    const idRes = await apiClient({
      method: "GET",
      url: "/user/getPlayerIDsByName",
      data: { arma_username: username, token: config.apiToken },
    });
    const ids = idRes.data;
    if (!Array.isArray(ids) || ids.length === 0) return null;

    // Get detailed stats for first matching ID
    const statsRes = await apiClient({
      method: "GET",
      url: "/user/getPlayerStatsByIDCurrentSeason",
      data: { arma_id: ids[0], token: config.apiToken },
    });
    return statsRes.data;
  } catch {
    return null;
  }
}

async function buildStats() {
  const now = Date.now();
  if (cachedStats && now - cacheTimestamp < CACHE_TTL) {
    return cachedStats;
  }

  const results = {
    leaderboard: [],
    leaderboardAllTime: [],
    bans: [],
    detailedStats: [],
    serverTotals: {},
    fetchedAt: new Date().toISOString(),
  };

  // Fetch leaderboard (current season + all-time) and bans in parallel
  const [seasonRes, alltimeRes, bansRes] = await Promise.allSettled([
    apiClient.get("/user/topTenUserStats/", { params: { token: config.apiToken } }),
    apiClient.get("/user/topTenUserStatsAllTime/", { params: { token: config.apiToken } }),
    apiClient({ method: "GET", url: "/user/getAllUserBans/", data: { token: config.apiToken } }),
  ]);

  if (seasonRes.status === "fulfilled") {
    results.leaderboard = Array.isArray(seasonRes.value.data) ? seasonRes.value.data : [];
  }
  if (alltimeRes.status === "fulfilled") {
    results.leaderboardAllTime = Array.isArray(alltimeRes.value.data) ? alltimeRes.value.data : [];
  }
  if (bansRes.status === "fulfilled") {
    results.bans = Array.isArray(bansRes.value.data?.data) ? bansRes.value.data.data : [];
  }

  // Fetch detailed stats for top 10 current-season players
  const topPlayers = results.leaderboard.slice(0, 10);
  const detailedPromises = topPlayers.map((p) => fetchDetailedStats(p.arma_username));
  const detailedResults = await Promise.allSettled(detailedPromises);

  results.detailedStats = detailedResults
    .map((r, i) => {
      if (r.status === "fulfilled" && r.value) {
        return { username: topPlayers[i].arma_username, ...r.value };
      }
      return null;
    })
    .filter(Boolean);

  // Aggregate server totals from detailed stats
  let totalKills = 0, totalDeaths = 0, totalShots = 0, totalGrenades = 0;
  let totalAiKills = 0, totalRoadkills = 0;
  let totalDistWalked = 0, totalDistDriven = 0;
  let totalBandages = 0, totalMorphine = 0, totalVehicleDeaths = 0;

  for (const s of results.detailedStats) {
    totalKills += Number(s.kill_count) || 0;
    totalDeaths += Number(s.deaths) || 0;
    totalShots += Number(s.shots_fired) || 0;
    totalGrenades += Number(s.grenades_thrown) || 0;
    totalAiKills += Number(s.ai_kills) || 0;
    totalRoadkills += Number(s.roadkills) || 0;
    totalDistWalked += Number(s.distance_walked) || 0;
    totalDistDriven += Number(s.distance_driven) || 0;
    totalBandages += (Number(s.bandage_self) || 0) + (Number(s.bandage_friendlies) || 0);
    totalMorphine += (Number(s.morphine_self) || 0) + (Number(s.morphine_friendlies) || 0);
    totalVehicleDeaths += Number(s.players_died_in_vehicle) || 0;
  }

  results.serverTotals = {
    kills: totalKills,
    deaths: totalDeaths,
    shotsFired: totalShots,
    grenades: totalGrenades,
    aiKills: totalAiKills,
    roadkills: totalRoadkills,
    vehicleDeaths: totalVehicleDeaths,
    distanceWalkedKm: Math.round(totalDistWalked / 1000),
    distanceDrivenKm: Math.round(totalDistDriven / 1000),
    bandagesUsed: totalBandages,
    morphineUsed: totalMorphine,
  };

  cachedStats = results;
  cacheTimestamp = now;
  return results;
}

// GET /api/stats
router.get("/stats", async (req, res) => {
  try {
    const stats = await buildStats();
    res.json(stats);
  } catch (error) {
    console.error("Stats API error:", error.message);
    sendWebhookError("Stats API", error.message);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// GET /api/server-history — public endpoint for player/CPU/memory charts
router.get("/server-history", (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours) || 6, 1), 720);
  res.json(metricsHistory.getHistory(hours));
});

module.exports = router;
