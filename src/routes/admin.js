const express = require("express");
const axios = require("axios");
const config = require("../config");
const { sendWebhookError } = require("../webhook");
const analytics = require("../analytics");
const router = express.Router();

const apiClient = axios.create({
  baseURL: config.apiBaseUrl,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

// Admin auth middleware
router.use((req, res, next) => {
  if (!req.session.user) {
    return res.redirect("/");
  }
  if (!req.session.user.isAdmin) {
    console.warn(`Unauthorized admin access attempt by ${req.session.user.username} (${req.session.user.discord_id})`);
    sendWebhookError("Unauthorized Admin Access", `**${req.session.user.username}** (${req.session.user.discord_id}) tried to access ${req.originalUrl}`);
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
    user,
    bans,
    bansError,
    banCount: bans.length,
    search,
    field,
  });
});

// Helper to build avatar URL
function buildAvatarUrl(user) {
  if (user.avatar) {
    user.avatarUrl =
      "https://cdn.discordapp.com/avatars/" +
      user.discord_id + "/" + user.avatar + ".png?size=32";
  } else {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl =
      "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
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
    user,
    search,
    players,
    selectedArmaId: req.query.arma_id || "",
    selectedUsername: req.query.username || "",
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
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

    // Log to Discord webhook
    if (config.discordWebhookUrl) {
      axios.post(config.discordWebhookUrl, {
        embeds: [{
          title: "Money Added",
          description: `**${user.username}** added **$${Number(amount).toLocaleString()}** to player \`${arma_id}\``,
          color: 0xF59E0B,
          timestamp: new Date().toISOString(),
        }],
      }).catch(() => {});
    }

    res.redirect(`/admin/money?success=Added $${Number(amount).toLocaleString()} to ${arma_id}`);
  } catch (error) {
    console.error("Add money error:", error.message);
    if (error.response) {
      console.error("Response status:", error.response.status);
      console.error("Response data:", JSON.stringify(error.response.data));
    }
    sendWebhookError("Add Money", error.message);
    res.redirect("/admin/money?error=Failed to add money. " + error.message);
  }
});

// GET /admin/skins
router.get("/skins", requireWriteAdmin, async (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  let skins = [];
  let skinsError = false;

  try {
    const response = await apiClient.get(`/item/getItemNames`, {
      params: { token: config.backendToken },
    });
    skins = Array.isArray(response.data?.items) ? response.data.items : [];
  } catch (error) {
    console.error("Skins fetch error:", error.message);
    sendWebhookError("Skins Fetch", error.message);
    skinsError = true;
  }

  res.render("admin-skins", {
    page: "admin",
    pageTitle: "Skins",
    pageDescription: "Admin tool to assign skins to players.",
    user,
    skins,
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

    // Log to Discord webhook
    if (config.discordWebhookUrl) {
      axios.post(config.discordWebhookUrl, {
        embeds: [{
          title: "Skin Assigned",
          description: `**${user.username}** assigned **${item_name}** to Discord user \`${discord_id}\``,
          color: 0x8B5CF6,
          timestamp: new Date().toISOString(),
        }],
      }).catch(() => {});
    }

    res.redirect(`/admin/skins?success=Assigned "${item_name}" to Discord user ${discord_id}`);
  } catch (error) {
    console.error("Skin assign error:", error.message);
    const apiMsg = error.response?.data?.message || error.message;
    sendWebhookError("Skin Assign", apiMsg);
    res.redirect("/admin/skins?error=" + encodeURIComponent("Failed to assign skin. " + apiMsg));
  }
});

// GET /admin/analytics
router.get("/analytics", (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const stats = analytics.getStats();

  res.render("admin-analytics", {
    page: "admin",
    pageTitle: "Analytics",
    pageDescription: "Site analytics dashboard.",
    user,
    ...stats,
    dailyViewsJson: JSON.stringify(stats.dailyViews),
  });
});

module.exports = router;
