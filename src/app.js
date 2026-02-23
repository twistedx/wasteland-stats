const express = require("express");
const path = require("path");
const session = require("express-session");
const { engine } = require("express-handlebars");
const axios = require("axios");
const config = require("./config");
const { sendWebhookError } = require("./webhook");

const app = express();

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
      formatNumber: (val) => {
        if (val === undefined || val === null) return "0";
        return Number(val).toLocaleString();
      },
      fallback: (val, def) => (val !== undefined && val !== null ? val : def),
      math: (a, b) => a + b,
    },
  })
);
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
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

app.use("/auth", require("./routes/auth"));
app.use("/admin", require("./routes/admin"));

app.get("/", async (req, res) => {
  const tab = req.query.tab === "alltime" ? "alltime" : "season";
  const user = req.session.user || null;

  let leaderboard = [];
  let leaderboardError = false;
  let stats = null;
  let statsError = null;
  let statsNotLinked = false;
  let miscStats = [];

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

      // Send Discord webhook notification
      if (config.discordWebhookUrl) {
        axios.post(config.discordWebhookUrl, {
          embeds: [{
            title: "Stats Viewed",
            description: `**${user.username}** pulled their stats on the website.`,
            color: 0x5865F2,
            timestamp: new Date().toISOString(),
          }],
        }).catch(() => {});
      }

      miscStats = MISC_FIELDS.filter(
        (f) => stats[f.key] !== undefined && stats[f.key] !== null
      ).map((f) => ({ label: f.label, value: stats[f.key] }));
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

  res.render("home", {
    page: "home",
    pageTitle: "Stats & Leaderboard",
    pageDescription: "Track your Arma Wasteland combat stats, view kill/death ratios, and compete on the season and all-time leaderboards.",
    user,
    tab,
    leaderboard,
    leaderboardError,
    stats,
    statsError,
    statsNotLinked,
    miscStats,
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
