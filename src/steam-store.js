const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "steam.db");

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS steam_links (
      discord_id TEXT PRIMARY KEY,
      discord_username TEXT,
      steam_id TEXT NOT NULL,
      steam_name TEXT,
      updated_at INTEGER NOT NULL
    )
  `);

  console.log("SteamStore: initialized.");
}

function upsert(discordId, discordUsername, steamId, steamName) {
  if (!db) return;
  db.prepare(`
    INSERT INTO steam_links (discord_id, discord_username, steam_id, steam_name, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      discord_username = excluded.discord_username,
      steam_id = excluded.steam_id,
      steam_name = excluded.steam_name,
      updated_at = excluded.updated_at
  `).run(discordId, discordUsername, steamId, steamName, Date.now());
}

function getByDiscordId(discordId) {
  if (!db) return null;
  return db.prepare("SELECT * FROM steam_links WHERE discord_id = ?").get(discordId) || null;
}

function getBySteamId(steamId) {
  if (!db) return null;
  return db.prepare("SELECT * FROM steam_links WHERE steam_id = ?").get(steamId) || null;
}

function getAll() {
  if (!db) return [];
  return db.prepare("SELECT * FROM steam_links ORDER BY updated_at DESC").all();
}

function getCount() {
  if (!db) return 0;
  return db.prepare("SELECT COUNT(*) AS c FROM steam_links").get().c;
}

module.exports = { init, upsert, getByDiscordId, getBySteamId, getAll, getCount };
