const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "ip-blocks.db");

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_ips (
      ip TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      strikes INTEGER NOT NULL DEFAULT 1,
      blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_blocked_expires ON blocked_ips (expires_at)`);

  // Prune expired blocks on startup
  db.prepare("DELETE FROM blocked_ips WHERE expires_at < datetime('now')").run();

  const count = db.prepare("SELECT COUNT(*) as cnt FROM blocked_ips").get().cnt;
  console.log(`IPBlock: ${count} blocked IPs in database.`);
}

function isBlocked(ip) {
  const row = db.prepare("SELECT * FROM blocked_ips WHERE ip = ? AND expires_at > datetime('now')").get(ip);
  return !!row;
}

function block(ip, reason, durationMs) {
  const expiresAt = new Date(Date.now() + durationMs).toISOString().replace("T", " ").slice(0, 19);
  const existing = db.prepare("SELECT * FROM blocked_ips WHERE ip = ?").get(ip);
  if (existing) {
    db.prepare("UPDATE blocked_ips SET reason = ?, strikes = strikes + 1, blocked_at = datetime('now'), expires_at = ? WHERE ip = ?")
      .run(reason, expiresAt, ip);
  } else {
    db.prepare("INSERT INTO blocked_ips (ip, reason, expires_at) VALUES (?, ?, ?)")
      .run(ip, reason, expiresAt);
  }
}

function unblock(ip) {
  return db.prepare("DELETE FROM blocked_ips WHERE ip = ?").run(ip);
}

function getAll() {
  return db.prepare("SELECT * FROM blocked_ips WHERE expires_at > datetime('now') ORDER BY blocked_at DESC").all();
}

function getStats() {
  const total = db.prepare("SELECT COUNT(*) as cnt FROM blocked_ips WHERE expires_at > datetime('now')").get().cnt;
  const today = db.prepare("SELECT COUNT(*) as cnt FROM blocked_ips WHERE blocked_at >= date('now')").get().cnt;
  return { total, today };
}

function prune() {
  return db.prepare("DELETE FROM blocked_ips WHERE expires_at < datetime('now')").run().changes;
}

module.exports = { init, isBlocked, block, unblock, getAll, getStats, prune };
