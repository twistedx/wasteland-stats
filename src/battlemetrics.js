const axios = require("axios");
const fs = require("fs");
const path = require("path");

const SERVERS = [
  { id: "32143546", label: "Server 1" },
  { id: "37902633", label: "Server 2" },
];

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const PEAK_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
const PEAK_FILE = path.join(__dirname, "..", "data", "peaks.json");

let serverData = [];
// { serverId: [ { count, timestamp }, ... ] } — rolling 24h samples
let peakSamples = {};
let pollTimer = null;

function loadPeaks() {
  try {
    if (fs.existsSync(PEAK_FILE)) {
      peakSamples = JSON.parse(fs.readFileSync(PEAK_FILE, "utf8"));
    }
  } catch (err) {
    console.error("BattleMetrics: failed to load peaks", err.message);
    peakSamples = {};
  }
}

function savePeaks() {
  try {
    fs.writeFileSync(PEAK_FILE, JSON.stringify(peakSamples), "utf8");
  } catch (err) {
    console.error("BattleMetrics: failed to save peaks", err.message);
  }
}

function recordSample(serverId, count) {
  if (!peakSamples[serverId]) peakSamples[serverId] = [];
  peakSamples[serverId].push({ count, timestamp: Date.now() });
  // Prune samples older than 24 hours
  const cutoff = Date.now() - PEAK_WINDOW;
  peakSamples[serverId] = peakSamples[serverId].filter(s => s.timestamp >= cutoff);
}

function getPeak(serverId) {
  const samples = peakSamples[serverId];
  if (!samples || samples.length === 0) return 0;
  const cutoff = Date.now() - PEAK_WINDOW;
  let max = 0;
  for (const s of samples) {
    if (s.timestamp >= cutoff && s.count > max) max = s.count;
  }
  return max;
}

async function fetchServers() {
  const results = await Promise.allSettled(
    SERVERS.map(async (srv) => {
      const res = await axios.get(
        `https://api.battlemetrics.com/servers/${srv.id}`,
        { timeout: 10000 }
      );
      const a = res.data?.data?.attributes || {};
      return {
        id: srv.id,
        label: srv.label,
        name: a.name || "Unknown",
        players: a.players || 0,
        maxPlayers: a.maxPlayers || 0,
        status: a.status || "unknown",
        rank: a.rank || null,
        country: a.country || null,
        updatedAt: a.updatedAt || null,
      };
    })
  );

  serverData = results.map((r, i) => {
    if (r.status === "fulfilled") {
      const srv = r.value;
      recordSample(srv.id, srv.players);
      srv.peak = getPeak(srv.id);
      return srv;
    }
    const fallback = {
      id: SERVERS[i].id,
      label: SERVERS[i].label,
      name: "Unavailable",
      players: 0,
      maxPlayers: 0,
      status: "error",
      rank: null,
      country: null,
      updatedAt: null,
      peak: getPeak(SERVERS[i].id),
    };
    return fallback;
  });

  savePeaks();
}

function init() {
  loadPeaks();

  fetchServers().catch((err) =>
    console.error("BattleMetrics: initial fetch failed", err.message)
  );

  pollTimer = setInterval(() => {
    fetchServers().catch((err) =>
      console.error("BattleMetrics: poll failed", err.message)
    );
  }, POLL_INTERVAL);

  console.log(
    `BattleMetrics: polling ${SERVERS.length} servers every ${POLL_INTERVAL / 1000}s`
  );
}

function getStatus() {
  const totalPlayers = serverData.reduce((sum, s) => sum + s.players, 0);
  const totalMax = serverData.reduce((sum, s) => sum + s.maxPlayers, 0);
  return {
    servers: serverData,
    totalPlayers,
    totalMax,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { init, getStatus };
