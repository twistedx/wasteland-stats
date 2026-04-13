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

// POST /api/store-sync — receive store data from admin and upsert
const store = require("../store");
const skinDraw = require("../skin-draw");
const auditLog = require("../audit-log");

router.post("/store-sync", (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace("Bearer ", "");
  if (!token || token !== config.apiToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { products, categories, drawPool } = req.body;
  if (!products && !categories && !drawPool) {
    return res.status(400).json({ error: "No data provided" });
  }

  try {
    // Ensure skin draw tables exist before syncing
    skinDraw.init();

    const summary = {};
    if (categories || products) {
      const storeResult = store.upsertSyncData({
        products: products || [],
        categories: categories || [],
      });
      summary.categories = storeResult.categories;
      summary.products = storeResult.products;
    }
    if (drawPool && Array.isArray(drawPool)) {
      summary.drawPool = skinDraw.upsertPoolItems(drawPool);
    }

    auditLog.log("store", "Store Sync Received", `Products: ${products?.length || 0}, Categories: ${categories?.length || 0}, Draw Pool: ${drawPool?.length || 0}`, { username: "sync-api" });
    console.log("Store sync completed:", JSON.stringify(summary));
    res.json({ ok: true, summary });
  } catch (err) {
    console.error("Store sync error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Player search for watchlist (admin only)
router.get("/players/search", async (req, res) => {
  if (!req.session?.user?.isAdmin) return res.status(403).json({ error: "Unauthorized" });

  const q = (req.query.q || "").trim();
  if (q.length < 3) return res.json({ players: [] });

  try {
    const searchRes = await apiClient({
      method: "GET",
      url: "/user/searchUsersByUsername/",
      data: { search: q, token: config.apiToken },
    });
    const data = searchRes.data?.users || searchRes.data?.data || searchRes.data;
    const players = Array.isArray(data) ? data.slice(0, 20).map(p => ({
      arma_id: p.arma_id,
      arma_username: p.arma_username || "Unknown",
    })) : [];
    res.json({ players });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track profile CTA clicks
router.post("/profile-cta", (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { ctaIndex, ctaText } = req.body;
  if (ctaIndex === undefined || !ctaText) return res.status(400).json({ error: "Missing fields" });
  analytics.recordCtaClick(user.discord_id, user.username, String(ctaIndex), String(ctaText).slice(0, 200));
  res.json({ ok: true });
});

module.exports = router;
