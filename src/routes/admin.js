const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const config = require("../config");
const { sendWebhook, sendWebhookError, sendVacWebhook } = require("../webhook");
const analytics = require("../analytics");
const blog = require("../blog");
const amp = require("../amp");
const bm = require("../armahq");
const metricsHistory = require("../metrics-history");
const systemStats = require("../system-stats");
const store = require("../store");
const auditLog = require("../audit-log");
const skinDraw = require("../skin-draw");
const tasks = require("../tasks");
const ipBlock = require("../ip-block");
const economyTracker = require("../economy-tracker");
const vacChecker = require("../vac-checker");
const vacScanner = require("../vac-scanner");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const router = express.Router();

// Store image upload config
const storeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG, and WebP images are allowed."));
    }
  },
});

async function saveStoreImage(file) {
  const dir = path.join(__dirname, "..", "..", "public", "img", "store");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "").toLowerCase();
  const filepath = path.join(dir, filename);
  await sharp(file.buffer).resize(600, 800, { fit: "inside", withoutEnlargement: true }).png({ quality: 85 }).toFile(filepath);
  return "/img/store/" + filename;
}

const apiClient = axios.create({
  baseURL: config.apiBaseUrl,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

const adminApiClient = axios.create({
  baseURL: config.apiBaseUrl,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

// Admin auth middleware — verify session has valid user with admin role
router.use((req, res, next) => {
  if (!req.session.user || (!req.session.user.discord_id && req.session.user.authMethod !== "email")) {
    return res.redirect("/auth/discord");
  }
  if (!req.session.user.isAdmin) {
    console.warn(`Unauthorized admin access attempt by ${req.session.user.username} (${req.session.user.discord_id})`);
    return res.redirect("/");
  }
  next();
});

// GET /admin/bans
router.get("/bans", async (req, res) => {
  const user = req.session.user;
  const search = (req.query.search || "").trim();
  const field = req.query.field || "all";
  const dateRange = req.query.range || "all"; // 24h | 7d | 30d | 90d | custom | all
  const dateFrom = (req.query.from || "").trim(); // YYYY-MM-DD
  const dateTo = (req.query.to || "").trim();     // YYYY-MM-DD
  buildAvatarUrl(user);

  let bans = [];
  let bansError = false;

  try {
    const response = await apiClient({
      method: "GET",
      url: "/user/getAllUserBans/",
      data: { token: config.apiToken },
    });
    bans = Array.isArray(response.data?.data) ? response.data.data : [];
  } catch (error) {
    console.error("Ban list error:", error.message);
    sendWebhookError("Ban List Fetch", error.message);
    bansError = true;
  }

  // Apply search filter
  if (search && bans.length) {
    const q = search.toLowerCase();
    bans = bans.filter((ban) => {
      if (field === "username") {
        return (ban.banned_arma_username || "").toLowerCase().includes(q);
      }
      if (field === "guid") {
        return (ban.user_id_banned || "").toLowerCase().includes(q);
      }
      if (field === "banned_by") {
        return (ban.admin_name || "").toLowerCase().includes(q);
      }
      if (field === "reason") {
        return (ban.reason || "").toLowerCase().includes(q);
      }
      // "all" — search across all fields
      return (
        (ban.banned_arma_username || "").toLowerCase().includes(q) ||
        (ban.user_id_banned || "").toLowerCase().includes(q) ||
        (ban.admin_name || "").toLowerCase().includes(q) ||
        (ban.reason || "").toLowerCase().includes(q) ||
        (ban.banned_discord_username || "").toLowerCase().includes(q)
      );
    });
  }

  // Apply date filter — uses ban.time_stamp (ISO date)
  if (bans.length && dateRange !== "all") {
    const now = Date.now();
    let fromMs = null;
    let toMs = null;
    if (dateRange === "24h") fromMs = now - 86400000;
    else if (dateRange === "7d") fromMs = now - 7 * 86400000;
    else if (dateRange === "30d") fromMs = now - 30 * 86400000;
    else if (dateRange === "90d") fromMs = now - 90 * 86400000;
    else if (dateRange === "custom") {
      if (dateFrom) {
        const f = new Date(dateFrom + "T00:00:00Z");
        if (!isNaN(f)) fromMs = f.getTime();
      }
      if (dateTo) {
        const t = new Date(dateTo + "T23:59:59Z");
        if (!isNaN(t)) toMs = t.getTime();
      }
    }
    if (fromMs !== null || toMs !== null) {
      bans = bans.filter((ban) => {
        if (!ban.time_stamp) return false;
        const ts = new Date(ban.time_stamp).getTime();
        if (isNaN(ts)) return false;
        if (fromMs !== null && ts < fromMs) return false;
        if (toMs !== null && ts > toMs) return false;
        return true;
      });
    }
  }

  res.render("admin-bans", {
    page: "admin",
    pageTitle: "Ban List",
    pageDescription: "Admin ban list viewer for Arma Wasteland server.",
    activeTab: "bans",
    user,
    bans,
    bansError,
    banCount: bans.length,
    search,
    field,
    dateRange,
    dateFrom,
    dateTo,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// GET /admin/bans/notes — fetch web notes for a player (AJAX)
router.get("/bans/notes", async (req, res) => {
  const armaId = (req.query.arma_id || "").trim();
  if (!armaId) return res.json({ web_notes: "" });

  console.log(`[Notes] GET notes for arma_id=${armaId}`);
  try {
    const notesRes = await adminApiClient.get("/admin/bans/webNotes", {
      params: { token: config.adminApiToken, arma_id: armaId },
    });
    console.log(`[Notes] GET response for ${armaId}: "${(notesRes.data?.web_notes || "").slice(0, 100)}"`);
    res.json({ web_notes: notesRes.data?.web_notes || "" });
  } catch (error) {
    console.error(`[Notes] GET failed for ${armaId}: [${error.response?.status}] ${error.response?.data?.message || error.message}`);
    res.json({ web_notes: "" });
  }
});

// POST /admin/bans/notes — save web notes for a player (AJAX)
router.post("/bans/notes", async (req, res) => {
  const { arma_id, web_notes } = req.body;
  if (!arma_id) return res.status(400).json({ error: "Arma ID is required." });

  console.log(`[Notes] Bans POST notes for arma_id=${arma_id}, notes="${(web_notes || "").slice(0, 100)}"`);
  console.log(`[Notes] Using token: ${config.adminApiToken?.slice(0, 4)}... → POST ${config.apiBaseUrl}/admin/bans/webNotes`);

  try {
    const response = await adminApiClient.post("/admin/bans/webNotes", {
      token: config.adminApiToken,
      arma_id,
      web_notes: web_notes || "",
    });
    console.log(`[Notes] Bans POST success for ${arma_id}: ${response.data?.message || response.status}`);
    res.json({ success: true });
  } catch (error) {
    const status = error.response?.status;
    const apiMsg = error.response?.data?.message || error.message;
    console.error(`[Notes] Bans POST failed for ${arma_id}: [${status}] ${apiMsg}`);
    console.error(`[Notes] Full error:`, error.response?.data || error.message);
    res.status(500).json({ error: `Failed to save notes: ${apiMsg}` });
  }
});

// GET /admin/bans/search-players — JSON endpoint for modal player search
router.get("/bans/search-players", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    const searchRes = await apiClient({
      method: "GET",
      url: "/user/searchUsersByUsername/",
      data: { search: q, token: config.apiToken },
    });
    const data = searchRes.data?.users || searchRes.data?.data || searchRes.data;
    const players = Array.isArray(data) ? data : [];
    res.json(players.slice(0, 20).map((p) => ({
      arma_id: p.arma_id || "-",
      arma_username: p.arma_username || "Unknown",
    })));
  } catch (error) {
    console.error("Player search error (bans):", error.message);
    res.json([]);
  }
});

// GET /admin/bans/search-bans — search active bans for unban modal
router.get("/bans/search-bans", async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json([]);
  try {
    const r = await apiClient({
      method: "GET",
      url: "/user/getAllUserBans/",
      data: { token: config.apiToken },
    });
    const bans = Array.isArray(r.data?.data) ? r.data.data : [];
    const matches = bans.filter(b =>
      (b.banned_arma_username || "").toLowerCase().includes(q) ||
      (b.user_id_banned || "").toLowerCase().includes(q) ||
      (b.banned_discord_username || "").toLowerCase().includes(q)
    ).slice(0, 30).map(b => ({
      ban_id: b.id,
      arma_id: b.user_id_banned || "-",
      arma_username: b.banned_arma_username || "Unknown",
      reason: b.reason || "-",
      duration_hours: b.duration_hours,
    }));
    res.json(matches);
  } catch (error) {
    console.error("Ban search error:", error.message);
    res.json([]);
  }
});

// GET /admin/bans/export — download all bans as CSV
router.get("/bans/export", async (req, res) => {
  try {
    const response = await apiClient({
      method: "GET",
      url: "/user/getAllUserBans/",
      data: { token: config.apiToken },
    });
    const bans = Array.isArray(response.data?.data) ? response.data.data : [];

    const header = "Username,Discord,Arma GUID,Ban Date,Banned By,Reason,Duration";
    const rows = bans.map((b) => {
      const username = csvEscape(b.banned_arma_username || "Unknown");
      const discord = csvEscape(b.banned_discord_username || "");
      const guid = csvEscape(b.user_id_banned || "");
      const date = b.time_stamp ? new Date(b.time_stamp).toISOString() : "";
      const bannedBy = csvEscape(b.admin_name || "");
      const reason = csvEscape(b.reason || "");
      const duration = b.duration_hours === -1 ? "Permanent" : (b.duration_hours + "h");
      return `${username},${discord},${guid},${date},${bannedBy},${reason},${duration}`;
    });

    const csv = header + "\n" + rows.join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=bans-export.csv");
    res.send(csv);
  } catch (error) {
    console.error("Ban export error:", error.message);
    sendWebhookError("Ban Export", error.message);
    res.redirect("/admin/bans?error=Failed to export bans.");
  }
});

// POST /admin/bans — ban a player
router.post("/bans", async (req, res) => {
  const { arma_id, reason, duration_hours } = req.body;
  const user = req.session.user;

  if (!arma_id || !reason) {
    return res.redirect("/admin/bans?error=Arma ID and reason are required.");
  }

  const hours = parseInt(duration_hours);
  if (isNaN(hours)) {
    return res.redirect("/admin/bans?error=Invalid duration.");
  }

  try {
    await apiClient({
      method: "POST",
      url: "/user/banByArmaID/",
      data: {
        token: config.backendToken,
        arma_id,
        reason,
        duration_hours: hours,
        admin_name: user.username,
      },
    });

    // Reconnect RCON first (connections drop silently), then kick if online
    let kickNote = "";
    try {
      const rcon = require("../rcon");
      try { await rcon.reconnect(); } catch (e) { console.warn("RCON reconnect before kick failed:", e.message); }
      const kickResults = await rcon.kickPlayer(arma_id);
      const kicked = kickResults?.filter(r => r.result && !/not online|not found/i.test(r.result)) || [];
      if (kicked.length > 0) {
        kickNote = `\n**Kicked from:** ${kicked.map(r => r.server).join(", ")}`;
      }
    } catch (kickErr) {
      console.warn("Ban kick error:", kickErr.message);
    }

    auditLog.log("moderation", "Player Banned", `Arma ID: ${arma_id}, Reason: ${reason}, Duration: ${hours === -1 ? "Permanent" : hours + "h"}`, user);
    sendWebhook({
      title: "Player Banned",
      description: `<@${user.discord_id}> banned \`${String(arma_id).replace(/[`*_~|]/g, "")}\`\n**Reason:** ${String(reason).replace(/[`*_~|]/g, "")}\n**Duration:** ${hours === -1 ? "Permanent" : hours + "h"}${kickNote}`,
      color: 0xff3e3e,
    });

    res.redirect("/admin/bans?success=" + encodeURIComponent("Player " + arma_id + " has been banned."));
  } catch (error) {
    console.error("Ban player error:", error.message);
    const apiMsg = error.response?.data?.message || error.message;
    sendWebhookError("Ban Player", apiMsg);
    res.redirect("/admin/bans?error=" + encodeURIComponent("Failed to ban player. Please try again."));
  }
});

// POST /admin/bans/ban-progress — streaming version that emits per-step NDJSON
// Lets the UI show a live log so admins don't rage-click while RCON reconnects.
router.post("/bans/ban-progress", requireWriteAdmin, async (req, res) => {
  const user = req.session.user;
  const { arma_id, reason, duration_hours } = req.body;

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering if behind proxy
  });

  const startedAt = Date.now();
  const send = (step, status, msg, extra = {}) => {
    res.write(JSON.stringify({ step, status, msg, ts: Date.now() - startedAt, ...extra }) + "\n");
  };

  if (!arma_id || !reason) {
    send("validate", "error", "Arma ID and reason are required.");
    return res.end();
  }
  const hours = parseInt(duration_hours);
  if (isNaN(hours)) {
    send("validate", "error", "Invalid duration.");
    return res.end();
  }
  send("validate", "ok", "Inputs validated.");

  // Step 1: ban via game-server API
  send("ban_api", "start", "Calling game server ban endpoint…");
  try {
    const t = Date.now();
    await apiClient({
      method: "POST",
      url: "/user/banByArmaID/",
      data: { token: config.backendToken, arma_id, reason, duration_hours: hours, admin_name: user.username },
    });
    send("ban_api", "ok", `Ban recorded on game server (${Date.now() - t}ms).`);
  } catch (error) {
    const apiMsg = error.response?.data?.message || error.message;
    send("ban_api", "error", `Failed: ${apiMsg}`);
    sendWebhookError("Ban Player", apiMsg);
    return res.end();
  }

  // Step 2: RCON kick (try first, reconnect only if needed)
  let kickedFromServers = [];
  send("rcon_kick", "start", "Sending RCON kick…");
  try {
    const rcon = require("../rcon");
    const t = Date.now();
    let kicks = await rcon.kickPlayer(arma_id);
    let healthy = (kicks || []).filter(r => r.result && !/error|disconnect|timeout/i.test(r.result));
    if (healthy.length === 0 && kicks?.length > 0) {
      // All kicks failed — try reconnect once
      send("rcon_kick", "info", "Kick failed, reconnecting RCON sockets…");
      try { await rcon.reconnect(); } catch {}
      kicks = await rcon.kickPlayer(arma_id);
    }
    const landed = (kicks || []).filter(r => r.result && !/not online|not found|error|disconnect|timeout/i.test(r.result));
    kickedFromServers = landed.map(r => r.server);
    if (landed.length > 0) {
      send("rcon_kick", "ok", `Kicked from: ${kickedFromServers.join(", ")} (${Date.now() - t}ms).`);
    } else {
      send("rcon_kick", "skip", `Player not online on any server (${Date.now() - t}ms).`);
    }
  } catch (kickErr) {
    send("rcon_kick", "warn", `Kick error (ban still applied): ${kickErr.message}`);
  }

  // Step 3: audit log
  send("audit", "start", "Writing audit log…");
  auditLog.log("moderation", "Player Banned", `Arma ID: ${arma_id}, Reason: ${reason}, Duration: ${hours === -1 ? "Permanent" : hours + "h"}`, user);
  send("audit", "ok", "Audit logged.");

  // Step 4: Discord webhook
  send("webhook", "start", "Posting to Discord webhook…");
  try {
    const kickNote = kickedFromServers.length > 0 ? `\n**Kicked from:** ${kickedFromServers.join(", ")}` : "";
    sendWebhook({
      title: "Player Banned",
      description: `<@${user.discord_id}> banned \`${String(arma_id).replace(/[`*_~|]/g, "")}\`\n**Reason:** ${String(reason).replace(/[`*_~|]/g, "")}\n**Duration:** ${hours === -1 ? "Permanent" : hours + "h"}${kickNote}`,
      color: 0xff3e3e,
    });
    send("webhook", "ok", "Discord notified.");
  } catch (webhookErr) {
    send("webhook", "warn", `Webhook failed: ${webhookErr.message}`);
  }

  send("complete", "ok", `Ban complete in ${Date.now() - startedAt}ms.`, { redirect: `/admin/bans?success=${encodeURIComponent("Player " + arma_id + " has been banned.")}` });
  res.end();
});

// POST /admin/bans/unban — unban a player
router.post("/bans/unban", async (req, res) => {
  const { ban_id, arma_id } = req.body;
  const user = req.session.user;

  if (!ban_id && !arma_id) {
    return res.redirect("/admin/bans?error=Ban ID is required.");
  }

  try {
    const data = { token: config.backendToken };
    if (ban_id) data.ban_id = ban_id;
    else data.arma_id = arma_id;

    await apiClient({
      method: "POST",
      url: "/user/removeUserBanByID/",
      data,
    });

    const label = ban_id ? `Ban ID: ${ban_id}` : `Arma ID: ${arma_id}`;
    auditLog.log("moderation", "Player Unbanned", label, user);
    sendWebhook({
      title: "Player Unbanned",
      description: `<@${user.discord_id}> unbanned \`${String(ban_id || arma_id).replace(/[`*_~|]/g, "")}\``,
      color: 0x22c55e,
    });

    res.redirect("/admin/bans?success=" + encodeURIComponent("Ban removed."));
  } catch (error) {
    console.error("Unban player error:", error.message);
    const apiMsg = error.response?.data?.message || error.message;
    sendWebhookError("Unban Player", apiMsg);
    res.redirect("/admin/bans?error=" + encodeURIComponent("Failed to unban player. Please try again."));
  }
});

function csvEscape(val) {
  let str = String(val);
  // Prevent CSV formula injection (Excel treats =, +, -, @ as formulas)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Helper to build avatar URL
function buildAvatarUrl(user) {
  if (user.avatar && user.discord_id) {
    user.avatarUrl =
      "https://cdn.discordapp.com/avatars/" +
      user.discord_id + "/" + user.avatar + ".png?size=32";
  } else if (user.discord_id) {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl =
      "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
  } else {
    user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/0.png";
  }
}

// Write-admin middleware for money and skins
function requireWriteAdmin(req, res, next) {
  if (!req.session.user.isWriteAdmin) {
    console.warn(`Unauthorized write-admin access by ${req.session.user.username} (${req.session.user.discord_id})`);
    sendWebhookError("Unauthorized Write-Admin Access", `**${req.session.user.username}** (${req.session.user.discord_id}) tried to access ${req.originalUrl}`);
    return res.redirect("/admin/analytics");
  }
  next();
}

function requireOwner(req, res, next) {
  if (!req.session.user?.isOwner) {
    console.warn(`Unauthorized owner-only access by ${req.session.user?.username} (${req.session.user?.discord_id})`);
    sendWebhookError("Unauthorized Owner-Only Access", `**${req.session.user?.username}** (${req.session.user?.discord_id}) tried to access ${req.originalUrl}`);
    return res.redirect("/admin/analytics");
  }
  next();
}

// ── Feature Flags Toggle ──
router.post("/feature-flags/toggle", requireWriteAdmin, (req, res) => {
  const { flag, enabled } = req.body;
  try {
    const ff = require("../feature-flags");
    ff.setEnabled(flag, enabled === "true" || enabled === "1" || enabled === true);
    auditLog.log("feature-flags", `${flag} ${ff.isEnabled(flag) ? "enabled" : "disabled"}`, `Toggled by ${req.session.user.username}`, req.session.user);
    const tab = ["wasted_coins", "lottery", "skin_lottery", "kill_wagers"].includes(flag) ? "coins" : "outfits";
    res.redirect(`/admin/analytics?tab=${tab}&success=` + encodeURIComponent(`${flag} is now ${ff.isEnabled(flag) ? "ON" : "OFF"}.`));
  } catch (err) {
    res.redirect("/admin/analytics?tab=outfits&error=" + encodeURIComponent(err.message));
  }
});

// ── Poll Admin ──
router.post("/polls/:id/close", requireWriteAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const polls = require("../poll");
    polls.adminClosePoll(id);
    auditLog.log("polls", `Poll #${id} closed`, `Closed by ${req.session.user.username}`, req.session.user);
    res.redirect("/admin/analytics?tab=polls&success=" + encodeURIComponent(`Poll #${id} closed.`));
  } catch (err) {
    res.redirect("/admin/analytics?tab=polls&error=" + encodeURIComponent(err.message));
  }
});

// ── Outfit Admin ──
router.post("/outfits/:id/logo", requireWriteAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { logo_url } = req.body;
  try {
    const outfits = require("../outfits");
    await outfits.updateOutfit(id, { logo_url: (logo_url || "").trim() || null });
    auditLog.log("outfit-logo", `Outfit #${id} logo updated`, `Set by ${req.session.user.username}: ${logo_url || "(removed)"}`, req.session.user);
    res.redirect("/admin/analytics?tab=outfits&success=" + encodeURIComponent("Outfit logo updated."));
  } catch (err) {
    res.redirect("/admin/analytics?tab=outfits&error=" + encodeURIComponent(err.message));
  }
});

// ── Wasted Coins Admin ──
const wastedCoins = require("../wasted-coins");

router.get("/coins", requireWriteAdmin, (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);
  const top = wastedCoins.getLeaderboard(50);
  const recent = wastedCoins.getRecentTransactions(null, 50).map(t => {
    let metaParsed = null;
    try { metaParsed = t.meta ? JSON.parse(t.meta) : null; } catch {}
    return { ...t, metaParsed };
  });
  res.render("admin-coins", {
    page: "admin",
    pageTitle: "Wasted Coins",
    pageDescription: "Manage the Wasted Coins economy.",
    activeTab: "coins",
    user,
    top,
    recent,
    coinEmoji: wastedCoins.EMOJI,
    coinName: wastedCoins.NAME,
    constants: {
      DAILY_BASE: wastedCoins.DAILY_BASE,
      DAILY_TRANSFER_CAP: wastedCoins.DAILY_TRANSFER_CAP.toLocaleString(),
      DAILY_TRANSFER_CAP_SUBSCRIBER: wastedCoins.DAILY_TRANSFER_CAP_SUBSCRIBER.toLocaleString(),
    },
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// Add coins from money page (by arma_id — resolves to discord_id via getPlayer)
router.post("/money/coins", requireWriteAdmin, async (req, res) => {
  const { arma_id, amount } = req.body;
  const n = parseInt(amount, 10);
  if (!arma_id || !Number.isFinite(n) || n === 0) {
    return res.redirect("/admin/money?error=" + encodeURIComponent("Arma ID and non-zero amount required."));
  }
  try {
    const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
    const lookup = await apiClient.get("/user/getPlayer", { params: { arma_id, token: config.apiToken } });
    const discordId = lookup.data?.discord_id;
    const username = lookup.data?.arma_username || arma_id;
    if (!discordId) {
      return res.redirect("/admin/money?error=" + encodeURIComponent(`Player "${username}" doesn't have a linked Discord account. They need to /verify in-game first.`));
    }
    const newBal = wastedCoins.adminAdjust(discordId, n, req.session.user.username);
    auditLog.log("coins", "Coin Adjust (via money page)", `${n > 0 ? "+" : ""}${n} for ${discordId} (${username}) → ${newBal}`, req.session.user);
    res.redirect("/admin/money?success=" + encodeURIComponent(`${n > 0 ? "Added" : "Removed"} ${Math.abs(n)} coins ${n > 0 ? "to" : "from"} ${username}. Balance: ${newBal}`));
  } catch (err) {
    const msg = err.response?.status === 404 ? "Player not found." : err.message;
    res.redirect("/admin/money?error=" + encodeURIComponent(msg));
  }
});

router.post("/coins/adjust", requireWriteAdmin, (req, res) => {
  const { discord_id, delta } = req.body;
  const n = parseInt(delta, 10);
  if (!discord_id || !Number.isFinite(n) || n === 0) {
    return res.redirect("/admin/coins?error=" + encodeURIComponent("discord_id and non-zero delta required."));
  }
  try {
    const newBal = wastedCoins.adminAdjust(discord_id, n, req.session.user.username);
    auditLog.log("coins", "Coin Adjust", `${n > 0 ? "+" : ""}${n} for ${discord_id} → ${newBal}`, req.session.user);
    res.redirect("/admin/coins?success=" + encodeURIComponent(`Adjusted ${discord_id} by ${n}. New balance: ${newBal}`));
  } catch (err) {
    res.redirect("/admin/coins?error=" + encodeURIComponent(err.message));
  }
});

// ── Profile Customizations Admin ──
const profileCustomizations = require("../profile-customizations");

router.get("/profile-items", requireWriteAdmin, (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);
  const items = profileCustomizations.getAllItems();
  res.render("admin-profile-items", {
    page: "admin",
    pageTitle: "Profile Items",
    pageDescription: "Manage profile customization catalog.",
    activeTab: "profile-items",
    user,
    items,
    types: profileCustomizations.TYPES,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

router.post("/profile-items", requireWriteAdmin, (req, res) => {
  const { type, name, description, price, image, css_value, rarity, sort_order } = req.body;
  if (!type || !name || !price) {
    return res.redirect("/admin/profile-items?error=" + encodeURIComponent("type, name, and price are required."));
  }
  try {
    profileCustomizations.createItem({
      type, name, description, image, css_value, rarity,
      price: Math.round(Number(price) * 100),
      sort_order: parseInt(sort_order || "0", 10),
    });
    auditLog.log("profile-items", "Item Created", `${type}: ${name}`, req.session.user);
    res.redirect("/admin/profile-items?success=" + encodeURIComponent("Item created."));
  } catch (err) {
    res.redirect("/admin/profile-items?error=" + encodeURIComponent(err.message));
  }
});

router.post("/profile-items/:id/update", requireWriteAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { type, name, description, price, image, css_value, rarity, active, sort_order } = req.body;
  try {
    profileCustomizations.updateItem(id, {
      type, name, description, image, css_value, rarity,
      price: Math.round(Number(price) * 100),
      active: active ? 1 : 0,
      sort_order: parseInt(sort_order || "0", 10),
    });
    auditLog.log("profile-items", "Item Updated", `#${id} ${name}`, req.session.user);
    res.redirect("/admin/profile-items?success=" + encodeURIComponent("Item updated."));
  } catch (err) {
    res.redirect("/admin/profile-items?error=" + encodeURIComponent(err.message));
  }
});

router.post("/profile-items/:id/delete", requireWriteAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    profileCustomizations.deleteItem(id);
    auditLog.log("profile-items", "Item Deleted", `#${id}`, req.session.user);
    res.redirect("/admin/profile-items?success=" + encodeURIComponent("Item deleted."));
  } catch (err) {
    res.redirect("/admin/profile-items?error=" + encodeURIComponent(err.message));
  }
});

// GET /admin/money
router.get("/money", requireWriteAdmin, async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const search = (req.query.search || "").trim();
  const searchPage = parseInt(req.query.p) || 1;
  let players = [];
  let totalResults = 0;
  let hasMore = false;

  if (search) {
    try {
      const response = await apiClient({
        method: "GET",
        url: "/user/searchUsersByUsername/",
        data: { search, page: searchPage, token: config.apiToken },
      });
      const data = response.data?.users || response.data?.data || response.data;
      players = Array.isArray(data) ? data : [];
      totalResults = response.data?.total || response.data?.totalCount || players.length;
      hasMore = players.length >= 20; // assume 20 per page
    } catch (error) {
      console.error("Player search error:", error.message);
      if (error.response) {
        console.error("Response status:", error.response.status);
        console.error("Response data:", JSON.stringify(error.response.data));
      }
    }
  }

  res.render("admin-money", {
    page: "admin",
    pageTitle: "Add Money",
    pageDescription: "Admin tool to add money to player accounts.",
    activeTab: "money",
    user,
    search,
    players,
    searchPage,
    hasMore,
    hasPrev: searchPage > 1,
    selectedArmaId: req.query.arma_id || "",
    selectedUsername: req.query.username || "",
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// GET /admin/money/balance — JSON endpoint to fetch player cash balance
router.get("/money/balance", requireWriteAdmin, async (req, res) => {
  const armaId = (req.query.arma_id || "").trim();
  if (!armaId) return res.json({ balance: null });
  try {
    const cashRes = await apiClient({
      method: "GET",
      url: "/user/getUserCash/",
      data: { arma_id: armaId, token: config.apiToken },
    });
    console.log("[Money Balance]", armaId, JSON.stringify(cashRes.data));
    let balance = cashRes.data?.arma_cash_balance ?? cashRes.data?.cash ?? cashRes.data?.data?.cash ?? cashRes.data?.amount ?? null;
    if (balance === null && cashRes.data?.data !== undefined) {
      balance = cashRes.data.data;
    }
    res.json({ balance });
  } catch (error) {
    console.error("Balance fetch error:", error.message);
    res.json({ balance: null });
  }
});

// POST /admin/money
router.post("/money", requireWriteAdmin, async (req, res) => {
  const { arma_id, amount } = req.body;
  const user = req.session.user;

  if (!arma_id || !amount || Number(amount) <= 0) {
    return res.redirect("/admin/money?error=Invalid player ID or amount.");
  }

  try {
    await apiClient({
      method: "POST",
      url: "/user/updateUserCash/",
      data: {
        arma_id,
        amount: Number(amount),
        token: config.backendToken,
      },
    });

    // Track deposit total
    analytics.recordDeposit(Number(amount));
    auditLog.log("economy", "Money Added", `$${Number(amount).toLocaleString()} to Arma ID: ${arma_id}`, user);

    sendWebhook({
      title: "Money Added",
      description: `<@${user.discord_id}> added **$${Number(amount).toLocaleString()}** to player \`${arma_id}\``,
      color: 0xF59E0B,
    });

    res.redirect(`/admin/money?success=Added $${Number(amount).toLocaleString()} to ${arma_id}`);
  } catch (error) {
    console.error("Add money error:", error.message);
    if (error.response) {
      console.error("Response status:", error.response.status);
      console.error("Response data:", JSON.stringify(error.response.data));
    }
    sendWebhookError("Add Money", error.message);
    res.redirect("/admin/money?error=Failed to add money. Please try again.");
  }
});

// POST /admin/money/atm-limit — set ATM deposit limit
router.post("/money/atm-limit", requireWriteAdmin, async (req, res) => {
  const { arma_id, atm_limit } = req.body;
  const user = req.session.user;

  if (!arma_id || !atm_limit || Number(atm_limit) <= 0) {
    return res.redirect("/admin/money?error=Invalid player ID or ATM limit.");
  }

  try {
    console.log(`[ATM Limit] Setting limit for ${arma_id} to ${atm_limit}`);
    await adminApiClient.post("/admin/atm-limit", {
      token: config.adminApiToken,
      arma_id,
      atm_limit: Number(atm_limit),
    });

    auditLog.log("economy", "ATM Limit Set", `$${Number(atm_limit).toLocaleString()} for Arma ID: ${arma_id}`, user);
    sendWebhook({
      title: "ATM Limit Updated",
      description: `<@${user.discord_id}> set ATM limit to **$${Number(atm_limit).toLocaleString()}** for player \`${arma_id}\``,
      color: 0xfbbf24,
    });

    res.redirect(`/admin/money?success=ATM limit set to $${Number(atm_limit).toLocaleString()} for ${arma_id}&arma_id=${encodeURIComponent(arma_id)}`);
  } catch (error) {
    console.error("Set ATM limit error:", error.response?.status, error.response?.data || error.message);
    sendWebhookError("Set ATM Limit", error.response?.data?.message || error.message);
    res.redirect("/admin/money?error=Failed to set ATM limit. Please try again.");
  }
});

// GET /admin/money/atm-limit — fetch current ATM limit (JSON)
router.get("/money/atm-limit", requireWriteAdmin, async (req, res) => {
  const armaId = (req.query.arma_id || "").trim();
  if (!armaId) return res.json({ atm_limit: null });
  try {
    const limRes = await adminApiClient.get("/admin/atm-limit", { params: { token: config.adminApiToken, arma_id: armaId } });
    res.json({ atm_limit: limRes.data?.atm_limit ?? limRes.data?.data?.atm_limit ?? null });
  } catch {
    res.json({ atm_limit: null });
  }
});

// GET /admin/search — search players by name, arma ID, or discord ID
router.get("/search", async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const query = (req.query.q || "").trim();
  const searchType = req.query.type || "name";
  const page = parseInt(req.query.p) || 1;
  let results = [];
  let hasMore = false;
  let error = null;

  if (query) {
    try {
      if (searchType === "discord") {
        // Search by Discord ID via getPlayer (returns full record with arma_id)
        const playerRes = await apiClient.get("/user/getPlayer", { params: { discord_id: query, token: config.apiToken } });
        if (playerRes.data?.arma_id) {
          results = [{
            arma_id: playerRes.data.arma_id,
            arma_username: playerRes.data.arma_username || "Unknown",
            discord_id: playerRes.data.discord_id || query,
          }];
        }
      } else if (searchType === "arma_id") {
        // Search by Arma ID via getPlayer (returns full record)
        const playerRes = await apiClient.get("/user/getPlayer", { params: { arma_id: query, token: config.apiToken } });
        if (playerRes.data?.arma_id) {
          results = [{
            arma_id: playerRes.data.arma_id,
            arma_username: playerRes.data.arma_username || "Unknown",
            discord_id: playerRes.data.discord_id || null,
          }];
        }
      } else {
        // Search by name — paginate at 10 per page
        const PAGE_SIZE = 10;
        const searchRes = await apiClient({ method: "GET", url: "/user/searchUsersByUsername/", data: { search: query, page, token: config.apiToken } });
        const data = searchRes.data?.users || searchRes.data?.data || searchRes.data;
        const allResults = Array.isArray(data) ? data : [];
        // If the API returns everything in one response, slice it client-side
        if (allResults.length > PAGE_SIZE) {
          const startIdx = (page - 1) * PAGE_SIZE;
          results = allResults.slice(startIdx, startIdx + PAGE_SIZE);
          hasMore = allResults.length > startIdx + PAGE_SIZE;
        } else {
          // API handled pagination — results are already the current page
          results = allResults;
          hasMore = allResults.length >= PAGE_SIZE;
        }
      }
    } catch (err) {
      if (err.response?.status === 404) {
        results = [];
      } else {
        error = err.response?.data?.message || err.message;
      }
    }
  }

  // Enrich results with Steam ID and watchlist status
  for (const player of results.slice(0, 10)) {
    try {
      const wlRes = await adminApiClient.get("/admin/watchlist", { params: { token: config.adminApiToken, arma_id: player.arma_id } });
      player.isWatchlisted = !!wlRes.data?.is_watchlisted;
    } catch { player.isWatchlisted = false; }
    try {
      const steamRes = await adminApiClient.get("/admin/steam-id", { params: { token: config.adminApiToken, arma_id: player.arma_id } });
      player.steamId = steamRes.data?.steam_ids?.[0]?.steam64_id || null;
    } catch { player.steamId = null; }
  }

  res.render("admin-search", {
    page: "admin",
    pageTitle: "Search Players",
    pageDescription: "Search for players by name, Arma ID, or Discord ID.",
    activeTab: "search",
    user,
    query,
    searchType,
    searchPage: page,
    results,
    hasMore,
    hasPrev: page > 1,
    errorMessage: error || req.query.error || null,
  });
});

// GET /admin/rcon-players — list online players via RCON
router.get("/rcon-players", async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const rcon = require("../rcon");
  let players = [];
  let rconStatus = [];
  let error = null;

  try {
    rconStatus = rcon.getStatus();
    players = await rcon.getPlayers();
  } catch (err) {
    error = err.message;
  }

  // Check watchlist status for all players
  const watchlisted = new Set();
  const adminApiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 10000, headers: { "Content-Type": "application/json" } });
  await Promise.all(players.map(async (p) => {
    if (!p.guid) return;
    try {
      const res = await adminApiClient.get("/admin/watchlist", { params: { token: config.adminApiToken, arma_id: p.guid } });
      if (res.data?.is_watchlisted) watchlisted.add(p.guid);
    } catch {}
  }));
  players.forEach(p => { p.watchlisted = watchlisted.has(p.guid); });

  // Group by server
  const byServer = {};
  players.forEach(p => {
    if (!byServer[p.server]) byServer[p.server] = [];
    byServer[p.server].push(p);
  });

  res.render("admin-rcon-players", {
    page: "admin",
    pageTitle: "Online Players",
    pageDescription: "Live player list from game servers via RCON.",
    activeTab: "rcon-players",
    user,
    servers: Object.entries(byServer).map(([name, list]) => ({ name, players: list, count: list.length })),
    totalPlayers: players.length,
    rconStatus,
    errorMessage: error || req.query.error || null,
    successMessage: req.query.success || null,
  });
});

// POST /admin/rcon-players/kick — kick a player via RCON
router.post("/rcon-players/kick", requireWriteAdmin, async (req, res) => {
  const { guid, player_name } = req.body;
  const user = req.session.user;
  if (!guid) return res.redirect("/admin/rcon-players?error=GUID required.");

  const rcon = require("../rcon");
  try {
    const results = await rcon.kickPlayer(guid);
    const msg = results.map(r => `${r.server}: ${r.result}`).join(", ");
    auditLog.log("moderation", "Player Kicked (RCON)", `${player_name || guid} kicked by ${user.username}: ${msg}`, user);
    sendWebhook({
      title: "Player Kicked (RCON)",
      description: `<@${user.discord_id}> kicked **${player_name || guid}** (\`${guid}\`)\n${msg}`,
      color: 0xf59e0b,
    });
    res.redirect(`/admin/rcon-players?success=${encodeURIComponent(`Kicked ${player_name || guid}: ${msg}`)}`);
  } catch (err) {
    res.redirect(`/admin/rcon-players?error=${encodeURIComponent("Kick failed: " + err.message)}`);
  }
});

// POST /admin/rcon-players/reconnect — reconnect RCON
router.post("/rcon-players/reconnect", requireWriteAdmin, async (req, res) => {
  const rcon = require("../rcon");
  try {
    const results = await rcon.reconnect();
    const msg = results.map(r => `${r.name}: ${r.status}`).join(", ");
    res.redirect(`/admin/rcon-players?success=${encodeURIComponent("RCON reconnect: " + msg)}`);
  } catch (err) {
    res.redirect(`/admin/rcon-players?error=${encodeURIComponent("Reconnect failed: " + err.message)}`);
  }
});

// ── Builder Role Management ──
const BUILDER_ROLE_ID = "1485801785082773525";

// GET /admin/builder-role — search guild members + show their builder-role status
router.get("/builder-role", requireWriteAdmin, async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);
  const search = (req.query.search || "").trim();
  let members = [];
  let searchError = null;

  if (search) {
    try {
      const { getClient } = require("../discord-bot");
      const bot = getClient();
      if (!bot?.isReady()) {
        searchError = "Discord bot not connected.";
      } else {
        const guild = bot.guilds.cache.get(config.discordGuildId);
        if (!guild) {
          searchError = "Discord guild not found.";
        } else {
          const fetched = await guild.members.search({ query: search, limit: 25 });
          members = fetched.map(m => ({
            discord_id: m.id,
            username: m.user.username,
            displayName: m.displayName || m.user.globalName || m.user.username,
            avatar: m.user.displayAvatarURL({ size: 64 }),
            hasBuilderRole: m.roles.cache.has(BUILDER_ROLE_ID),
          }));
        }
      }
    } catch (err) {
      console.error("Builder role search error:", err.message);
      searchError = `Search failed: ${err.message}`;
    }
  }

  res.render("admin-builder-role", {
    page: "admin",
    pageTitle: "Builder Role",
    pageDescription: "Assign or remove the in-game Builder role for Discord members.",
    activeTab: "builder-role",
    user,
    search,
    members,
    searchError,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// POST /admin/builder-role — assign or remove the role
router.post("/builder-role", requireWriteAdmin, async (req, res) => {
  const { discord_id, action } = req.body;
  const user = req.session.user;
  if (!discord_id || !["assign", "remove"].includes(action)) {
    return res.redirect("/admin/builder-role?error=" + encodeURIComponent("Invalid request."));
  }
  try {
    const { getClient } = require("../discord-bot");
    const bot = getClient();
    if (!bot?.isReady()) throw new Error("Discord bot not connected.");
    const guild = bot.guilds.cache.get(config.discordGuildId);
    if (!guild) throw new Error("Guild not found.");
    const member = await guild.members.fetch(discord_id).catch(() => null);
    if (!member) throw new Error("Member not in the guild.");

    if (action === "assign") {
      await member.roles.add(BUILDER_ROLE_ID, `Assigned by ${user.username} via admin panel`);
      auditLog.log("roles", "Builder Role Assigned", `${member.user.username} (${discord_id}) by ${user.username}`, user);
    } else {
      await member.roles.remove(BUILDER_ROLE_ID, `Removed by ${user.username} via admin panel`);
      auditLog.log("roles", "Builder Role Removed", `${member.user.username} (${discord_id}) by ${user.username}`, user);
    }

    const search = (req.body.search || req.query.search || member.user.username || "").trim();
    res.redirect(`/admin/builder-role?search=${encodeURIComponent(search)}&success=` + encodeURIComponent(`Builder role ${action === "assign" ? "assigned to" : "removed from"} ${member.user.username}.`));
  } catch (err) {
    console.error("Builder role assign error:", err.message);
    res.redirect("/admin/builder-role?error=" + encodeURIComponent(err.message));
  }
});

// GET /admin/skins
router.get("/skins", requireWriteAdmin, async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  let skins = [];
  let items = [];
  let skinsError = false;

  try {
    const [skinsRes, itemsRes] = await Promise.all([
      apiClient.get(`/item/getItemNames`, { params: { token: config.backendToken } }),
      adminApiClient.get("/admin/items", { params: { token: config.adminApiToken } }),
    ]);
    skins = Array.isArray(skinsRes.data?.items) ? skinsRes.data.items : [];
    items = Array.isArray(itemsRes.data?.items) ? itemsRes.data.items : [];
  } catch (error) {
    console.error("Skins fetch error:", error.message);
    sendWebhookError("Skins Fetch", error.message);
    skinsError = true;
  }

  res.render("admin-skins", {
    page: "admin",
    pageTitle: "Skins",
    pageDescription: "Admin tool to assign skins to players.",
    activeTab: "skins",
    user,
    skins,
    items,
    skinsError,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// POST /admin/skins
router.post("/skins", requireWriteAdmin, async (req, res) => {
  const { discord_id, item_name } = req.body;
  const user = req.session.user;

  if (!discord_id || !item_name) {
    return res.redirect("/admin/skins?error=Discord ID and skin are required.");
  }

  try {
    const response = await apiClient.post(
      `/itemsUser/updateDiscordUserItemFromDiscord`,
      { discord_id, item_name, request_type: "set", quantity: 1 },
      { params: { token: config.backendToken } }
    );

    auditLog.log("skins", "Skin Assigned", `${item_name} to Discord user ${discord_id}`, user);
    sendWebhook({
      title: "Skin Assigned",
      description: `<@${user.discord_id}> assigned **${item_name}** to Discord user <@${discord_id}>`,
      color: 0x8B5CF6,
    });

    res.redirect(`/admin/skins?success=Assigned "${item_name}" to Discord user ${discord_id}`);
  } catch (error) {
    console.error("Skin assign error:", error.message);
    const apiMsg = error.response?.data?.message || error.message;
    sendWebhookError("Skin Assign", apiMsg);
    res.redirect("/admin/skins?error=" + encodeURIComponent("Failed to assign skin. Please try again."));
  }
});

// POST /admin/skins/tebex — add a new skin/item to the database via Tebex-format payload
router.post("/skins/tebex", requireWriteAdmin, async (req, res) => {
  const { item_name, skin_key } = req.body;
  const adminUser = req.session.user;

  if (!item_name || !skin_key) {
    return res.redirect("/admin/skins?error=All fields are required.");
  }

  // Ensure skin_key doesn't already have "skin=" prefix
  const cleanKey = skin_key.replace(/^skin=/, "");
  const now = new Date().toISOString();
  const txId = "tbx-manual-" + Date.now().toString(36);

  const payload = {
    id: crypto.randomUUID(),
    type: "payment.completed",
    date: now,
    subject: {
      transaction_id: txId,
      status: { id: 1, description: "Complete" },
      payment_sequence: "oneoff",
      created_at: now,
      price: { amount: 0, currency: "USD", base_currency: "USD", base_currency_price: 0 },
      price_paid: { amount: 0, currency: "USD", base_currency: "USD", base_currency_price: 0 },
      payment_method: { name: "Manual Admin", refundable: false },
      fees: {
        tax: { amount: 0, currency: "USD", base_currency: "USD", base_currency_price: 0 },
        gateway: { amount: 0, currency: "USD", base_currency: "USD", base_currency_price: 0 },
      },
      customer: {
        first_name: "Manual",
        last_name: "Admin",
        email: "admin@manual.local",
        ip: "127.0.0.1",
        username: { id: "0", username: adminUser.username || "Admin" },
        marketing_consent: false,
        country: "US",
        postal_code: null,
      },
      products: [
        {
          id: Date.now(),
          name: item_name,
          type: "single",
          quantity: 1,
          base_price: { amount: 0, currency: "USD", base_currency: "USD", base_currency_price: 0 },
          paid_price: { amount: 0, currency: "USD", base_currency: "USD", base_currency_price: 0 },
          variables: [{ identifier: "discord_id", option: adminUser.discord_id }],
          expires_at: null,
          custom: "skin=" + cleanKey,
          username: { id: "0", username: adminUser.username || "Admin" },
          servers: [],
        },
      ],
      coupons: [],
      gift_cards: [],
      recurring_payment_reference: null,
      custom: {},
      revenue_share: [],
      decline_reason: null,
      creator_code: null,
      settled_at: now,
    },
  };

  console.log("Skin add — custom field:", payload.subject.products[0].custom);
  console.log("Skin add — posting to:", config.apiBaseUrl + "/itemsUser/updateDiscordUserItem");

  try {
    const response = await apiClient.post(
      `/itemsUser/updateDiscordUserItem`,
      payload,
      { params: { token: config.backendToken } }
    );

    console.log("Skin add response:", response.status, JSON.stringify(response.data));

    auditLog.log("skins", "Skin Added to DB", `${item_name} (skin=${cleanKey})`, adminUser);
    sendWebhook({
      title: "Skin Created",
      description: `<@${adminUser.discord_id}> added **${item_name}** (skin=${cleanKey}) to the database`,
      color: 0x8B5CF6,
    });

    res.redirect(`/admin/skins?success=Added "${item_name}" (${cleanKey}) to the database`);
  } catch (error) {
    console.error("Skin add error:", error.message);
    console.error("Skin add error response:", error.response?.status, JSON.stringify(error.response?.data));
    const apiMsg = error.response?.data?.message || error.message;
    sendWebhookError("Skin Add", apiMsg);
    res.redirect("/admin/skins?error=" + encodeURIComponent("Failed to add skin: " + apiMsg));
  }
});

// GET /admin/items — item/skin registry
router.get("/items", requireWriteAdmin, async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  let items = [];
  let itemsError = false;

  try {
    const response = await adminApiClient.get("/admin/items", {
      params: { token: config.adminApiToken },
    });
    items = Array.isArray(response.data?.items) ? response.data.items : [];
  } catch (error) {
    console.error("Items fetch error:", error.message);
    itemsError = true;
  }

  res.render("admin-items", {
    page: "admin",
    pageTitle: "Create Skins",
    pageDescription: "Manage the skin registry.",
    activeTab: "items",
    user,
    items,
    itemCount: items.length,
    itemsError,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// POST /admin/items — create a new item
router.post("/items", requireWriteAdmin, async (req, res) => {
  const { name, description, skin_classname } = req.body;
  const user = req.session.user;

  if (!name) {
    return res.redirect("/admin/items?error=Skin name is required.");
  }

  try {
    await adminApiClient.post("/admin/items", {
      token: config.adminApiToken,
      name,
      description: description || "",
      misc_data: skin_classname ? { skin: skin_classname } : {},
    });

    auditLog.log("skins", "Skin Created", `${name}${skin_classname ? " (skin=" + skin_classname + ")" : ""}`, user);
    sendWebhook({
      title: "Skin Created",
      description: `<@${user.discord_id}> created skin **${name}**`,
      color: 0x8B5CF6,
    });

    res.redirect("/admin/items?success=" + encodeURIComponent(`Skin "${name}" created successfully.`));
  } catch (error) {
    console.error("Item create error:", error.message);
    sendWebhookError("Skin Create", error.message);
    res.redirect("/admin/items?error=" + encodeURIComponent("Failed to create skin. Please try again."));
  }
});

// ── Watchlist ──

// (adminApiClient declared at top of file)

// GET /admin/watchlist
router.get("/watchlist", async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const search = (req.query.search || "").trim();
  let players = [];
  let watchlistError = false;

  if (search) {
    try {
      let matchList = [];
      // Detect Steam64 ID (17-digit number starting with 7656) and do reverse lookup
      if (/^7656\d{13}$/.test(search)) {
        try {
          const res = await adminApiClient.get("/admin/steam-id", { params: { token: config.adminApiToken, steam64_id: search } });
          if (res.data?.arma_id) {
            matchList = [{ arma_id: res.data.arma_id, arma_username: res.data.arma_username || "Unknown" }];
          }
        } catch (e) {
          if (e.response?.status !== 404) console.error("Steam64 lookup error:", e.message);
        }
      } else {
        const searchRes = await apiClient({
          method: "GET",
          url: "/user/searchUsersByUsername/",
          data: { search, token: config.apiToken },
        });
        const data = searchRes.data?.users || searchRes.data?.data || searchRes.data;
        matchList = Array.isArray(data) ? data : [];
      }

      // Check watchlist status and Steam ID for each matched player
      const checks = matchList.slice(0, 20).map(async (p) => {
        let isWatchlisted = false;
        let webNotes = "";
        let steam_id = null;
        try {
          const wlRes = await adminApiClient.get("/admin/watchlist", {
            params: { token: config.adminApiToken, arma_id: p.arma_id },
          });
          isWatchlisted = !!wlRes.data?.is_watchlisted;
        } catch {}
        try {
          const notesRes = await adminApiClient.get("/admin/bans/webNotes", {
            params: { token: config.adminApiToken, arma_id: p.arma_id },
          });
          webNotes = notesRes.data?.web_notes || "";
        } catch {}
        try {
          const steamRes = await adminApiClient.get("/admin/steam-id", {
            params: { token: config.adminApiToken, arma_id: p.arma_id },
          });
          steam_id = steamRes.data?.steam64_id || null;
        } catch {}
        return {
          arma_id: p.arma_id || "-",
          arma_username: p.arma_username || "Unknown",
          isWatchlisted,
          webNotes,
          steam_id,
        };
      });
      players = await Promise.all(checks);

      // Check VAC bans for players with Steam IDs
      if (config.steamApiKey) {
        try {
          players = await vacChecker.enrichPlayers(players);
        } catch (err) {
          console.error("VAC check error:", err.message);
        }
      }
    } catch (error) {
      console.error("Watchlist search error:", error.message);
      watchlistError = true;
    }
  }

  res.render("admin-watchlist", {
    page: "admin",
    pageTitle: "Watchlist",
    pageDescription: "Manage the player watchlist.",
    activeTab: "watchlist",
    user,
    search,
    players,
    playerCount: players.length,
    watchlistError,
    vacFlagged: user.isAdmin ? await enrichVacFlagged() : [],
    vacStats: user.isAdmin ? vacScanner.getStats() : { total: 0, vacBanned: 0, gameBanned: 0, clean: 0 },
    vacLastScan: user.isAdmin ? vacScanner.getLastScan() : null,
    activeWatchlistTab: req.query.tab || "search",
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// POST /admin/watchlist — toggle watchlist status
router.post("/watchlist", requireWriteAdmin, async (req, res) => {
  const { arma_id, action, search, from } = req.body;
  const user = req.session.user;
  const searchParam = search ? "&search=" + encodeURIComponent(search) : "";
  const returnUrl = from === "vac" ? "/admin/watchlist?tab=vac" : null;

  if (!arma_id) {
    return res.redirect("/admin/watchlist?error=Arma ID is required." + searchParam);
  }

  const isWatchlisted = action === "add";

  try {
    await adminApiClient.post("/admin/watchlist", {
      token: config.adminApiToken,
      arma_id,
      is_watchlisted: isWatchlisted,
    });

    auditLog.log("moderation", isWatchlisted ? "Added to Watchlist" : "Removed from Watchlist", `Arma ID: ${arma_id}`, user);
    vacScanner.touchPlayer(arma_id);

    // Look up Steam profile for webhook
    let steamLink = "";
    try {
      const steamRes = await adminApiClient.get("/admin/steam-id", { params: { token: config.adminApiToken, arma_id } });
      if (steamRes.data?.steam_ids?.[0]?.steam64_id) {
        steamLink = `\n[Steam Profile](https://steamcommunity.com/profiles/${steamRes.data.steam_ids[0].steam64_id})`;
      }
    } catch {}

    sendVacWebhook({
      title: isWatchlisted ? "Player Added to Watchlist" : "Player Removed from Watchlist",
      description: `<@${user.discord_id}> ${isWatchlisted ? "added" : "removed"} \`${String(arma_id).replace(/[`*_~|]/g, "")}\` ${isWatchlisted ? "to" : "from"} the watchlist${steamLink}\n[View Profile](${config.siteUrl}/admin/player/${arma_id})`,
      color: isWatchlisted ? 0xf59e0b : 0x22c55e,
    });

    if (returnUrl) {
      res.redirect(returnUrl + "&success=" + encodeURIComponent(`Player ${arma_id} added to watchlist.`));
    } else {
      res.redirect("/admin/watchlist?success=" + encodeURIComponent(
        `Player ${arma_id} has been ${isWatchlisted ? "added to" : "removed from"} the watchlist.`
      ) + searchParam);
    }
  } catch (error) {
    console.error("Watchlist update error:", error.message);
    const apiMsg = error.response?.data?.message || error.message;
    sendWebhookError("Watchlist Update", apiMsg);
    if (returnUrl) {
      res.redirect(returnUrl + "&error=" + encodeURIComponent("Failed to update watchlist."));
    } else {
      res.redirect("/admin/watchlist?error=" + encodeURIComponent("Failed to update watchlist. Please try again.") + searchParam);
    }
  }
});

// POST /admin/watchlist/notes — update web notes for a player
router.post("/watchlist/notes", async (req, res) => {
  const { arma_id, web_notes, search } = req.body;
  const searchParam = search ? "&search=" + encodeURIComponent(search) : "";

  if (!arma_id) {
    return res.redirect("/admin/watchlist?error=Arma ID is required." + searchParam);
  }

  console.log(`[Notes] Watchlist POST notes for arma_id=${arma_id}, notes="${(web_notes || "").slice(0, 100)}"`);
  console.log(`[Notes] Using token: ${config.adminApiToken?.slice(0, 4)}... → POST ${config.apiBaseUrl}/admin/bans/webNotes`);

  try {
    const response = await adminApiClient.post("/admin/bans/webNotes", {
      token: config.adminApiToken,
      arma_id,
      web_notes: web_notes || "",
    });

    console.log(`[Notes] Watchlist POST success for ${arma_id}: ${response.data?.message || response.status}`);
    res.redirect("/admin/watchlist?success=" + encodeURIComponent("Notes updated for " + arma_id + ".") + searchParam);
  } catch (error) {
    const status = error.response?.status;
    const apiMsg = error.response?.data?.message || error.message;
    console.error(`[Notes] Watchlist POST failed for ${arma_id}: [${status}] ${apiMsg}`);
    console.error(`[Notes] Full error:`, error.response?.data || error.message);
    sendWebhookError("Web Notes Update", `${arma_id}: [${status}] ${apiMsg}`);
    res.redirect("/admin/watchlist?error=" + encodeURIComponent("Failed to update notes. Please try again.") + searchParam);
  }
});

// GET /admin/player/:arma_id — player profile page
router.get("/player/:arma_id", async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);
  const armaId = req.params.arma_id;

  const profile = { arma_id: armaId, arma_username: null, stats: null, allTimeStats: null, miscStats: [], watchlist: false, webNotes: "", steamId: null, atmLimit: null, vacInfo: null, bans: [], cashBalance: null, wastedCoinsBalance: null, lastLogin: null, accountCreated: null, discordId: null, timePlayed: null, serverHistory: [], previousNames: [], ownedSkins: [] };

  // Fetch all data in parallel
  const [statsRes, allTimeStatsRes, miscRes, wlRes, notesRes, steamRes, atmRes, cashRes, playerRes, historyRes] = await Promise.allSettled([
    apiClient({ method: "GET", url: "/user/getPlayerStatsByIDCurrentSeason/", data: { arma_id: armaId, token: config.apiToken } }),
    apiClient({ method: "GET", url: "/user/getPlayerStatsByID/", data: { arma_id: armaId, token: config.apiToken } }),
    apiClient({ method: "GET", url: "/user/getUserMiscStats/", data: { arma_id: armaId, token: config.apiToken } }),
    adminApiClient.get("/admin/watchlist", { params: { token: config.adminApiToken, arma_id: armaId } }),
    adminApiClient.get("/admin/bans/webNotes", { params: { token: config.adminApiToken, arma_id: armaId } }),
    adminApiClient.get("/admin/steam-id", { params: { token: config.adminApiToken, arma_id: armaId } }),
    adminApiClient.get("/admin/atm-limit", { params: { token: config.adminApiToken, arma_id: armaId } }),
    apiClient({ method: "GET", url: "/user/getUserCash/", data: { arma_id: armaId, token: config.apiToken } }),
    adminApiClient.get("/user/getPlayer", { params: { arma_id: armaId, token: config.adminApiToken } }),
    apiClient.get("/user/getPlayerServerHistory", { params: { arma_id: armaId, token: config.apiToken } }),
  ]);

  if (statsRes.status === "fulfilled" && statsRes.value.data) {
    profile.stats = statsRes.value.data;
    profile.arma_username = statsRes.value.data.arma_username || null;
  }
  if (allTimeStatsRes.status === "fulfilled" && allTimeStatsRes.value.data) {
    profile.allTimeStats = allTimeStatsRes.value.data;
    profile.arma_username = profile.arma_username || allTimeStatsRes.value.data.arma_username || null;
  }

  if (miscRes.status === "fulfilled" && miscRes.value.data) {
    const MISC_FIELDS = [
      { key: "ai_kills", label: "AI Kills" }, { key: "distance_walked", label: "Distance Walked (m)" },
      { key: "distance_driven", label: "Distance Driven (m)" }, { key: "distance_as_occupant", label: "Distance as Passenger (m)" },
      { key: "shots_fired", label: "Shots Fired" }, { key: "grenades_thrown", label: "Grenades Thrown" },
      { key: "roadkills", label: "Roadkills" }, { key: "ai_roadkills", label: "AI Roadkills" },
      { key: "players_died_in_vehicle", label: "Vehicle Deaths Caused" }, { key: "bandage_self", label: "Bandaged Self" },
      { key: "bandage_friendlies", label: "Bandaged Friendlies" }, { key: "tourniquet_self", label: "Tourniquet Self" },
      { key: "tourniquet_friendlies", label: "Tourniquet Friendlies" }, { key: "saline_self", label: "Saline Self" },
      { key: "saline_friendlies", label: "Saline Friendlies" }, { key: "morphine_self", label: "Morphine Self" },
      { key: "morphine_friendlies", label: "Morphine Friendlies" },
    ];
    const d = miscRes.value.data;
    profile.miscStats = MISC_FIELDS.filter(f => d[f.key] !== undefined && d[f.key] !== null).map(f => ({ label: f.label, value: d[f.key] }));
  }

  if (wlRes.status === "fulfilled") profile.watchlist = !!wlRes.value.data?.is_watchlisted;
  if (notesRes.status === "fulfilled") profile.webNotes = notesRes.value.data?.web_notes || "";
  if (steamRes.status === "fulfilled" && steamRes.value.data?.steam_ids?.length > 0) {
    profile.steamId = steamRes.value.data.steam_ids[0].steam64_id;
    profile.arma_username = profile.arma_username || steamRes.value.data.arma_username || null;
  }
  if (atmRes.status === "fulfilled" && atmRes.value.data) {
    profile.atmLimit = atmRes.value.data.atm_limit;
    profile.arma_username = profile.arma_username || atmRes.value.data.arma_username || null;
  }
  if (cashRes.status === "fulfilled" && cashRes.value.data) {
    profile.cashBalance = cashRes.value.data.arma_cash_balance ?? cashRes.value.data.cash ?? cashRes.value.data.amount ?? null;
  }
  if (playerRes.status === "fulfilled" && playerRes.value.data) {
    const p = playerRes.value.data;
    profile.lastLogin = p.time_stamp_last_arma_login || null;
    profile.accountCreated = p.time_stamp_created || null;
    profile.discordId = p.discord_id || profile.discordId;
    profile.timePlayed = p.arma_time_played || null;
    profile.arma_username = profile.arma_username || p.arma_username || null;
    // Previous names — backend may return as comma-separated string or array
    if (p.previous_names) {
      const raw = Array.isArray(p.previous_names) ? p.previous_names : String(p.previous_names).split(",");
      profile.previousNames = raw
        .map(n => String(n || "").trim())
        .filter(n => n && n.toLowerCase() !== String(profile.arma_username || "").toLowerCase());
    }
  }
  if (historyRes.status === "fulfilled" && historyRes.value.data?.servers) {
    profile.serverHistory = historyRes.value.data.servers
      .slice()
      .sort((a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0));
  }

  // Check VAC status from local DB — try steam_id first, then arma_id
  const vacScanner = require("../vac-scanner");
  const allVac = vacScanner.getAll();
  let vacRow = null;
  if (profile.steamId) {
    vacRow = allVac.find(r => r.steam_id === profile.steamId);
  }
  if (!vacRow) {
    vacRow = allVac.find(r => r.arma_id === armaId);
  }
  if (vacRow) profile.vacInfo = vacRow;

  // Get ban history from bans list
  try {
    const bansRes = await apiClient({ method: "GET", url: "/user/getAllUserBans/", data: { token: config.apiToken } });
    const allBans = bansRes.data?.bans || bansRes.data?.data || bansRes.data || [];
    if (Array.isArray(allBans)) {
      profile.bans = allBans.filter(b => b.user_id_banned === armaId);
    }
  } catch {}

  // Wasted Coins balance — only resolvable if we have a linked Discord ID
  if (profile.discordId) {
    profile.wastedCoinsBalance = wastedCoins.getBalance(profile.discordId);
  }

  // Owned skins/items — only resolvable if we have a linked Discord ID
  if (profile.discordId) {
    try {
      const itemsRes = await apiClient.get("/itemsUser/getUserItemsByDiscordId", {
        params: { discord_id: profile.discordId, token: config.apiToken },
        timeout: 10000,
      });
      const items = itemsRes.data?.items || [];
      profile.ownedSkins = items.map(i => {
        let name = String(i.item_name || "")
          .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{1FA00}-\u{1FA9F}]/gu, "")
          .replace(/^[\s\u{FE0F}]+/u, "")
          .trim();
        if (!name) name = i.item_name;
        return {
          name,
          quantity: i.quantity || 1,
          rarity: i.misc_data?.rarity || null,
          date: i.date_added || null,
        };
      }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    } catch (err) {
      console.error("admin-player: owned-skins fetch failed:", err.message);
    }
  }

  // Daily kills/deaths — server-side bucketed via /user/getPlayerKillsByDay
  profile.dailyStatsSeason = [];
  profile.dailyStatsAllTime = [];
  const [seasonRes, allTimeRes] = await Promise.allSettled([
    apiClient.get("/user/getPlayerKillsByDay", { params: { arma_id: armaId, season: "current", token: config.apiToken }, timeout: 10000 }),
    apiClient.get("/user/getPlayerKillsByDay", { params: { arma_id: armaId, season: "all", token: config.apiToken }, timeout: 10000 }),
  ]);
  if (seasonRes.status === "fulfilled" && Array.isArray(seasonRes.value.data?.days)) {
    profile.dailyStatsSeason = seasonRes.value.data.days;
  } else if (seasonRes.status === "rejected") {
    console.error("admin-player: getPlayerKillsByDay (season) failed:", seasonRes.reason?.message);
  }
  if (allTimeRes.status === "fulfilled" && Array.isArray(allTimeRes.value.data?.days)) {
    profile.dailyStatsAllTime = allTimeRes.value.data.days;
  } else if (allTimeRes.status === "rejected") {
    console.error("admin-player: getPlayerKillsByDay (all) failed:", allTimeRes.reason?.message);
  }

  const playerNotes = auditLog.getPlayerNotes(armaId);

  res.render("admin-player", {
    page: "admin",
    pageTitle: profile.arma_username || armaId,
    pageDescription: "Player profile",
    activeTab: "player",
    user,
    profile,
    playerNotes,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// POST /admin/player/:arma_id/note — add a note
// POST /admin/player/:arma_id/link-discord — Owner-only manual Discord link
router.post("/player/:arma_id/link-discord", requireOwner, async (req, res) => {
  const armaId = req.params.arma_id;
  const discord_id = (req.body.discord_id || "").trim();
  const action = req.body.action || "set"; // "set" or "unlink"

  if (action === "set" && !/^\d{17,20}$/.test(discord_id)) {
    return res.redirect(`/admin/player/${armaId}?error=Invalid Discord ID (expected 17-20 digits).`);
  }

  try {
    const finalDiscordId = action === "unlink" ? null : discord_id;
    await adminApiClient.post("/admin/link-discord", {
      token: config.adminApiToken,
      arma_id: armaId,
      discord_id: finalDiscordId,
    });
    auditLog.log("player-link", action === "unlink" ? "Discord Unlinked" : "Discord Linked",
      `arma:${armaId} ↔ discord:${finalDiscordId || "(cleared)"} by ${req.session.user.username}`,
      req.session.user);
    res.redirect(`/admin/player/${armaId}?success=` + encodeURIComponent(action === "unlink" ? "Discord link removed." : `Discord ${discord_id} linked.`));
  } catch (err) {
    const apiMsg = err.response?.data?.message || err.message;
    const conflict = err.response?.status === 409 && err.response?.data?.linked_to;
    const msg = conflict
      ? `That Discord is already linked to arma_id ${err.response.data.linked_to}.`
      : apiMsg;
    res.redirect(`/admin/player/${armaId}?error=` + encodeURIComponent(msg));
  }
});

router.post("/player/:arma_id/note", requireWriteAdmin, (req, res) => {
  const { note } = req.body;
  const armaId = req.params.arma_id;
  if (!note || !note.trim()) {
    return res.redirect(`/admin/player/${armaId}?error=Note cannot be empty.`);
  }
  auditLog.addPlayerNote(armaId, note.trim(), req.session.user);
  vacScanner.touchPlayer(armaId);
  res.redirect(`/admin/player/${armaId}`);
});

// POST /admin/player/:arma_id/note/:id/delete — delete a note (and its attachments)
router.post("/player/:arma_id/note/:id/delete", requireWriteAdmin, (req, res) => {
  const note = auditLog.getPlayerNote(req.params.id);
  if (note?.attachmentsArr?.length) {
    // Also remove attachment files from disk
    const dir = path.join(__dirname, "..", "..", "uploads", "notes", note.arma_id);
    for (const att of note.attachmentsArr) {
      try { fs.unlinkSync(path.join(dir, att.filename)); } catch {}
    }
  }
  auditLog.deletePlayerNote(req.params.id);
  res.redirect(`/admin/player/${req.params.arma_id}`);
});

// ── Note Attachment Uploads ──
const NOTE_UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads", "notes");
const MAX_IMAGE_MB = 5;
const MAX_VIDEO_MB = 500; // raised — ffmpeg compresses videos ~5–10x on save
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv)$/i;
const videoCompress = require("../video-compress");

const noteUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const armaId = req.params.arma_id;
      if (!/^[a-f0-9-]{8,}$/i.test(armaId)) return cb(new Error("Invalid arma_id"));
      const dir = path.join(NOTE_UPLOAD_DIR, armaId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase().slice(-80);
      cb(null, Date.now() + "-" + safe);
    },
  }),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (IMAGE_EXT.test(file.originalname) || VIDEO_EXT.test(file.originalname)) cb(null, true);
    else cb(new Error("Only images (jpg, png, webp, gif) and videos (mp4, webm, mov, avi, mkv) are allowed."));
  },
});

// POST /admin/player/:arma_id/note/:id/attach — upload file to a note
router.post("/player/:arma_id/note/:id/attach", requireWriteAdmin, (req, res) => {
  noteUpload.single("file")(req, res, async (err) => {
    const armaId = req.params.arma_id;
    const noteId = parseInt(req.params.id, 10);
    if (err) return res.redirect(`/admin/player/${armaId}?error=${encodeURIComponent(err.message)}`);
    if (!req.file) return res.redirect(`/admin/player/${armaId}?error=No file uploaded.`);

    const isImage = IMAGE_EXT.test(req.file.originalname);
    const isVideo = VIDEO_EXT.test(req.file.originalname);
    const sizeMB = req.file.size / (1024 * 1024);

    if (isImage && sizeMB > MAX_IMAGE_MB) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.redirect(`/admin/player/${armaId}?error=Image too large (max ${MAX_IMAGE_MB} MB).`);
    }

    try {
      const originalSize = req.file.size;
      let compressionNote = "";
      let finalFilename = path.basename(req.file.path);

      // Compress images via Sharp (except GIFs)
      if (isImage && !/\.gif$/i.test(req.file.originalname)) {
        const compressed = path.join(path.dirname(req.file.path), "c-" + path.basename(req.file.path));
        await sharp(req.file.path).resize(1920, 1920, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(compressed);
        fs.unlinkSync(req.file.path);
        fs.renameSync(compressed, req.file.path);
      }

      // Compress videos via ffmpeg (if available — otherwise keep original)
      if (isVideo && videoCompress.hasFfmpeg()) {
        const origPath = req.file.path;
        // Force output to .mp4 so browsers can play all uploads consistently
        const baseNoExt = path.basename(origPath).replace(/\.[^.]+$/, "");
        const compressedPath = path.join(path.dirname(origPath), baseNoExt + ".compressed.mp4");
        try {
          const res2 = await videoCompress.compressVideo(origPath, compressedPath);
          // Replace original with compressed version (.mp4 extension for browser compatibility)
          const finalPath = path.join(path.dirname(origPath), baseNoExt + ".mp4");
          fs.unlinkSync(origPath);
          fs.renameSync(compressedPath, finalPath);
          finalFilename = path.basename(finalPath);
          const savedMB = ((res2.originalSize - res2.compressedSize) / (1024 * 1024)).toFixed(1);
          const ratio = (res2.originalSize / Math.max(1, res2.compressedSize)).toFixed(1);
          compressionNote = ` (compressed ${ratio}x — saved ${savedMB} MB in ${Math.round(res2.durationMs / 1000)}s)`;
          console.log(`Video compressed: ${req.file.originalname} ${(res2.originalSize / 1024 / 1024).toFixed(1)} MB → ${(res2.compressedSize / 1024 / 1024).toFixed(1)} MB (${ratio}x)`);
        } catch (compressErr) {
          console.warn(`Video compression failed, keeping original: ${compressErr.message}`);
          // Keep original file — already at req.file.path
        }
      }

      const finalPath = path.join(path.dirname(req.file.path), finalFilename);
      auditLog.addAttachment(noteId, {
        type: isImage ? "image" : "video",
        filename: finalFilename,
        original_name: req.file.originalname,
        size: fs.statSync(finalPath).size,
        original_size: originalSize,
        uploaded_at: new Date().toISOString(),
        uploaded_by: req.session.user.username,
      });
      auditLog.log("player-notes", `Attachment added`, `${req.file.originalname} → note #${noteId} (player ${armaId})${compressionNote}`, req.session.user);
      res.redirect(`/admin/player/${armaId}?success=${encodeURIComponent("Attachment uploaded" + compressionNote + ".")}`);
    } catch (e) {
      console.error("Attachment save error:", e.message);
      try { fs.unlinkSync(req.file.path); } catch {}
      res.redirect(`/admin/player/${armaId}?error=Upload failed: ${encodeURIComponent(e.message)}`);
    }
  });
});

// GET /admin/uploads/note/:arma_id/:filename — serve attachment (admin-only)
router.get("/uploads/note/:arma_id/:filename", (req, res) => {
  const { arma_id, filename } = req.params;
  if (!/^[a-f0-9-]{8,}$/i.test(arma_id)) return res.status(400).send("Invalid id");
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return res.status(400).send("Invalid filename");
  const filepath = path.join(NOTE_UPLOAD_DIR, arma_id, filename);
  if (!filepath.startsWith(NOTE_UPLOAD_DIR)) return res.status(403).send("Forbidden");
  if (!fs.existsSync(filepath)) return res.status(404).send("Not found");
  res.sendFile(filepath);
});

// POST /admin/player/:arma_id/note/:id/attach/:filename/delete — remove a single attachment
router.post("/player/:arma_id/note/:id/attach/:filename/delete", requireWriteAdmin, (req, res) => {
  const { arma_id, id, filename } = req.params;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return res.redirect(`/admin/player/${arma_id}?error=Invalid filename`);
  try {
    auditLog.removeAttachment(parseInt(id, 10), filename);
    const filepath = path.join(NOTE_UPLOAD_DIR, arma_id, filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    auditLog.log("player-notes", `Attachment removed`, `${filename} from note #${id}`, req.session.user);
    res.redirect(`/admin/player/${arma_id}?success=Attachment removed.`);
  } catch (err) {
    res.redirect(`/admin/player/${arma_id}?error=${encodeURIComponent(err.message)}`);
  }
});

// GET /admin/kd-report — renders page immediately with spinner, data loaded via AJAX
router.get("/kd-report", (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const threshold = Math.max(1, Math.min(100, parseFloat(req.query.threshold) || 3.0));
  const minKills = Math.max(1, Math.min(1000, parseInt(req.query.min_kills) || 10));

  res.render("admin-kd-report", {
    page: "admin",
    pageTitle: "K/D Report",
    pageDescription: "Players with suspicious kill/death ratios.",
    activeTab: "kd-report",
    user,
    threshold,
    minKills,
  });
});

// GET /admin/kd-report/data — JSON API for K/D report data
router.get("/kd-report/data", async (req, res) => {
  const threshold = Math.max(1, Math.min(100, parseFloat(req.query.threshold) || 3.0));
  const minKills = Math.max(1, Math.min(1000, parseInt(req.query.min_kills) || 10));

  try {
    const [kdRes, bansRes] = await Promise.all([
      adminApiClient.get("/admin/kd-report", {
        params: { token: config.adminApiToken, threshold, min_kills: minKills },
      }),
      apiClient({ method: "GET", url: "/user/getAllUserBans/", data: { token: config.apiToken } }),
    ]);

    const players = Array.isArray(kdRes.data?.players) ? kdRes.data.players : [];
    const playerCount = kdRes.data?.count || players.length;

    const bans = Array.isArray(bansRes.data?.data) ? bansRes.data.data : [];
    const bannedIds = new Set(bans.map(b => b.user_id_banned));
    players.forEach(p => { p.is_banned = bannedIds.has(p.arma_id); });

    res.json({ players, playerCount });
  } catch (error) {
    console.error("K/D report error:", error.message);
    res.status(500).json({ error: "Failed to load K/D report." });
  }
});

// GET /admin/kills
router.get("/kills", async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const search = (req.query.search || "").trim();
  const sort = req.query.sort || "kills";
  const selectedArmaId = (req.query.arma_id || "").trim();
  const selectedUsername = (req.query.username || "").trim();
  let players = [];
  let killsError = false;
  let recentKills = [];
  let recentKillsError = false;

  try {
    if (search) {
      // Search for players by name
      const searchRes = await apiClient({
        method: "GET",
        url: "/user/searchUsersByUsername/",
        data: { search, token: config.apiToken },
      });
      const matches = searchRes.data?.users || searchRes.data?.data || searchRes.data;
      const matchList = Array.isArray(matches) ? matches : [];

      // Fetch detailed stats for each match (up to 20)
      const statsPromises = matchList.slice(0, 20).map(async (p) => {
        try {
          const statsRes = await apiClient({
            method: "GET",
            url: "/user/getPlayerStatsByIDCurrentSeason",
            data: { arma_id: p.arma_id, token: config.apiToken },
          });
          const s = statsRes.data || {};
          return {
            arma_id: p.arma_id,
            arma_username: s.arma_username || p.arma_username,
            kill_count: Number(s.kill_count) || 0,
            deaths: Number(s.deaths) || 0,
            kdRatio: s.kdRatio || "0.0",
            mostKilled: s.mostKilled || "-",
            mostKilledCount: Number(s.mostKilledCount) || 0,
            mostKilledBy: s.mostKilledBy || "-",
            mostKilledByCount: Number(s.mostKilledByCount) || 0,
            shots_fired: Number(s.shots_fired) || 0,
          };
        } catch {
          return {
            arma_id: p.arma_id,
            arma_username: p.arma_username,
            kill_count: 0, deaths: 0, kdRatio: "0.0",
            mostKilled: "-", mostKilledCount: 0,
            mostKilledBy: "-", mostKilledByCount: 0,
            shots_fired: 0,
          };
        }
      });
      players = await Promise.all(statsPromises);
    } else if (!selectedArmaId) {
      // Default: show top 10 leaderboard (only when no player selected)
      const lbRes = await apiClient.get("/user/topTenUserStats/", {
        params: { token: config.apiToken },
      });
      const lb = Array.isArray(lbRes.data) ? lbRes.data : [];

      // Fetch detailed stats + arma_id for each leaderboard entry
      const statsPromises = lb.slice(0, 10).map(async (p) => {
        try {
          const idRes = await apiClient({
            method: "GET",
            url: "/user/getPlayerIDsByName",
            data: { arma_username: p.arma_username, token: config.apiToken },
          });
          const ids = idRes.data;
          const arma_id = Array.isArray(ids) && ids.length > 0 ? ids[0] : "-";

          return {
            arma_id,
            arma_username: p.arma_username,
            kill_count: Number(p.kill_count) || 0,
            deaths: Number(p.deaths) || 0,
            kdRatio: p.kdRatio || "0.0",
            mostKilled: p.mostKilled || "-",
            mostKilledCount: Number(p.mostKilledCount) || 0,
            mostKilledBy: p.mostKilledBy || "-",
            mostKilledByCount: Number(p.mostKilledByCount) || 0,
            shots_fired: 0,
          };
        } catch {
          return {
            arma_id: "-",
            arma_username: p.arma_username,
            kill_count: Number(p.kill_count) || 0,
            deaths: Number(p.deaths) || 0,
            kdRatio: p.kdRatio || "0.0",
            mostKilled: p.mostKilled || "-",
            mostKilledCount: Number(p.mostKilledCount) || 0,
            mostKilledBy: p.mostKilledBy || "-",
            mostKilledByCount: Number(p.mostKilledByCount) || 0,
            shots_fired: 0,
          };
        }
      });
      players = await Promise.all(statsPromises);
    }

    // Sort
    if (sort === "kills") {
      players.sort((a, b) => b.kill_count - a.kill_count);
    } else if (sort === "deaths") {
      players.sort((a, b) => b.deaths - a.deaths);
    } else if (sort === "kd") {
      players.sort((a, b) => parseFloat(b.kdRatio) - parseFloat(a.kdRatio));
    } else if (sort === "id") {
      players.sort((a, b) => String(a.arma_id).localeCompare(String(b.arma_id)));
    }
  } catch (error) {
    console.error("Kill log error:", error.message);
    sendWebhookError("Kill Log Fetch", error.message);
    killsError = true;
  }

  // Fetch recent kills for selected player (7 days, paginated)
  let recentPlayer = null;
  const killPage = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 25;
  let totalIncidents = 0;
  let totalPages = 1;
  if (selectedArmaId) {
    try {
      const recentRes = await apiClient.get("/user/getRecentPlayerKillsByArmaId", {
        params: { token: config.apiToken, arma_id: selectedArmaId, rows: 500 },
      });
      const data = recentRes.data;
      let allIncidents = Array.isArray(data?.incidents) ? data.incidents : [];
      recentPlayer = data?.player || null;

      // Filter to last 7 days
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      allIncidents = allIncidents.filter((inc) => {
        return inc.time_stamp && new Date(inc.time_stamp).getTime() >= sevenDaysAgo;
      });

      totalIncidents = allIncidents.length;
      totalPages = Math.max(1, Math.ceil(totalIncidents / perPage));
      const offset = (killPage - 1) * perPage;
      recentKills = allIncidents.slice(offset, offset + perPage).map((inc) => ({
        ...inc,
        killer_arma_id: inc.killer_arma_id || inc.arma_id_killer || inc.killer_id || null,
        killed_arma_id: inc.killed_arma_id || inc.arma_id_death || inc.arma_id_killed || inc.killed_id || null,
      }));
    } catch (error) {
      console.error("[RecentKills] Error:", error.message);
      recentKillsError = true;
    }
  }

  res.render("admin-kills", {
    page: "admin",
    pageTitle: "Kill Log",
    pageDescription: "Admin kill stats viewer for Arma Wasteland server.",
    activeTab: "kills",
    user,
    players,
    killsError,
    playerCount: players.length,
    search,
    sort,
    selectedArmaId,
    selectedUsername: selectedUsername || (recentPlayer?.arma_username || ""),
    recentKills,
    recentKillsError,
    recentKillCount: totalIncidents,
    killPage,
    totalPages,
  });
});

// GET /admin/analytics
router.get("/analytics", async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);
  const atmDays = [30, 90, 180, 365].includes(parseInt(req.query.atmDays)) ? parseInt(req.query.atmDays) : 30;

  const stats = analytics.getStats();

  // Fetch Discord stats
  const discordStats = require("../discord-stats");
  const discord = await discordStats.getStats();
  const onlineHistory = discordStats.getOnlineHistory(7);
  const recentDepartures = discordStats.getRecentDepartures(30).map(d => {
    let durationLabel = "—";
    if (d.membership_days != null) {
      const days = d.membership_days;
      if (days >= 365) {
        const y = Math.floor(days / 365);
        const mo = Math.floor((days % 365) / 30);
        durationLabel = `${y}y ${mo}mo`;
      } else if (days >= 30) {
        const mo = Math.floor(days / 30);
        const rem = days % 30;
        durationLabel = `${mo}mo ${rem}d`;
      } else {
        durationLabel = `${days}d`;
      }
    }
    return { ...d, durationLabel, durationColor: d.membership_days == null ? "var(--text-secondary)" : d.membership_days >= 365 ? "#22c55e" : d.membership_days >= 30 ? "#fbbf24" : "#ef4444" };
  });

  // Store stats and audit log (admin only)
  const storeStats = user.isAdmin ? store.getStoreStats() : null;
  const auditEntries = user.isAdmin ? (auditLog.getEntries({ limit: 50 }) || []) : null;
  const auditStats = user.isAdmin ? (auditLog.getStats() || { total: 0, today: 0, byCat: [], byAdmin: [] }) : null;

  res.render("admin-analytics", {
    page: "admin",
    pageTitle: "Analytics",
    pageDescription: "Site analytics dashboard.",
    activeTab: "analytics",
    user,
    ...stats,
    dailyViewsJson: JSON.stringify(stats.dailyViews),
    discord,
    discordJson: JSON.stringify(discord || {}),
    onlineHistoryJson: JSON.stringify(onlineHistory || []),
    recentDepartures,
    storeStats,
    storeStatsJson: JSON.stringify(storeStats || {}),
    auditEntries,
    auditStats,
    blockedIPs: user.isAdmin ? ipBlock.getAll() : [],
    ipBlockStats: user.isAdmin ? ipBlock.getStats() : { total: 0, today: 0 },
    ctaStats: user.isAdmin ? analytics.getCtaStats() : [],
    ctaRecent: user.isAdmin ? analytics.getCtaRecent(20) : [],
    visitors: user.isAdmin ? analytics.getVisitors({ limit: 200, since: Date.now() - 30 * 86400000 }) : [],
    countryStats: user.isAdmin ? analytics.getCountryStats({ since: Date.now() - 30 * 86400000 }) : [],
    flaggedVisitorCount: user.isAdmin ? analytics.getFlaggedVisitorCount({ since: Date.now() - 30 * 86400000 }) : 0,
    flaggedCountries: analytics.FLAGGED_COUNTRIES,
    economyStats: user.isAdmin ? economyTracker.getStats(atmDays) : null,
    economyHistoryJson: JSON.stringify(user.isAdmin && economyTracker.getStats(atmDays) ? economyTracker.getStats(atmDays).dailyHistory : []),
    atmDays,
    cashRollup: user.isAdmin ? await fetchCashRollup() : null,
    featureFlags: user.isAdmin ? require("../feature-flags").getAll() : null,
    outfitStats: user.isAdmin ? await (async () => {
      try {
        const o = require("../outfits");
        const raw = await o.getAllOutfits();
        const all = Array.isArray(raw) ? raw : (Array.isArray(raw?.outfits) ? raw.outfits : []);
        const lbRaw = await o.getOutfitLeaderboard(10);
        const leaderboard = Array.isArray(lbRaw) ? lbRaw : (Array.isArray(lbRaw?.outfits) ? lbRaw.outfits : []);
        return { total: all.length, totalMembers: all.reduce((s, x) => s + (x.member_count || 0), 0), leaderboard };
      } catch (e) { console.error("outfitStats error:", e.message); return { total: 0, totalMembers: 0, leaderboard: [], apiError: e.message }; }
    })() : null,
    playtimeLeaderboard: user.isAdmin ? await (async () => {
      try {
        const res = await apiClient.get("/user/getTopPlayersByPlaytime", { params: { limit: 50, token: config.apiToken } });
        const raw = res.data?.players || [];
        const players = raw.map(p => {
          const mins = Number(p.arma_time_played || 0);
          const hrs = Math.floor(mins / 60);
          const m = mins % 60;
          return { ...p, hoursLabel: hrs > 0 ? `${hrs.toLocaleString()}h ${m}m` : `${m}m` };
        });
        const top = players[0];
        return {
          players,
          topUsername: top?.arma_username || "—",
          topHours: top ? Math.floor((top.arma_time_played || 0) / 60).toLocaleString() : 0,
        };
      } catch (e) {
        const msg = e.response?.status === 404 ? "Endpoint not implemented on game server" : e.message;
        return { players: [], error: msg };
      }
    })() : null,
    rulesStats: user.isAdmin ? (() => {
      try {
        const rulesAck = require("../rules-ack");
        return rulesAck.getStats();
      } catch (e) { console.error("rulesStats error:", e.message); return { totalPosts: 0, totalYes: 0, totalNo: 0, uniqueAckers: 0 }; }
    })() : null,
    rulesAcks: user.isAdmin ? (() => {
      try {
        const rulesAck = require("../rules-ack");
        return rulesAck.getAllAcks();
      } catch (e) { console.error("rulesAcks error:", e.message); return []; }
    })() : null,
    pollStats: user.isAdmin ? (() => {
      try {
        const polls = require("../poll");
        return polls.getStats();
      } catch (e) { console.error("pollStats error:", e.message); return { open: 0, closed: 0, totalVotes: 0 }; }
    })() : null,
    polls: user.isAdmin ? await (async () => {
      try {
        const polls = require("../poll");
        const { getGuildJoinDates } = require("../discord-bot");
        const recent = polls.getRecentPolls(20);

        // Collect all unique voter discord_ids across polls
        const allIds = new Set();
        const pollData = recent.map(p => {
          const votes = polls.getVotes(p.id);
          votes.forEach(v => allIds.add(v.discord_id));
          return { ...p, tally: polls.getTally(p.id), votes };
        });

        // Fetch guild join dates once for all voters
        let joinMap = new Map();
        try { joinMap = await getGuildJoinDates([...allIds]); } catch (e) { console.warn("getGuildJoinDates failed:", e.message); }

        // Attach to each vote
        for (const p of pollData) {
          p.votes = p.votes.map(v => ({ ...v, guild_joined_at: joinMap.get(v.discord_id) || null }));
        }
        return pollData;
      } catch (e) { console.error("polls error:", e.message); return []; }
    })() : null,
    coinStats: user.isAdmin ? (() => {
      try {
        const circ = wastedCoins.getCirculation();
        const flow24 = wastedCoins.getFlow(24 * 3600 * 1000);
        const flow7d = wastedCoins.getFlow(7 * 24 * 3600 * 1000);
        const top10 = wastedCoins.getLeaderboard(10);
        const recent = wastedCoins.getRecentTransactions(null, 25).map(t => {
          try { t.metaParsed = t.meta ? JSON.parse(t.meta) : null; } catch { t.metaParsed = null; }
          return t;
        });
        return { circ, flow24, flow7d, top10, recent };
      } catch (e) { console.error("coinStats error:", e.message); return null; }
    })() : null,
  });
});

async function fetchCashRollup() {
  try {
    const res = await adminApiClient.get("/admin/cash-rollup", { params: { token: config.adminApiToken } });
    return res.data || null;
  } catch { return null; }
}

// Build the full watchlist page data: VAC flagged + all watchlisted players
async function enrichVacFlagged() {
  const flagged = vacScanner.getFlagged();

  // Fetch all server bans
  const serverBans = new Set();
  try {
    const bansRes = await apiClient({ method: "GET", url: "/user/getAllUserBans/", data: { token: config.apiToken } });
    const bans = bansRes.data?.bans || bansRes.data?.data || bansRes.data || [];
    if (Array.isArray(bans)) {
      for (const b of bans) {
        if (b.user_id_banned) serverBans.add(b.user_id_banned);
      }
    }
  } catch {}

  // Build map of VAC-flagged by arma_id
  const vacMap = new Map();
  for (const p of flagged) {
    if (p.arma_id) vacMap.set(p.arma_id, p);
  }

  // Get ALL watchlisted players from backend — check each flagged player + search for more
  const allPlayers = new Map(); // arma_id -> enriched player

  // 1. Add all VAC-flagged players
  for (const player of flagged) {
    if (!player.arma_id || serverBans.has(player.arma_id)) continue;

    let isWatchlisted = false;
    try {
      const wlRes = await adminApiClient.get("/admin/watchlist", { params: { token: config.adminApiToken, arma_id: player.arma_id } });
      isWatchlisted = !!wlRes.data?.is_watchlisted;
    } catch {}

    allPlayers.set(player.arma_id, {
      ...player,
      displayName: player.arma_username || player.discord_username || "Unknown",
      isServerBanned: false,
      isWatchlisted,
      source: "vac",
    });
  }

  // 2. Find watchlisted players who aren't VAC-flagged by checking all known users
  // Use the VAC scan DB to find watchlisted players (they were added by the scanner)
  const allScanned = vacScanner.getAll();
  const BATCH = 20;
  const toCheck = allScanned.filter(p => p.arma_id && !allPlayers.has(p.arma_id) && !serverBans.has(p.arma_id));

  for (let i = 0; i < toCheck.length; i += BATCH) {
    const batch = toCheck.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async (player) => {
      try {
        const wlRes = await adminApiClient.get("/admin/watchlist", { params: { token: config.adminApiToken, arma_id: player.arma_id } });
        if (wlRes.data?.is_watchlisted) {
          allPlayers.set(player.arma_id, {
            ...player,
            displayName: player.arma_username || player.discord_username || "Unknown",
            isServerBanned: false,
            isWatchlisted: true,
            source: "watchlist",
          });
        }
      } catch {}
    }));
  }

  // Sort: watchlisted first, then by scanned_at desc
  return [...allPlayers.values()].sort((a, b) => {
    if (a.isWatchlisted !== b.isWatchlisted) return a.isWatchlisted ? -1 : 1;
    return (b.scanned_at || "").localeCompare(a.scanned_at || "");
  });
}

// Blog-admin middleware
function requireBlogAdmin(req, res, next) {
  if (!req.session.user.isBlogAdmin) {
    console.warn(`Unauthorized blog-admin access by ${req.session.user.username} (${req.session.user.discord_id})`);
    sendWebhookError("Unauthorized Blog-Admin Access", `**${req.session.user.username}** (${req.session.user.discord_id}) tried to access ${req.originalUrl}`);
    return res.redirect("/admin/analytics");
  }
  next();
}

// GET /admin/blog — list all posts
router.get("/blog", requireBlogAdmin, (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const posts = blog.getPosts(false);

  res.render("admin-blog", {
    page: "admin",
    pageTitle: "Blog Management",
    pageDescription: "Manage blog posts.",
    activeTab: "blog",
    user,
    posts,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// GET /admin/blog/new — create form
router.get("/blog/new", requireBlogAdmin, (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  res.render("admin-blog-edit", {
    page: "admin",
    pageTitle: "New Post",
    pageDescription: "Create a new blog post.",
    activeTab: "blog",
    user,
    post: null,
    isNew: true,
  });
});

// POST /admin/blog — create post
router.post("/blog", requireBlogAdmin, (req, res) => {
  const { title, description, content, tags, published } = req.body;
  const user = req.session.user;

  if (!title || !content) {
    return res.redirect("/admin/blog/new?error=Title and content are required.");
  }

  blog.createPost({
    title,
    description: description || "",
    content,
    tags: tags || "",
    author: user.username,
    authorId: user.discord_id,
    published: published === "on",
  });

  res.redirect("/admin/blog?success=Post created.");
});

// GET /admin/blog/edit/:id — edit form
router.get("/blog/edit/:id", requireBlogAdmin, (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const post = blog.getPostById(req.params.id);
  if (!post) {
    return res.redirect("/admin/blog?error=Post not found.");
  }

  res.render("admin-blog-edit", {
    page: "admin",
    pageTitle: "Edit Post",
    pageDescription: "Edit blog post.",
    activeTab: "blog",
    user,
    post,
    isNew: false,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// POST /admin/blog/edit/:id — update post
router.post("/blog/edit/:id", requireBlogAdmin, (req, res) => {
  const { title, description, content, tags, published } = req.body;

  if (!title || !content) {
    return res.redirect(`/admin/blog/edit/${req.params.id}?error=Title and content are required.`);
  }

  const updated = blog.updatePost(req.params.id, {
    title,
    description: description || "",
    content,
    tags: tags || "",
    published: published === "on",
  });

  if (!updated) {
    return res.redirect("/admin/blog?error=Post not found.");
  }

  res.redirect("/admin/blog?success=Post updated.");
});

// POST /admin/blog/delete/:id — delete post
router.post("/blog/delete/:id", requireBlogAdmin, (req, res) => {
  const deleted = blog.deletePost(req.params.id);
  if (!deleted) {
    return res.redirect("/admin/blog?error=Post not found.");
  }
  res.redirect("/admin/blog?success=Post deleted.");
});

// GET /admin/servers — server status dashboard (ArmaHQ + AMP)
router.get("/servers", async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  let servers = [];
  let serversError = false;
  let backendHealth = null;

  // Check backend API health
  try {
    const healthRes = await adminApiClient.get("/admin/health/ping", {
      params: { token: config.adminApiToken },
      timeout: 5000,
    });
    backendHealth = healthRes.data?.success ? "online" : "offline";
  } catch {
    backendHealth = "offline";
  }

  try {
    const [ampStatus, ahqStatus] = await Promise.all([
      amp.getFreshStatus(),
      bm.getFreshStatus(),
    ]);

    // Build server list from ArmaHQ data, overlay AMP CPU/memory
    const wastelandInstances = ampStatus.instances.filter(i =>
      i.running && i.appState >= 5 && i.friendlyName.toLowerCase().includes("wasteland")
    );

    servers = ahqStatus.servers.map((srv, i) => {
      const ampInst = wastelandInstances[i] || null;
      return {
        label: srv.label,
        name: srv.name,
        players: srv.players,
        maxPlayers: srv.maxPlayers,
        queue: srv.queue || 0,
        peak: srv.peak || 0,
        status: srv.status,
        cpu: ampInst ? ampInst.cpu : { value: 0, max: 100, percent: 0, units: "%" },
        memory: ampInst ? ampInst.memory : { value: 0, max: 0, percent: 0, units: "MB" },
        instanceId: ampInst ? ampInst.instanceId : null,
        instanceName: ampInst ? ampInst.instanceName : "",
        ampVersion: ampInst ? ampInst.ampVersion : "",
      };
    });
    // Record metrics for history charts
    const wasteland = ampStatus.instances.filter(i =>
      i.running && i.appState >= 5 && i.friendlyName.toLowerCase().includes("wasteland")
    );
    for (let i = 0; i < ahqStatus.servers.length && i < wasteland.length; i++) {
      const srv = ahqStatus.servers[i];
      wasteland[i].players.current = srv.players;
      wasteland[i].players.max = srv.maxPlayers;
      wasteland[i].players.percent = srv.maxPlayers ? Math.round((srv.players / srv.maxPlayers) * 100) : 0;
    }
    metricsHistory.record(wasteland, ahqStatus.servers);
  } catch (err) {
    console.error("Admin servers error:", err.message);
    serversError = true;
  }

  const totalPlayers = servers.reduce((sum, s) => sum + s.players, 0);
  const totalMax = servers.reduce((sum, s) => sum + s.maxPlayers, 0);
  const totalQueue = servers.reduce((sum, s) => sum + s.queue, 0);

  res.render("admin-servers", {
    page: "admin",
    pageTitle: "Servers",
    pageDescription: "Live server performance metrics.",
    activeTab: "servers",
    user,
    servers,
    totalPlayers,
    totalMax,
    totalQueue,
    serverCount: servers.length,
    fetchedAt: new Date().toISOString(),
    serversError,
    backendHealth,
    chartDataJson: JSON.stringify(metricsHistory.getHistory(6)).replace(/</g, "\\u003c"),
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// GET /admin/servers/history — JSON endpoint for chart time range
router.get("/servers/history", (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours) || 6, 1), 720);
  res.json(metricsHistory.getHistory(hours));
});

// POST /admin/servers/restart/:instanceId — restart a game server via AMP
router.post("/servers/restart/:instanceId", requireWriteAdmin, async (req, res) => {
  const instanceId = req.params.instanceId;
  const user = req.session.user;

  console.log(`Server restart requested by ${user.username} for instance ${instanceId}`);

  try {
    await amp.restartInstance(instanceId);
    auditLog.log("servers", "Game Server Restarted", `Instance: ${instanceId}`, user);

    sendWebhook({
      title: "Game Server Restarted",
      description: `<@${user.discord_id}> restarted server instance \`${instanceId}\``,
      color: 0xF59E0B,
    });

    res.redirect("/admin/servers?success=" + encodeURIComponent("Restart command sent. Server is restarting."));
  } catch (error) {
    console.error("Server restart error:", error.message);
    sendWebhookError("Server Restart", error.message);
    res.redirect("/admin/servers?error=" + encodeURIComponent("Restart failed: " + error.message));
  }
});

// Recursively calculate directory size + per-player breakdown, split into images/videos
function getAttachmentStorage() {
  const out = { totalBytes: 0, imageBytes: 0, videoBytes: 0, fileCount: 0, imageCount: 0, videoCount: 0, players: [], topPlayers: [] };
  if (!fs.existsSync(NOTE_UPLOAD_DIR)) return out;

  const playerDirs = fs.readdirSync(NOTE_UPLOAD_DIR);
  for (const armaId of playerDirs) {
    const playerDir = path.join(NOTE_UPLOAD_DIR, armaId);
    if (!fs.statSync(playerDir).isDirectory()) continue;
    let playerBytes = 0;
    let playerImageBytes = 0;
    let playerVideoBytes = 0;
    let playerFileCount = 0;
    for (const file of fs.readdirSync(playerDir)) {
      const fp = path.join(playerDir, file);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        const sz = st.size;
        playerBytes += sz;
        playerFileCount++;
        out.totalBytes += sz;
        out.fileCount++;
        if (VIDEO_EXT.test(file)) {
          playerVideoBytes += sz;
          out.videoBytes += sz;
          out.videoCount++;
        } else if (IMAGE_EXT.test(file)) {
          playerImageBytes += sz;
          out.imageBytes += sz;
          out.imageCount++;
        }
      } catch {}
    }
    if (playerBytes > 0) {
      out.players.push({ arma_id: armaId, bytes: playerBytes, imageBytes: playerImageBytes, videoBytes: playerVideoBytes, fileCount: playerFileCount });
    }
  }
  out.topPlayers = out.players.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  return out;
}

// GET /admin/system — VPS health dashboard
router.get("/system", (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const stats = systemStats.getStats();
  const attachments = getAttachmentStorage();

  // Warning thresholds
  const WARN_VIDEO_GB = 50;   // warn if video storage crosses 50 GB
  const CRIT_VIDEO_GB = 200;  // critical at 200 GB
  const WARN_DISK_PCT = 75;   // warn if overall disk usage > 75%
  const CRIT_DISK_PCT = 90;   // critical at 90%

  const videoGB = attachments.videoBytes / (1024 ** 3);
  const diskPct = stats.disk?.usagePercent || 0;
  const diskWarning = (
    diskPct >= CRIT_DISK_PCT ? { level: "critical", msg: `Disk usage at ${diskPct}% — free up space immediately.` } :
    diskPct >= WARN_DISK_PCT ? { level: "warning", msg: `Disk usage at ${diskPct}% — consider cleanup.` } :
    videoGB >= CRIT_VIDEO_GB ? { level: "critical", msg: `Video evidence storage at ${videoGB.toFixed(1)} GB. Review old clips.` } :
    videoGB >= WARN_VIDEO_GB ? { level: "warning", msg: `Video evidence storage at ${videoGB.toFixed(1)} GB — monitor growth.` } :
    null
  );

  res.render("admin-system", {
    page: "admin",
    pageTitle: "System",
    pageDescription: "VPS health and system metrics.",
    activeTab: "system",
    user,
    ...stats,
    attachments,
    diskWarning,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// SSH helper — run a command on the remote server
function sshExec(command) {
  const { Client } = require("ssh2");
  const fs = require("fs");

  return new Promise((resolve, reject) => {
    if (!config.ssh.host || !config.ssh.username || !config.ssh.privateKeyPath) {
      return reject(new Error("SSH not configured. Set SSH_HOST, SSH_USERNAME, and SSH_PRIVATE_KEY_PATH in .env"));
    }

    const conn = new Client();
    let stdout = "";
    let stderr = "";

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        stream.on("data", (data) => { stdout += data.toString(); });
        stream.stderr.on("data", (data) => { stderr += data.toString(); });
        stream.on("close", (code) => {
          conn.end();
          if (code !== 0) {
            return reject(new Error(stderr || `Command exited with code ${code}`));
          }
          resolve(stdout);
        });
      });
    });

    conn.on("error", (err) => reject(err));

    conn.connect({
      host: config.ssh.host,
      port: config.ssh.port,
      username: config.ssh.username,
      privateKey: fs.readFileSync(config.ssh.privateKeyPath),
    });
  });
}

// POST /admin/system/restart-pm2 — restart PM2 via SSH
router.post("/system/restart-pm2", async (req, res) => {
  const user = req.session.user;
  const pm2App = config.ssh.pm2AppName;

  try {
    const output = await sshExec(`npx pm2 restart ${pm2App}`);
    console.log("PM2 restart output:", output);
    auditLog.log("servers", "PM2 Restarted", `App: ${pm2App}`, user);

    sendWebhook({
      title: "PM2 Restarted",
      description: `<@${user.discord_id}> restarted \`${pm2App}\` via SSH.`,
      color: 0xF59E0B,
    });

    res.redirect("/admin/system?success=" + encodeURIComponent(`PM2 process "${pm2App}" restarted successfully.`));
  } catch (err) {
    console.error("PM2 restart error:", err.message);
    sendWebhookError("PM2 Restart", err.message);
    res.redirect("/admin/system?error=" + encodeURIComponent("PM2 restart failed. Check server logs for details."));
  }
});

// POST /admin/system/deploy — full deploy via deploy.sh
router.post("/system/deploy", async (req, res) => {
  const user = req.session.user;
  const { exec } = require("child_process");
  const path = require("path");

  try {
    const output = await new Promise((resolve, reject) => {
      exec("bash scripts/deploy.sh", {
        cwd: path.resolve(__dirname, "../.."),
        timeout: 120000,
      }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || stdout || err.message));
        resolve(stdout);
      });
    });

    console.log("Deploy output:", output);
    auditLog.log("servers", "Deployed via SSH", `App: ${config.ssh.pm2AppName}`, user);

    sendWebhook({
      title: "Deployed via SSH",
      description: `<@${user.discord_id}> deployed latest changes to production and restarted \`${config.ssh.pm2AppName}\`.`,
      color: 0x22c55e,
    });

    res.redirect("/admin/system?success=" + encodeURIComponent("Deploy completed successfully. Changes are live."));
  } catch (err) {
    console.error("Deploy error:", err.message);
    sendWebhookError("Deploy", err.message);
    res.redirect("/admin/system?error=" + encodeURIComponent("Deploy failed. Check server logs for details."));
  }
});

// ── Store Management ──

// GET /admin/store
router.get("/store", requireWriteAdmin, (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const products = store.getAllProducts().map(p => ({
    ...p,
    priceDisplay: (p.price / 100).toFixed(2),
    salePriceDisplay: p.sale_price ? (p.sale_price / 100).toFixed(2) : "",
  }));
  const categories = store.getAllCategories();
  const profileItems = profileCustomizations.getAllItems().map(i => ({
    ...i,
    priceDisplay: (i.price / 100).toFixed(2),
    syncedToStripe: !!i.stripe_price_id,
  }));

  res.render("admin-store", {
    page: "admin",
    pageTitle: "Store Management",
    pageDescription: "Manage store products and pricing.",
    activeTab: "store",
    user,
    products,
    categories,
    profileItems,
    profileItemTypes: profileCustomizations.TYPES,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// POST /admin/store — create product
router.post("/store", requireWriteAdmin, storeUpload.single("image_file"), async (req, res) => {
  const { name, description, price, sale_price, image, category, badge, sort_order } = req.body;

  if (!name || !price) {
    return res.redirect("/admin/store?error=Name and price are required.");
  }

  let imagePath = image || null;
  if (req.file) {
    try {
      imagePath = await saveStoreImage(req.file);
    } catch (err) {
      console.error("Image upload error:", err.message);
      return res.redirect("/admin/store?error=" + encodeURIComponent("Image upload failed: " + err.message));
    }
  }

  store.createProduct({
    name,
    description: description || "",
    price: Math.round(parseFloat(price) * 100),
    sale_price: sale_price ? Math.round(parseFloat(sale_price) * 100) : null,
    image: imagePath,
    category: category || "loadout",
    badge: badge || null,
    sort_order: parseInt(sort_order) || 0,
  });

  auditLog.log("store", "Product Added", `${name} ($${price}) in ${category}`, req.session.user);
  res.redirect("/admin/store?success=" + encodeURIComponent(`"${name}" added to store.`));
});

// POST /admin/store/edit/:id — update product
router.post("/store/edit/:id", requireWriteAdmin, storeUpload.single("image_file"), async (req, res) => {
  const id = parseInt(req.params.id);
  const product = store.getProductById(id);
  if (!product) {
    return res.redirect("/admin/store?error=Product not found.");
  }

  const { name, description, price, sale_price, image, category, active, badge, sort_order } = req.body;

  let imagePath = image || product.image || null;
  if (req.file) {
    try {
      imagePath = await saveStoreImage(req.file);
    } catch (err) {
      console.error("Image upload error:", err.message);
      return res.redirect("/admin/store?error=" + encodeURIComponent("Image upload failed: " + err.message));
    }
  }

  store.updateProduct(id, {
    name: name || product.name,
    description: description || "",
    price: Math.round(parseFloat(price) * 100),
    sale_price: sale_price ? Math.round(parseFloat(sale_price) * 100) : null,
    image: imagePath,
    category: category || product.category,
    active: parseInt(active),
    badge: badge || null,
    sort_order: parseInt(sort_order) || 0,
  });

  auditLog.log("store", "Product Updated", `${name}${sale_price ? " (sale: $" + sale_price + ")" : ""}`, req.session.user);
  res.redirect("/admin/store?success=" + encodeURIComponent(`"${name}" updated.`));
});

// POST /admin/store/delete/:id — delete product
router.post("/store/delete/:id", requireWriteAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const product = store.getProductById(id);
  if (!product) {
    return res.redirect("/admin/store?error=Product not found.");
  }

  store.deleteProduct(id);
  auditLog.log("store", "Product Deleted", product.name, req.session.user);
  res.redirect("/admin/store?success=" + encodeURIComponent(`"${product.name}" deleted.`));
});

// POST /admin/store/category — create category
router.post("/store/category", requireWriteAdmin, (req, res) => {
  const { slug, label, description, sort_order } = req.body;
  if (!slug || !label) {
    return res.redirect("/admin/store?error=Slug and label are required.");
  }
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  try {
    store.createCategory({ slug: cleanSlug, label, description: description || "", sort_order: parseInt(sort_order) || 0 });
    auditLog.log("store", "Category Created", `${label} (${cleanSlug})`, req.session.user);
    res.redirect("/admin/store?success=" + encodeURIComponent(`Category "${label}" created.`));
  } catch (err) {
    res.redirect("/admin/store?error=" + encodeURIComponent("Failed to create category: " + err.message));
  }
});

// POST /admin/store/category/edit/:id — update category
router.post("/store/category/edit/:id", requireWriteAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const cat = store.getCategoryById(id);
  if (!cat) return res.redirect("/admin/store?error=Category not found.");

  const { slug, label, description, sort_order } = req.body;
  const cleanSlug = (slug || cat.slug).toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // Update products that used the old slug
  if (cleanSlug !== cat.slug) {
    const products = store.getAllProducts().filter(p => p.category === cat.slug);
    for (const p of products) {
      store.updateProduct(p.id, { ...p, category: cleanSlug });
    }
  }

  store.updateCategory(id, { slug: cleanSlug, label: label || cat.label, description: description || "", sort_order: parseInt(sort_order) || 0 });
  auditLog.log("store", "Category Updated", `${label}`, req.session.user);
  res.redirect("/admin/store?success=" + encodeURIComponent(`Category "${label}" updated.`));
});

// POST /admin/store/category/delete/:id — delete category
router.post("/store/category/delete/:id", requireWriteAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const cat = store.getCategoryById(id);
  if (!cat) return res.redirect("/admin/store?error=Category not found.");
  store.deleteCategory(id);
  auditLog.log("store", "Category Deleted", cat.label, req.session.user);
  res.redirect("/admin/store?success=" + encodeURIComponent(`Category "${cat.label}" deleted.`));
});

// POST /admin/store/sync-stripe — sync all products + profile items to Stripe
router.post("/store/sync-stripe", requireWriteAdmin, async (req, res) => {
  try {
    const storeResult = await store.syncToStripe();
    const profileResult = await profileCustomizations.syncToStripe();
    const totalSynced = (storeResult.synced || 0) + (profileResult.synced || 0);
    const totalCount = (storeResult.total || 0) + (profileResult.total || 0);
    const allErrors = [
      ...(storeResult.errors || []).map(e => e.product || e),
      ...(profileResult.errors || []).map(e => e.item || e),
    ];
    auditLog.log("store", "Stripe Sync", `Synced ${totalSynced}/${totalCount} (store + profile items)${allErrors.length ? ", " + allErrors.length + " errors" : ""}`, req.session.user);
    if (allErrors.length) {
      res.redirect("/admin/store?error=" + encodeURIComponent(`Synced ${totalSynced}/${totalCount}. Errors: ${allErrors.join(", ")}`));
    } else {
      res.redirect("/admin/store?success=" + encodeURIComponent(`All ${totalSynced} items synced to Stripe (${storeResult.synced} products, ${profileResult.synced} profile items).`));
    }
  } catch (err) {
    console.error("Stripe sync error:", err.message);
    res.redirect("/admin/store?error=" + encodeURIComponent("Stripe sync failed: " + err.message));
  }
});

// POST /admin/store/sync-production — push store data to production server
router.post("/store/sync-production", requireWriteAdmin, async (req, res) => {
  if (!config.productionSyncUrl) {
    return res.redirect("/admin/store?error=" + encodeURIComponent("PRODUCTION_SYNC_URL not configured."));
  }

  try {
    const products = store.getAllProducts();
    const categories = store.getAllCategories();
    const drawPool = skinDraw.getAllPool();

    const response = await axios.post(`${config.productionSyncUrl}/api/store-sync`, {
      products: products.map(p => ({
        name: p.name, description: p.description, price: p.price,
        sale_price: p.sale_price, image: p.image, category: p.category,
        active: p.active, badge: p.badge, sort_order: p.sort_order,
      })),
      categories: categories.map(c => ({
        slug: c.slug, label: c.label, description: c.description,
        sort_order: c.sort_order,
      })),
      drawPool: drawPool.map(d => ({
        name: d.name, skin_key: d.skin_key, rarity: d.rarity,
        weight: d.weight, image: d.image, active: d.active,
      })),
    }, {
      params: { token: config.apiToken },
      timeout: 30000,
      headers: { "Content-Type": "application/json" },
    });

    const s = response.data.summary || {};
    auditLog.log("store", "Synced to Production", `Products: ${products.length}, Categories: ${categories.length}, Draw Pool: ${drawPool.length}`, req.session.user);
    res.redirect("/admin/store?success=" + encodeURIComponent(`Synced to production — ${products.length} products, ${categories.length} categories, ${drawPool.length} draw pool items.`));
  } catch (err) {
    console.error("Production sync error:", err.message);
    const msg = err.response?.data?.error || err.message;
    res.redirect("/admin/store?error=" + encodeURIComponent("Sync failed: " + msg));
  }
});

// ── VAC Scanner ──

router.post("/vac/scan", requireWriteAdmin, async (req, res) => {
  try {
    const full = req.body.full === "1";
    const result = await vacScanner.scan({ full });
    const wlResult = await vacScanner.autoWatchlist();
    auditLog.log("security", "VAC Scan", `Scanned ${result.scanned} players, ${result.flagged} flagged, ${wlResult.count} watchlisted, ${wlResult.flaggedOnly || 0} flagged (old bans)`, req.session.user);

    const playerList = wlResult.players.slice(0, 10).map(p =>
      `• **${p.arma_username || "Unknown"}** — [Steam](https://steamcommunity.com/profiles/${p.steam_id}) | [Profile](${config.siteUrl}/admin/player/${p.arma_id})`
    ).join("\n");
    const extra = wlResult.count > 10 ? `\n...and ${wlResult.count - 10} more` : "";
    const flaggedNote = wlResult.flaggedOnly ? `, ${wlResult.flaggedOnly} flagged (old bans, not watchlisted)` : "";
    const msg = `VAC scan complete: ${result.scanned} new, ${result.skipped} skipped, ${result.flagged} flagged, ${wlResult.count} auto-watchlisted${flaggedNote}.`;
    sendVacWebhook({ title: "VAC Scan Complete", description: `${msg}${wlResult.count > 0 ? "\n\n" + playerList + extra : ""}`, color: result.flagged > 0 ? 0xef4444 : 0x22c55e });
    res.redirect("/admin/watchlist?success=" + encodeURIComponent(msg) + "&tab=vac");
  } catch (err) {
    console.error("VAC scan error:", err.message);
    res.redirect("/admin/watchlist?error=" + encodeURIComponent("VAC scan failed: " + err.message) + "&tab=vac");
  }
});

router.post("/vac/watchlist-all", requireWriteAdmin, async (req, res) => {
  try {
    const wlResult = await vacScanner.autoWatchlist();
    auditLog.log("security", "VAC Watchlist All", `${wlResult.count} players auto-watchlisted`, req.session.user);
    res.redirect("/admin/watchlist?success=" + encodeURIComponent(`${wlResult.count} VAC-banned players added to watchlist.`) + "&tab=vac");
  } catch (err) {
    console.error("VAC watchlist-all error:", err.message);
    res.redirect("/admin/watchlist?error=" + encodeURIComponent("Failed: " + err.message) + "&tab=vac");
  }
});

// ── ATM: Parse Channel History ──

router.post("/atm/parse", requireWriteAdmin, async (req, res) => {
  try {
    const { backfill } = require("../atm-backfill");
    const result = await backfill(economyTracker, 50);
    auditLog.log("economy", "ATM Parse", `Parsed ${result.parsed} transactions from ${result.total} messages`, req.session.user);
    res.redirect("/admin/analytics?success=" + encodeURIComponent(`Parsed ${result.parsed} ATM transactions from Discord.`) + "&tab=atm");
  } catch (err) {
    console.error("ATM parse error:", err.message);
    res.redirect("/admin/analytics?error=" + encodeURIComponent("ATM parse failed: " + err.message) + "&tab=atm");
  }
});

// ── Security: IP Block ──

router.post("/security/block", requireWriteAdmin, (req, res) => {
  const { ip, reason, duration } = req.body;
  if (!ip || !reason) {
    return res.redirect("/admin/analytics?error=" + encodeURIComponent("IP and reason are required."));
  }
  ipBlock.block(ip.trim(), reason.trim(), parseInt(duration) || 86400000);
  auditLog.log("security", "IP Blocked", `${ip.trim()} — ${reason.trim()}`, req.session.user);
  res.redirect("/admin/analytics?success=" + encodeURIComponent(`Blocked ${ip.trim()}.`));
});

router.post("/security/unblock", requireWriteAdmin, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.redirect("/admin/analytics");
  ipBlock.unblock(ip.trim());
  auditLog.log("security", "IP Unblocked", ip.trim(), req.session.user);
  res.redirect("/admin/analytics?success=" + encodeURIComponent(`Unblocked ${ip.trim()}.`));
});

// ── Task Board ──

router.get("/tasks", (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);
  const allTasks = tasks.getAll();
  res.render("admin-tasks", {
    page: "admin",
    pageTitle: "Task Board",
    activeTab: "tasks",
    user,
    notStarted: allTasks.filter(t => t.status === "not_started"),
    inProgress: allTasks.filter(t => t.status === "in_progress"),
    blocked: allTasks.filter(t => t.status === "blocked"),
    completed: allTasks.filter(t => t.status === "completed"),
    stats: tasks.getStats(),
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

router.post("/tasks", (req, res) => {
  const { title, description, type, priority, assigned_to, link } = req.body;
  if (!title || !title.trim()) {
    return res.redirect("/admin/tasks?error=" + encodeURIComponent("Title is required."));
  }
  tasks.create({
    title: title.trim(),
    description: (description || "").trim(),
    type: type || "bug",
    priority: priority || "normal",
    created_by: req.session.user.username,
    created_by_discord_id: req.session.user.discord_id || null,
    assigned_to: (assigned_to || "").trim() || null,
    link: (link || "").trim() || null,
  });
  auditLog.log("tasks", "Task Created", title.trim(), req.session.user);
  sendWebhook({
    title: "Task Created",
    description: `**${title.trim()}**\nType: ${type || "bug"} | Priority: ${priority || "normal"}\nCreated by: ${req.session.user.username}${description ? "\n" + description.trim() : ""}`,
    color: 0x5865F2,
  });
  res.redirect("/admin/tasks?success=" + encodeURIComponent(`Task "${title.trim()}" created.`));
});

router.post("/tasks/:id/status", (req, res) => {
  const { status } = req.body;
  const validStatuses = ["not_started", "in_progress", "blocked", "completed"];
  if (!validStatuses.includes(status)) {
    return res.redirect("/admin/tasks?error=" + encodeURIComponent("Invalid status."));
  }
  const task = tasks.getById(req.params.id);
  if (!task) return res.redirect("/admin/tasks?error=" + encodeURIComponent("Task not found."));
  tasks.updateStatus(req.params.id, status);
  auditLog.log("tasks", "Task Status Changed", `"${task.title}" → ${status}`, req.session.user);
  const statusLabels = { not_started: "Not Started", in_progress: "In Progress", blocked: "Blocked", completed: "Completed" };
  const statusColors = { not_started: 0x6b7280, in_progress: 0x3b82f6, blocked: 0xef4444, completed: 0x22c55e };
  sendWebhook({
    title: "Task Updated",
    description: `**${task.title}**\n${statusLabels[task.status] || task.status} → **${statusLabels[status] || status}**\nBy: ${req.session.user.username}`,
    color: statusColors[status] || 0x5865F2,
  });
  res.redirect("/admin/tasks");
});

router.post("/tasks/:id/notes", (req, res) => {
  const task = tasks.getById(req.params.id);
  if (!task) return res.redirect("/admin/tasks?error=" + encodeURIComponent("Task not found."));
  const notes = (req.body.notes || "").trim();
  tasks.updateNotes(req.params.id, notes);
  res.redirect("/admin/tasks");
});

router.post("/tasks/:id/delete", (req, res) => {
  const task = tasks.getById(req.params.id);
  if (!task) return res.redirect("/admin/tasks?error=" + encodeURIComponent("Task not found."));
  tasks.remove(req.params.id);
  auditLog.log("tasks", "Task Deleted", task.title, req.session.user);
  sendWebhook({
    title: "Task Deleted",
    description: `**${task.title}**\nDeleted by: ${req.session.user.username}`,
    color: 0xef4444,
  });
  res.redirect("/admin/tasks?success=" + encodeURIComponent(`Task "${task.title}" deleted.`));
});

module.exports = router;
