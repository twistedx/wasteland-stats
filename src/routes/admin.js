const express = require("express");
const axios = require("axios");
const config = require("../config");
const { sendWebhookError } = require("../webhook");
const router = express.Router();

const apiClient = axios.create({
  baseURL: config.apiBaseUrl,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

// Admin auth middleware
router.use((req, res, next) => {
  if (!req.session.user?.isAdmin) {
    return res.redirect("/");
  }
  next();
});

// GET /admin/bans
router.get("/bans", async (req, res) => {
  const user = req.session.user;
  const search = (req.query.search || "").trim();
  const field = req.query.field || "all";

  // Build avatar URL
  if (user.avatar) {
    user.avatarUrl =
      "https://cdn.discordapp.com/avatars/" +
      user.discord_id + "/" + user.avatar + ".png?size=32";
  } else {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl =
      "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
  }

  let bans = [];
  let bansError = false;

  try {
    const response = await apiClient.get("/user/getAllUserBans/", {
      params: { token: config.apiToken },
    });
    bans = response.data || [];
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
        return (ban.arma_username || "").toLowerCase().includes(q);
      }
      if (field === "guid") {
        return (ban.arma_id || "").toLowerCase().includes(q);
      }
      if (field === "banned_by") {
        return (ban.admin_name || "").toLowerCase().includes(q);
      }
      if (field === "reason") {
        return (ban.reason || "").toLowerCase().includes(q);
      }
      // "all" — search across all fields
      return (
        (ban.arma_username || "").toLowerCase().includes(q) ||
        (ban.arma_id || "").toLowerCase().includes(q) ||
        (ban.admin_name || "").toLowerCase().includes(q) ||
        (ban.reason || "").toLowerCase().includes(q)
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

module.exports = router;
