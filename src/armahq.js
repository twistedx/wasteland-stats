const axios = require("axios");

const SERVERS = [
  { id: "8f7304f7-a5bb-44c9-a11a-689cac78bba6", label: "Server 1" },
  { id: "0965fe2b-5983-4b29-8dec-93fef69fa2b9", label: "Server 2" },
];

const POLL_INTERVAL = 60 * 1000; // 1 minute

let serverData = [];
let pollTimer = null;

async function fetchServer(srv) {
  const res = await axios.get(`https://www.armahq.com/servers/${srv.id}`, {
    timeout: 15000,
    headers: { "User-Agent": "IWPG-Stats-Dashboard/1.0" },
  });

  const html = res.data;

  // Parse playerCount and playerCountLimit from the embedded RSC payload
  const playersMatch = html.match(/"playerCount"\s*:\s*(\d+)/);
  const maxMatch = html.match(/"playerCountLimit"\s*:\s*(\d+)/);
  const nameMatch = html.match(/"name"\s*:\s*"([^"]+)"/);
  const statusMatch = html.match(/"joinable"\s*:\s*(true|false)/);

  return {
    id: srv.id,
    label: srv.label,
    name: nameMatch ? nameMatch[1] : "Unknown",
    players: playersMatch ? Number(playersMatch[1]) : 0,
    maxPlayers: maxMatch ? Number(maxMatch[1]) : 0,
    status: statusMatch && statusMatch[1] === "true" ? "online" : "offline",
  };
}

async function fetchAll() {
  const results = await Promise.allSettled(SERVERS.map(fetchServer));

  serverData = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.error(`ArmaHQ: failed to fetch ${SERVERS[i].label}:`, r.reason?.message);
    return {
      id: SERVERS[i].id,
      label: SERVERS[i].label,
      name: "Unavailable",
      players: 0,
      maxPlayers: 0,
      status: "error",
    };
  });

  console.log(`ArmaHQ: fetched ${serverData.length} servers, ${serverData.reduce((s, d) => s + d.players, 0)} total players`);
}

function init() {
  fetchAll().catch((err) =>
    console.error("ArmaHQ: initial fetch failed:", err.message)
  );

  pollTimer = setInterval(() => {
    fetchAll().catch((err) =>
      console.error("ArmaHQ: poll failed:", err.message)
    );
  }, POLL_INTERVAL);

  console.log(`ArmaHQ: polling ${SERVERS.length} servers every ${POLL_INTERVAL / 1000}s`);
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
  await fetchAll();
  return getStatus();
}

module.exports = { init, getStatus, getFreshStatus };
