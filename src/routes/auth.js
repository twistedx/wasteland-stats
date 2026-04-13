const express = require("express");
const axios = require("axios");
const config = require("../config");
const steamStore = require("../steam-store");
const adminUsers = require("../admin-users");
const bm = require("../armahq");
const router = express.Router();

const DISCORD_AUTH_URL = "https://discord.com/api/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_API = "https://discord.com/api/v10";

// Check if a user is watchlisted and send a Discord webhook alert
async function checkWatchlist(user) {
  if (!config.watchlistWebhookUrl || !config.adminApiToken) return;
  const discordId = user.discord_id;
  if (!discordId) return;

  try {
    const res = await axios.get(`${config.apiBaseUrl}/admin/watchlist`, {
      params: { token: config.adminApiToken, discord_id: discordId },
      timeout: 10000,
    });
    if (!res.data?.is_watchlisted) return;

    // Determine which server(s) they might be on from cached ArmaHQ data
    const status = bm.getStatus();
    const serverInfo = status.servers
      .filter(s => s.players > 0)
      .map(s => `${s.label}: ${s.players}/${s.maxPlayers}`)
      .join(", ") || "No active servers";

    await axios.post(config.watchlistWebhookUrl, {
      embeds: [{
        title: "Watchlisted Player Login",
        description: `**${user.username}** has logged into the dashboard.`,
        color: 0xf59e0b,
        fields: [
          { name: "Discord ID", value: discordId, inline: true },
          { name: "Servers Online", value: serverInfo, inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    }, { timeout: 10000 });

    console.log(`[Watchlist] Alert sent for ${user.username} (${discordId})`);
  } catch (err) {
    console.error("[Watchlist] Check/webhook error:", err.message);
  }
}

// Track rate limit state — don't call Discord if we know we're blocked
let rateLimitedUntil = 0;

function isRateLimited() {
  return Date.now() < rateLimitedUntil;
}

function handleRateLimit(error) {
  if (error.response?.status === 429) {
    const retryAfter = error.response.data?.retry_after || error.response.headers?.["retry-after"] || 60;
    rateLimitedUntil = Date.now() + (retryAfter * 1000);
    console.error(`Discord: rate limited, backing off for ${retryAfter}s`);
    return true;
  }
  return false;
}

// Step 1: Redirect to Discord
router.get("/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: "code",
    scope: "identify connections",
  });
  res.redirect(`${DISCORD_AUTH_URL}?${params.toString()}`);
});

// Step 2: Discord callback — exchange code for token, fetch user identity
router.get("/discord/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.redirect("/?error=no_code");
  }

  try {
    console.log("Discord API: POST /oauth2/token (exchange code for access token)");
    const tokenRes = await axios.post(
      DISCORD_TOKEN_URL,
      new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.discord.redirectUri,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token } = tokenRes.data;

    console.log("Discord API: GET /users/@me (fetch user profile)");
    const userRes = await axios.get(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const discordUser = userRes.data;

    // Fetch connected accounts (Steam, Xbox, etc.)
    let connections = [];
    try {
      console.log("Discord API: GET /users/@me/connections (fetch linked accounts)");
      const connRes = await axios.get(`${DISCORD_API}/users/@me/connections`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      connections = (connRes.data || [])
        .filter(c => c.visibility === 1 || c.verified)
        .map(c => ({ type: c.type, name: c.name, id: c.id, verified: c.verified }));
    } catch (connErr) {
      if (!handleRateLimit(connErr)) {
        console.error("Connections fetch error:", connErr.response?.status, connErr.message);
      }
    }

    // Fetch guild member roles using bot token
    let isAdmin = false;
    let isWriteAdmin = false;
    let isBlogAdmin = false;
    try {
      console.log(`Discord API: GET /guilds/${config.discordGuildId}/members/${discordUser.id} (fetch guild roles)`);
      const memberRes = await axios.get(
        `${DISCORD_API}/guilds/${config.discordGuildId}/members/${discordUser.id}`,
        { headers: { Authorization: `Bot ${config.discordBotToken}` } }
      );
      const memberRoles = memberRes.data.roles || [];
      isAdmin = memberRoles.some(r => config.adminRoleIds.includes(r));
      isWriteAdmin = memberRoles.some(r => config.adminWriteRoleIds.includes(r));
      isBlogAdmin = memberRoles.some(r => config.blogRoleIds.includes(r));
    } catch (roleErr) {
      if (!handleRateLimit(roleErr)) {
        console.error("Role fetch error:", roleErr.response?.status, roleErr.response?.data || roleErr.message);
      }
    }

    // Store Steam link if available
    const steamConn = connections.find(c => c.type === "steam");
    if (steamConn) {
      steamStore.upsert(discordUser.id, discordUser.username, steamConn.id, steamConn.name);
    }

    const userData = {
      discord_id: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar,
      discriminator: discordUser.discriminator,
      isAdmin,
      isWriteAdmin,
      isBlogAdmin,
      connections,
      steamId: steamConn?.id || null,
    };

    // Regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) console.error("Session regenerate error:", err.message);
      req.session.user = userData;

      // Check watchlist in background (don't block login)
      checkWatchlist(req.session.user);

      req.session.save(() => {
        res.redirect("/profile");
      });
    });
  } catch (error) {
    handleRateLimit(error);
    const errMsg = error.response?.data
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error("Discord OAuth error:", errMsg);
    // Don't send a webhook about Discord errors — it would hit Discord again
    res.redirect("/?error=auth_failed");
  }
});

// Redirect old email auth routes to Discord login
router.get("/login", (req, res) => res.redirect("/auth/discord"));
router.get("/register", (req, res) => res.redirect("/auth/discord"));
router.get("/account", (req, res) => res.redirect("/profile"));

// Check login status
router.get("/me", (req, res) => {
  if (req.session.user) {
    return res.json({ loggedIn: true, user: req.session.user });
  }
  res.json({ loggedIn: false });
});

// Logout
router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

module.exports = router;
