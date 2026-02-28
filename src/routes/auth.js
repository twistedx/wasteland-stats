const express = require("express");
const axios = require("axios");
const config = require("../config");
const steamStore = require("../steam-store");
const adminUsers = require("../admin-users");
const router = express.Router();

const DISCORD_AUTH_URL = "https://discord.com/api/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_API = "https://discord.com/api/v10";

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
  if (isRateLimited()) {
    console.log("Discord: skipping auth redirect, rate limited");
    return res.redirect("/?error=rate_limited");
  }
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

  if (isRateLimited()) {
    console.log("Discord: skipping callback, rate limited");
    return res.redirect("/?error=rate_limited");
  }

  try {
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

    const userRes = await axios.get(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const discordUser = userRes.data;

    // Fetch connected accounts (Steam, Xbox, etc.)
    let connections = [];
    try {
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

    req.session.user = {
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

    req.session.save(() => {
      res.redirect("/?login=success");
    });
  } catch (error) {
    if (handleRateLimit(error)) {
      return res.redirect("/?error=rate_limited");
    }
    const errMsg = error.response?.data
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error("Discord OAuth error:", errMsg);
    // Don't send a webhook about Discord errors — it would hit Discord again
    res.redirect("/?error=auth_failed");
  }
});

// Email/password login form
router.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/");
  }
  res.render("login", {
    page: "login",
    pageTitle: "Admin Login",
    pageDescription: "Admin login for Arma Wasteland dashboard.",
    error: req.query.error || null,
  });
});

// Email/password login — admin fallback when Discord is down
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.redirect("/auth/login?error=Email and password are required.");
  }

  try {
    const user = await adminUsers.authenticate(email, password);
    if (!user) {
      console.warn(`Admin login: failed attempt for ${email}`);
      return res.redirect("/auth/login?error=Invalid email or password.");
    }

    req.session.user = {
      username: user.username,
      discord_id: user.discord_id || null,
      avatar: null,
      discriminator: null,
      isAdmin: !!user.is_admin,
      isWriteAdmin: !!user.is_write_admin,
      isBlogAdmin: !!user.is_blog_admin,
      authMethod: "email",
      connections: [],
      steamId: null,
    };

    req.session.save(() => {
      console.log(`Admin login: ${user.username} (${email}) logged in via email`);
      res.redirect("/admin/analytics");
    });
  } catch (err) {
    console.error("Admin login error:", err.message);
    res.redirect("/auth/login?error=Login failed. Please try again.");
  }
});

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
