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
const { sendWebhook, sendWebhookError } = require("./webhook");
const analytics = require("./analytics");
const amp = require("./amp");
const bm = require("./armahq");
const blog = require("./blog");
const metricsHistory = require("./metrics-history");
const adminUsers = require("./admin-users");
const store = require("./store");
const auditLog = require("./audit-log");
const skinDraw = require("./skin-draw");
const tasks = require("./tasks");
const ipBlock = require("./ip-block");
const vacScanner = require("./vac-scanner");
const cron = require("node-cron");
const subscriptionPerks = require("./subscription-perks");
const { marked } = require("marked");

const fs = require("fs");

// DOMPurify for sanitizing markdown HTML output
const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

const app = express();
app.set("trust proxy", 1);

// Auto-block IPs: port scans, exploit probes, brute force
const ipStrikes = new Map();    // ip -> { count, firstSeen }
const requestLog = new Map();   // ip -> { count, firstSeen } — rate flood detection
const BLOCK_DURATION = 24 * 60 * 60 * 1000;      // 24 hours
const BLOCK_DURATION_LONG = 7 * 24 * 60 * 60 * 1000; // 7 days for repeat offenders
const STRIKE_WINDOW = 60 * 1000;  // 1 minute
const MAX_STRIKES = 3;            // block after 3 probe hits in 1 minute

// Paths that no legitimate user would ever hit
const INSTANT_BLOCK_PATHS = [
  "/xmlrpc.php", "/wp-login.php", "/wp-admin", "/wp-content",
  "/wp-includes", "/.env", "/.git", "/phpmyadmin", "/pma",
  "/admin.php", "/administrator", "/cgi-bin", "/config.php",
  "/setup.php", "/install.php", "/solr", "/actuator",
  "/api/v1/pods", "/_profiler", "/telescope",
  "/manager/html", "/invoker", "/jmx-console", "/web-console",
  "/.aws", "/.docker", "/.ssh", "/.svn", "/.htaccess", "/.htpasswd",
  "/etc/passwd", "/proc/self", "/wp-cron.php",
  "/composer.json", "/database.yml", "/credentials",
];

// Suspicious file extensions — scanning for vulnerabilities
const SUSPICIOUS_EXTENSIONS = [
  ".php", ".asp", ".aspx", ".jsp", ".cgi", ".pl",
  ".sql", ".bak", ".old", ".orig", ".swp", ".DS_Store",
];

// Flood threshold — too many requests per minute = bot
const FLOOD_WINDOW = 60 * 1000;
const FLOOD_THRESHOLD = 200; // 200 requests/minute is clearly automated

app.use((req, res, next) => {
  // Use real client IP from Cloudflare, fall back to req.ip
  const ip = req.headers["cf-connecting-ip"] || req.ip;

  // Never block whitelisted IPs
  if (config.whitelistedIPs.includes(ip)) return next();

  // Check if already blocked in DB
  if (ipBlock.isBlocked(ip)) {
    return res.status(403).end();
  }

  const lowerPath = req.path.toLowerCase();
  const now = Date.now();

  // 1. Known exploit/scan paths — strike system
  const isProbe = INSTANT_BLOCK_PATHS.some(p => lowerPath.startsWith(p));
  if (isProbe) {
    const now = Date.now();
    const strikes = ipStrikes.get(ip) || { count: 0, firstSeen: now };
    if (now - strikes.firstSeen > STRIKE_WINDOW) { strikes.count = 0; strikes.firstSeen = now; }
    strikes.count++;
    ipStrikes.set(ip, strikes);

    if (strikes.count >= MAX_STRIKES) {
      ipBlock.block(ip, `Port scan: ${strikes.count} probes (${req.path})`, BLOCK_DURATION);
      ipStrikes.delete(ip);
      console.warn(`Blocked IP ${ip} for 24h — ${strikes.count} probe attempts (last: ${req.path})`);
      return res.status(403).end();
    }
    return res.status(404).end();
  }

  // 2. Suspicious file extension on non-static paths
  const ext = lowerPath.match(/\.[a-z0-9]+$/)?.[0];
  if (ext && SUSPICIOUS_EXTENSIONS.includes(ext) && !lowerPath.startsWith("/img/") && !lowerPath.startsWith("/css/") && !lowerPath.startsWith("/js/") && !lowerPath.startsWith("/fonts/")) {
    const strikes = ipStrikes.get(ip) || { count: 0, firstSeen: now };
    if (now - strikes.firstSeen > STRIKE_WINDOW) { strikes.count = 0; strikes.firstSeen = now; }
    strikes.count++;
    ipStrikes.set(ip, strikes);

    if (strikes.count >= 3) {
      ipBlock.block(ip, `Suspicious requests: ${strikes.count} hits (${ext})`, BLOCK_DURATION);
      ipStrikes.delete(ip);
      console.warn(`Blocked IP ${ip} for 24h — ${strikes.count} suspicious extension requests`);
      return res.status(403).end();
    }
    return res.status(404).end();
  }

  // 3. Request flood detection
  const flood = requestLog.get(ip) || { count: 0, firstSeen: now };
  if (now - flood.firstSeen > FLOOD_WINDOW) { flood.count = 0; flood.firstSeen = now; }
  flood.count++;
  requestLog.set(ip, flood);

  if (flood.count > FLOOD_THRESHOLD) {
    ipBlock.block(ip, `Request flood: ${flood.count} req/min`, BLOCK_DURATION);
    requestLog.delete(ip);
    console.warn(`Blocked IP ${ip} for 24h — request flood: ${flood.count}/min`);
    return res.status(429).end();
  }

  next();
});

// Prune expired blocks and stale tracking every hour
setInterval(() => {
  ipBlock.prune();
  const now = Date.now();
  for (const [ip, s] of ipStrikes) {
    if (now - s.firstSeen > STRIKE_WINDOW) ipStrikes.delete(ip);
  }
  for (const [ip, f] of requestLog) {
    if (now - f.firstSeen > FLOOD_WINDOW) requestLog.delete(ip);
  }
}, 60 * 60 * 1000);

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
      formAction: ["'self'", "https://checkout.stripe.com"],
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
app.use("/store/webhook", express.raw({ type: "application/json" }));
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
  if (req.path === "/store/webhook") {
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
          res.redirect("/auth/discord");
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
skinDraw.init();
tasks.init();
ipBlock.init();
vacScanner.init();

// VAC scan cron — 4 AM and 4 PM EST
cron.schedule("0 4,16 * * *", async () => {
  console.log("VAC cron: starting scheduled scan...");
  try {
    const result = await vacScanner.scan();
    const wlResult = await vacScanner.autoWatchlist();
    if (result.flagged > 0 || wlResult.count > 0) {
      const { sendWebhook } = require("./webhook");
      const playerList = wlResult.players.slice(0, 10).map(p =>
        `• **${p.arma_username || "Unknown"}** — [Steam](https://steamcommunity.com/profiles/${p.steam_id}) | [Profile](${config.siteUrl}/admin/player/${p.arma_id})`
      ).join("\n");
      const extra = wlResult.count > 10 ? `\n...and ${wlResult.count - 10} more` : "";
      sendWebhook({
        title: "Scheduled VAC Scan",
        description: `Scanned ${result.scanned} players, **${result.flagged} flagged**, ${wlResult.count} auto-watchlisted.\n\n${playerList}${extra}`,
        color: 0xef4444,
      });
    }
    console.log(`VAC cron: done — ${result.scanned} scanned, ${result.flagged} flagged, ${wlResult.count} watchlisted`);
  } catch (err) {
    console.error("VAC cron error:", err.message);
  }
}, { timezone: "America/New_York" });

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

  // Fetch leaderboard (retry once on timeout)
  try {
    const endpoint =
      tab === "alltime"
        ? "/user/topTenUserStatsAllTime/"
        : "/user/topTenUserStats/";
    let response;
    try {
      response = await apiClient.get(endpoint, {
        params: { token: config.apiToken },
        timeout: 45000,
      });
    } catch (firstErr) {
      if (firstErr.code === "ECONNABORTED" || firstErr.message.includes("timeout")) {
        console.warn("Leaderboard: first attempt timed out, retrying...");
        response = await apiClient.get(endpoint, {
          params: { token: config.apiToken },
          timeout: 60000,
        });
      } else {
        throw firstErr;
      }
    }
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
  res.send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /auth\nDisallow: /api\nDisallow: /store\n\nSitemap: ${base}/sitemap.xml\n`);
});

app.get("/sitemap.xml", (req, res) => {
  const base = config.siteUrl;
  const now = new Date().toISOString().split("T")[0];

  const staticPages = [
    { loc: "/", priority: "1.0", changefreq: "daily" },
    { loc: "/blog", priority: "0.8", changefreq: "daily" },
    { loc: "/products", priority: "0.8", changefreq: "weekly" },
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

app.get("/products", (req, res) => {
  const user = req.session.user || null;
  if (user) {
    if (user.avatar) {
      user.avatarUrl = "https://cdn.discordapp.com/avatars/" + user.discord_id + "/" + user.avatar + ".png?size=32";
    } else if (user.discord_id) {
      const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
      user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
    }
  }
  res.render("products", {
    page: "products",
    pageTitle: "Products & Perks",
    pageDescription: "Subscriptions, loadout skins, mystery bundles, and community support tiers for Arma Wasteland.",
    user,
  });
});

// ── Skin Draw ──

app.get("/draw", (req, res) => {
  if (req.query.key !== "%PassW0rd@") {
    return res.status(404).send("Not found");
  }
  const user = req.session.user || null;
  if (user) {
    if (user.avatar) {
      user.avatarUrl = "https://cdn.discordapp.com/avatars/" + user.discord_id + "/" + user.avatar + ".png?size=32";
    } else if (user.discord_id) {
      const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
      user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
    }
  }
  const pool = skinDraw.getDropRates();
  const recentDraws = skinDraw.getRecentDraws(10);

  res.render("draw", {
    page: "draw",
    pageTitle: "Mystery Skin Bundle",
    pageDescription: "Purchase a mystery bundle and receive a guaranteed cosmetic skin.",
    user,
    poolJson: JSON.stringify(pool),
    recentDrawsJson: JSON.stringify(recentDraws),
    canDraw: !!user?.discord_id,
  });
});

// Skin draw checkout — $14.99 per roll
app.post("/draw/checkout", async (req, res) => {
  if (req.body.draw_key !== "%PassW0rd@") {
    return res.status(404).send("Not found");
  }
  if (!req.session.user?.discord_id) {
    return res.redirect("/auth/discord");
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).send("Stripe is not configured.");
  }
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: "Mystery Skin Bundle" },
          unit_amount: 1499,
        },
        quantity: 1,
      }],
      success_url: `${config.siteUrl}/draw/result?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.siteUrl}/draw?canceled=1`,
      metadata: {
        type: "skin_draw",
        discord_id: req.session.user.discord_id,
        username: req.session.user.username,
      },
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error("Draw checkout error:", err.message);
    res.status(500).send("Failed to start checkout.");
  }
});

// Draw result page — shows after successful payment
app.get("/draw/result", async (req, res) => {
  const user = req.session.user || null;
  if (!user?.discord_id) return res.redirect("/auth/discord");

  if (user.avatar) {
    user.avatarUrl = "https://cdn.discordapp.com/avatars/" + user.discord_id + "/" + user.avatar + ".png?size=32";
  } else {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
  }

  const sessionId = req.query.session_id;
  if (!sessionId) return res.redirect("/draw");

  // Verify payment completed
  if (!process.env.STRIPE_SECRET_KEY) return res.redirect("/draw");
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid" || session.metadata?.type !== "skin_draw") {
      return res.redirect("/draw");
    }

    // Check if this session was already drawn (prevent re-rolls on refresh)
    const existing = skinDraw.getRecentDraws(100).find(d => d.stripe_session_id === sessionId);
    let result;
    if (existing) {
      // Already drawn, show same result
      const pool = skinDraw.getPool();
      result = pool.find(p => p.name === existing.result_name) || { name: existing.result_name, rarity: existing.result_rarity, image: null };
    } else {
      // Roll!
      result = skinDraw.draw();
      if (!result) return res.redirect("/draw?error=No skins in pool");

      // Record and fulfill
      skinDraw.recordDraw({
        discord_id: session.metadata.discord_id,
        result_name: result.name,
        result_rarity: result.rarity,
        stripe_session_id: sessionId,
      });

      // Grant the skin
      try {

        await axios.post(
          `${config.apiBaseUrl}/itemsUser/updateDiscordUserItemFromDiscord`,
          { discord_id: session.metadata.discord_id, item_name: result.game_item_name || result.name, request_type: "set", quantity: 1 },
          { params: { token: config.backendToken }, timeout: 15000, headers: { "Content-Type": "application/json" } }
        );
        console.log(`Skin Draw: granted "${result.name}" (${result.rarity}) to ${session.metadata.discord_id}`);
      } catch (grantErr) {
        console.error("Skin Draw grant error:", grantErr.response?.data?.message || grantErr.message);
        sendWebhookError("Skin Draw Grant", `Failed to grant "${result.name}" to ${session.metadata.discord_id}: ${grantErr.message}`);
      }


      const tierNames = { common: "Standard", uncommon: "Premium", rare: "Deluxe", epic: "Elite", legendary: "Exclusive" };
      sendWebhook({
        title: "Mystery Bundle Opened",
        description: `A **${tierNames[result.rarity] || result.rarity}** tier skin was received — **${result.name}**`,
        color: result.rarity === "epic" ? 0x9a60b4 : result.rarity === "rare" ? 0x5470c6 : result.rarity === "uncommon" ? 0x91cc75 : 0x9a9a9a,
      });
    }

    const pool = skinDraw.getDropRates();

    res.render("draw-result", {
      page: "draw",
      pageTitle: "Mystery Skin Bundle",
      pageDescription: "Your bundle has been opened!",
      user,
      result: JSON.stringify(result),
      poolJson: JSON.stringify(pool),
    });
  } catch (err) {
    console.error("Draw result error:", err.message);
    res.redirect("/draw");
  }
});

// ── Store / Build page ──

// Build page admin guard
function requireAdminForBuild(req, res, next) {
  if (!req.session.user || (!req.session.user.discord_id && req.session.user.authMethod !== "email")) {
    return res.redirect("/auth/discord");
  }
  if (!req.session.user.isAdmin) {
    return res.redirect("/");
  }
  next();
}

// 301 redirect old /build URLs to /store
app.get("/build*", (req, res) => {
  const newPath = req.originalUrl.replace(/^\/build/, "/store");
  res.redirect(301, newPath);
});

app.get("/store", (req, res) => {
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
    page: "store",
    pageTitle: "Store",
    pageDescription: "Support the server — grab skins, items, and more.",
    noIndex: true,
    user,
    categoriesJson: JSON.stringify(categories),
    success: req.query.success || null,
    canceled: req.query.canceled || null,
    error: req.query.error || null,
  });
});

// Account verification screen — shown when player has no linked Arma account
app.get("/store/verify", (req, res) => {
  const user = req.session.user || null;
  if (!user) return res.redirect("/auth/discord");

  if (user.avatar) {
    user.avatarUrl = "https://cdn.discordapp.com/avatars/" + user.discord_id + "/" + user.avatar + ".png?size=32";
  } else if (user.discord_id) {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
  }

  res.render("build-verify", {
    page: "store",
    pageTitle: "Link Your Account",
    pageDescription: "Link your game account to purchase items.",
    noIndex: true,
    user,
    error: req.query.error === "not_found" ? "Account not found yet. Make sure you've joined a game server, then try again." : null,
  });
});

// POST /store/verify — submit temp password to link Discord to Arma account
app.post("/store/verify", async (req, res) => {
  const user = req.session.user;
  if (!user?.discord_id) return res.redirect("/auth/discord");

  const tempPassword = (req.body.temp_password || "").trim();
  if (!tempPassword) {
    return res.redirect("/store/verify?error=not_found");
  }

  if (user.avatar) {
    user.avatarUrl = "https://cdn.discordapp.com/avatars/" + user.discord_id + "/" + user.avatar + ".png?size=32";
  } else {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
  }

  try {
    console.log(`Store verify: submitting temp_password="${tempPassword}" for discord_id=${user.discord_id}`);
    const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
    const verifyRes = await apiClient.post("/user/verifyUsersByTempPassword/", {
      temp_password: tempPassword,
      discord_id: user.discord_id,
      token: config.apiToken,
    });

    console.log(`Store verify response:`, verifyRes.status, JSON.stringify(verifyRes.data).slice(0, 300));

    res.render("build-verify", {
      page: "store",
      pageTitle: "Account Linked",
      pageDescription: "Your account has been verified!",
      noIndex: true,
      user,
      success: "Your Arma account is now linked to your Discord! You can now purchase items from the store.",
    });
  } catch (err) {
    console.error("Store verify error:", err.response?.status, JSON.stringify(err.response?.data));
    const msg = err.response?.data?.message || "Invalid or expired verification code. Please check your code and try again.";
    res.render("build-verify", {
      page: "store",
      pageTitle: "Link Your Account",
      pageDescription: "Link your game account to purchase items.",
      noIndex: true,
      user,
      error: msg,
    });
  }
});

// Stripe checkout session creation
app.post("/store/checkout", async (req, res) => {
  if (!req.session.user?.discord_id) {
    return res.redirect("/auth/discord");
  }

  // Verify user has a linked Arma account via backend API
  try {
    const discordId = req.session.user.discord_id;
    console.log(`Store checkout: verifying discord_id=${discordId}`);
    console.log(`Store checkout: calling ${config.apiBaseUrl}/user/getAllPlayerStatsByDiscordID with token=${config.apiToken?.slice(0, 4)}...`);

    const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 10000, headers: { "Content-Type": "application/json" } });
    const verifyRes = await apiClient({
      method: "GET",
      url: "/user/getAllPlayerStatsByDiscordID",
      data: {
        discord_id: discordId,
        token: config.apiToken,
      },
    });

    console.log(`Store checkout: response status=${verifyRes.status}`);
    console.log(`Store checkout: response data=`, JSON.stringify(verifyRes.data).slice(0, 300));

    if (!verifyRes.data || !verifyRes.data.arma_username) {
      console.log(`Store checkout: no arma_username found in response for discord_id=${discordId}`);
      return res.redirect("/store/verify");
    }
    console.log(`Store checkout: verified ${discordId} — player: ${verifyRes.data.arma_username}`);
  } catch (verifyErr) {
    console.error("Store checkout verify error:", verifyErr.message);
    console.error("Store checkout verify status:", verifyErr.response?.status);
    console.error("Store checkout verify data:", JSON.stringify(verifyErr.response?.data));
    if (verifyErr.response?.status === 404) {
      return res.redirect("/store/verify");
    }
    // Don't block checkout on API errors — log and continue
  }

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

  // Split cart into one-time and subscription items
  const SUBSCRIPTION_CATEGORIES = ["subscriptions"];
  const oneTimeItems = [];
  const subItems = [];
  const cartProducts = [];

  for (const item of cart) {
    const product = store.getProductById(parseInt(item.id));
    if (!product || !product.active) continue;
    const qty = Math.max(1, Math.min(99, parseInt(item.qty) || 1));
    cartProducts.push({ id: product.id, name: product.name, qty, category: product.category });

    if (SUBSCRIPTION_CATEGORIES.includes(product.category)) {
      subItems.push({ product, qty });
    } else {
      oneTimeItems.push({ product, qty });
    }
  }

  if (oneTimeItems.length === 0 && subItems.length === 0) {
    return res.status(400).send("No valid items in cart.");
  }

  // Can't mix one-time and subscription in the same Stripe session
  if (oneTimeItems.length > 0 && subItems.length > 0) {
    return res.status(400).send("Cannot checkout one-time purchases and subscriptions together. Please purchase them separately.");
  }

  const isSubscription = subItems.length > 0;
  const items = isSubscription ? subItems : oneTimeItems;

  // Build Stripe line items
  const lineItems = [];
  for (const { product, qty } of items) {
    if (product.stripe_price_id && !isSubscription) {
      // Only use pre-synced Stripe prices for one-time purchases
      // Subscriptions need price_data with recurring interval
      lineItems.push({ price: product.stripe_price_id, quantity: qty });
    } else {
      const effectivePrice = store.getEffectivePrice(product);
      const priceData = {
        currency: "usd",
        product_data: { name: product.name },
        unit_amount: effectivePrice,
      };
      if (isSubscription) {
        priceData.recurring = { interval: "month" };
      }
      lineItems.push({ price_data: priceData, quantity: qty });
    }
  }

  try {
    const sessionParams = {
      mode: isSubscription ? "subscription" : "payment",
      line_items: lineItems,
      success_url: `${config.siteUrl}/store?success=1`,
      cancel_url: `${config.siteUrl}/store?canceled=1`,
      metadata: {
        app: "armawasteland",
        discord_id: req.session.user?.discord_id || "guest",
        username: req.session.user?.username || "guest",
        cart_items: JSON.stringify(cartProducts),
      },
    };
    // Store metadata on the subscription itself for renewal lookups
    if (isSubscription) {
      sessionParams.subscription_data = {
        metadata: {
          app: "armawasteland",
          discord_id: req.session.user?.discord_id || "guest",
          cart_items: JSON.stringify(cartProducts),
        },
      };
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.redirect(303, session.url);
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    sendWebhookError("Stripe Checkout", err.message);
    res.status(500).send("Failed to create checkout session.");
  }
});

// Stripe webhook — receives payment confirmations
// This endpoint is CSRF-exempt (handled by the CSRF middleware skipping /store/webhook)
app.post("/store/webhook", async (req, res) => {
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
      const discordIdForRecord = session.metadata?.discord_id || null;
      const discordUsernameForRecord = session.metadata?.username || null;
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
      for (const item of lineItems.data) {
        store.recordPurchase({
          stripe_session_id: session.id,
          product_name: item.description || "Unknown",
          quantity: item.quantity || 1,
          amount: item.amount_total || 0,
          discord_id: discordIdForRecord,
          discord_username: discordUsernameForRecord,
        });
      }
      console.log(`Stripe: recorded ${lineItems.data.length} line items for session ${session.id}`);

      // Fulfill — grant items to the buyer via backend API
      // Only fulfill loadout skins — subscriptions/supporter tiers need manual Discord role assignment
      const FULFILLABLE_CATEGORIES = ["loadout"];
      const SKIP_PRODUCTS = ["Random Skin Draw", "Mystery Skin Bundle"]; // handled by /draw flow

      const discordId = session.metadata?.discord_id;
      const cartItems = session.metadata?.cart_items ? JSON.parse(session.metadata.cart_items) : [];
      const fulfilled = [];
      const skipped = [];
      const fulfillErrors = [];

      if (discordId && discordId !== "guest" && cartItems.length > 0) {

        const apiBaseUrl = config.apiBaseUrl;
        const backendToken = config.backendToken;

        for (const cartItem of cartItems) {
          const product = store.getProductById(cartItem.id);
          if (!product) {
            fulfillErrors.push(`Product ID ${cartItem.id} not found in DB`);
            continue;
          }

          // Skip non-skin products
          if (SKIP_PRODUCTS.includes(product.name) || !FULFILLABLE_CATEGORIES.includes(product.category)) {
            skipped.push(product.name);
            console.log(`Stripe fulfillment: skipped "${product.name}" (category: ${product.category}) — requires manual fulfillment`);
            continue;
          }

          const gameItemName = product.game_item_name || product.name;
          try {
            await axios.post(
              `${apiBaseUrl}/itemsUser/updateDiscordUserItemFromDiscord`,
              { discord_id: discordId, item_name: gameItemName, request_type: "set", quantity: cartItem.qty },
              { params: { token: backendToken }, timeout: 15000, headers: { "Content-Type": "application/json" } }
            );
            fulfilled.push(product.name);
            console.log(`Stripe fulfillment: granted "${gameItemName}" x${cartItem.qty} to ${discordId}`);
          } catch (itemErr) {
            const msg = itemErr.response?.data?.message || itemErr.message;
            fulfillErrors.push(`${product.name}: ${msg}`);
            console.error(`Stripe fulfillment error for "${product.name}":`, msg);
          }
        }
      }


      const buyerLabel = discordIdForRecord && discordIdForRecord !== "guest"
        ? `<@${discordIdForRecord}>`
        : (discordUsernameForRecord || "Guest");
      const fulfillSummary = fulfilled.length > 0 ? `\nDelivered: ${fulfilled.join(", ")}` : "";
      const skippedSummary = skipped.length > 0 ? `\nManual fulfillment needed: ${skipped.join(", ")}` : "";
      const errorSummary = fulfillErrors.length > 0 ? `\nErrors: ${fulfillErrors.join("; ")}` : "";
      sendWebhook({
        title: "Purchase Completed",
        description: `${buyerLabel} spent **$${(session.amount_total / 100).toFixed(2)}** — ${lineItems.data.length} item(s)${fulfillSummary}${skippedSummary}${errorSummary}`,
        color: fulfillErrors.length > 0 ? 0xF59E0B : 0x22c55e,
      });

      if (fulfillErrors.length > 0) {
        sendWebhookError("Stripe Fulfillment Errors", fulfillErrors.join("\n"));
      }

      // Assign Donator role to the buyer
      if (discordIdForRecord && discordIdForRecord !== "guest") {
        try {
          const { getClient } = require("./discord-bot");
          const bot = getClient();
          if (bot?.isReady()) {
            const guild = bot.guilds.cache.get(config.discordGuildId);
            if (guild) {
              const member = await guild.members.fetch(discordIdForRecord).catch(() => null);
              if (member) {
                await member.roles.add("1282418153925640402");
                console.log(`Donator role assigned to ${discordIdForRecord}`);
              }
            }
          }
        } catch (roleErr) {
          console.warn(`Failed to assign donator role to ${discordIdForRecord}: ${roleErr.message}`);
        }
      }
    } catch (fulfillErr) {
      console.error("Order fulfillment error:", fulfillErr.message);
      sendWebhookError("Stripe Fulfillment", fulfillErr.message);
    }

    // Apply subscription perks if this was a subscription checkout
    if (session.mode === "subscription") {
      const discordId = session.metadata?.discord_id;
      const cartItems = session.metadata?.cart_items ? JSON.parse(session.metadata.cart_items) : [];
      if (discordId && discordId !== "guest") {
        for (const cartItem of cartItems) {
          try {
            await subscriptionPerks.applyPerks(discordId, cartItem.name);
          } catch (perkErr) {
            console.error("Subscription perk error:", perkErr.message);
            sendWebhookError("Subscription Perk Error", `${cartItem.name}: ${perkErr.message}`);
          }
        }
      }
    }
  }

  // ── Chargeback / Refund — revoke items ──
  if (event.type === "charge.disputed" || event.type === "charge.refunded") {
    const charge = event.data.object;
    const isDispute = event.type === "charge.disputed";
    const label = isDispute ? "Chargeback" : "Refund";

    console.log(`Stripe ${label}: charge ${charge.id} — $${((charge.amount || 0) / 100).toFixed(2)}`);

    try {
      // Get the checkout session from the payment intent
      const paymentIntentId = charge.payment_intent;
      if (paymentIntentId) {
        const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
        const session = sessions.data[0];

        if (session?.metadata?.discord_id && session.metadata.discord_id !== "guest" && session.metadata.cart_items) {
          const discordId = session.metadata.discord_id;
          const cartItems = JSON.parse(session.metadata.cart_items);
  
          const revoked = [];

          for (const cartItem of cartItems) {
            const product = store.getProductById(cartItem.id);
            if (!product) continue;

            const revokeItemName = product.game_item_name || product.name;
            try {
              await axios.post(
                `${config.apiBaseUrl}/itemsUser/updateDiscordUserItemFromDiscord`,
                { discord_id: discordId, item_name: revokeItemName, request_type: "remove", quantity: cartItem.qty },
                { params: { token: config.backendToken }, timeout: 15000, headers: { "Content-Type": "application/json" } }
              );
              revoked.push(product.name);
              console.log(`Stripe ${label}: revoked "${revokeItemName}" from ${discordId}`);
            } catch (revokeErr) {
              console.error(`Stripe ${label}: failed to revoke "${product.name}":`, revokeErr.response?.data?.message || revokeErr.message);
            }
          }

          // Update purchase status in DB
          if (session.id) {
            try { store.updatePurchaseStatus(session.id, isDispute ? "disputed" : "refunded"); } catch {}
          }

          sendWebhookError(`${label} — Items Revoked`, `**$${((charge.amount || 0) / 100).toFixed(2)}** from Discord user ${discordId}\nRevoked: ${revoked.length > 0 ? revoked.join(", ") : "none (lookup failed)"}`);

          auditLog.log("store", label, `$${((charge.amount || 0) / 100).toFixed(2)} — revoked ${revoked.join(", ")} from ${discordId}`, { username: "Stripe", discord_id: null });
        } else {
          // Try to get discord_id from the charge metadata or customer
          const discordId = session?.metadata?.discord_id || null;
          if (discordId && discordId !== "guest") {
            // Subscription refund — revoke subscription perks (bank limit)
            try {
              const subscriptionPerks = require("./subscription-perks");
              await subscriptionPerks.revokePerks(discordId);
              sendWebhookError(`${label} — Subscription Perks Revoked`, `**$${((charge.amount || 0) / 100).toFixed(2)}** from <@${discordId}>\nBank limit reset to default.`);
            } catch (perkErr) {
              sendWebhookError(`${label} — Manual Review Needed`, `**$${((charge.amount || 0) / 100).toFixed(2)}** from <@${discordId}> — auto-revoke failed: ${perkErr.message}. Charge: ${charge.id}`);
            }
          } else {
            sendWebhookError(`${label} — Manual Review Needed`, `**$${((charge.amount || 0) / 100).toFixed(2)}** — could not find session metadata to auto-revoke items. Charge: ${charge.id}`);
          }
        }
      }
    } catch (revokeErr) {
      console.error(`Stripe ${label} handler error:`, revokeErr.message);
      sendWebhookError(`${label} Error`, revokeErr.message);
    }
  }

  // ── Subscription canceled — revoke perks ──
  if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
    const subscription = event.data.object;
    if (subscription.metadata?.app) return res.json({ received: true });
    const isCanceled = subscription.status === "canceled" || subscription.status === "unpaid";

    if (isCanceled) {
      console.log(`Stripe subscription ${event.type}: ${subscription.id} — status: ${subscription.status}`);

      try {
        // Get the checkout session that created this subscription
        const sessions = await stripe.checkout.sessions.list({ subscription: subscription.id, limit: 1 });
        const session = sessions.data[0];

        // Also check subscription metadata directly (more reliable for renewals)
        const discordId = session?.metadata?.discord_id || subscription.metadata?.discord_id;
        const cartItemsRaw = session?.metadata?.cart_items || subscription.metadata?.cart_items;
        const cartItems = cartItemsRaw ? JSON.parse(cartItemsRaw) : [];

        if (discordId && discordId !== "guest") {
          // Revoke subscription perks (reset bank limit)
          await subscriptionPerks.revokePerks(discordId);

          sendWebhookError("Subscription Canceled", `Discord user ${discordId} — subscription ${subscription.id} is now ${subscription.status}. ${cartItems.map(i => i.name).join(", ")}\nBank limit reset to ${subscriptionPerks.DEFAULT_BANK_LIMIT.toLocaleString()}`);

          auditLog.log("store", "Subscription Canceled", `${subscription.id} — ${cartItems.map(i => i.name).join(", ")} for ${discordId} — perks revoked`, { username: "Stripe" });
        } else {
          sendWebhookError("Subscription Canceled", `Subscription ${subscription.id} canceled — could not find Discord ID for auto-revoke.`);
        }
      } catch (subErr) {
        console.error("Subscription cancel handler error:", subErr.message);
        sendWebhookError("Subscription Cancel Error", subErr.message);
      }
    }
  }

  // ── Invoice payment failed (subscription renewal failed) ──
  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object;
    console.log(`Stripe invoice payment failed: ${invoice.id} — subscription: ${invoice.subscription}`);
    sendWebhookError("Subscription Payment Failed", `Invoice ${invoice.id} — $${((invoice.amount_due || 0) / 100).toFixed(2)} failed. Subscription: ${invoice.subscription || "unknown"}`);
  }

  // ── Invoice paid — grant monthly subscription skins on renewal ──
  if (event.type === "invoice.paid") {
    const invoice = event.data.object;
    // Only process recurring renewals, not the initial subscription payment
    if (invoice.billing_reason === "subscription_cycle") {
      console.log(`Stripe subscription renewal paid: ${invoice.id} — $${((invoice.amount_paid || 0) / 100).toFixed(2)}`);
      try {
        // Get metadata from the subscription object directly
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const discordId = subscription.metadata?.discord_id;
        const cartItems = subscription.metadata?.cart_items ? JSON.parse(subscription.metadata.cart_items) : [];

        if (discordId && discordId !== "guest") {
          for (const cartItem of cartItems) {
            const tier = subscriptionPerks.getTierForProduct(cartItem.name);
            if (tier && tier.skinsPerMonth > 0) {
              console.log(`Stripe renewal: granting ${tier.skinsPerMonth} skins for "${cartItem.name}" to ${discordId}`);
              const results = await subscriptionPerks.grantSkins(discordId, tier.skinsPerMonth);
              sendWebhook({
                title: "Monthly Subscription Skins Delivered",
                description: `**${cartItem.name}** renewal\n${results.map(s => `${s.name} (${s.rarity})${s.success ? "" : " FAILED"}`).join("\n")}`,
                color: 0x5865F2,
              });
            }
          }
        }
      } catch (renewErr) {
        console.error("Subscription renewal perk error:", renewErr.message);
        sendWebhookError("Subscription Renewal Error", renewErr.message);
      }
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
