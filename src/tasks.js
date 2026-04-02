const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "tasks.db");

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'not_started',
      type TEXT NOT NULL DEFAULT 'bug',
      priority TEXT NOT NULL DEFAULT 'normal',
      created_by TEXT NOT NULL,
      created_by_discord_id TEXT,
      link TEXT DEFAULT NULL,
      assigned_to TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)`);

  // Add type column to existing databases
  try { db.exec(`ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'bug'`); } catch (e) { /* column exists */ }
  try { db.exec(`ALTER TABLE tasks ADD COLUMN link TEXT DEFAULT NULL`); } catch (e) { /* column exists */ }
  try { db.exec(`ALTER TABLE tasks ADD COLUMN notes TEXT DEFAULT ''`); } catch (e) { /* column exists */ }

  const count = db.prepare("SELECT COUNT(*) as cnt FROM tasks").get().cnt;
  console.log(`Tasks: ${count} tasks in database.`);
}

function create({ title, description, type, priority, created_by, created_by_discord_id, assigned_to, link }) {
  const result = db.prepare(`
    INSERT INTO tasks (title, description, type, priority, created_by, created_by_discord_id, assigned_to, link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, description || "", type || "bug", priority || "normal", created_by, created_by_discord_id || null, assigned_to || null, link || null);
  return result.lastInsertRowid;
}

function getAll() {
  return db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
}

function getByStatus(status) {
  return db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC").all(status);
}

function getById(id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

function updateStatus(id, status) {
  return db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

function update(id, { title, description, type, priority, status, assigned_to, link }) {
  return db.prepare(`
    UPDATE tasks SET title = ?, description = ?, type = ?, priority = ?, status = ?, assigned_to = ?, link = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(title, description || "", type || "bug", priority || "normal", status, assigned_to || null, link || null, id);
}

function updateNotes(id, notes) {
  return db.prepare("UPDATE tasks SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(notes || "", id);
}

function remove(id) {
  return db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

function getStats() {
  const rows = db.prepare("SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status").all();
  const stats = { not_started: 0, in_progress: 0, blocked: 0, completed: 0 };
  for (const r of rows) stats[r.status] = r.cnt;
  stats.total = Object.values(stats).reduce((a, b) => a + b, 0);
  return stats;
}

module.exports = { init, create, getAll, getByStatus, getById, updateStatus, updateNotes, update, remove, getStats };
