const axios = require("axios");

const SERVERS = [
  { id: "32143546", label: "Server 1" },
  { id: "37902633", label: "Server 2" },
];

let serverData = [];

// In-memory daily peak tracking (resets on process restart or new day)
const peaks = {};  // keyed by server id
let peakDate = new Date().toDateString();

async function fetchServers() {
  const results = await Promise.allSettled(
    SERVERS.map(async (srv) => {
      const res = await axios.get(
        `https://api.battlemetrics.com/servers/${srv.id}`,
        {
          timeout: 10000,
          headers: {
            "Cache-Control": "no-cache, no-store",
            "Pragma": "no-cache",
          },
        }
      );
      const a = res.data?.data?.attributes || {};
      return {
        id: srv.id,
        label: srv.label,
        name: a.name || "Unknown",
        players: a.players || 0,
        maxPlayers: a.maxPlayers || 0,
        status: a.status || "unknown",
      };
    })
  );

  // Reset peaks on new day
  const today = new Date().toDateString();
  if (today !== peakDate) {
    for (const id in peaks) delete peaks[id];
    peakDate = today;
  }

  serverData = results.map((r, i) => {
    if (r.status === "fulfilled") {
      const srv = r.value;
      // Update daily peak
      if (!peaks[srv.id] || srv.players > peaks[srv.id]) {
        peaks[srv.id] = srv.players;
      }
      srv.peak = peaks[srv.id];
      console.log(`BattleMetrics: ${srv.label} "${srv.name}" — ${srv.players}/${srv.maxPlayers} players (peak: ${srv.peak})`);
      return srv;
    }
    console.error(`BattleMetrics: ${SERVERS[i].label} fetch failed:`, r.reason?.message);
    return {
      id: SERVERS[i].id,
      label: SERVERS[i].label,
      name: "Unavailable",
      players: 0,
      maxPlayers: 0,
      peak: peaks[SERVERS[i].id] || 0,
      status: "error",
    };
  });
}

function init() {
  console.log("BattleMetrics: initialized (live fetch only, no DB).");
}

function getStatus() {
  const totalPlayers = serverData.reduce((sum, s) => sum + s.players, 0);
  const totalMax = serverData.reduce((sum, s) => sum + s.maxPlayers, 0);
  return {
    servers: serverData,
    totalPlayers,
    totalMax,
  };
}

async function getFreshStatus() {
  await fetchServers();
  return getStatus();
}

module.exports = { init, getStatus, getFreshStatus };
