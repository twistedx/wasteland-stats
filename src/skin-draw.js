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
function draw() {
  const pool = getPool();
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

module.exports = { init, getPool, getAllPool, getPoolItem, addToPool, updatePoolItem, removeFromPool, draw, recordDraw, getRecentDraws, getDrawStats, getDropRates, upsertPoolItems };
