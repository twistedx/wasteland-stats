const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "store.db");

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS skin_draw_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      skin_key TEXT NOT NULL,
      rarity TEXT NOT NULL DEFAULT 'common',
      weight INTEGER NOT NULL DEFAULT 100,
      image TEXT DEFAULT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS skin_draw_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT,
      result_name TEXT NOT NULL,
      result_rarity TEXT NOT NULL,
      stripe_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_draw_history_ts ON skin_draw_history (created_at)");
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_draw_pool_name ON skin_draw_pool (name)"); } catch {}

  // Add game_item_name column for backend API mapping
  try { db.exec("ALTER TABLE skin_draw_pool ADD COLUMN game_item_name TEXT DEFAULT NULL"); } catch {}

  // Backfill game_item_name for items that don't match the backend exactly
  const SKIN_GAME_NAMES = {
    "The Sheen Out": "\u{1F334} Wasteland Loadout Drop \u2014 The Sheen Out",
    "The Cowboy": "\u{1F920} Wasteland Loadout Drop \u2014 The Cowboy",
    "The Packer": "\u{1F392} Wasteland Loadout Drop \u2014 The Packer",
    "The Burglar": "\u{1F511} Wasteland Loadout Drop \u2014 The Burglar",
    "The Prepper": "\u{1F52B} Wasteland Loadout Drop \u2014 The Prepper",
    "The Corsair": "\u{1F3F4}\u200D\u2620\uFE0F Wasteland Loadout Drop \u2014 The Corsair",
    "The Slav Specter": "\u{1F47B} Wasteland Loadout Drop \u2014 The Slav Specter",
    "The LumberJack": "\u{1FA93} Wasteland Loadout Drop \u2014 TheLumberJack",
    "Nostalgia": "Nostaglia",
    "R700 - \"Catacomb\"": "R700 - \u201cCatacomb\u201d",
    "R700 - \"Biohazard\"": "R700 - \u201cBiohazard\u201d",
    "R700 - \"Fracture Skin\" - Glowing": "R700 - \u201cFracture Skin\u201d - Glowing",
    "R700 - \"Purple Haze\"": "R700 - \u201cPurple Haze\u201d",
    "AK-105 \"Alien Metal\" Edition": "AK_105-Alien",
    "6B13 \"Striped\" Vest": "6B13 \u201cStriped\u201d Vest",
  };
  const backfillSkin = db.prepare("UPDATE skin_draw_pool SET game_item_name = ? WHERE name = ? AND game_item_name IS NULL");
  for (const [poolName, gameName] of Object.entries(SKIN_GAME_NAMES)) {
    backfillSkin.run(gameName, poolName);
  }
}

function getPool() {
  return db.prepare("SELECT * FROM skin_draw_pool WHERE active = 1 ORDER BY weight DESC").all();
}

function getAllPool() {
  return db.prepare("SELECT * FROM skin_draw_pool ORDER BY rarity, weight DESC").all();
}

function getPoolItem(id) {
  return db.prepare("SELECT * FROM skin_draw_pool WHERE id = ?").get(id);
}

function addToPool({ name, skin_key, rarity, weight, image }) {
  return db.prepare("INSERT INTO skin_draw_pool (name, skin_key, rarity, weight, image) VALUES (?, ?, ?, ?, ?)")
    .run(name, skin_key, rarity || "common", weight || 100, image || null);
}

function updatePoolItem(id, { name, skin_key, rarity, weight, image, active }) {
  return db.prepare("UPDATE skin_draw_pool SET name = ?, skin_key = ?, rarity = ?, weight = ?, image = ?, active = ? WHERE id = ?")
    .run(name, skin_key, rarity, weight, image || null, active, id);
}

function removeFromPool(id) {
  return db.prepare("DELETE FROM skin_draw_pool WHERE id = ?").run(id);
}

// Weighted random draw — cryptographically secure
// Pass ownedNames (Set of lowercase item names) to exclude skins the player already has
function draw(ownedNames) {
  let pool = getPool();
  if (ownedNames && ownedNames.size > 0) {
    const filtered = pool.filter(item => {
      const name = (item.game_item_name || item.name || "").toLowerCase();
      const skinKey = (item.skin_key || "").toLowerCase();
      return !ownedNames.has(name) && !ownedNames.has(skinKey);
    });
    if (filtered.length > 0) {
      pool = filtered;
    } else {
      // Player owns everything in the pool — fall back to full pool
      console.log("[SkinDraw] Player owns all skins in pool, drawing from full pool");
    }
  }
  if (pool.length === 0) return null;

  const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
  const roll = crypto.randomInt(0, totalWeight);

  let cumulative = 0;
  for (const item of pool) {
    cumulative += item.weight;
    if (roll < cumulative) {
      return item;
    }
  }
  return pool[pool.length - 1]; // fallback
}

function recordDraw({ discord_id, result_name, result_rarity, stripe_session_id }) {
  return db.prepare("INSERT INTO skin_draw_history (discord_id, result_name, result_rarity, stripe_session_id) VALUES (?, ?, ?, ?)")
    .run(discord_id || null, result_name, result_rarity, stripe_session_id || null);
}

function getRecentDraws(limit) {
  return db.prepare("SELECT result_name, result_rarity, created_at FROM skin_draw_history ORDER BY created_at DESC LIMIT ?").all(limit || 20);
}

function getDrawStats() {
  const total = db.prepare("SELECT COUNT(*) as cnt FROM skin_draw_history").get().cnt;
  const byRarity = db.prepare("SELECT result_rarity, COUNT(*) as cnt FROM skin_draw_history GROUP BY result_rarity ORDER BY cnt DESC").all();
  const byItem = db.prepare("SELECT result_name, result_rarity, COUNT(*) as cnt FROM skin_draw_history GROUP BY result_name ORDER BY cnt DESC LIMIT 10").all();
  return { total, byRarity, byItem };
}

// Calculate drop rates for display
function getDropRates() {
  const pool = getPool();
  const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
  return pool.map(item => ({
    ...item,
    dropRate: totalWeight > 0 ? ((item.weight / totalWeight) * 100).toFixed(1) : "0.0",
  }));
}

function upsertPoolItems(items) {
  const summary = { inserted: 0, updated: 0 };
  const tx = db.transaction(() => {
    for (const item of items) {
      const existing = db.prepare("SELECT id FROM skin_draw_pool WHERE name = ?").get(item.name);
      if (existing) {
        db.prepare("UPDATE skin_draw_pool SET skin_key = ?, rarity = ?, weight = ?, image = ?, active = ? WHERE name = ?")
          .run(item.skin_key, item.rarity, item.weight, item.image || null, item.active ?? 1, item.name);
        summary.updated++;
      } else {
        db.prepare("INSERT INTO skin_draw_pool (name, skin_key, rarity, weight, image, active) VALUES (?, ?, ?, ?, ?, ?)")
          .run(item.name, item.skin_key, item.rarity || "common", item.weight || 100, item.image || null, item.active ?? 1);
        summary.inserted++;
      }
    }
  });
  tx();
  return summary;
}

function getDrawsByDiscordId(discordId) {
  if (!db) return [];
  return db.prepare("SELECT result_name, result_rarity, created_at FROM skin_draw_history WHERE discord_id = ? ORDER BY created_at DESC").all(discordId);
}

module.exports = { init, getPool, getAllPool, getPoolItem, addToPool, updatePoolItem, removeFromPool, draw, recordDraw, getRecentDraws, getDrawStats, getDropRates, upsertPoolItems, getDrawsByDiscordId };
