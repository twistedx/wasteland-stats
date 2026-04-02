const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const axios = require("axios");
const vacChecker = require("./vac-checker");
const steamStore = require("./steam-store");
const config = require("./config");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "vac-scan.db");

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS vac_results (
      steam_id TEXT PRIMARY KEY,
      discord_id TEXT,
      discord_username TEXT,
      arma_id TEXT,
      vac_banned INTEGER NOT NULL DEFAULT 0,
      number_of_vac_bans INTEGER NOT NULL DEFAULT 0,
      days_since_last_ban INTEGER NOT NULL DEFAULT 0,
      community_banned INTEGER NOT NULL DEFAULT 0,
      number_of_game_bans INTEGER NOT NULL DEFAULT 0,
      economy_ban INTEGER NOT NULL DEFAULT 0,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vac_banned ON vac_results (vac_banned)`);

  // Migration: add arma_id column
  try { db.exec("ALTER TABLE vac_results ADD COLUMN arma_id TEXT"); } catch (e) { /* exists */ }

  const count = db.prepare("SELECT COUNT(*) as cnt FROM vac_results WHERE vac_banned = 1 OR number_of_game_bans > 0").get().cnt;
  console.log(`VACScanner: ${count} flagged players in database.`);
}

// All known arma_id → steam64_id mappings from the backend database
// TODO: Replace with GET /admin/steam-ids/all endpoint when available
const BACKEND_STEAM_IDS_FILE = path.join(DB_DIR, "steam-ids-cache.json");

function loadBackendSteamIds() {
  try {
    if (fs.existsSync(BACKEND_STEAM_IDS_FILE)) {
      return JSON.parse(fs.readFileSync(BACKEND_STEAM_IDS_FILE, "utf8"));
    }
  } catch {}
  return [];
}

function saveBackendSteamIds(data) {
  fs.writeFileSync(BACKEND_STEAM_IDS_FILE, JSON.stringify(data), "utf8");
}

// Fetch Steam IDs — uses cached file, falls back to API
async function fetchBackendSteamIds() {
  // Try API bulk endpoint first (for when it's available)
  if (config.adminApiToken) {
    try {
      const adminApi = axios.create({ baseURL: config.apiBaseUrl, timeout: 30000, headers: { "Content-Type": "application/json" } });
      const res = await adminApi.get("/admin/steam-ids/all", { params: { token: config.adminApiToken } });
      if (res.data?.steam_ids && Array.isArray(res.data.steam_ids) && res.data.steam_ids.length > 0) {
        const mapped = res.data.steam_ids.map(r => ({ arma_id: r.arma_id, steam_id: r.steam64_id })).filter(r => r.arma_id && r.steam_id);
        console.log(`[VAC Scan]   Fetched ${mapped.length} Steam IDs from bulk API endpoint`);
        saveBackendSteamIds(mapped);
        return mapped;
      }
    } catch {
      // Bulk endpoint not available yet — use cache
    }
  }

  const cached = loadBackendSteamIds();
  if (cached.length > 0) {
    console.log(`[VAC Scan]   Loaded ${cached.length} Steam IDs from cache`);
    return cached;
  }

  console.log("[VAC Scan]   No Steam ID data available (no bulk endpoint or cache)");
  return [];
}

// Progressive scan — only check Steam IDs not already in the database
async function scan({ full = false } = {}) {
  if (!config.steamApiKey) {
    console.log("VACScanner: no Steam API key, skipping.");
    return { scanned: 0, flagged: 0, skipped: 0 };
  }

  console.log(`[VAC Scan] === Starting ${full ? "FULL" : "progressive"} scan ===`);

  // Collect Steam IDs from both sources
  console.log("[VAC Scan] Step 1: Fetching Steam IDs from local steam_links...");
  const allLinks = steamStore.getAll();
  console.log(`[VAC Scan]   Found ${allLinks.length} Discord-linked Steam IDs`);

  console.log("[VAC Scan] Step 2: Fetching Steam IDs from backend API...");
  const backendSteam = await fetchBackendSteamIds();

  // Merge: steam_id -> { discord_id, discord_username, arma_id }
  const steamEntries = new Map();
  for (const l of allLinks) {
    if (l.steam_id) {
      steamEntries.set(l.steam_id, {
        discord_id: l.discord_id,
        discord_username: l.discord_username,
        arma_id: null,
      });
    }
  }
  for (const b of backendSteam) {
    if (steamEntries.has(b.steam_id)) {
      steamEntries.get(b.steam_id).arma_id = b.arma_id;
    } else {
      steamEntries.set(b.steam_id, {
        discord_id: null,
        discord_username: null,
        arma_id: b.arma_id,
      });
    }
  }

  // Resolve arma_ids for Discord-linked players that don't have one
  const needArmaLookup = [...steamEntries.entries()].filter(([_, e]) => !e.arma_id && e.discord_id);
  if (needArmaLookup.length > 0) {
    console.log(`[VAC Scan]   Resolving arma_ids for ${needArmaLookup.length} Discord-linked players...`);
    const lookupApi = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
    let resolved = 0;
    for (let i = 0; i < needArmaLookup.length; i += 10) {
      const batch = needArmaLookup.slice(i, i + 10);
      await Promise.allSettled(batch.map(async ([, entry]) => {
        try {
          const res = await lookupApi({ method: "GET", url: "/user/getPlayerStatsByDiscordID/", data: { discord_id: entry.discord_id, token: config.apiToken } });
          const armaId = res.data?.arma_id;
          if (armaId) {
            entry.arma_id = armaId;
            resolved++;
          }
        } catch {}
      }));
    }
    console.log(`[VAC Scan]   Resolved ${resolved}/${needArmaLookup.length} arma_ids from Discord IDs`);
  }

  console.log(`[VAC Scan] Step 3: Merged ${steamEntries.size} unique Steam IDs from both sources`);

  if (steamEntries.size === 0) {
    console.log("[VAC Scan] No Steam IDs found from any source. Aborting.");
    return { scanned: 0, flagged: 0, skipped: 0 };
  }

  let steamIds;
  let skipped = 0;

  if (full) {
    steamIds = [...steamEntries.keys()];
  } else {
    const alreadyScanned = new Set(
      db.prepare("SELECT steam_id FROM vac_results").all().map(r => r.steam_id)
    );
    steamIds = [...steamEntries.keys()].filter(id => !alreadyScanned.has(id));
    skipped = steamEntries.size - steamIds.length;
  }

  if (steamIds.length === 0) {
    console.log(`VACScanner: no new IDs to scan (${skipped} already scanned).`);
    return { scanned: 0, flagged: 0, skipped };
  }

  console.log(`[VAC Scan] Step 4: Checking ${steamIds.length} new Steam IDs against Valve API (${skipped} already scanned)...`);

  const results = await vacChecker.checkBans(steamIds);

  const upsertStmt = db.prepare(`
    INSERT INTO vac_results (steam_id, discord_id, discord_username, arma_id, vac_banned, number_of_vac_bans, days_since_last_ban, community_banned, number_of_game_bans, economy_ban, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(steam_id) DO UPDATE SET
      discord_id = COALESCE(excluded.discord_id, vac_results.discord_id),
      discord_username = COALESCE(excluded.discord_username, vac_results.discord_username),
      arma_id = COALESCE(excluded.arma_id, vac_results.arma_id),
      vac_banned = excluded.vac_banned,
      number_of_vac_bans = excluded.number_of_vac_bans,
      days_since_last_ban = excluded.days_since_last_ban,
      community_banned = excluded.community_banned,
      number_of_game_bans = excluded.number_of_game_bans,
      economy_ban = excluded.economy_ban,
      scanned_at = datetime('now')
  `);

  console.log(`[VAC Scan] Step 5: Saving ${results.length} results to database...`);

  let flagged = 0;
  const tx = db.transaction(() => {
    for (const r of results) {
      const entry = steamEntries.get(r.SteamId) || {};
      const isBanned = r.VACBanned || r.NumberOfGameBans > 0;
      if (isBanned) flagged++;
      upsertStmt.run(
        r.SteamId,
        entry.discord_id || null,
        entry.discord_username || null,
        entry.arma_id || null,
        r.VACBanned ? 1 : 0,
        r.NumberOfVACBans || 0,
        r.DaysSinceLastBan || 0,
        r.CommunityBanned ? 1 : 0,
        r.NumberOfGameBans || 0,
        r.EconomyBan !== "none" ? 1 : 0,
      );
    }
  });
  tx();

  console.log(`[VAC Scan] === Scan complete: ${results.length} checked, ${flagged} flagged, ${skipped} skipped ===`);
  return { scanned: results.length, flagged, skipped };
}

function getFlagged() {
  if (!db) return [];
  return db.prepare("SELECT * FROM vac_results WHERE vac_banned = 1 OR number_of_game_bans > 0 ORDER BY days_since_last_ban ASC").all();
}

function getAll() {
  if (!db) return [];
  return db.prepare("SELECT * FROM vac_results ORDER BY scanned_at DESC").all();
}

function getStats() {
  if (!db) return { total: 0, vacBanned: 0, gameBanned: 0, clean: 0 };
  const total = db.prepare("SELECT COUNT(*) as cnt FROM vac_results").get().cnt;
  const vacBanned = db.prepare("SELECT COUNT(*) as cnt FROM vac_results WHERE vac_banned = 1").get().cnt;
  const gameBanned = db.prepare("SELECT COUNT(*) as cnt FROM vac_results WHERE number_of_game_bans > 0 AND vac_banned = 0").get().cnt;
  const clean = total - vacBanned - gameBanned;
  return { total, vacBanned, gameBanned, clean };
}

function getLastScan() {
  if (!db) return null;
  const row = db.prepare("SELECT MAX(scanned_at) as last FROM vac_results").get();
  return row?.last || null;
}

module.exports = { init, scan, getFlagged, getAll, getStats, getLastScan };
