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

    auditLog.log("moderation", "Player Banned", `Arma ID: ${arma_id}, Reason: ${reason}, Duration: ${hours === -1 ? "Permanent" : hours + "h"}`, user);
    sendWebhook({
      title: "Player Banned",
      description: `<@${user.discord_id}> banned \`${String(arma_id).replace(/[`*_~|]/g, "")}\`\n**Reason:** ${String(reason).replace(/[`*_~|]/g, "")}\n**Duration:** ${hours === -1 ? "Permanent" : hours + "h"}`,
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

// POST /admin/bans/unban — unban a player
router.post("/bans/unban", async (req, res) => {
  const { arma_id } = req.body;
  const user = req.session.user;

  if (!arma_id) {
    return res.redirect("/admin/bans?error=Arma ID is required.");
  }

  try {
    await apiClient({
      method: "POST",
      url: "/user/removeUserBanByID/",
      data: {
        token: config.backendToken,
        arma_id,
      },
    });

    auditLog.log("moderation", "Player Unbanned", `Arma ID: ${arma_id}`, user);
    sendWebhook({
      title: "Player Unbanned",
      description: `<@${user.discord_id}> unbanned \`${String(arma_id).replace(/[`*_~|]/g, "")}\``,
      color: 0x22c55e,
    });

    res.redirect("/admin/bans?success=" + encodeURIComponent("Player " + arma_id + " has been unbanned."));
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

// GET /admin/money
router.get("/money", requireWriteAdmin, async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const search = (req.query.search || "").trim();
  let players = [];

  if (search) {
    try {
      const response = await apiClient({
        method: "GET",
        url: "/user/searchUsersByUsername/",
        data: { search, token: config.apiToken },
      });
      const data = response.data?.users || response.data?.data || response.data;
      players = Array.isArray(data) ? data : [];
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
    const cashRes = await apiClient.get("/user/getUserCash/", {
      params: { arma_id: armaId, token: config.apiToken },
    });
    console.log("[Money Balance]", armaId, JSON.stringify(cashRes.data));
    let balance = cashRes.data?.cash ?? cashRes.data?.data?.cash ?? cashRes.data?.amount ?? null;
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
      const searchRes = await apiClient({
        method: "GET",
        url: "/user/searchUsersByUsername/",
        data: { search, token: config.apiToken },
      });
      const data = searchRes.data?.users || searchRes.data?.data || searchRes.data;
      const matchList = Array.isArray(data) ? data : [];

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
router.post("/watchlist", async (req, res) => {
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

  const profile = { arma_id: armaId, arma_username: null, stats: null, miscStats: [], watchlist: false, webNotes: "", steamId: null, atmLimit: null, vacInfo: null, bans: [], cashBalance: null };

  // Fetch all data in parallel
  const [statsRes, miscRes, wlRes, notesRes, steamRes, atmRes, cashRes] = await Promise.allSettled([
    apiClient({ method: "GET", url: "/user/getPlayerStatsByIDCurrentSeason/", data: { arma_id: armaId, token: config.apiToken } }),
    apiClient({ method: "GET", url: "/user/getUserMiscStats/", data: { arma_id: armaId, token: config.apiToken } }),
    adminApiClient.get("/admin/watchlist", { params: { token: config.adminApiToken, arma_id: armaId } }),
    adminApiClient.get("/admin/bans/webNotes", { params: { token: config.adminApiToken, arma_id: armaId } }),
    adminApiClient.get("/admin/steam-id", { params: { token: config.adminApiToken, arma_id: armaId } }),
    adminApiClient.get("/admin/atm-limit", { params: { token: config.adminApiToken, arma_id: armaId } }),
    apiClient({ method: "GET", url: "/user/getUserCash/", data: { arma_id: armaId, token: config.apiToken } }),
  ]);

  if (statsRes.status === "fulfilled" && statsRes.value.data) {
    profile.stats = statsRes.value.data;
    profile.arma_username = statsRes.value.data.arma_username || null;
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
    profile.cashBalance = cashRes.value.data.cash || cashRes.value.data.amount || null;
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
router.post("/player/:arma_id/note", (req, res) => {
  const { note } = req.body;
  const armaId = req.params.arma_id;
  if (!note || !note.trim()) {
    return res.redirect(`/admin/player/${armaId}?error=Note cannot be empty.`);
  }
  auditLog.addPlayerNote(armaId, note.trim(), req.session.user);
  vacScanner.touchPlayer(armaId);
  res.redirect(`/admin/player/${armaId}`);
});

// POST /admin/player/:arma_id/note/:id/delete — delete a note
router.post("/player/:arma_id/note/:id/delete", (req, res) => {
  auditLog.deletePlayerNote(req.params.id);
  res.redirect(`/admin/player/${req.params.arma_id}`);
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
      recentKills = allIncidents.slice(offset, offset + perPage);
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
  const atmDays = [30, 90, 180].includes(parseInt(req.query.atmDays)) ? parseInt(req.query.atmDays) : 30;

  const stats = analytics.getStats();

  // Fetch Discord stats
  const discordStats = require("../discord-stats");
  const discord = await discordStats.getStats();
  const onlineHistory = discordStats.getOnlineHistory(7);

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
    storeStats,
    storeStatsJson: JSON.stringify(storeStats || {}),
    auditEntries,
    auditStats,
    blockedIPs: user.isAdmin ? ipBlock.getAll() : [],
    ipBlockStats: user.isAdmin ? ipBlock.getStats() : { total: 0, today: 0 },
    economyStats: user.isAdmin ? economyTracker.getStats(atmDays) : null,
    economyHistoryJson: JSON.stringify(user.isAdmin && economyTracker.getStats(atmDays) ? economyTracker.getStats(atmDays).dailyHistory : []),
    atmDays,
    cashRollup: user.isAdmin ? await fetchCashRollup() : null,
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

// GET /admin/system — VPS health dashboard
router.get("/system", (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const stats = systemStats.getStats();

  res.render("admin-system", {
    page: "admin",
    pageTitle: "System",
    pageDescription: "VPS health and system metrics.",
    activeTab: "system",
    user,
    ...stats,
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

  res.render("admin-store", {
    page: "admin",
    pageTitle: "Store Management",
    pageDescription: "Manage store products and pricing.",
    activeTab: "store",
    user,
    products,
    categories,
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

// POST /admin/store/sync-stripe — sync all products to Stripe
router.post("/store/sync-stripe", requireWriteAdmin, async (req, res) => {
  try {
    const result = await store.syncToStripe();
    auditLog.log("store", "Stripe Sync", `Synced ${result.synced}/${result.total} products${result.errors.length ? ", " + result.errors.length + " errors" : ""}`, req.session.user);
    if (result.errors.length) {
      res.redirect("/admin/store?error=" + encodeURIComponent(`Synced ${result.synced}/${result.total}. Errors: ${result.errors.map(e => e.product).join(", ")}`));
    } else {
      res.redirect("/admin/store?success=" + encodeURIComponent(`All ${result.synced} products synced to Stripe.`));
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
    auditLog.log("security", "VAC Scan", `Scanned ${result.scanned} players, ${result.flagged} flagged, ${wlResult.count} watchlisted`, req.session.user);

    const playerList = wlResult.players.slice(0, 10).map(p =>
      `• **${p.arma_username || "Unknown"}** — [Steam](https://steamcommunity.com/profiles/${p.steam_id}) | [Profile](${config.siteUrl}/admin/player/${p.arma_id})`
    ).join("\n");
    const extra = wlResult.count > 10 ? `\n...and ${wlResult.count - 10} more` : "";
    const msg = `VAC scan complete: ${result.scanned} new, ${result.skipped} skipped, ${result.flagged} flagged, ${wlResult.count} auto-watchlisted.`;
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
