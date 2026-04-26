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
const economyTracker = require("./economy-tracker");
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
const BLOCK_DURATION = 0;                           // permanent for probe/scan
const BLOCK_DURATION_LONG = 0;                      // permanent for repeat offenders
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
      includes: (arr, val) => Array.isArray(arr) && arr.includes(val),
      gt: (a, b) => a > b,
      lt: (a, b) => a < b,
      gte: (a, b) => a >= b,
      lte: (a, b) => a <= b,
      add: (a, b) => a + b,
      subtract: (a, b) => a - b,
      divideBy: (a, b) => (b ? (a / b).toFixed(2) : "0.00"),
      multiply: (a, b) => (Number(a) * Number(b)).toLocaleString(),
      formatNumber: (val) => {
        if (val === undefined || val === null) return "0";
        return Number(val).toLocaleString();
      },
      json: (val) => JSON.stringify(val ?? null).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026"),
      formatBytes: (bytes) => {
        const n = Number(bytes || 0);
        if (n < 1024) return n + " B";
        if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
        if (n < 1024 ** 3) return (n / (1024 ** 2)).toFixed(1) + " MB";
        if (n < 1024 ** 4) return (n / (1024 ** 3)).toFixed(2) + " GB";
        return (n / (1024 ** 4)).toFixed(2) + " TB";
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
      formatDateEST: (val) => {
        if (!val) return "-";
        const d = new Date(val);
        if (isNaN(d)) return val;
        return d.toLocaleDateString("en-US", {
          year: "numeric", month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit",
          timeZone: "America/New_York",
        }) + " EST";
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
  res.locals.outfitsEnabled = require("./feature-flags").isEnabled("outfits");
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
      // For POST routes, redirect to a sensible GET page
      const safePath = req.path.replace(/\/edit\/\d+/, "").replace(/\/delete\/\d+/, "") || "/";
      return res.redirect(safePath + "?error=Form+expired.+Please+try+again.");
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
require("./profile-customizations").init();
require("./wasted-coins").init();
auditLog.init();
skinDraw.init();
tasks.init();
ipBlock.init();
vacScanner.init();
economyTracker.init();

// VAC scan cron — 4 AM and 4 PM EST
cron.schedule("0 4,16 * * *", async () => {
  console.log("VAC cron: starting scheduled scan...");
  try {
    const result = await vacScanner.scan();
    const wlResult = await vacScanner.autoWatchlist();
    if (result.flagged > 0 || wlResult.count > 0) {
      const { sendVacWebhook } = require("./webhook");
      const playerList = wlResult.players.slice(0, 10).map(p =>
        `• **${p.arma_username || "Unknown"}** — [Steam](https://steamcommunity.com/profiles/${p.steam_id}) | [Profile](${config.siteUrl}/admin/player/${p.arma_id})`
      ).join("\n");
      const extra = wlResult.count > 10 ? `\n...and ${wlResult.count - 10} more` : "";
      sendVacWebhook({
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

// Economy snapshot every hour — track total cash in game
cron.schedule("0 * * * *", async () => {
  try {
    const res = await apiClient({ method: "GET", url: "/admin/cash-rollup", data: { token: config.adminApiToken } });
    if (res.data?.total_cash_balance) {
      economyTracker.recordSnapshot(res.data.total_cash_balance, res.data.player_count || 0);
    }
  } catch (err) {
    console.error("Economy snapshot error:", err.message);
  }
});

// Record server metrics every 15 minutes
cron.schedule("*/15 * * * *", async () => {
  try {
    const bmStatus = await bm.getFreshStatus();
    if (bmStatus.servers.length > 0) {
      // Map ArmaHQ labels to AMP instance names for consistent chart series
      const NAME_MAP = { "Server 1": "Wasteland - Sectorlink", "Server 2": "Wasteland #2" };
      const instances = bmStatus.servers.map(srv => ({
        instanceId: srv.id || srv.label.replace(/\s+/g, "-").toLowerCase(),
        friendlyName: NAME_MAP[srv.label] || srv.label || srv.name,
        players: { current: srv.players, max: srv.maxPlayers, percent: srv.maxPlayers ? Math.round((srv.players / srv.maxPlayers) * 100) : 0 },
        cpu: { percent: 0 },
        memory: { value: 0, max: 0 },
      }));
      metricsHistory.record(instances, bmStatus.servers);
      console.log(`Metrics cron: recorded ${instances.length} servers — ${bmStatus.totalPlayers} total players`);
    }
  } catch (err) {
    console.error("Metrics cron error:", err.message);
  }
});

const rcon = require("./rcon");
rcon.init();

// Lottery + Skin Lottery + Kill Wagers
const lottery = require("./lottery");
lottery.init();
const skinLottery = require("./skin-lottery");
skinLottery.init();
const killWagers = require("./kill-wagers");
killWagers.init();
const trailGame = require("./trail-game");
trailGame.init();
const armsDealer = require("./arms-dealer");
armsDealer.init();
const polls = require("./poll");
polls.init();
const rulesAck = require("./rules-ack");
rulesAck.init();
const featureFlags = require("./feature-flags");
featureFlags.load();
const outfitsModule = require("./outfits");
outfitsModule.init();

// Twice daily at 13:00 and 01:00 UTC (~9am/9pm EST): post/edit the active outfit-wars Discord embed
cron.schedule("0 1,13 * * *", async () => {
  try {
    await require("./wars-broadcaster").broadcast();
  } catch (err) {
    console.error("wars-broadcaster cron failed:", err.message);
  }
});

// Daily at 12:00 UTC (7am EST): post lottery countdown to public channel
cron.schedule("0 12 * * *", () => {
  try {
    const { sendPublicWebhook } = require("./webhook");
    const lot = require("./lottery");
    const sl = require("./skin-lottery");
    const coinPot = lot.getCurrentPot();
    const skinPot = sl.getCurrentPot();
    const next = lot.nextDrawDate();
    const now = new Date();
    const daysLeft = Math.ceil((next.getTime() - now.getTime()) / 86400000);
    if (daysLeft <= 0) return; // draw day or past — the draw cron handles it
    const dayWord = daysLeft === 1 ? "day" : "days";
    const drawTs = Math.floor(next.getTime() / 1000);
    const lines = [
      `**Drawing in ${daysLeft} ${dayWord}** — <t:${drawTs}:F>`,
      ``,
      `**Coin Lottery:** ${coinPot.tickets} tickets from ${coinPot.players} players — pot: **${coinPot.pot.toLocaleString()} 💀**`,
      `**Skin Lottery:** ${skinPot.tickets} tickets from ${skinPot.players} players`,
      ``,
      `Buy in with \`/lottery buy\` (100 💀/ticket) or \`/skin-lottery buy\` (250 💀/ticket) — max 10/day.`,
      `Earn coins free with \`/daily\`.`,
    ];
    sendPublicWebhook({
      title: "🎰 Weekly Lottery Update",
      description: lines.join("\n"),
      color: 0xa855f7,
    });
  } catch (err) {
    console.error("Lottery countdown cron error:", err.message);
  }
});

// Hourly: settle finished kill wagers + run weekly lottery draw
cron.schedule("5 * * * *", async () => {
  try {
    const wc = require("./wasted-coins");
    const events = await killWagers.tick(wc);
    for (const ev of events) {
      try {
        const { sendPublicWebhook } = require("./webhook");
        if (ev.kind === "expired") {
          sendPublicWebhook({
            title: "💀 Kill Wager Expired",
            description: `<@${ev.wager.challenger_discord_id}>'s **${ev.wager.amount.toLocaleString()} 💀** challenge to <@${ev.wager.target_discord_id}> expired with no answer. Refunded.`,
            color: 0x6b7280,
          });
        } else if (ev.kind === "settled") {
          const r = ev.result;
          if (r.isTie) {
            sendPublicWebhook({
              title: "💀 Kill Wager — Tie",
              description: `<@${r.challenger}> and <@${r.target}> both gained ${r.challengerDelta} kills. Antes refunded.`,
              color: 0x6b7280,
            });
          } else {
            const loser = r.winner === r.challenger ? r.target : r.challenger;
            sendPublicWebhook({
              title: "💀 Kill Wager Settled",
              description: `<@${r.winner}> beat <@${loser}> ${r.winner === r.challenger ? r.challengerDelta : r.targetDelta}–${r.winner === r.challenger ? r.targetDelta : r.challengerDelta} kills and won **${r.payout.toLocaleString()} 💀** (pot ${r.pot.toLocaleString()}, ${r.houseRake} rake).`,
              color: 0x22c55e,
            });
          }
        }
      } catch (e) { console.error("Wager webhook error:", e.message); }
    }
  } catch (err) {
    console.error("Kill wager cron error:", err.message);
  }

  try {
    const wc = require("./wasted-coins");
    const drawn = lottery.checkAndDraw(wc);
    if (drawn && drawn.status === "completed") {
      const { sendPublicWebhook } = require("./webhook");
      sendPublicWebhook({
        title: "💀 Weekly Lottery Winner",
        description: `<@${drawn.winner.discord_id}> won the **${drawn.payout.toLocaleString()} 💀** pot for the week of ${drawn.weekId}!\n\n${drawn.total_tickets} tickets in play, ${drawn.house_rake.toLocaleString()} 💀 house rake.\n\nNext draw is next Friday — buy tickets with \`/lottery buy\`.`,
        color: 0xfbbf24,
      });
    } else if (drawn && drawn.status === "no_tickets") {
      const { sendPublicWebhook } = require("./webhook");
      sendPublicWebhook({
        title: "💀 Lottery — No Winner",
        description: `No tickets were sold for the week of ${drawn.weekId}. Buy in next week with \`/lottery buy\`.`,
        color: 0x6b7280,
      });
    }
  } catch (err) {
    console.error("Lottery cron error:", err.message);
  }

  // Outfit wars — settle finished, expire stale
  try {
    const wc = require("./wasted-coins");
    const outfitEvents = await outfitsModule.tick(wc);
    for (const ev of outfitEvents) {
      try {
        const { sendPublicWebhook } = require("./webhook");
        if (ev.kind === "expired") {
          sendPublicWebhook({
            title: "⚔️ War Expired",
            description: `War #${ev.war.id} expired without being accepted. Wager refunded.`,
            color: 0x6b7280,
          });
        } else if (ev.kind === "settled") {
          const r = ev.result;
          const winTag = r.winnerId ? (r.winnerId === r.challenger.id ? r.challenger.tag : r.defender.tag) : null;
          sendPublicWebhook({
            title: r.isTie ? "⚔️ War Ended — Tie" : `⚔️ War Won by [${winTag}]`,
            description: `**[${r.challenger.tag}]** ${r.challengerScore} — ${r.defenderScore} **[${r.defender.tag}]**${r.payout ? `\n💀 ${r.payout.toLocaleString()} to [${winTag}] treasury` : ""}`,
            color: r.isTie ? 0x6b7280 : 0x22c55e,
          });
        }
      } catch (e) { console.error("Outfit war webhook error:", e.message); }
    }
  } catch (err) {
    console.error("Outfit war cron error:", err.message);
  }

  // Auto-close expired polls
  try {
    const polls = require("./poll");
    const expired = polls.getExpiredOpenPolls();
    for (const p of expired) {
      try {
        polls.adminClosePoll(p.id);
        // Edit the original poll message to show closed state
        if (p.message_id && p.channel_id) {
          try {
            const bot = require("./discord-bot").getClient();
            if (bot?.isReady()) {
              const channel = await bot.channels.fetch(p.channel_id).catch(() => null);
              const msg = channel ? await channel.messages.fetch(p.message_id).catch(() => null) : null;
              if (msg) {
                await msg.edit({
                  embeds: [{
                    color: 0x6b7280,
                    title: `📊 Poll #${p.id} — Closed`,
                    description: `**${p.question}**\n\n_This poll is now closed._`,
                    footer: { text: "Closed (auto-expired)" },
                  }],
                  components: [],
                });
              }
            }
          } catch (e) { console.warn(`Poll #${p.id} edit failed:`, e.message); }
        }
        console.log(`Polls: auto-closed expired poll #${p.id}`);
      } catch (e) { console.error(`Poll #${p.id} auto-close error:`, e.message); }
    }
  } catch (err) {
    console.error("Poll expiry cron error:", err.message);
  }

  // Skin lottery — same Friday cadence
  try {
    const skinDrawn = await skinLottery.checkAndDraw();
    if (skinDrawn && skinDrawn.status === "completed" && skinDrawn.skin) {
      const { sendPublicWebhook, sendWebhookError } = require("./webhook");
      const grantNote = skinDrawn.grant_status === "failed"
        ? `\n\n⚠️ Auto-grant failed: \`${skinDrawn.grant_error}\`. An admin has been notified to grant manually.`
        : `\n\nThe skin has been added to their in-game inventory.`;
      sendPublicWebhook({
        title: "💀🎨 Weekly Skin Lottery Winner",
        description: `<@${skinDrawn.winner.discord_id}> won **${skinDrawn.skin.name}** (${skinDrawn.skin.rarity}) for the week of ${skinDrawn.weekId}!\n\n${skinDrawn.total_tickets} tickets in play.${grantNote}\n\nNext drawing is next Friday — buy tickets with \`/skin-lottery buy\`.`,
        color: 0x8B5CF6,
      });
      if (skinDrawn.grant_status === "failed") {
        sendWebhookError("Skin Lottery Grant Failed", `Winner: ${skinDrawn.winner.discord_id}, Skin: ${skinDrawn.skin.name}, Error: ${skinDrawn.grant_error}`);
      }
    } else if (skinDrawn && skinDrawn.status === "no_tickets") {
      const { sendPublicWebhook } = require("./webhook");
      sendPublicWebhook({
        title: "💀🎨 Skin Lottery — No Winner",
        description: `No skin-lottery tickets sold for the week of ${skinDrawn.weekId}. Buy in next week with \`/skin-lottery buy\`.`,
        color: 0x6b7280,
      });
    }
  } catch (err) {
    console.error("Skin lottery cron error:", err.message);
  }
});

require("./discord-bot").init();

app.use(analytics.middleware);

app.use("/auth", require("./routes/auth"));
const adminLimiter = rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use("/admin", adminLimiter, require("./routes/admin"));
app.use("/api", apiLimiter, require("./routes/api"));
app.use("/blog", require("./routes/blog"));
app.use("/profile", require("./routes/profile"));
app.use("/outfits", require("./routes/outfits"));

// /outfit (singular) — personal shortcut: takes the logged-in user to their own outfit, like /profile
app.get("/outfit", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord?returnTo=/outfit");
  try {
    const outfits = require("./outfits");
    const mine = await outfits.getMemberOutfit(user.discord_id);
    if (mine?.outfit_id) return res.redirect(`/outfits/${mine.outfit_id}`);
    return res.redirect("/outfits/create");
  } catch (err) {
    console.error("/outfit redirect failed:", err.message);
    return res.redirect("/outfits");
  }
});

async function fetchHomeData(req) {
  const tab = req.query.tab === "alltime" ? "alltime" : "season";
  const user = req.session.user || null;

  let leaderboard = [];
  let leaderboardError = false;
  let playtimeLeaderboard = { players: [], error: null };

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
    const raw = Array.isArray(response.data) ? response.data : [];
    const slugify = require("./profile-slug").slugify;
    leaderboard = raw.map(p => ({ ...p, slug: slugify(p.arma_username) }));
  } catch (error) {
    console.error("Leaderboard error:", error.message);
    sendWebhookError("Leaderboard Fetch", error.message);
    leaderboardError = true;
  }

  // Playtime leaderboard — top 10 by total time on server
  try {
    const ptRes = await apiClient.get("/user/getTopPlayersByPlaytime", {
      params: { limit: 10, token: config.apiToken },
      timeout: 15000,
    });
    const raw = ptRes.data?.players || [];
    const slugify = require("./profile-slug").slugify;
    playtimeLeaderboard.players = raw.map(p => {
      const mins = Number(p.arma_time_played || 0);
      const hrs = Math.floor(mins / 60);
      const m = mins % 60;
      return { ...p, slug: slugify(p.arma_username), hoursLabel: hrs > 0 ? `${hrs.toLocaleString()}h ${m}m` : `${m}m` };
    });
  } catch (err) {
    playtimeLeaderboard.error = err.response?.status === 404 ? "Endpoint not implemented on game server" : err.message;
    console.error("Playtime leaderboard error:", err.message);
  }

  // Build avatar URL for nav
  if (user) {
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

  return { user, tab, leaderboard, leaderboardError };
}

// ── Player Profile Page (logged-in users) ──
app.get("/profile", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");

  // Build avatar URL
  if (user.avatar && user.discord_id) {
    user.avatarUrl = `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png?size=128`;
  } else if (user.discord_id) {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  } else {
    user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/0.png";
  }

  const statsTab = req.query.stats === "alltime" ? "alltime" : "season";
  let stats = null;
  let statsNotLinked = false;
  let statsError = null;
  let miscStats = [];
  let atmBalance = null;
  let steamId = user.steamId || null;
  let recentKills = [];
  let leaderboardRank = null;

  try {
    const statsEndpoint = statsTab === "alltime"
      ? "/user/getAllPlayerStatsByDiscordID"
      : "/user/getAllPlayerStatsByDiscordIDCurrentSeason/";
    const response = await apiClient({
      method: "GET",
      url: statsEndpoint,
      data: { discord_id: user.discord_id, token: config.apiToken },
    });
    stats = response.data;

    miscStats = MISC_FIELDS.filter(
      (f) => stats[f.key] !== undefined && stats[f.key] !== null
    ).map((f) => ({ label: f.label, value: stats[f.key] }));

    // Fetch ATM balance, recent kills, and leaderboard rank in parallel
    const [cashRes, killsRes, lbRes] = await Promise.allSettled([
      stats.arma_id ? apiClient.get("/user/getUserCash/", { params: { arma_id: stats.arma_id, token: config.apiToken } }) : Promise.reject("no arma_id"),
      stats.arma_id ? apiClient({ method: "GET", url: "/user/getRecentPlayerKillsByArmaId", data: { arma_id: stats.arma_id, token: config.apiToken } }) : Promise.reject("no arma_id"),
      apiClient.get(statsTab === "alltime" ? "/user/topTenUserStatsAllTime/" : "/user/topTenUserStats/", { params: { token: config.apiToken }, timeout: 15000 }),
    ]);

    if (cashRes.status === "fulfilled") {
      atmBalance = cashRes.value.data?.cash ?? cashRes.value.data?.data?.cash ?? cashRes.value.data?.amount ?? cashRes.value.data?.data ?? null;
    }

    if (killsRes.status === "fulfilled") {
      const killData = killsRes.value.data?.data || killsRes.value.data;
      recentKills = Array.isArray(killData) ? killData.slice(0, 10) : [];
    }

    if (lbRes.status === "fulfilled" && stats.arma_id) {
      const lb = Array.isArray(lbRes.value.data) ? lbRes.value.data : [];
      const idx = lb.findIndex(p => p.arma_id === stats.arma_id);
      if (idx >= 0) leaderboardRank = idx + 1;
    }
  } catch (error) {
    if (error.response?.status === 404) {
      statsNotLinked = true;
    } else {
      console.error("Profile stats error:", error.message);
      statsError = "Failed to load your stats. Please try again.";
    }
  }

  // Steam connections from Discord
  const steamConnection = (user.connections || []).find(c => c.type === "steam");
  if (steamConnection && !steamId) steamId = steamConnection.id;

  // Fetch store purchases, skin draws, subscription info, Discord join date
  const purchases = store.getPurchasesByDiscordId(user.discord_id);
  const totalSpent = store.getTotalSpentByDiscordId(user.discord_id);
  // Fetch owned skins from backend API
  let ownedSkins = [];
  try {
    const itemsRes = await apiClient.get("/itemsUser/getUserItemsByDiscordId", {
      params: { discord_id: user.discord_id, token: config.apiToken },
      timeout: 10000,
    });
    const items = itemsRes.data?.items || [];
    ownedSkins = items.map(i => {
      // Clean up item name: remove emoji prefixes, fix underscores/dashes
      let name = i.item_name
        .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{1FA00}-\u{1FA9F}]/gu, "")
        .replace(/^[\s\u{FE0F}]+/u, "")
        .trim();
      if (!name) name = i.item_name;
      return {
        name,
        quantity: i.quantity,
        skinKey: i.misc_data?.skin || null,
        rarity: i.misc_data?.rarity || null,
        date: i.date_added,
      };
    });
  } catch (err) {
    if (err.response?.status !== 404) console.error("Profile items fetch error:", err.message);
  }

  // Determine active subscription tier from purchases
  const subscriptionPerksModule = require("./subscription-perks");
  let activeTier = null;
  let activeTierName = null;
  for (const p of purchases) {
    const tier = subscriptionPerksModule.getTierForProduct(p.product_name);
    if (tier) {
      activeTier = tier;
      activeTierName = p.product_name;
      break; // most recent subscription purchase
    }
  }

  // Get Discord member join date + roles from cache
  let memberSince = null;
  let memberDays = null;
  const discordStats = require("./discord-stats");
  let memberRoles = discordStats.getMemberRoles(user.discord_id).map(r => {
    // Fix dark/default colors that are invisible on dark backgrounds
    const hex = (r.color || "#000000").replace("#", "");
    const brightness = (parseInt(hex.slice(0, 2), 16) * 299 + parseInt(hex.slice(2, 4), 16) * 587 + parseInt(hex.slice(4, 6), 16) * 114) / 1000;
    return { ...r, color: brightness < 50 ? "#9ca3af" : r.color };
  });

  try {
    const { getClient } = require("./discord-bot");
    const bot = getClient();
    if (bot?.isReady()) {
      const guild = bot.guilds.cache.get(config.discordGuildId);
      if (guild) {
        const member = await guild.members.fetch(user.discord_id).catch(() => null);
        if (member) {
          memberSince = member.joinedAt;
          memberDays = Math.floor((Date.now() - member.joinedAt.getTime()) / 86400000);
        }
      }
    }
  } catch {}

  // ATM limit
  let atmLimit = null;
  if (stats?.arma_id) {
    try {
      const limRes = await axios.get(`${config.apiBaseUrl}/admin/atm-limit`, {
        params: { token: config.adminApiToken, arma_id: stats.arma_id },
        timeout: 8000,
      });
      atmLimit = limRes.data?.atm_limit ?? limRes.data?.data?.atm_limit ?? null;
    } catch {}
  }

  // Supporter tier system
  const BASE_TIERS = [
    { key: "bronze",    label: "Bronze",    threshold: 500,   icon: "&#9679;", perks: ["Donator role", "Profile badge"] },
    { key: "silver",    label: "Silver",    threshold: 2500,  icon: "&#9826;", perks: ["Silver profile ring", "Supporter card"] },
    { key: "gold",      label: "Gold",      threshold: 5000,  icon: "&#9829;", perks: ["Gold hero banner", "Priority support"] },
    { key: "platinum",  label: "Platinum",  threshold: 10000, icon: "&#9827;", perks: ["Platinum shine effect", "Exclusive badge"] },
    { key: "diamond",   label: "Diamond",   threshold: 25000, icon: "&#9830;", perks: ["Diamond glow aura", "Animated profile"] },
    { key: "legendary", label: "Legendary", threshold: 50000, icon: "&#9733;", perks: ["Legendary animated banner", "RGB effects", "Custom profile"] },
  ];
  const PRESTIGE_TIERS = [
    { key: "warlord",   label: "Warlord",   threshold: 100000, icon: "&#x2694;&#xFE0F;", perks: ["Warlord title", "Exclusive prestige badge", "Custom profile frame"] },
    { key: "overlord",  label: "Overlord",  threshold: 200000, icon: "&#x1F480;",      perks: ["Overlord title", "Skull animated border", "Legendary aura"] },
    { key: "immortal",  label: "Immortal",  threshold: 300000, icon: "&#x1F451;",      perks: ["Immortal title", "Permanent legacy", "Hall of Fame"] },
  ];

  const prestige = store.getPrestige(user.discord_id);
  const isPrestiged = prestige && prestige.prestige_level > 0;
  const TIERS = isPrestiged ? [...BASE_TIERS, ...PRESTIGE_TIERS] : BASE_TIERS;
  const canPrestige = !isPrestiged && totalSpent >= 50000; // can prestige once at legendary

  // Build upsell — store products the player doesn't own
  const allProducts = store.getActiveProducts();
  const ownedNames = new Set(ownedSkins.map(s => s.name.toLowerCase()));
  const purchasedNames = new Set(purchases.map(p => p.product_name.toLowerCase()));
  const unownedProducts = allProducts
    .filter(p => p.category === "loadout" && !ownedNames.has(p.name.toLowerCase()) && !purchasedNames.has(p.name.toLowerCase()));
  // Sort: sale items first, then by price ascending
  unownedProducts.sort((a, b) => {
    const aOnSale = a.sale_price && a.sale_price < a.price ? 1 : 0;
    const bOnSale = b.sale_price && b.sale_price < b.price ? 1 : 0;
    if (aOnSale !== bOnSale) return bOnSale - aOnSale; // sale items first
    return store.getEffectivePrice(a) - store.getEffectivePrice(b);
  });
  const upsellProducts = unownedProducts
    .slice(0, 3)
    .map(p => {
      const onSale = p.sale_price && p.sale_price < p.price;
      return {
        id: p.id,
        name: p.name,
        image: p.image,
        price: (store.getEffectivePrice(p) / 100).toFixed(2),
        originalPrice: onSale ? (p.price / 100).toFixed(2) : null,
        badge: p.badge,
        onSale,
      };
    });
  const ownsAll = upsellProducts.length === 0 && ownedSkins.length > 0;

  // Rotating CTA for non-supporters
  const CTA_MESSAGES = [
    { headline: "We Can't Keep the Lights On Without You", sub: "Every purchase directly supports server costs and development." },
    { headline: "Unlock Your Full Profile", sub: "Supporters get exclusive badges, glowing borders, and animated effects." },
    { headline: "This Server Runs on Your Support", sub: "Help us keep Wasteland alive — grab a skin, fund the fight." },
    { headline: "Stand Out on the Battlefield", sub: "Supporters get exclusive loadout skins and a profile that turns heads." },
    { headline: "Be Part of Something Bigger", sub: "Join the supporters keeping this community thriving." },
    { headline: "Your Profile Could Look Way Cooler", sub: "Unlock tier badges, animated effects, and the respect of the server." },
    { headline: "Servers Don't Pay for Themselves", sub: "Every dollar keeps the game running for everyone." },
    { headline: "Level Up Your Legacy", sub: "Support the project and watch your profile transform." },
  ];
  const ctaIndex = Math.floor(Math.random() * CTA_MESSAGES.length);
  const ctaMessage = purchases.length === 0 ? CTA_MESSAGES[ctaIndex] : null;

  // Rotating tier button CTA (shown to everyone with a tier)
  const TIER_BUTTON_CTAS = [
    "Keep Growing Your Support Tier",
    "Fuel the Fight — Upgrade Your Tier",
    "Every Dollar Unlocks Something New",
    "Your Support Keeps Us Online",
    "Climb Higher — Unlock the Next Tier",
    "Power Up Your Profile",
    "The Battlefield Needs You",
    "Go Further — Support the Mission",
    "Unlock More Perks Today",
    "Heroes Don't Stop Here",
  ];
  const tierBtnIndex = Math.floor(Math.random() * TIER_BUTTON_CTAS.length);
  const tierBtnText = TIER_BUTTON_CTAS[tierBtnIndex];

  const effectiveSpent = totalSpent;

  const donorTier = TIERS.slice().reverse().find(t => effectiveSpent >= t.threshold)?.key || null;

  const awards = TIERS.map(t => ({
    ...t,
    unlocked: effectiveSpent >= t.threshold,
    isCurrent: t.key === donorTier,
    thresholdDollars: (t.threshold / 100).toFixed(0),
  }));

  const currentTierIndex = TIERS.findIndex(t => t.key === donorTier);
  const nextTier = currentTierIndex >= 0 && currentTierIndex < TIERS.length - 1 ? TIERS[currentTierIndex + 1] : null;
  const spentDollars = (effectiveSpent / 100);
  const nextTierProgress = nextTier ? Math.min(100, Math.round(((effectiveSpent - TIERS[currentTierIndex].threshold) / (nextTier.threshold - TIERS[currentTierIndex].threshold)) * 100)) : 100;

  // Equipped profile customizations
  let equipped = { background: null, name_color: null, badges: [] };
  try {
    equipped = require("./profile-customizations").getEquipped(user.discord_id);
  } catch (e) {
    console.warn("[PROFILE] equipped lookup failed:", e.message);
  }

  // Wasted Coins balance
  let wastedCoinsBalance = 0;
  let wastedCoinsEmoji = "💀";
  try {
    const wc = require("./wasted-coins");
    wastedCoinsBalance = wc.getBalance(user.discord_id);
    wastedCoinsEmoji = wc.EMOJI;
  } catch (e) {
    console.warn("[PROFILE] wasted coins lookup failed:", e.message);
  }

  // Outfit membership
  let userOutfit = null;
  try {
    userOutfit = await require("./outfits").getMemberOutfit(user.discord_id);
  } catch (e) {
    console.warn("[PROFILE] outfit lookup failed:", e.message);
  }

  // Public profile slug — let the user find/share their public URL
  let publicProfileSlug = null;
  if (stats?.arma_username && stats?.arma_id) {
    try {
      const idsRes = await apiClient({ method: "GET", url: "/user/getPlayerIDsByName", data: { arma_username: stats.arma_username, token: config.apiToken } });
      const ids = Array.isArray(idsRes.data) ? idsRes.data : (idsRes.data?.data || []);
      const armaIds = ids.map(x => typeof x === "string" ? x : x?.arma_id).filter(Boolean);
      publicProfileSlug = require("./profile-slug").buildSlug(stats.arma_username, stats.arma_id, armaIds);
    } catch (e) {
      console.warn("[PROFILE] public-slug build failed:", e.message);
    }
  }

  res.render("profile", {
    page: "profile",
    pageTitle: "My Profile",
    pageDescription: "Your personal Arma Wasteland player profile.",
    noIndex: true,
    user,
    profileOwner: user,
    publicProfileSlug,
    stats,
    statsTab,
    statsNotLinked,
    statsError,
    miscStats,
    atmBalance,
    atmLimit,
    effectiveAtmLimit: Math.max(atmLimit || 0, activeTier?.bankLimit || 0) || null,
    equipped,
    wastedCoinsBalance,
    wastedCoinsEmoji,
    userOutfit,
    steamId,
    recentKills,
    leaderboardRank,
    hasMostKilled: stats?.mostKilled && stats.mostKilled !== "Not Available" && stats.mostKilledCount > 0,
    hasMostKilledBy: stats?.mostKilledBy && stats.mostKilledBy !== "Not Available" && stats.mostKilledByCount > 0,
    purchases: purchases.slice(0, 20),
    totalSpent: (totalSpent / 100).toFixed(2),
    purchaseCount: purchases.length,
    purchasesFormatted: purchases.slice(0, 20).map(p => ({ ...p, amountDollars: (p.amount / 100).toFixed(2) })),
    ownedSkins,
    skinCount: ownedSkins.length,
    activeTier,
    activeTierName,
    donorTier,
    currentTierIcon: TIERS.find(t => t.key === donorTier)?.icon || null,
    tierWatermarks: donorTier ? Array(6).fill(TIERS.find(t => t.key === donorTier)?.icon || "&#9679;") : [],
    awards,
    nextTier: nextTier ? { ...nextTier, thresholdDollars: (nextTier.threshold / 100).toFixed(0) } : null,
    nextTierProgress,
    spentDollars: spentDollars.toFixed(2),
    memberSince: memberSince ? memberSince.toISOString() : null,
    memberDays,
    memberRoles,
    isKing: memberRoles.some(r => r.name.toLowerCase().includes("king of the wasteland")),
    isGoat: memberRoles.some(r => r.name.toLowerCase().includes("goat")),
    roleCount: memberRoles.length,
    roleTier: memberRoles.length >= 20 ? "legendary" : memberRoles.length >= 15 ? "elite" : memberRoles.length >= 10 ? "veteran" : memberRoles.length >= 5 ? "regular" : memberRoles.length >= 1 ? "newcomer" : null,
    upsellProducts,
    allProductsJson: JSON.stringify(allProducts.map(p => ({ id: p.id, name: p.name, price: store.getEffectivePrice(p) / 100 }))),
    ownsAll,
    canPrestige,
    isPrestiged,
    prestigeLevel: prestige?.prestige_level || 0,
    ctaMessage,
    ctaIndex,
    tierBtnText,
    tierBtnIndex,
  });
});

// ── Public Player Search (anyone) ──
// Resolves a Discord ID to { arma_username, arma_id } or null via the bundled endpoint
// (zero kills/items overhead — params: recent_kills_limit=0 minimizes payload).
async function resolveArmaProfileFromDiscordId(discordId) {
  try {
    const r = await apiClient.get("/user/getPublicProfile", {
      params: { token: config.apiToken, discord_id: discordId, recent_kills_limit: 0 },
    });
    const p = r.data?.player;
    if (!p?.arma_id || !p?.arma_username) return null;
    return { arma_id: p.arma_id, arma_username: p.arma_username };
  } catch (err) {
    if (err.response?.status !== 404) console.warn(`resolveArmaProfileFromDiscordId(${discordId}) failed:`, err.message);
    return null;
  }
}

app.get("/players", async (req, res) => {
  const sessionUser = req.session.user || null;
  if (sessionUser) {
    if (sessionUser.avatar && sessionUser.discord_id) {
      sessionUser.avatarUrl = `https://cdn.discordapp.com/avatars/${sessionUser.discord_id}/${sessionUser.avatar}.png?size=128`;
    } else if (sessionUser.discord_id) {
      const defaultIndex = Number(BigInt(sessionUser.discord_id) >> 22n) % 6;
      sessionUser.avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
    }
  }
  const q = (req.query.q || "").trim();
  const slugify = require("./profile-slug").slugify;
  let players = [];
  let searchError = null;
  const seen = new Set(); // arma_id → dedupe across sources
  function pushPlayer(p, matchedVia) {
    if (!p.arma_username || !p.arma_id) return;
    if (seen.has(p.arma_id)) return;
    seen.add(p.arma_id);
    players.push({ arma_username: p.arma_username, arma_id: p.arma_id, slug: slugify(p.arma_username), matchedVia });
  }

  if (q.length >= 2) {
    const isDiscordId = /^\d{17,20}$/.test(q);
    try {
      if (isDiscordId) {
        const resolved = await resolveArmaProfileFromDiscordId(q);
        if (resolved) pushPlayer(resolved, "discord_id");
      } else {
        // Search Arma usernames + Discord guild members in parallel
        const [armaRes, discordMembers] = await Promise.allSettled([
          apiClient({ method: "GET", url: "/user/searchUsersByUsername/", data: { search: q, token: config.apiToken } }),
          (async () => {
            const { getClient } = require("./discord-bot");
            const bot = getClient();
            if (!bot?.isReady()) return [];
            const guild = bot.guilds.cache.get(config.discordGuildId);
            if (!guild) return [];
            try {
              const fetched = await guild.members.search({ query: q, limit: 10 });
              return [...fetched.values()];
            } catch { return []; }
          })(),
        ]);

        if (armaRes.status === "fulfilled") {
          const raw = armaRes.value.data?.users || armaRes.value.data?.data || armaRes.value.data || [];
          if (Array.isArray(raw)) {
            raw.slice(0, 50).forEach(p => pushPlayer({ arma_username: p.arma_username, arma_id: p.arma_id }, "arma_username"));
          }
        }

        if (discordMembers.status === "fulfilled" && discordMembers.value.length) {
          const armaLookups = await Promise.allSettled(
            discordMembers.value.map(m => resolveArmaProfileFromDiscordId(m.id))
          );
          armaLookups.forEach(r => {
            if (r.status === "fulfilled" && r.value) pushPlayer(r.value, "discord_username");
          });
        }
      }
    } catch (err) {
      console.error("Player search error:", err.message);
      searchError = "Search failed. Try again.";
    }
  }
  res.render("players-search", {
    page: "players",
    pageTitle: "Search Players",
    pageDescription: "Look up any Arma Wasteland player's public profile.",
    user: sessionUser,
    q,
    players,
    searchError,
    queryTooShort: q.length > 0 && q.length < 2,
  });
});

// ── Public Player Profile (anyone can view) ──
// Slug format: lowercase-username[-letter] e.g. /profile/twisted, /profile/twisted--a
const profileSlug = require("./profile-slug");

// Single-trip bundle fetch via /user/getPublicProfile.
// Slug resolution flow:
//   1. Try arma_username=<base> (case-insensitive exact match) — covers slugs like "fl1ck", "twisted"
//   2. On 404, fall back to substring search + slugify-filter — covers names with spaces/emojis
//   3. If slug has --a/--b suffix and the resolved bundle has name_collisions, re-call with the right arma_id
async function loadPublicProfile(slug, statsTab, recentKillsLimit = 10) {
  const { base, index } = profileSlug.parseSlug(slug);
  if (!base) return null;
  const season = statsTab === "alltime" ? "all" : "current";
  const baseParams = { token: config.apiToken, season, recent_kills_limit: recentKillsLimit };

  // Try direct arma_username lookup first
  let bundle = null;
  try {
    const res = await apiClient.get("/user/getPublicProfile", { params: { ...baseParams, arma_username: base } });
    bundle = res.data;
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error("getPublicProfile (by name) failed:", err.response?.status, err.message);
    }
  }

  // Fallback: slug doesn't match the exact username (e.g. "twisted-player" from "Twisted Player 🔫")
  if (!bundle) {
    try {
      const searchRes = await apiClient({
        method: "GET",
        url: "/user/searchUsersByUsername/",
        data: { search: base, token: config.apiToken },
      });
      const users = searchRes.data?.users || searchRes.data?.data || searchRes.data || [];
      if (Array.isArray(users)) {
        const matches = users
          .filter(u => profileSlug.slugify(u.arma_username) === base)
          .sort((a, b) => String(a.arma_id || "").localeCompare(String(b.arma_id || "")));
        if (matches.length && index < matches.length) {
          const res = await apiClient.get("/user/getPublicProfile", { params: { ...baseParams, arma_id: matches[index].arma_id } });
          return res.data;
        }
      }
    } catch (err) {
      console.error("getPublicProfile fallback search failed:", err.message);
    }
    return null;
  }

  // Suffix slug like "twisted--b" — re-fetch with the right collision sibling's arma_id
  if (index > 0 && Array.isArray(bundle.name_collisions) && index < bundle.name_collisions.length) {
    try {
      const res = await apiClient.get("/user/getPublicProfile", { params: { ...baseParams, arma_id: bundle.name_collisions[index].arma_id } });
      return res.data;
    } catch (err) {
      console.error("getPublicProfile collision re-fetch failed:", err.message);
      return null;
    }
  }

  return bundle;
}

app.get("/profile/:slug", async (req, res) => {
  const sessionUser = req.session.user || null;
  if (sessionUser) {
    if (sessionUser.avatar && sessionUser.discord_id) {
      sessionUser.avatarUrl = `https://cdn.discordapp.com/avatars/${sessionUser.discord_id}/${sessionUser.avatar}.png?size=128`;
    } else if (sessionUser.discord_id) {
      const defaultIndex = Number(BigInt(sessionUser.discord_id) >> 22n) % 6;
      sessionUser.avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
    }
  }

  const statsTab = req.query.stats === "alltime" ? "alltime" : "season";

  const bundle = await loadPublicProfile(req.params.slug, statsTab, 10);
  if (!bundle?.player?.arma_id) {
    return res.status(404).render("profile", {
      page: "profile",
      pageTitle: "Player Not Found",
      pageDescription: "No player matches this profile URL.",
      noIndex: true,
      isPublic: true,
      profileNotFound: true,
      slug: req.params.slug,
      user: sessionUser,
    });
  }

  const armaId = bundle.player.arma_id;
  const armaUsername = bundle.player.arma_username;
  const discordId = bundle.player.discord_id || null;

  const stats = bundle.stats || null;
  const statsError = null;
  const miscStats = stats ? MISC_FIELDS
    .filter(f => stats[f.key] !== undefined && stats[f.key] !== null)
    .map(f => ({ label: f.label, value: stats[f.key] })) : [];
  const leaderboardRank = bundle.leaderboard_rank || null;

  // Map recent_kills to the shape the view expects (victim_username derived from the player's role in the incident)
  const recentKills = (bundle.recent_kills || []).map(k => {
    const isKiller = k.incident_role === "killer" || k.incident_role === "killer_and_killed";
    return {
      victim_username: isKiller ? k.killed_name : k.killer_name,
      distance: k.distance,
      weapon: null, // backend schema has no weapon column
    };
  });

  // Map owned_items: bundle returns raw misc_data, view wants {name, quantity, skinKey, rarity, date}
  const ownedSkins = (bundle.owned_items || []).map(i => {
    let name = String(i.item_name || "")
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{1FA00}-\u{1FA9F}]/gu, "")
      .replace(/^[\s\u{FE0F}]+/u, "")
      .trim();
    if (!name) name = i.item_name;
    return {
      name,
      quantity: i.quantity,
      skinKey: i.misc_data?.skin || null,
      rarity: i.misc_data?.rarity || null,
      date: i.date_added,
    };
  });

  // Outfit comes through the bundle (already in the expected shape: outfit_id, outfit_tag, etc.)
  const userOutfit = bundle.outfit || null;

  // Discord guild member fetch (member-since) — requires a separate call to the bot, can't bundle
  let memberSince = null, memberDays = null;
  if (discordId) {
    try {
      const { getClient } = require("./discord-bot");
      const bot = getClient();
      if (bot?.isReady()) {
        const guild = bot.guilds.cache.get(config.discordGuildId);
        if (guild) {
          const member = await guild.members.fetch(discordId).catch(() => null);
          if (member) {
            memberSince = member.joinedAt;
            memberDays = Math.floor((Date.now() - member.joinedAt.getTime()) / 86400000);
          }
        }
      }
    } catch {}
  }

  // ── Local synchronous lookups (cheap — no I/O)
  const discordStats = require("./discord-stats");
  const memberRoles = discordId ? discordStats.getMemberRoles(discordId).map(r => {
    const hex = (r.color || "#000000").replace("#", "");
    const brightness = (parseInt(hex.slice(0, 2), 16) * 299 + parseInt(hex.slice(2, 4), 16) * 587 + parseInt(hex.slice(4, 6), 16) * 114) / 1000;
    return { ...r, color: brightness < 50 ? "#9ca3af" : r.color };
  }) : [];

  const totalSpent = discordId ? store.getTotalSpentByDiscordId(discordId) : 0;
  const BASE_TIERS = [
    { key: "bronze",    label: "Bronze",    threshold: 500,   icon: "&#9679;" },
    { key: "silver",    label: "Silver",    threshold: 2500,  icon: "&#9826;" },
    { key: "gold",      label: "Gold",      threshold: 5000,  icon: "&#9829;" },
    { key: "platinum",  label: "Platinum",  threshold: 10000, icon: "&#9827;" },
    { key: "diamond",   label: "Diamond",   threshold: 25000, icon: "&#9830;" },
    { key: "legendary", label: "Legendary", threshold: 50000, icon: "&#9733;" },
  ];
  const PRESTIGE_TIERS = [
    { key: "warlord",  label: "Warlord",  threshold: 100000, icon: "&#x2694;&#xFE0F;" },
    { key: "overlord", label: "Overlord", threshold: 200000, icon: "&#x1F480;" },
    { key: "immortal", label: "Immortal", threshold: 300000, icon: "&#x1F451;" },
  ];
  const prestige = discordId ? store.getPrestige(discordId) : null;
  const isPrestiged = prestige && prestige.prestige_level > 0;
  const TIERS = isPrestiged ? [...BASE_TIERS, ...PRESTIGE_TIERS] : BASE_TIERS;
  const donorTier = TIERS.slice().reverse().find(t => totalSpent >= t.threshold)?.key || null;
  const currentTierIcon = TIERS.find(t => t.key === donorTier)?.icon || null;
  const tierWatermarks = donorTier ? Array(6).fill(currentTierIcon || "&#9679;") : [];

  let wastedCoinsBalance = 0;
  let wastedCoinsEmoji = "💀";
  if (discordId) {
    try {
      const wc = require("./wasted-coins");
      wastedCoinsBalance = wc.getBalance(discordId);
      wastedCoinsEmoji = wc.EMOJI;
    } catch {}
  }

  let equipped = { background: null, name_color: null, badges: [] };
  if (discordId) {
    try { equipped = require("./profile-customizations").getEquipped(discordId); } catch {}
  }

  // Derive a displayable avatar for the player being viewed
  let ownerAvatarUrl = "https://cdn.discordapp.com/embed/avatars/0.png";
  if (discordId) {
    const defaultIndex = Number(BigInt(discordId) >> 22n) % 6;
    ownerAvatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  }
  const profileOwner = { username: armaUsername, avatarUrl: ownerAvatarUrl, discord_id: discordId };

  res.render("profile", {
    page: "profile",
    pageTitle: `${armaUsername} — Profile`,
    pageDescription: `Public Arma Wasteland player profile for ${armaUsername}.`,
    isPublic: true,
    profileSlug: req.params.slug,
    publicArmaUsername: armaUsername,
    publicArmaId: armaId,
    publicDiscordId: discordId,
    profileOwner,
    user: sessionUser,
    stats,
    statsTab,
    statsError,
    miscStats,
    equipped,
    wastedCoinsBalance,
    wastedCoinsEmoji,
    userOutfit,
    recentKills,
    leaderboardRank,
    hasMostKilled: stats?.mostKilled && stats.mostKilled !== "Not Available" && stats.mostKilledCount > 0,
    hasMostKilledBy: stats?.mostKilledBy && stats.mostKilledBy !== "Not Available" && stats.mostKilledByCount > 0,
    ownedSkins,
    skinCount: ownedSkins.length,
    donorTier,
    currentTierIcon,
    tierWatermarks,
    memberSince: memberSince ? memberSince.toISOString() : null,
    memberDays,
    memberRoles,
    isKing: memberRoles.some(r => r.name.toLowerCase().includes("king of the wasteland")),
    isGoat: memberRoles.some(r => r.name.toLowerCase().includes("goat")),
    roleCount: memberRoles.length,
    roleTier: memberRoles.length >= 20 ? "legendary" : memberRoles.length >= 15 ? "elite" : memberRoles.length >= 10 ? "veteran" : memberRoles.length >= 5 ? "regular" : memberRoles.length >= 1 ? "newcomer" : null,
    isPrestiged,
    prestigeLevel: prestige?.prestige_level || 0,
  });
});

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

  // Active outfit wars (homepage spotlight)
  let activeWars = [];
  try {
    activeWars = await require("./outfits").getAllActiveWars();
  } catch (err) {
    console.error("Active wars fetch error:", err.message);
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
    activeWars,
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

app.get("/wasted-coins/leaderboard", (req, res) => {
  const user = req.session.user || null;
  if (user?.avatar && user.discord_id) {
    user.avatarUrl = "https://cdn.discordapp.com/avatars/" + user.discord_id + "/" + user.avatar + ".png?size=32";
  } else if (user?.discord_id) {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
  }
  const wc = require("./wasted-coins");
  const top = wc.getAllTimeLeaderboard(100);
  const myDiscordId = user?.discord_id || null;
  let myRank = null;
  if (myDiscordId) {
    const idx = top.findIndex(t => t.discord_id === myDiscordId);
    if (idx >= 0) myRank = idx + 1;
  }
  res.render("wasted-coins-leaderboard", {
    page: "wasted-coins",
    pageTitle: "Wasted Coins Leaderboard — Top Earners",
    pageDescription: "See who's stacking the most 💀 Wasted Coins on Arma Wasteland. Earn coins daily, participate in lotteries, and climb the all-time leaderboard.",
    user,
    top,
    myDiscordId,
    myRank,
    coinEmoji: wc.EMOJI,
    coinName: wc.NAME,
  });
});

app.get("/wasted-coins", (req, res) => {
  const user = req.session.user || null;
  if (user?.avatar && user.discord_id) {
    user.avatarUrl = "https://cdn.discordapp.com/avatars/" + user.discord_id + "/" + user.avatar + ".png?size=32";
  } else if (user?.discord_id) {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl = "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
  }
  const wc = require("./wasted-coins");
  const lottery = require("./lottery");
  const skinLot = require("./skin-lottery");
  const wagers = require("./kill-wagers");
  let myBalance = null;
  let currentPot = null;
  let skinPot = null;
  if (user?.discord_id) {
    try { myBalance = wc.getBalance(user.discord_id); } catch {}
  }
  try { currentPot = lottery.getCurrentPot(); } catch {}
  try { skinPot = skinLot.getCurrentPot(); } catch {}
  res.render("wasted-coins", {
    page: "wasted-coins",
    pageTitle: "💀 Wasted Coins",
    pageDescription: "Earn Wasted Coins by playing, claim daily rewards, and spend them on profile customizations, the weekly lottery, kill wagers, or in-game cash.",
    user,
    myBalance,
    currentPot,
    skinPot,
    nextDraw: lottery.nextDrawDate().toISOString(),
    constants: {
      EMOJI: wc.EMOJI,
      NAME: wc.NAME,
      DAILY_BASE: wc.DAILY_BASE,
      DAILY_TRANSFER_CAP: wc.DAILY_TRANSFER_CAP.toLocaleString(),
      DAILY_TRANSFER_CAP_SUBSCRIBER: wc.DAILY_TRANSFER_CAP_SUBSCRIBER.toLocaleString(),
      LOTTERY_TICKET_PRICE: lottery.TICKET_PRICE,
      LOTTERY_DAILY_CAP: lottery.MAX_TICKETS_PER_DAY,
      LOTTERY_HOUSE_RAKE_PCT: Math.round(lottery.HOUSE_RAKE * 100),
      WAGER_MIN: wagers.MIN_WAGER,
      WAGER_MAX: wagers.MAX_WAGER,
      WAGER_DAILY_CAP: wagers.MAX_INITIATED_PER_DAY,
      WAGER_PENDING_CAP: wagers.MAX_PENDING_PER_USER,
      WAGER_ACCEPT_HOURS: wagers.ACCEPT_WINDOW_HOURS,
      WAGER_DURATION_HOURS: wagers.WAGER_DURATION_HOURS,
      WAGER_HOUSE_RAKE_PCT: Math.round(wagers.HOUSE_RAKE * 100),
      SKIN_LOTTERY_TICKET_PRICE: skinLot.TICKET_PRICE,
      SKIN_LOTTERY_DAILY_CAP: skinLot.MAX_TICKETS_PER_DAY,
    },
  });
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
      // Fetch owned skins to exclude from draw
      let ownedNames = new Set();
      const drawDiscordId = session.metadata?.discord_id;
      if (drawDiscordId) {
        try {
          const itemsRes = await apiClient.get("/itemsUser/getUserItemsByDiscordId", {
            params: { discord_id: drawDiscordId, token: config.apiToken },
            timeout: 10000,
          });
          (itemsRes.data?.items || []).forEach(i => ownedNames.add(i.item_name.toLowerCase()));
        } catch {}
      }

      // Roll!
      result = skinDraw.draw(ownedNames);
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

app.get("/store", async (req, res) => {
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

  // Fetch owned items for logged-in users
  let ownedItemNames = [];
  if (user) {
    try {
      const itemsRes = await apiClient.get("/itemsUser/getUserItemsByDiscordId", {
        params: { discord_id: user.discord_id, token: config.apiToken },
        timeout: 10000,
      });
      const items = itemsRes.data?.items || [];
      ownedItemNames = items.map(i => i.item_name.toLowerCase());
    } catch {}
  }

  // Mark owned products in each category
  for (const cat of categories) {
    for (const p of (cat.products || [])) {
      const gameName = (p.game_item_name || p.name || "").toLowerCase();
      const productName = (p.name || "").toLowerCase();
      p.owned = ownedItemNames.some(n => n === gameName || n === productName || gameName.includes(n) || n.includes(gameName));
    }
  }

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
    // Gift recipient (Discord ID) — validated as 17-20 digit numeric string
    const giftTo = (typeof item.giftTo === "string" && /^\d{17,20}$/.test(item.giftTo.trim())) ? item.giftTo.trim() : null;
    cartProducts.push({ id: product.id, name: product.name, qty, category: product.category, giftTo });

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

    // ── Profile customization unlock (separate flow from cart) ──
    if (session.metadata?.profile_item_id) {
      try {
        const profileCustomizations = require("./profile-customizations");
        const itemId = parseInt(session.metadata.profile_item_id, 10);
        const buyerDiscordId = session.metadata.discord_id;
        const item = profileCustomizations.getItem(itemId);
        if (item && buyerDiscordId && buyerDiscordId !== "guest") {
          profileCustomizations.unlock(buyerDiscordId, itemId, { source: "purchase", stripe_session_id: session.id });
          store.recordPurchase({
            stripe_session_id: session.id,
            product_name: `[Profile] ${item.name}`,
            quantity: 1,
            amount: session.amount_total || 0,
            discord_id: buyerDiscordId,
            discord_username: session.metadata.username || null,
          });
          sendWebhook({
            title: "Profile Customization Purchased",
            description: `<@${buyerDiscordId}> unlocked **${item.name}** (${item.type})`,
            color: 0x8B5CF6,
          });
          console.log(`ProfileCustomizations: unlocked item ${itemId} (${item.name}) for ${buyerDiscordId}`);
        }
      } catch (err) {
        console.error("Profile unlock error:", err.message);
        sendWebhookError("Profile Unlock", err.message);
      }
      return res.json({ received: true });
    }

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
          const recipientId = cartItem.giftTo || discordId;
          const isGift = cartItem.giftTo && cartItem.giftTo !== discordId;
          try {
            await axios.post(
              `${apiBaseUrl}/itemsUser/updateDiscordUserItemFromDiscord`,
              { discord_id: recipientId, item_name: gameItemName, request_type: "set", quantity: cartItem.qty },
              { params: { token: backendToken }, timeout: 15000, headers: { "Content-Type": "application/json" } }
            );
            fulfilled.push(isGift ? `${product.name} → <@${recipientId}>` : product.name);
            console.log(`Stripe fulfillment: granted "${gameItemName}" x${cartItem.qty} to ${recipientId}${isGift ? ` (gift from ${discordId})` : ""}`);
            if (isGift) {
              try {
                sendWebhook({
                  title: "🎁 Skin Gift",
                  description: `<@${discordId}> gifted **${product.name}** to <@${recipientId}>`,
                  color: 0xec4899,
                });
              } catch {}
            }
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

      // Supporter package: draw random skin per supporter-category item, DM buyer, log
      if (discordIdForRecord && discordIdForRecord !== "guest" && cartItems.length > 0) {
        for (const cartItem of cartItems) {
          const product = store.getProductById(cartItem.id);
          if (!product || product.category !== "supporter") continue;
          const qty = cartItem.qty || 1;
          for (let i = 0; i < qty; i++) {
            try {
              await subscriptionPerks.grantSupporterDraw(discordIdForRecord, product.name);
            } catch (drawErr) {
              console.error(`Supporter draw failed for ${product.name}:`, drawErr.message);
              sendWebhookError("Supporter Draw", `${product.name}: ${drawErr.message}`);
            }
          }
        }
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
            // Revoke from the actual recipient — gifted items go to giftTo, not the buyer
            const revokeTarget = cartItem.giftTo || discordId;
            const isGift = cartItem.giftTo && cartItem.giftTo !== discordId;
            try {
              await axios.post(
                `${config.apiBaseUrl}/itemsUser/updateDiscordUserItemFromDiscord`,
                { discord_id: revokeTarget, item_name: revokeItemName, request_type: "remove", quantity: cartItem.qty },
                { params: { token: config.backendToken }, timeout: 15000, headers: { "Content-Type": "application/json" } }
              );
              revoked.push(isGift ? `${product.name} (gift to ${revokeTarget})` : product.name);
              console.log(`Stripe ${label}: revoked "${revokeItemName}" from ${revokeTarget}${isGift ? ` (gift from ${discordId})` : ""}`);
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

          // Re-assign Donator role on renewal (in case it was manually removed)
          try {
            const { getClient } = require("./discord-bot");
            const bot = getClient();
            if (bot?.isReady()) {
              const guild = bot.guilds.cache.get(config.discordGuildId);
              if (guild) {
                const member = await guild.members.fetch(discordId).catch(() => null);
                if (member) {
                  await member.roles.add("1282418153925640402");
                  console.log(`Donator role re-assigned to ${discordId} on renewal`);
                }
              }
            }
          } catch (roleErr) {
            console.warn(`Failed to re-assign donator role to ${discordId}: ${roleErr.message}`);
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
