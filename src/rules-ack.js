const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "rules-ack.db");

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  // Rules posts — persistent messages in channels
  db.exec(`CREATE TABLE IF NOT EXISTS rules_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    channel_id TEXT,
    created_by_id TEXT NOT NULL,
    created_by_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Acknowledgments — one row per discord_id per post (upsert on re-click)
  db.exec(`CREATE TABLE IF NOT EXISTS rules_acks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES rules_posts(id),
    discord_id TEXT NOT NULL,
    username TEXT,
    response TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(post_id, discord_id)
  )`);

  db.exec("CREATE INDEX IF NOT EXISTS idx_rules_acks_post ON rules_acks(post_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_rules_acks_discord ON rules_acks(discord_id)");

  const posts = db.prepare("SELECT COUNT(*) as n FROM rules_posts").get().n;
  const acks = db.prepare("SELECT COUNT(*) as n FROM rules_acks").get().n;
  console.log(`RulesAck: ${posts} post(s), ${acks} acknowledgment(s).`);
}

function createPost(createdById, createdByName) {
  const r = db.prepare("INSERT INTO rules_posts (created_by_id, created_by_name) VALUES (?, ?)").run(String(createdById), createdByName);
  return { id: r.lastInsertRowid };
}

function updatePostMessage(postId, messageId, channelId) {
  db.prepare("UPDATE rules_posts SET message_id = ?, channel_id = ? WHERE id = ?").run(messageId, channelId, postId);
}

function getLatestPost() {
  return db.prepare("SELECT * FROM rules_posts ORDER BY id DESC LIMIT 1").get() || null;
}

function getPost(id) {
  return db.prepare("SELECT * FROM rules_posts WHERE id = ?").get(id) || null;
}

function recordAck(postId, discordId, username, response) {
  if (response !== "yes" && response !== "no") throw new Error("Invalid response.");
  db.prepare(
    "INSERT INTO rules_acks (post_id, discord_id, username, response) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(post_id, discord_id) DO UPDATE SET response = excluded.response, username = excluded.username, acknowledged_at = datetime('now')"
  ).run(postId, String(discordId), username, response);
}

function getAcks(postId, { onlyYes = false } = {}) {
  const sql = onlyYes
    ? "SELECT * FROM rules_acks WHERE post_id = ? AND response = 'yes' ORDER BY acknowledged_at DESC"
    : "SELECT * FROM rules_acks WHERE post_id = ? ORDER BY acknowledged_at DESC";
  return db.prepare(sql).all(postId);
}

function getAllAcks() {
  return db.prepare(`
    SELECT a.*, p.created_at as post_created_at
    FROM rules_acks a
    LEFT JOIN rules_posts p ON p.id = a.post_id
    ORDER BY a.acknowledged_at DESC
  `).all();
}

function getStats() {
  const totalPosts = db.prepare("SELECT COUNT(*) as n FROM rules_posts").get().n || 0;
  const totalYes = db.prepare("SELECT COUNT(*) as n FROM rules_acks WHERE response = 'yes'").get().n || 0;
  const totalNo = db.prepare("SELECT COUNT(*) as n FROM rules_acks WHERE response = 'no'").get().n || 0;
  const uniqueAckers = db.prepare("SELECT COUNT(DISTINCT discord_id) as n FROM rules_acks WHERE response = 'yes'").get().n || 0;
  return { totalPosts, totalYes, totalNo, uniqueAckers };
}

function getCountForPost(postId) {
  const yes = db.prepare("SELECT COUNT(*) as n FROM rules_acks WHERE post_id = ? AND response = 'yes'").get(postId).n || 0;
  const no = db.prepare("SELECT COUNT(*) as n FROM rules_acks WHERE post_id = ? AND response = 'no'").get(postId).n || 0;
  return { yes, no, total: yes + no };
}

module.exports = {
  init,
  createPost, updatePostMessage, getLatestPost, getPost,
  recordAck, getAcks, getAllAcks, getStats, getCountForPost,
};
