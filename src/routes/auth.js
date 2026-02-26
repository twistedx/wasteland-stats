const express = require("express");
const axios = require("axios");
const config = require("../config");
const { sendWebhookError } = require("../webhook");
const steamStore = require("../steam-store");
const router = express.Router();

const DISCORD_AUTH_URL = "https://discord.com/api/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_API = "https://discord.com/api/v10";

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
      console.error("Connections fetch error:", connErr.response?.status, connErr.message);
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
      console.log(`User ${discordUser.username} roles:`, memberRoles);
      console.log("Admin role IDs:", config.adminRoleIds);
      isAdmin = memberRoles.some(r => config.adminRoleIds.includes(r));
      isWriteAdmin = memberRoles.some(r => config.adminWriteRoleIds.includes(r));
      isBlogAdmin = memberRoles.some(r => config.blogRoleIds.includes(r));
    } catch (roleErr) {
      console.error("Role fetch error:", roleErr.response?.status, roleErr.response?.data || roleErr.message);
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
    const errMsg = error.response?.data
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error("Discord OAuth error:", errMsg);
    sendWebhookError("Discord OAuth", errMsg);
    res.redirect("/?error=auth_failed");
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
