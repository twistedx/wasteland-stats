const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "analytics.json");
const WRITE_INTERVAL = 30_000;
const MAX_VISITS = 50_000;

const SKIP_PREFIXES = [
  "/css/", "/img/", "/js/", "/favicon", "/apple-touch-icon",
  "/android-chrome", "/site.webmanifest",
];

let visits = [];
let dirty = false;
let flushTimer = null;

function init() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      visits = Array.isArray(parsed.visits) ? parsed.visits : [];
    } catch (err) {
      console.error("Analytics: failed to load data file, starting fresh.", err.message);
      visits = [];
    }
  }

  flushTimer = setInterval(() => {
    if (dirty) flush();
  }, WRITE_INTERVAL);

  const shutdown = () => {
    if (dirty) flush();
    if (flushTimer) clearInterval(flushTimer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Analytics: loaded ${visits.length} records from disk.`);
}

function flush() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ visits }));
    dirty = false;
  } catch (err) {
    console.error("Analytics: flush error", err.message);
  }
}

function middleware(req, res, next) {
  const p = req.path;
  if (SKIP_PREFIXES.some((prefix) => p.startsWith(prefix))) {
    return next();
  }

  const user = req.session?.user || null;
  const vid = crypto
    .createHash("sha256")
    .update(req.sessionID || req.ip || "unknown")
    .digest("hex")
    .substring(0, 12);

  visits.push({
    ts: Date.now(),
    path: p,
    loggedIn: !!user,
    username: user?.username || null,
    vid,
  });

  if (visits.length > MAX_VISITS) {
    visits = visits.slice(visits.length - MAX_VISITS + 10000);
  }

  dirty = true;
  next();
}

function getStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 7 * 86400000;
  const monthStart = todayStart - 30 * 86400000;

  let todayViews = 0;
  let yesterdayViews = 0;
  let loggedInToday = 0;
  let anonymousToday = 0;
  const uniqueToday = new Set();
  const uniqueWeek = new Set();
  const uniqueMonth = new Set();
  const activeUsersSet = new Set();
  const allTimeUsersSet = new Set();
  const pageCounts = {};

  for (const v of visits) {
    if (v.ts >= todayStart) {
      todayViews++;
      uniqueToday.add(v.vid);
      if (v.loggedIn) {
        loggedInToday++;
        if (v.username) activeUsersSet.add(v.username);
      } else {
        anonymousToday++;
      }
    }
    if (v.ts >= yesterdayStart && v.ts < todayStart) {
      yesterdayViews++;
    }
    if (v.ts >= weekStart) uniqueWeek.add(v.vid);
    if (v.ts >= monthStart) uniqueMonth.add(v.vid);

    if (v.loggedIn && v.username) allTimeUsersSet.add(v.username);
    pageCounts[v.path] = (pageCounts[v.path] || 0) + 1;
  }

  // Daily views for the last 30 days
  const dailyCounts = {};
  const dailyUnique = {};
  const dailyLoggedIn = {};
  for (const v of visits) {
    if (v.ts >= monthStart) {
      const day = new Date(v.ts).toISOString().slice(0, 10);
      dailyCounts[day] = (dailyCounts[day] || 0) + 1;
      if (!dailyUnique[day]) dailyUnique[day] = new Set();
      dailyUnique[day].add(v.vid);
      if (v.loggedIn) dailyLoggedIn[day] = (dailyLoggedIn[day] || 0) + 1;
    }
  }
  const dailyViews = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    dailyViews.push({
      date: key,
      views: dailyCounts[key] || 0,
      unique: dailyUnique[key] ? dailyUnique[key].size : 0,
      loggedIn: dailyLoggedIn[key] || 0,
    });
  }

  const topPages = Object.entries(pageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p, count]) => ({ path: p, count }));

  const recentActivity = visits
    .slice(-20)
    .reverse()
    .map((v) => ({
      time: new Date(v.ts).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      path: v.path,
      username: v.username || "Anonymous",
      loggedIn: v.loggedIn,
    }));

  const activeUsers = Array.from(activeUsersSet);

  return {
    todayViews,
    yesterdayViews,
    totalViews: visits.length,
    uniqueToday: uniqueToday.size,
    uniqueWeek: uniqueWeek.size,
    uniqueMonth: uniqueMonth.size,
    loggedInToday,
    anonymousToday,
    topPages,
    recentActivity,
    activeUsers,
    activeUserCount: activeUsers.length,
    allTimeUsers: allTimeUsersSet.size,
    dailyViews,
  };
}

module.exports = { init, middleware, getStats };
