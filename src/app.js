const express = require("express");
const path = require("path");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const { engine } = require("express-handlebars");
const axios = require("axios");
const config = require("./config");
const { sendWebhookError } = require("./webhook");
const analytics = require("./analytics");
const amp = require("./amp");
const bm = require("./armahq");
const blog = require("./blog");
const metricsHistory = require("./metrics-history");
const { marked } = require("marked");

const fs = require("fs");

const app = express();
app.set("trust proxy", 1);

// Use persistent disk on Render, local dir on Windows dev
const SESSION_DIR = process.platform === "win32"
  ? path.join(__dirname, "..", "sessions")
  : "/var/data/sessions";
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
        return marked(val);
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

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".css")) {
      res.setHeader("Content-Type", "text/css");
    }
  },
}));

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
      // Validate session has required fields
      if (!req.session.user.discord_id || !req.session.user.username) {
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

// Background polling — collect metrics every 5 minutes
async function collectMetrics() {
  try {
    const [status, bmStatus] = await Promise.all([
      amp.getFreshStatus(),
      bm.getFreshStatus(),
    ]);

    // Filter to active Wasteland instances
    const wasteland = status.instances.filter(i =>
      i.running && i.appState >= 5 && i.friendlyName.toLowerCase().includes("wasteland")
    );

    // Overlay ArmaHQ player counts onto AMP instances
    for (let i = 0; i < bmStatus.servers.length && i < wasteland.length; i++) {
      const srv = bmStatus.servers[i];
      wasteland[i].players.current = srv.players;
      wasteland[i].players.max = srv.maxPlayers;
      wasteland[i].players.percent = srv.maxPlayers ? Math.round((srv.players / srv.maxPlayers) * 100) : 0;
    }

    metricsHistory.record(wasteland, bmStatus.servers);
    console.log(`MetricsHistory: recorded ${wasteland.length} instances`);
  } catch (err) {
    console.error("MetricsHistory: collection error:", err.message);
  }
}

// Collect immediately on startup, then every 5 minutes
collectMetrics();
setInterval(collectMetrics, 5 * 60 * 1000);

app.use(analytics.middleware);

app.use("/auth", require("./routes/auth"));
app.use("/admin", require("./routes/admin"));
app.use("/api", require("./routes/api"));
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
    if (user.avatar) {
      user.avatarUrl =
        "https://cdn.discordapp.com/avatars/" +
        user.discord_id +
        "/" +
        user.avatar +
        ".png?size=32";
    } else {
      const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
      user.avatarUrl =
        "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
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

  res.render("dashboard", {
    page: "home",
    pageTitle: "Server Dashboard",
    pageDescription: "Live combat statistics, kill leaderboards, and ban analytics from the Arma Wasteland battlefield.",
    ...data,
    serverStatus,
    totalPlayers,
    totalMaxPlayers,
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
  res.send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /auth\nDisallow: /api\n\nSitemap: ${base}/sitemap.xml\n`);
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
