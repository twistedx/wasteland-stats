const axios = require("axios");

const SERVERS = [
  { id: "32143546", label: "Server 1" },
  { id: "37902633", label: "Server 2" },
];

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
let serverData = [];
let peakPlayers = {}; // { serverId: number }
let pollTimer = null;

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
      if (!peakPlayers[srv.id] || srv.players > peakPlayers[srv.id]) {
        peakPlayers[srv.id] = srv.players;
      }
      srv.peak = peakPlayers[srv.id] || srv.players;
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
      peak: peakPlayers[SERVERS[i].id] || 0,
    };
    return fallback;
  });
}

function init() {
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
