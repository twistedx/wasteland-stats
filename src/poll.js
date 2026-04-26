const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "polls.db");

const ACTIVE_DAYS = 30; // logged in within this many days to count as "active"

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    created_by_id TEXT NOT NULL,
    created_by_name TEXT,
    message_id TEXT,
    channel_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    closed_at TEXT
  )`);
  try { db.exec("ALTER TABLE polls ADD COLUMN expires_at TEXT"); } catch (e) { /* exists */ }

  db.exec(`CREATE TABLE IF NOT EXISTS poll_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL REFERENCES polls(id),
    discord_id TEXT NOT NULL,
    username TEXT,
    vote TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    last_login TEXT,
    voted_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(poll_id, discord_id)
  )`);

  db.exec("CREATE INDEX IF NOT EXISTS idx_votes_poll ON poll_votes(poll_id)");

  const total = db.prepare("SELECT COUNT(*) as n FROM polls").get().n;
  console.log(`Polls: ${total} polls created.`);
}

function createPoll(question, createdById, createdByName, durationDays = null) {
  let expiresAt = null;
  if (durationDays && Number.isFinite(durationDays) && durationDays > 0) {
    expiresAt = new Date(Date.now() + durationDays * 86400000).toISOString().replace("T", " ").slice(0, 19);
  }
  const r = db.prepare("INSERT INTO polls (question, created_by_id, created_by_name, expires_at) VALUES (?, ?, ?, ?)").run(question, String(createdById), createdByName, expiresAt);
  return { id: r.lastInsertRowid, question, expiresAt };
}

function getExpiredOpenPolls() {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  return db.prepare("SELECT * FROM polls WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?").all(now);
}

function getPoll(id) {
  return db.prepare("SELECT * FROM polls WHERE id = ?").get(id) || null;
}

function updatePollMessage(id, messageId, channelId) {
  db.prepare("UPDATE polls SET message_id = ?, channel_id = ? WHERE id = ?").run(messageId, channelId, id);
}

function getExistingVote(pollId, discordId) {
  return db.prepare("SELECT * FROM poll_votes WHERE poll_id = ? AND discord_id = ?").get(pollId, String(discordId)) || null;
}

// vote: 'yes' or 'no'
// lastLoginISO: ISO string or null from game server
function recordVote(pollId, discordId, username, vote, lastLoginISO) {
  const poll = getPoll(pollId);
  if (!poll) throw new Error("Poll not found.");
  if (poll.status !== "open") throw new Error("This poll is closed.");
  if (vote !== "yes" && vote !== "no") throw new Error("Invalid vote.");

  let isActive = 0;
  if (lastLoginISO) {
    const last = new Date(lastLoginISO);
    if (!isNaN(last)) {
      const daysAgo = (Date.now() - last.getTime()) / (1000 * 60 * 60 * 24);
      if (daysAgo <= ACTIVE_DAYS) isActive = 1;
    }
  }

  // Upsert — user can change vote but we keep their is_active/last_login fresh
  db.prepare(
    "INSERT INTO poll_votes (poll_id, discord_id, username, vote, is_active, last_login) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(poll_id, discord_id) DO UPDATE SET vote = excluded.vote, is_active = excluded.is_active, last_login = excluded.last_login, voted_at = datetime('now'), username = excluded.username"
  ).run(pollId, String(discordId), username, vote, isActive, lastLoginISO || null);

  return { isActive: !!isActive };
}

function getTally(pollId) {
  const rows = db.prepare("SELECT vote, is_active, COUNT(*) as n FROM poll_votes WHERE poll_id = ? GROUP BY vote, is_active").all(pollId);
  let yesActive = 0, yesInactive = 0, noActive = 0, noInactive = 0;
  for (const r of rows) {
    if (r.vote === "yes" && r.is_active) yesActive = r.n;
    else if (r.vote === "yes" && !r.is_active) yesInactive = r.n;
    else if (r.vote === "no" && r.is_active) noActive = r.n;
    else if (r.vote === "no" && !r.is_active) noInactive = r.n;
  }
  return {
    yesActive, yesInactive, noActive, noInactive,
    yesTotal: yesActive + yesInactive,
    noTotal: noActive + noInactive,
    activeTotal: yesActive + noActive,
    inactiveTotal: yesInactive + noInactive,
    grandTotal: yesActive + yesInactive + noActive + noInactive,
  };
}

function closePoll(id, closerDiscordId) {
  const poll = getPoll(id);
  if (!poll) throw new Error("Poll not found.");
  if (poll.status !== "open") throw new Error("Poll is already closed.");
  if (poll.created_by_id !== String(closerDiscordId)) {
    // We'll also allow admins in the command handler, but module default is creator-only
    throw new Error("Only the poll creator can close it (or an admin).");
  }
  db.prepare("UPDATE polls SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(id);
  return getTally(id);
}

function adminClosePoll(id) {
  const poll = getPoll(id);
  if (!poll) throw new Error("Poll not found.");
  if (poll.status !== "open") throw new Error("Poll is already closed.");
  db.prepare("UPDATE polls SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(id);
  return getTally(id);
}

function getRecentPolls(limit = 10) {
  return db.prepare("SELECT * FROM polls ORDER BY id DESC LIMIT ?").all(limit);
}

function getVotes(pollId) {
  return db.prepare("SELECT discord_id, username, vote, is_active, last_login, voted_at FROM poll_votes WHERE poll_id = ? ORDER BY voted_at DESC").all(pollId);
}

function getStats() {
  const open = db.prepare("SELECT COUNT(*) as n FROM polls WHERE status = 'open'").get().n || 0;
  const closed = db.prepare("SELECT COUNT(*) as n FROM polls WHERE status = 'closed'").get().n || 0;
  const totalVotes = db.prepare("SELECT COUNT(*) as n FROM poll_votes").get().n || 0;
  return { open, closed, totalVotes };
}

module.exports = {
  init, ACTIVE_DAYS,
  createPoll, getPoll, updatePollMessage,
  getExistingVote, recordVote, getTally,
  closePoll, adminClosePoll, getRecentPolls, getVotes, getStats, getExpiredOpenPolls,
};
