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
    handleRateLimit(error);
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
    pageTitle: "Sign In",
    pageDescription: "Sign in to your Arma Wasteland account.",
    error: req.query.error || null,
  });
});

// Email/password login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.redirect("/auth/login?error=Email and password are required.");
  }

  try {
    const user = await adminUsers.authenticate(email, password);
    if (!user) {
      console.warn(`Login: failed attempt for ${email}`);
      return res.redirect("/auth/login?error=Invalid email or password.");
    }

    // Fetch live Discord roles if account is linked
    let isAdmin = false;
    let isWriteAdmin = false;
    let isBlogAdmin = false;
    if (!user.discord_id) {
      console.log(`Login: ${email} has no linked discord_id, using DB roles`);
      isAdmin = !!user.is_admin;
      isWriteAdmin = !!user.is_write_admin;
      isBlogAdmin = !!user.is_blog_admin;
      console.log(`Login: DB roles — isAdmin=${isAdmin} isWriteAdmin=${isWriteAdmin} isBlogAdmin=${isBlogAdmin}`);
    } else if (isRateLimited()) {
      console.log(`Login: ${email} discord_id=${user.discord_id}, but rate limited — using DB roles`);
      isAdmin = !!user.is_admin;
      isWriteAdmin = !!user.is_write_admin;
      isBlogAdmin = !!user.is_blog_admin;
    } else {
      try {
        console.log(`Discord API: GET /guilds/${config.discordGuildId}/members/${user.discord_id} (email login role check)`);
        const memberRes = await axios.get(
          `${DISCORD_API}/guilds/${config.discordGuildId}/members/${user.discord_id}`,
          { headers: { Authorization: `Bot ${config.discordBotToken}` } }
        );
        const memberRoles = memberRes.data.roles || [];
        console.log(`Login: ${email} discord roles: [${memberRoles.join(",")}]`);
        console.log(`Login: config adminRoleIds=[${config.adminRoleIds.join(",")}] writeRoleIds=[${config.adminWriteRoleIds.join(",")}] blogRoleIds=[${config.blogRoleIds.join(",")}]`);
        isAdmin = memberRoles.some(r => config.adminRoleIds.includes(r));
        isWriteAdmin = memberRoles.some(r => config.adminWriteRoleIds.includes(r));
        isBlogAdmin = memberRoles.some(r => config.blogRoleIds.includes(r));
        console.log(`Login: resolved isAdmin=${isAdmin} isWriteAdmin=${isWriteAdmin} isBlogAdmin=${isBlogAdmin}`);
      } catch (roleErr) {
        if (!handleRateLimit(roleErr)) {
          console.error("Email login role fetch error:", roleErr.response?.status, roleErr.response?.data || roleErr.message);
        }
        // Fall back to DB roles if Discord is unavailable
        isAdmin = !!user.is_admin;
        isWriteAdmin = !!user.is_write_admin;
        isBlogAdmin = !!user.is_blog_admin;
        console.log(`Login: fell back to DB roles — isAdmin=${isAdmin} isWriteAdmin=${isWriteAdmin} isBlogAdmin=${isBlogAdmin}`);
      }
    }

    req.session.user = {
      username: user.username,
      email: user.email,
      discord_id: user.discord_id || null,
      avatar: null,
      discriminator: null,
      isAdmin,
      isWriteAdmin,
      isBlogAdmin,
      authMethod: "email",
      connections: [],
      steamId: null,
    };

    req.session.save(() => {
      console.log(`Login: ${user.username} (${email}) logged in via email [admin=${isAdmin}]`);
      res.redirect("/");
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.redirect("/auth/login?error=Login failed. Please try again.");
  }
});

// Registration form
router.get("/register", (req, res) => {
  if (req.session.user) {
    return res.redirect("/");
  }
  res.render("register", {
    page: "register",
    pageTitle: "Create Account",
    pageDescription: "Create your Arma Wasteland account.",
    error: req.query.error || null,
  });
});

// Registration
router.post("/register", async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.redirect("/auth/register?error=All fields are required.");
  }

  if (username.trim().length < 2 || username.trim().length > 32) {
    return res.redirect("/auth/register?error=Display name must be 2-32 characters.");
  }

  if (password.length < 8) {
    return res.redirect("/auth/register?error=Password must be at least 8 characters.");
  }

  try {
    const existing = adminUsers.getByEmail(email);
    if (existing) {
      return res.redirect("/auth/register?error=An account with that email already exists.");
    }

    await adminUsers.register(email, password, username);

    // Auto-login after registration
    const user = await adminUsers.authenticate(email, password);

    req.session.user = {
      username: user.username,
      email: user.email,
      discord_id: null,
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
      console.log(`Register: ${user.username} (${email}) created account`);
      res.redirect("/");
    });
  } catch (err) {
    console.error("Registration error:", err.message);
    res.redirect("/auth/register?error=Registration failed. Please try again.");
  }
});

// Account page — link Discord via /verify command
router.get("/account", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/auth/login");
  }
  const user = req.session.user;

  // Build avatar URL for display
  if (user.avatar && user.discord_id) {
    user.avatarUrl = "https://cdn.discordapp.com/avatars/" + user.discord_id + "/" + user.avatar + ".png?size=64";
  } else if (user.discord_id) {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
  } else {
    user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/0.png";
  }

  // Generate a verification code for unlinked email accounts
  let verifyCode = null;
  if (user.authMethod === "email" && !user.discord_id && user.email) {
    verifyCode = adminUsers.generateVerifyCode(user.email);
  }

  res.render("account", {
    page: "account",
    pageTitle: "Account",
    pageDescription: "Manage your account settings.",
    user,
    verifyCode,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

// Update username
router.post("/account/username", (req, res) => {
  if (!req.session.user) return res.redirect("/auth/login");
  const { username } = req.body;

  if (!username || username.trim().length < 2 || username.trim().length > 32) {
    return res.redirect("/auth/account?error=Display name must be 2-32 characters.");
  }

  // Email users — update in DB
  if (req.session.user.email) {
    adminUsers.updateUsername(req.session.user.email, username);
  }
  req.session.user.username = username.trim();
  req.session.save(() => {
    res.redirect("/auth/account?success=Display name updated.");
  });
});

// Update email
router.post("/account/email", (req, res) => {
  if (!req.session.user) return res.redirect("/auth/login");
  if (!req.session.user.email) {
    return res.redirect("/auth/account?error=Discord-only accounts cannot change email.");
  }

  const { email } = req.body;
  if (!email || !email.includes("@")) {
    return res.redirect("/auth/account?error=Please enter a valid email address.");
  }

  const success = adminUsers.updateEmail(req.session.user.email, email);
  if (!success) {
    return res.redirect("/auth/account?error=That email is already in use.");
  }
  req.session.user.email = email.toLowerCase().trim();
  req.session.save(() => {
    res.redirect("/auth/account?success=Email updated.");
  });
});

// Update password
router.post("/account/password", async (req, res) => {
  if (!req.session.user) return res.redirect("/auth/login");
  if (!req.session.user.email) {
    return res.redirect("/auth/account?error=Discord-only accounts cannot change password.");
  }

  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.redirect("/auth/account?error=All password fields are required.");
  }
  if (newPassword.length < 8) {
    return res.redirect("/auth/account?error=New password must be at least 8 characters.");
  }
  if (newPassword !== confirmPassword) {
    return res.redirect("/auth/account?error=New passwords do not match.");
  }

  try {
    const success = await adminUsers.updatePassword(req.session.user.email, currentPassword, newPassword);
    if (!success) {
      return res.redirect("/auth/account?error=Current password is incorrect.");
    }
    res.redirect("/auth/account?success=Password updated.");
  } catch (err) {
    console.error("Password update error:", err.message);
    res.redirect("/auth/account?error=Password update failed.");
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
