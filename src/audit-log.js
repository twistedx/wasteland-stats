const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "audit.db");
const RETENTION_DAYS = 90;

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      category TEXT NOT NULL,
      detail TEXT,
      admin_username TEXT NOT NULL,
      admin_discord_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_cat ON audit_log (category)`);

  // Prune old entries
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().replace("T", " ").slice(0, 19);
  db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff);

  const count = db.prepare("SELECT COUNT(*) as cnt FROM audit_log").get().cnt;
  console.log(`AuditLog: ${count} entries in database.`);
}

function log(category, action, detail, user) {
  if (!db) return;
  db.prepare("INSERT INTO audit_log (action, category, detail, admin_username, admin_discord_id) VALUES (?, ?, ?, ?, ?)")
    .run(action, category, detail || null, user?.username || "unknown", user?.discord_id || null);
}

function getEntries({ category, limit, offset } = {}) {
  limit = Math.min(limit || 50, 200);
  offset = offset || 0;
  if (category) {
    return db.prepare("SELECT * FROM audit_log WHERE category = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(category, limit, offset);
  }
  return db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
}

function getCategories() {
  return db.prepare("SELECT DISTINCT category FROM audit_log ORDER BY category").all().map(r => r.category);
}

function getStats() {
  const total = db.prepare("SELECT COUNT(*) as cnt FROM audit_log").get().cnt;
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = db.prepare("SELECT COUNT(*) as cnt FROM audit_log WHERE created_at >= ?").get(todayStr).cnt;
  const byCat = db.prepare("SELECT category, COUNT(*) as cnt FROM audit_log GROUP BY category ORDER BY cnt DESC").all();
  const byAdmin = db.prepare("SELECT admin_username, COUNT(*) as cnt FROM audit_log GROUP BY admin_username ORDER BY cnt DESC LIMIT 10").all();
  return { total, today, byCat, byAdmin };
}

module.exports = { init, log, getEntries, getCategories, getStats };
