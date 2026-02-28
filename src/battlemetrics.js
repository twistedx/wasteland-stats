const axios = require("axios");
const config = require("./config");

const SERVERS = [
  { id: "8f7304f7-a5bb-44c9-a11a-689cac78bba6", label: "Server 1" },
  { id: "0965fe2b-5983-4b29-8dec-93fef69fa2b9", label: "Server 2" },
];

let serverData = [];

// In-memory daily peak tracking (resets on process restart or new day)
const peaks = {};
let peakDate = new Date().toDateString();

async function fetchServers() {
  const results = await Promise.allSettled(
    SERVERS.map(async (srv) => {
      const res = await axios.get(
        `https://armahq.com/api/v1/server/${srv.id}`,
        {
          timeout: 10000,
          headers: {
            "x-api-key": config.armaHqApiKey,
          },
          maxRedirects: 5,
        }
      );
      const d = res.data || {};
      return {
        id: srv.id,
        label: srv.label,
        name: d.serverName || "Unknown",
        players: d.playerCount || 0,
        maxPlayers: d.maxPlayers || 0,
        queue: d.queueCount || 0,
        status: d.success ? "online" : "unknown",
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
      console.log(`ArmaHQ: ${srv.label} "${srv.name}" — ${srv.players}/${srv.maxPlayers} players, queue: ${srv.queue} (peak: ${srv.peak})`);
      return srv;
    }
    console.error(`ArmaHQ: ${SERVERS[i].label} fetch failed:`, r.reason?.message);
    return {
      id: SERVERS[i].id,
      label: SERVERS[i].label,
      name: "Unavailable",
      players: 0,
      maxPlayers: 0,
      queue: 0,
      peak: peaks[SERVERS[i].id] || 0,
      status: "error",
    };
  });
}

function init() {
  console.log("ArmaHQ: initialized (live fetch only).");
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
