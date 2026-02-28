const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "analytics.db");
const OLD_DATA_DIR = path.join(__dirname, "..", "data");
const OLD_DATA_FILE = path.join(OLD_DATA_DIR, "analytics.json");
const RETENTION_DAYS = 90;

const SKIP_PREFIXES = [
  "/css/", "/img/", "/js/", "/favicon", "/apple-touch-icon",
  "/android-chrome", "/site.webmanifest",
];

let db = null;
let insertStmt = null;

function init() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      path TEXT NOT NULL,
      logged_in INTEGER NOT NULL DEFAULT 0,
      username TEXT,
      vid TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits (ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_vid ON visits (vid, ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_path ON visits (path)`);

  insertStmt = db.prepare(
    "INSERT INTO visits (ts, path, logged_in, username, vid) VALUES (?, ?, ?, ?, ?)"
  );

  // Migrate old JSON data if it exists
  migrateJson();

  // Prune old data
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM visits WHERE ts < ?").run(cutoff);

  const count = db.prepare("SELECT COUNT(*) as cnt FROM visits").get().cnt;
  console.log(`Analytics: ${count} records in database.`);
}

function migrateJson() {
  if (!fs.existsSync(OLD_DATA_FILE)) return;

  const already = db.prepare("SELECT value FROM meta WHERE key = 'json_migrated'").get();
  if (already) return;

  try {
    const raw = fs.readFileSync(OLD_DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const visits = Array.isArray(parsed.visits) ? parsed.visits : [];
    const totalDeposited = Number(parsed.totalDeposited) || 0;

    if (visits.length > 0) {
      const tx = db.transaction(() => {
        for (const v of visits) {
          insertStmt.run(
            v.ts,
            v.path || "/",
            v.loggedIn ? 1 : 0,
            v.username || null,
            v.vid || "unknown"
          );
        }
      });
      tx();
      console.log(`Analytics: migrated ${visits.length} records from JSON.`);
    }

    if (totalDeposited > 0) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('totalDeposited', ?)").run(String(totalDeposited));
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('json_migrated', '1')").run();
  } catch (err) {
    console.error("Analytics: JSON migration failed:", err.message);
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

  try {
    insertStmt.run(Date.now(), p, user ? 1 : 0, user?.username || null, vid);
  } catch (err) {
    console.error("Analytics: insert error", err.message);
  }

  next();
}

function getStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 7 * 86400000;
  const monthStart = todayStart - 30 * 86400000;

  const todayViews = db.prepare("SELECT COUNT(*) as cnt FROM visits WHERE ts >= ?").get(todayStart).cnt;
  const yesterdayViews = db.prepare("SELECT COUNT(*) as cnt FROM visits WHERE ts >= ? AND ts < ?").get(yesterdayStart, todayStart).cnt;
  const totalViews = db.prepare("SELECT COUNT(*) as cnt FROM visits").get().cnt;

  const uniqueToday = db.prepare("SELECT COUNT(DISTINCT vid) as cnt FROM visits WHERE ts >= ?").get(todayStart).cnt;
  const uniqueWeek = db.prepare("SELECT COUNT(DISTINCT vid) as cnt FROM visits WHERE ts >= ?").get(weekStart).cnt;
  const uniqueMonth = db.prepare("SELECT COUNT(DISTINCT vid) as cnt FROM visits WHERE ts >= ?").get(monthStart).cnt;

  const loggedInToday = db.prepare("SELECT COUNT(*) as cnt FROM visits WHERE ts >= ? AND logged_in = 1").get(todayStart).cnt;
  const anonymousToday = todayViews - loggedInToday;

  const activeUsers = db.prepare(
    "SELECT DISTINCT username FROM visits WHERE ts >= ? AND logged_in = 1 AND username IS NOT NULL"
  ).all(todayStart).map(r => r.username);

  const allTimeUsers = db.prepare(
    "SELECT COUNT(DISTINCT username) as cnt FROM visits WHERE logged_in = 1 AND username IS NOT NULL"
  ).get().cnt;

  const topPages = db.prepare(
    "SELECT path, COUNT(*) as count FROM visits GROUP BY path ORDER BY count DESC LIMIT 10"
  ).all();

  const recentActivity = db.prepare(
    "SELECT ts, path, username, logged_in FROM visits ORDER BY ts DESC LIMIT 20"
  ).all().map(v => ({
    time: new Date(v.ts).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    path: v.path,
    username: v.username || "Anonymous",
    loggedIn: !!v.logged_in,
  }));

  // Daily views for the last 30 days
  const dailyRows = db.prepare(`
    SELECT
      date(ts / 1000, 'unixepoch') as day,
      COUNT(*) as views,
      COUNT(DISTINCT vid) as uniq,
      SUM(CASE WHEN logged_in = 1 THEN 1 ELSE 0 END) as logged_in
    FROM visits
    WHERE ts >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(monthStart);

  const dailyMap = {};
  for (const r of dailyRows) {
    dailyMap[r.day] = { views: r.views, unique: r.uniq, loggedIn: r.logged_in };
  }

  const dailyViews = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const entry = dailyMap[key] || { views: 0, unique: 0, loggedIn: 0 };
    dailyViews.push({ date: key, views: entry.views, unique: entry.unique, loggedIn: entry.loggedIn });
  }

  return {
    todayViews,
    yesterdayViews,
    totalViews,
    uniqueToday,
    uniqueWeek,
    uniqueMonth,
    loggedInToday,
    anonymousToday,
    topPages,
    recentActivity,
    activeUsers,
    activeUserCount: activeUsers.length,
    allTimeUsers,
    dailyViews,
  };
}

function recordDeposit(amount) {
  const current = Number(db.prepare("SELECT value FROM meta WHERE key = 'totalDeposited'").get()?.value || 0);
  const updated = current + (Number(amount) || 0);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('totalDeposited', ?)").run(String(updated));
}

function getTotalDeposited() {
  return Number(db.prepare("SELECT value FROM meta WHERE key = 'totalDeposited'").get()?.value || 0);
}

module.exports = { init, middleware, getStats, recordDeposit, getTotalDeposited };
