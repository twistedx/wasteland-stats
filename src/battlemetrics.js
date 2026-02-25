const axios = require("axios");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const SERVERS = [
  { id: "32143546", label: "Server 1" },
  { id: "37902633", label: "Server 2" },
];

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const DB_DIR = "/var/data";
const DB_FILE = path.join(DB_DIR, "peaks.db");

let db = null;
let serverData = [];
let pollTimer = null;
let resetTimer = null;

function initDb() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS peaks (
      server_id TEXT NOT NULL,
      count INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_peaks_server ON peaks (server_id, recorded_at)
  `);

  // Migrate from old JSON file if DB is empty
  const total = db.prepare("SELECT COUNT(*) AS c FROM peaks").get().c;
  const oldFile = path.join(__dirname, "..", "data", "peaks.json");
  if (total === 0 && fs.existsSync(oldFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(oldFile, "utf8"));
      const insert = db.prepare("INSERT INTO peaks (server_id, count, recorded_at) VALUES (?, ?, ?)");
      const migrate = db.transaction(() => {
        for (const [serverId, samples] of Object.entries(raw)) {
          if (!Array.isArray(samples)) continue;
          for (const s of samples) {
            insert.run(serverId, s.count, s.timestamp);
          }
        }
      });
      migrate();
      console.log("BattleMetrics: migrated peaks from JSON to SQLite.");
    } catch (err) {
      console.error("BattleMetrics: JSON migration failed", err.message);
    }
  }
}

function recordSample(serverId, count) {
  db.prepare("INSERT INTO peaks (server_id, count, recorded_at) VALUES (?, ?, ?)").run(serverId, count, Date.now());
}

function getPeak(serverId) {
  const row = db.prepare(
    "SELECT MAX(count) AS peak FROM peaks WHERE server_id = ?"
  ).get(serverId);
  return row?.peak || 0;
}

function dropAllPeaks() {
  db.prepare("DELETE FROM peaks").run();
  console.log("BattleMetrics: daily peak reset complete.");
}

function msUntilNext5amEST() {
  const now = new Date();
  // EST = UTC-5
  const estOffset = -5 * 60;
  const estNow = new Date(now.getTime() + estOffset * 60 * 1000);

  const next5am = new Date(estNow);
  next5am.setUTCHours(5, 0, 0, 0);

  // If 5 AM EST already passed today, schedule for tomorrow
  if (next5am <= estNow) {
    next5am.setUTCDate(next5am.getUTCDate() + 1);
  }

  // Convert back to real time
  return next5am.getTime() - estOffset * 60 * 1000 - now.getTime();
}

function scheduleDailyReset() {
  const ms = msUntilNext5amEST();
  const hours = (ms / 3600000).toFixed(1);
  console.log(`BattleMetrics: next peak reset in ${hours}h (5:00 AM EST).`);

  resetTimer = setTimeout(() => {
    dropAllPeaks();
    // Re-schedule for next day
    scheduleDailyReset();
  }, ms);
}

async function fetchServers() {
  const results = await Promise.allSettled(
    SERVERS.map(async (srv) => {
      const res = await axios.get(
        `https://api.battlemetrics.com/servers/${srv.id}`,
        { timeout: 10000 }
      );
      const a = res.data?.data?.attributes || {};
      return {
        id: srv.id,
        label: srv.label,
        name: a.name || "Unknown",
        players: a.players || 0,
        maxPlayers: a.maxPlayers || 0,
        status: a.status || "unknown",
        rank: a.rank || null,
        country: a.country || null,
        updatedAt: a.updatedAt || null,
      };
    })
  );

  serverData = results.map((r, i) => {
    if (r.status === "fulfilled") {
      const srv = r.value;
      recordSample(srv.id, srv.players);
      srv.peak = getPeak(srv.id);
      return srv;
    }
    return {
      id: SERVERS[i].id,
      label: SERVERS[i].label,
      name: "Unavailable",
      players: 0,
      maxPlayers: 0,
      status: "error",
      rank: null,
      country: null,
      updatedAt: null,
      peak: getPeak(SERVERS[i].id),
    };
  });
}

function init() {
  initDb();

  fetchServers().catch((err) =>
    console.error("BattleMetrics: initial fetch failed", err.message)
  );

  pollTimer = setInterval(() => {
    fetchServers().catch((err) =>
      console.error("BattleMetrics: poll failed", err.message)
    );
  }, POLL_INTERVAL);

  scheduleDailyReset();

  console.log(
    `BattleMetrics: polling ${SERVERS.length} servers every ${POLL_INTERVAL / 1000}s`
  );
}

function getStatus() {
  const totalPlayers = serverData.reduce((sum, s) => sum + s.players, 0);
  const totalMax = serverData.reduce((sum, s) => sum + s.maxPlayers, 0);
  return {
    servers: serverData,
    totalPlayers,
    totalMax,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { init, getStatus };
