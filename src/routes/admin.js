const express = require("express");
const axios = require("axios");
const config = require("../config");
const { sendWebhookError } = require("../webhook");
const analytics = require("../analytics");
const blog = require("../blog");
const amp = require("../amp");
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
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
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
        token: config.apiToken,
        arma_id,
        reason,
        duration_hours: hours,
        admin_name: user.username,
      },
    });

    if (config.discordWebhookUrl) {
      const safeId = String(arma_id).replace(/[`*_~|]/g, "");
      const safeReason = String(reason).replace(/[`*_~|]/g, "");
      axios.post(config.discordWebhookUrl, {
        embeds: [{
          title: "Player Banned",
          description: `**${user.username}** banned \`${safeId}\`\n**Reason:** ${safeReason}\n**Duration:** ${hours === -1 ? "Permanent" : hours + "h"}`,
          color: 0xff3e3e,
          timestamp: new Date().toISOString(),
        }],
      }).catch(() => {});
    }

    res.redirect("/admin/bans?success=" + encodeURIComponent("Player " + arma_id + " has been banned."));
  } catch (error) {
    console.error("Ban player error:", error.message);
    const apiMsg = error.response?.data?.message || error.message;
    sendWebhookError("Ban Player", apiMsg);
    res.redirect("/admin/bans?error=" + encodeURIComponent("Failed to ban player. " + apiMsg));
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
        token: config.apiToken,
        arma_id,
      },
    });

    if (config.discordWebhookUrl) {
      const safeId = String(arma_id).replace(/[`*_~|]/g, "");
      axios.post(config.discordWebhookUrl, {
        embeds: [{
          title: "Player Unbanned",
          description: `**${user.username}** unbanned \`${safeId}\``,
          color: 0x22c55e,
          timestamp: new Date().toISOString(),
        }],
      }).catch(() => {});
    }

    res.redirect("/admin/bans?success=" + encodeURIComponent("Player " + arma_id + " has been unbanned."));
  } catch (error) {
    console.error("Unban player error:", error.message);
    const apiMsg = error.response?.data?.message || error.message;
    sendWebhookError("Unban Player", apiMsg);
    res.redirect("/admin/bans?error=" + encodeURIComponent("Failed to unban player. " + apiMsg));
  }
});

function csvEscape(val) {
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

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
    let balance = cashRes.data?.cash ?? cashRes.data?.data?.cash ?? cashRes.data?.amount ?? null;
    if (balance === null && cashRes.data?.data !== undefined) {
      balance = cashRes.data.data;
    }
    console.log("[Money Balance]", armaId, cashRes.data);
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

// GET /admin/servers — AMP server status dashboard
router.get("/servers", (req, res) => {
  const user = req.session.user;
  buildAvatarUrl(user);

  const status = amp.getStatus();
  const history = amp.getHistory(24);

  // Build chart data: group by instance, time series of players/cpu/ram
  const chartData = {};
  for (const row of history) {
    if (!chartData[row.instance_id]) {
      chartData[row.instance_id] = {
        name: row.friendly_name,
        times: [],
        players: [],
        cpu: [],
        memory: [],
      };
    }
    const series = chartData[row.instance_id];
    series.times.push(row.recorded_at);
    series.players.push(row.players);
    series.cpu.push(row.cpu_percent);
    series.memory.push(row.memory_percent);
  }

  res.render("admin-servers", {
    page: "admin",
    pageTitle: "Servers",
    pageDescription: "Live server performance metrics from AMP.",
    user,
    instances: status.instances,
    totalPlayers: status.totalPlayers,
    totalMax: status.totalMax,
    instanceCount: status.instances.length,
    fetchedAt: status.fetchedAt,
    ampError: !status.fetchedAt && status.instances.length === 0,
    chartDataJson: JSON.stringify(chartData),
  });
});

// GET /admin/servers/history — JSON endpoint for chart data
router.get("/servers/history", (req, res) => {
  const hours = Math.min(720, Math.max(1, parseInt(req.query.hours) || 24));
  const history = amp.getHistory(hours);

  const chartData = {};
  for (const row of history) {
    if (!chartData[row.instance_id]) {
      chartData[row.instance_id] = {
        name: row.friendly_name,
        times: [],
        players: [],
        cpu: [],
        memory: [],
      };
    }
    const series = chartData[row.instance_id];
    series.times.push(row.recorded_at);
    series.players.push(row.players);
    series.cpu.push(row.cpu_percent);
    series.memory.push(row.memory_percent);
  }

  res.json(chartData);
});

module.exports = router;
