const express = require("express");
const path = require("path");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const { engine } = require("express-handlebars");
const axios = require("axios");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { csrfSync } = require("csrf-sync");
const { JSDOM } = require("jsdom");
const createDOMPurify = require("dompurify");
const config = require("./config");
const { sendWebhookError } = require("./webhook");
const analytics = require("./analytics");
const amp = require("./amp");
const bm = require("./armahq");
const blog = require("./blog");
const metricsHistory = require("./metrics-history");
const adminUsers = require("./admin-users");
const store = require("./store");
const auditLog = require("./audit-log");
const { marked } = require("marked");

const fs = require("fs");

// DOMPurify for sanitizing markdown HTML output
const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

const app = express();
app.set("trust proxy", 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "https://cdn.discordapp.com", "data:"],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://youtube.com", "https://www.youtube-nocookie.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const SESSION_DIR = path.join(__dirname, "..", "data", "sessions");
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

const apiClient = axios.create({
  baseURL: config.apiBaseUrl,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

const MISC_FIELDS = [
  { key: "ai_kills", label: "AI Kills" },
  { key: "distance_walked", label: "Distance Walked (m)" },
  { key: "distance_driven", label: "Distance Driven (m)" },
  { key: "distance_as_occupant", label: "Distance as Passenger (m)" },
  { key: "shots_fired", label: "Shots Fired" },
  { key: "grenades_thrown", label: "Grenades Thrown" },
  { key: "roadkills", label: "Roadkills" },
  { key: "ai_roadkills", label: "AI Roadkills" },
  { key: "players_died_in_vehicle", label: "Vehicle Deaths Caused" },
  { key: "bandage_self", label: "Bandaged Self" },
  { key: "bandage_friendlies", label: "Bandaged Friendlies" },
  { key: "tourniquet_self", label: "Tourniquet Self" },
  { key: "tourniquet_friendlies", label: "Tourniquet Friendlies" },
  { key: "saline_self", label: "Saline Self" },
  { key: "saline_friendlies", label: "Saline Friendlies" },
  { key: "morphine_self", label: "Morphine Self" },
  { key: "morphine_friendlies", label: "Morphine Friendlies" },
];

app.engine(
  "hbs",
  engine({
    extname: ".hbs",
    defaultLayout: "main",
    layoutsDir: path.join(__dirname, "..", "views", "layouts"),
    partialsDir: path.join(__dirname, "..", "views", "partials"),
    helpers: {
      eq: (a, b) => a === b,
      or: (a, b) => a || b,
      gt: (a, b) => a > b,
      lt: (a, b) => a < b,
      add: (a, b) => a + b,
      subtract: (a, b) => a - b,
      formatNumber: (val) => {
        if (val === undefined || val === null) return "0";
        return Number(val).toLocaleString();
      },
      fallback: (val, def) => (val !== undefined && val !== null ? val : def),
      math: (a, b) => a + b,
      percent: (a, b) => (b ? Math.round((a / b) * 100) : 0),
      formatDate: (val) => {
        if (!val) return "-";
        const d = new Date(val);
        if (isNaN(d)) return val;
        return d.toLocaleDateString("en-US", {
          year: "numeric", month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit",
        });
      },
      markdown: (val) => {
        if (!val) return "";
        return DOMPurify.sanitize(marked(val));
      },
      joinTags: (arr) => {
        if (!arr || !Array.isArray(arr)) return "";
        return arr.join(", ");
      },
      encodeURI: (val) => {
        if (!val) return "";
        return encodeURIComponent(val);
      },
      excerpt: (val, len) => {
        if (!val) return "";
        const plain = val
          .replace(/<[^>]*>/g, "")
          .replace(/[#*_`~\[\]()>!-]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (plain.length <= len) return plain;
        return plain.substring(0, len) + "...";
      },
    },
  })
);
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(
  session({
    store: new FileStore({
      path: SESSION_DIR,
      ttl: 7 * 86400,
      retries: 0,
      reapInterval: 3600,
    }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// Stripe webhook needs raw body for signature verification — must come before json parser
app.use("/build/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".css")) {
      res.setHeader("Content-Type", "text/css");
    }
  },
}));

// CSRF protection
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.body._csrf || req.headers["x-csrf-token"],
  getTokenFromState: (req) => req.session?.csrfToken,
  storeTokenInState: (req, token) => { req.session.csrfToken = token; },
  size: 64,
});

// Make CSRF token available in all views — reuse existing token per session
app.use((req, res, next) => {
  if (req.session) {
    if (!req.session.csrfToken) {
      generateToken(req, true);
    }
    res.locals.csrfToken = req.session.csrfToken;
  }
  next();
});

// Apply CSRF protection to all POST/PUT/DELETE (skip API JSON endpoints)
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  // Skip CSRF for JSON API endpoints (they use API tokens)
  if (req.path.startsWith("/api/")) {
    return next();
  }
  // Skip CSRF for Stripe webhook (verified via Stripe signature)
  if (req.path === "/build/webhook") {
    return next();
  }
  // Guard: if no session exists yet, reject the POST
  if (!req.session) {
    return res.status(403).send("Session required.");
  }
  // For multipart/form-data, body isn't parsed yet — check query string for CSRF token
  if (req.headers['content-type']?.startsWith('multipart/form-data') && req.query._csrf) {
    req.body = req.body || {};
    req.body._csrf = req.query._csrf;
  }
  csrfSynchronisedProtection(req, res, (err) => {
    if (err) {
      console.warn(`CSRF validation failed: ${req.method} ${req.path} — ${err.message}`);
      // Redirect back with error instead of crashing
      const referer = req.headers.referer;
      if (referer) {
        try {
          const url = new URL(referer);
          url.searchParams.set("error", "Form expired. Please try again.");
          return res.redirect(url.pathname + url.search);
        } catch {}
      }
      return res.redirect(req.path + "?error=Form+expired.+Please+try+again.");
    }
    next();
  });
});

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: "Too many login attempts. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Export limiters for use in routes
app.set("loginLimiter", loginLimiter);
app.set("apiLimiter", apiLimiter);

// Session validation — verify the cookie matches valid server-side session data
app.use((req, res, next) => {
  // Skip static assets and auth routes
  if (req.path.startsWith("/css/") || req.path.startsWith("/js/") || req.path.startsWith("/img/") ||
      req.path.startsWith("/favicon") || req.path.startsWith("/auth")) {
    return next();
  }

  // If there's a session cookie but user data is missing or corrupt, clear it
  if (req.sessionID && req.session && req.cookies && req.headers.cookie?.includes("connect.sid")) {
    if (req.session.user) {
      // Validate session has required fields — Discord users need discord_id, email users need authMethod
      const u = req.session.user;
      const validDiscord = u.discord_id && u.username;
      const validEmail = u.authMethod === "email" && u.username;
      if (!validDiscord && !validEmail) {
        console.log(`Session: invalid user data for session ${req.sessionID}, destroying`);
        return req.session.destroy(() => {
          res.clearCookie("connect.sid");
          res.redirect("/auth/login");
        });
      }
    }
  }

  next();
});

analytics.init();
blog.init();
require("./steam-store").init();
bm.init();
metricsHistory.init();
adminUsers.init();
store.init();
auditLog.init();
require("./discord-bot").init();

app.use(analytics.middleware);

app.use("/auth", require("./routes/auth"));
const adminLimiter = rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use("/admin", adminLimiter, require("./routes/admin"));
app.use("/api", apiLimiter, require("./routes/api"));
app.use("/blog", require("./routes/blog"));

async function fetchHomeData(req) {
  const tab = req.query.tab === "alltime" ? "alltime" : "season";
  const user = req.session.user || null;

  let leaderboard = [];
  let leaderboardError = false;
  let stats = null;
  let statsError = null;
  let statsNotLinked = false;
  let miscStats = [];
  let atmBalance = null;

  // Fetch leaderboard
  try {
    const endpoint =
      tab === "alltime"
        ? "/user/topTenUserStatsAllTime/"
        : "/user/topTenUserStats/";
    const response = await apiClient.get(endpoint, {
      params: { token: config.apiToken },
    });
    leaderboard = response.data;
  } catch (error) {
    console.error("Leaderboard error:", error.message);
    sendWebhookError("Leaderboard Fetch", error.message);
    leaderboardError = true;
  }

  // Fetch personal stats if logged in
  if (user) {
    try {
      const response = await apiClient({
        method: "GET",
        url: "/user/getAllPlayerStatsByDiscordID",
        data: {
          discord_id: user.discord_id,
          token: config.apiToken,
        },
      });
      stats = response.data;


      miscStats = MISC_FIELDS.filter(
        (f) => stats[f.key] !== undefined && stats[f.key] !== null
      ).map((f) => ({ label: f.label, value: stats[f.key] }));

      // Fetch ATM balance if we have arma_id
      if (stats.arma_id) {
        try {
          const cashRes = await apiClient.get("/user/getUserCash/", {
            params: { arma_id: stats.arma_id, token: config.apiToken },
          });
          atmBalance = cashRes.data?.cash ?? cashRes.data?.data?.cash ?? cashRes.data?.amount ?? null;
          if (atmBalance === null && cashRes.data?.data !== undefined) {
            atmBalance = cashRes.data.data;
          }
        } catch (cashErr) {
          console.error("Cash fetch error:", cashErr.message);
        }
      }
    } catch (error) {
      if (error.response?.status === 404) {
        statsNotLinked = true;
      } else {
        console.error("Stats error:", error.message);
        sendWebhookError("Stats Fetch", error.message);
        statsError = "Failed to fetch stats.";
      }
    }

    // Build avatar URL
    if (user.avatar && user.discord_id) {
      user.avatarUrl =
        "https://cdn.discordapp.com/avatars/" +
        user.discord_id +
        "/" +
        user.avatar +
        ".png?size=32";
    } else if (user.discord_id) {
      const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
      user.avatarUrl =
        "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
    } else {
      user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/0.png";
    }
  }

  return { user, tab, leaderboard, leaderboardError, stats, statsError, statsNotLinked, miscStats, atmBalance };
}

app.get("/", async (req, res) => {
  const data = await fetchHomeData(req);
  const bmStatus = await bm.getFreshStatus();
  console.log(`HOME: BattleMetrics status — ${bmStatus.servers.length} servers, ${bmStatus.totalPlayers}/${bmStatus.totalMax} players`);
  const serverStatus = bmStatus.servers.map((srv) => ({
    label: srv.label,
    name: srv.name,
    players: srv.players,
    maxPlayers: srv.maxPlayers,
    queue: srv.queue || 0,
    status: srv.status === "online" ? "online" : "offline",
    peak: srv.peak || 0,
  }));
  const totalPlayers = bmStatus.totalPlayers;
  const totalMaxPlayers = bmStatus.totalMax;

  // Fetch cash rollup from admin API
  let cashRollup = null;
  try {
    const cashRes = await axios.get(`${config.apiBaseUrl}/admin/cash-rollup`, {
      params: { token: config.adminApiToken },
      timeout: 10000,
    });
    cashRollup = cashRes.data || null;
  } catch (err) {
    console.error("Cash rollup fetch error:", err.message);
  }

  res.render("dashboard", {
    page: "home",
    pageTitle: "Server Dashboard",
    pageDescription: "Live combat statistics, kill leaderboards, and ban analytics from the Arma Wasteland battlefield.",
    ...data,
    serverStatus,
    totalPlayers,
    totalMaxPlayers,
    cashRollup,
  });
});

app.get("/about", (req, res) => {
  const user = req.session.user || null;
  if (user) {
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
  res.render("about", {
    page: "about",
    pageTitle: "About",
    pageDescription: "Learn about Arma Wasteland — a dynamic open-world survival game mode built on Arma Reforger featuring base building, resource scavenging, and team combat.",
    user,
  });
});

app.get("/robots.txt", (req, res) => {
  const base = config.siteUrl;
  res.set("Content-Type", "text/plain");
  res.send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /auth\nDisallow: /api\nDisallow: /build\n\nSitemap: ${base}/sitemap.xml\n`);
});

app.get("/sitemap.xml", (req, res) => {
  const base = config.siteUrl;
  const now = new Date().toISOString().split("T")[0];

  const staticPages = [
    { loc: "/", priority: "1.0", changefreq: "daily" },
    { loc: "/blog", priority: "0.8", changefreq: "daily" },
    { loc: "/about", priority: "0.5", changefreq: "monthly" },
    { loc: "/how-to", priority: "0.5", changefreq: "monthly" },
  ];

  const posts = blog.getPosts(true);

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  for (const page of staticPages) {
    xml += "  <url>\n";
    xml += `    <loc>${base}${page.loc}</loc>\n`;
    xml += `    <lastmod>${now}</lastmod>\n`;
    xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
    xml += `    <priority>${page.priority}</priority>\n`;
    xml += "  </url>\n";
  }

  for (const post of posts) {
    const lastmod = new Date(post.updatedAt || post.createdAt).toISOString().split("T")[0];
    xml += "  <url>\n";
    xml += `    <loc>${base}/blog/${post.slug}</loc>\n`;
    xml += `    <lastmod>${lastmod}</lastmod>\n`;
    xml += `    <changefreq>weekly</changefreq>\n`;
    xml += `    <priority>0.7</priority>\n`;
    xml += "  </url>\n";
  }

  xml += "</urlset>";

  res.set("Content-Type", "application/xml");
  res.send(xml);
});

// ── Store / Build page ──

// Build page admin guard
function requireAdminForBuild(req, res, next) {
  if (!req.session.user || (!req.session.user.discord_id && req.session.user.authMethod !== "email")) {
    return res.redirect("/auth/login");
  }
  if (!req.session.user.isAdmin) {
    return res.redirect("/");
  }
  next();
}

app.get("/build", requireAdminForBuild, (req, res) => {
  const user = req.session.user || null;
  if (user) {
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
  const categories = store.getCategoriesWithProducts();

  res.render("build", {
    page: "build",
    pageTitle: "Store",
    pageDescription: "Support the server — grab skins, items, and more.",
    noIndex: true,
    user,
    categoriesJson: JSON.stringify(categories),
    success: req.query.success || null,
    canceled: req.query.canceled || null,
  });
});

// Stripe checkout session creation
app.post("/build/checkout", requireAdminForBuild, async (req, res) => {
  // Require Stripe key to be configured
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).send("Stripe is not configured yet.");
  }
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

  let cart;
  try {
    cart = JSON.parse(req.body.cart);
  } catch {
    return res.status(400).send("Invalid cart data.");
  }

  if (!Array.isArray(cart) || cart.length === 0) {
    return res.status(400).send("Cart is empty.");
  }

  // Build Stripe line items from the cart — validate against DB prices
  const lineItems = [];
  for (const item of cart) {
    const product = store.getProductById(parseInt(item.id));
    if (!product || !product.active) continue;
    const qty = Math.max(1, Math.min(99, parseInt(item.qty) || 1));
    const effectivePrice = store.getEffectivePrice(product);
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: { name: product.name },
        unit_amount: effectivePrice, // cents — uses sale_price if set
      },
      quantity: qty,
    });
  }

  if (lineItems.length === 0) {
    return res.status(400).send("No valid items in cart.");
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${config.siteUrl}/build?success=1`,
      cancel_url: `${config.siteUrl}/build?canceled=1`,
      metadata: {
        discord_id: req.session.user?.discord_id || "guest",
        username: req.session.user?.username || "guest",
      },
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    sendWebhookError("Stripe Checkout", err.message);
    res.status(500).send("Failed to create checkout session.");
  }
});

// Stripe webhook — receives payment confirmations
// This endpoint is CSRF-exempt (handled by the CSRF middleware skipping /build/webhook below)
app.post("/build/webhook", async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send("Stripe webhook not configured.");
  }
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log(`Stripe payment completed: ${session.id} — $${(session.amount_total / 100).toFixed(2)}`);

    // Record purchases (no PII stored — only Stripe session ID, product, amount)
    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
      for (const item of lineItems.data) {
        store.recordPurchase({
          stripe_session_id: session.id,
          product_name: item.description || "Unknown",
          quantity: item.quantity || 1,
          amount: item.amount_total || 0,
        });
      }
      console.log(`Stripe: recorded ${lineItems.data.length} line items for session ${session.id}`);

      // TODO: Call your backend API to grant skins/cash/VIP as needed

      const { sendWebhook } = require("./webhook");
      sendWebhook({
        title: "Purchase Completed",
        description: `**$${(session.amount_total / 100).toFixed(2)}** — ${lineItems.data.length} item(s)`,
        color: 0x22c55e,
      });
    } catch (fulfillErr) {
      console.error("Order fulfillment error:", fulfillErr.message);
      sendWebhookError("Stripe Fulfillment", fulfillErr.message);
    }
  }

  res.json({ received: true });
});

app.get("/how-to", (req, res) => {
  const user = req.session.user || null;
  if (user) {
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
  res.render("how-to", {
    page: "howto",
    pageTitle: "How To Play",
    pageDescription: "Master Arma Wasteland with squad tactics, communication tips, formation strategies, and video guides to dominate the battlefield.",
    user,
  });
});

module.exports = app;
