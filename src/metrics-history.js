const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "metrics.db");

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS server_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      instance_id TEXT NOT NULL,
      instance_name TEXT NOT NULL,
      players INTEGER DEFAULT 0,
      max_players INTEGER DEFAULT 0,
      queue INTEGER DEFAULT 0,
      cpu REAL DEFAULT 0,
      memory REAL DEFAULT 0,
      memory_max REAL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON server_metrics(ts);
    CREATE INDEX IF NOT EXISTS idx_metrics_instance ON server_metrics(instance_id, ts);
  `);

  // Purge data older than 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM server_metrics WHERE ts < ?").run(cutoff);

  const count = db.prepare("SELECT COUNT(*) as cnt FROM server_metrics").get().cnt;
  console.log(`MetricsHistory: initialized, ${count} data points in DB.`);
}

const INSERT_SQL = `INSERT INTO server_metrics (ts, instance_id, instance_name, players, max_players, queue, cpu, memory, memory_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function record(instances, armaHqServers) {
  if (!db) return;

  const now = Date.now();
  const insert = db.prepare(INSERT_SQL);

  const tx = db.transaction(() => {
    // Record AMP instances (CPU + memory from AMP, players from ArmaHQ overlay)
    for (const inst of instances) {
      // Try to find matching ArmaHQ server for queue data
      const ahqMatch = (armaHqServers || []).find(s =>
        inst.friendlyName.toLowerCase().includes(s.label.toLowerCase().replace("server ", ""))
      );

      insert.run(
        now,
        inst.instanceId,
        inst.friendlyName,
        inst.players.current,
        inst.players.max,
        ahqMatch?.queue || 0,
        inst.cpu.percent,
        inst.memory.value,
        inst.memory.max
      );
    }
  });

  tx();
}

function getHistory(hours) {
  if (!db) return {};

  const since = Date.now() - hours * 60 * 60 * 1000;
  const rows = db.prepare(`
    SELECT instance_id, instance_name, ts, players, cpu, memory, memory_max
    FROM server_metrics
    WHERE ts >= ?
    ORDER BY ts ASC
  `).all(since);

  // Group by instance
  const result = {};
  for (const row of rows) {
    if (!result[row.instance_id]) {
      result[row.instance_id] = {
        name: row.instance_name,
        times: [],
        players: [],
        cpu: [],
        memory: [],
      };
    }
    const entry = result[row.instance_id];
    entry.times.push(row.ts);
    entry.players.push(row.players);
    entry.cpu.push(Math.round(row.cpu * 10) / 10);
    entry.memory.push(row.memory_max > 0 ? Math.round((row.memory / row.memory_max) * 100) : 0);
  }

  return result;
}

module.exports = { init, record, getHistory };
