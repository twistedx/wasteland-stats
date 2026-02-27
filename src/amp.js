const axios = require("axios");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const config = require("./config");

const POLL_INTERVAL = 60 * 1000; // 1 minute
const DB_DIR = "/var/data";
const DB_FILE = path.join(DB_DIR, "amp.db");

let sessionID = null;
let serverData = [];
let pollTimer = null;
let lastFetch = null;
let db = null;

async function login() {
  console.log("AMP: logging in to", config.amp.url);
  const res = await axios.post(`${config.amp.url}/API/Core/Login`, {
    username: config.amp.username,
    password: config.amp.password,
    token: "",
    rememberMe: false,
  }, {
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });

  if (!res.data.success) {
    console.error("AMP: login failed:", res.data.resultReason || "unknown");
    throw new Error("AMP login failed: " + (res.data.resultReason || "unknown"));
  }

  sessionID = res.data.sessionID;
  console.log("AMP: login successful, sessionID obtained");
  return sessionID;
}

async function apiCall(endpoint, params = {}) {
  console.log(`AMP: calling ${endpoint}`);
  if (!sessionID) {
    await login();
  }

  try {
    const res = await axios.post(`${config.amp.url}/API/${endpoint}`, {
      SESSIONID: sessionID,
      ...params,
    }, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    // Check for auth errors and re-login
    if (res.data?.Title === "Unauthorized Access" || res.data?.Title === "Session Expired") {
      console.log(`AMP: session expired on ${endpoint}, re-authenticating`);
      await login();
      const retry = await axios.post(`${config.amp.url}/API/${endpoint}`, {
        SESSIONID: sessionID,
        ...params,
      }, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      });
      return retry.data;
    }

    return res.data;
  } catch (err) {
    // If 401/403, re-login and retry once
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      await login();
      const retry = await axios.post(`${config.amp.url}/API/${endpoint}`, {
        SESSIONID: sessionID,
        ...params,
      }, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      });
      return retry.data;
    }
    throw err;
  }
}

async function fetchInstances() {
  const response = await apiCall("ADSModule/GetInstances", { ForceIncludeSelf: true });

  // Handle both raw array and { result: [...] } wrapper
  console.log("AMP: GetInstances raw response type:", typeof response, Array.isArray(response) ? `array[${response.length}]` : Object.keys(response || {}).join(","));
  const targets = Array.isArray(response) ? response : (response?.result || response || []);
  if (!Array.isArray(targets)) {
    console.error("AMP: unexpected GetInstances response:", JSON.stringify(response).slice(0, 200));
    return;
  }
  console.log(`AMP: found ${targets.length} target(s)`);

  const instances = [];
  for (const target of targets) {
    if (!target.AvailableInstances) {
      console.log(`AMP: target "${target.FriendlyName}" has no AvailableInstances`);
      continue;
    }
    console.log(`AMP: target "${target.FriendlyName}" has ${target.AvailableInstances.length} instance(s)`);
    for (const inst of target.AvailableInstances) {
      // Skip the ADS controller itself
      if (inst.Module === "ADS") {
        console.log(`AMP:   skipping ADS controller "${inst.FriendlyName}"`);
        continue;
      }

      // GetInstances metrics are cached — fetch live status per instance
      let cpu = {}, ram = {}, users = {};
      try {
        const status = await apiCall(`ADSModule/Servers/${inst.InstanceID}/API/Core/GetStatus`);
        console.log(`AMP:   instance "${inst.FriendlyName}" GetStatus keys:`, Object.keys(status || {}));
        console.log(`AMP:   instance "${inst.FriendlyName}" GetStatus raw:`, JSON.stringify(status).slice(0, 500));
        const liveMetrics = status?.Metrics || {};
        cpu = liveMetrics["CPU Usage"] || {};
        ram = liveMetrics["Memory Usage"] || {};
        users = liveMetrics["Active Users"] || {};
        console.log(`AMP:   instance "${inst.FriendlyName}" LIVE players=${users.RawValue}/${users.MaxValue} cpu=${cpu.RawValue}% ram=${ram.RawValue}MB`);
      } catch (err) {
        // Fall back to cached GetInstances metrics
        const metrics = inst.Metrics || {};
        cpu = metrics["CPU Usage"] || {};
        ram = metrics["Memory Usage"] || {};
        users = metrics["Active Users"] || {};
        console.log(`AMP:   instance "${inst.FriendlyName}" CACHED (live fetch failed: ${err.message}) players=${users.RawValue}/${users.MaxValue}`);
      }

      instances.push({
        instanceId: inst.InstanceID,
        instanceName: inst.InstanceName,
        friendlyName: inst.FriendlyName,
        targetName: target.FriendlyName,
        module: inst.Module,
        running: inst.Running,
        appState: inst.AppState,
        suspended: inst.Suspended,
        ampVersion: inst.AMPVersion,
        cpu: {
          value: Number(cpu.RawValue) || 0,
          max: Number(cpu.MaxValue) || 100,
          percent: Number(cpu.Percent) || 0,
          units: cpu.Units || "%",
        },
        memory: {
          value: Number(ram.RawValue) || 0,
          max: Number(ram.MaxValue) || 0,
          percent: Number(ram.Percent) || 0,
          units: ram.Units || "MB",
        },
        players: {
          current: Number(users.RawValue) || 0,
          max: Number(users.MaxValue) || 0,
          percent: Number(users.Percent) || 0,
        },
        endpoints: (inst.ApplicationEndpoints || []).map(ep => ({
          name: ep.DisplayName,
          endpoint: ep.Endpoint,
          uri: ep.Uri,
        })),
      });
    }
  }

  serverData = instances;
  lastFetch = new Date().toISOString();
  console.log(`AMP: fetched ${instances.length} instances, ${instances.reduce((s, i) => s + i.players.current, 0)} total players`);

  // Record metrics to DB
  if (db) {
    const insert = db.prepare(
      "INSERT INTO metrics (instance_id, friendly_name, players, max_players, cpu_percent, memory_percent, memory_mb, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const now = Date.now();
    const tx = db.transaction(() => {
      for (const inst of instances) {
        insert.run(
          inst.instanceId,
          inst.friendlyName,
          inst.players.current,
          inst.players.max,
          inst.cpu.percent,
          inst.memory.percent,
          inst.memory.value,
          now
        );
      }
    });
    tx();
  }
}

function initDb() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      friendly_name TEXT,
      players INTEGER NOT NULL DEFAULT 0,
      max_players INTEGER NOT NULL DEFAULT 0,
      cpu_percent INTEGER NOT NULL DEFAULT 0,
      memory_percent INTEGER NOT NULL DEFAULT 0,
      memory_mb INTEGER NOT NULL DEFAULT 0,
      recorded_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_metrics_instance ON metrics (instance_id, recorded_at)
  `);

  // Prune data older than 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM metrics WHERE recorded_at < ?").run(cutoff);
}

function init() {
  if (!config.amp.url || !config.amp.username || !config.amp.password) {
    console.log("AMP: skipping init (no credentials configured).");
    return;
  }

  initDb();

  fetchInstances().catch(err =>
    console.error("AMP: initial fetch failed:", err.message)
  );

  pollTimer = setInterval(() => {
    fetchInstances().catch(err =>
      console.error("AMP: poll failed:", err.message)
    );
  }, POLL_INTERVAL);

  console.log(`AMP: polling instances every ${POLL_INTERVAL / 1000}s`);
}

function getStatus() {
  const totalPlayers = serverData.reduce((sum, s) => sum + s.players.current, 0);
  const totalMax = serverData.reduce((sum, s) => sum + s.players.max, 0);
  return {
    instances: serverData,
    totalPlayers,
    totalMax,
    fetchedAt: lastFetch,
  };
}

function getHistory(hours = 24) {
  if (!db) return [];
  const since = Date.now() - hours * 60 * 60 * 1000;
  return db.prepare(`
    SELECT instance_id, friendly_name, players, max_players, cpu_percent, memory_percent, memory_mb, recorded_at
    FROM metrics
    WHERE recorded_at >= ?
    ORDER BY recorded_at ASC
  `).all(since);
}

module.exports = { init, getStatus, getHistory, apiCall };
