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

  // If any ArmaHQ call failed, try AMP as a fallback source for player counts
  let ampFallback = null;
  if (results.some(r => r.status === "rejected")) {
    try {
      const amp = require("./amp");
      ampFallback = amp.getStatus();
      if (!ampFallback?.instances?.length) {
        ampFallback = await amp.getFreshStatus().catch(() => null);
      }
    } catch (e) {
      console.error("ArmaHQ: AMP fallback unavailable:", e.message);
    }
  }

  function matchAmpInstance(label) {
    if (!ampFallback?.instances) return null;
    const running = ampFallback.instances.filter(i => i.running && i.appState >= 5 && /wasteland/i.test(i.friendlyName));
    // Map "Server 1" → first running wasteland instance, "Server 2" → second, etc.
    const m = label.match(/(\d+)/);
    const idx = m ? parseInt(m[1], 10) - 1 : 0;
    return running[idx] || null;
  }

  serverData = results.map((r, i) => {
    if (r.status === "fulfilled") {
      const srv = r.value;
      if (!peaks[srv.id] || srv.players > peaks[srv.id]) {
        peaks[srv.id] = srv.players;
      }
      srv.peak = peaks[srv.id];
      console.log(`ArmaHQ: ${srv.label} "${srv.name}" — ${srv.players}/${srv.maxPlayers} players, queue: ${srv.queue} (peak: ${srv.peak})`);
      return srv;
    }

    console.error(`ArmaHQ: ${SERVERS[i].label} fetch failed:`, r.reason?.message);

    const ampInst = matchAmpInstance(SERVERS[i].label);
    if (ampInst) {
      const players = ampInst.players.current || 0;
      if (!peaks[SERVERS[i].id] || players > peaks[SERVERS[i].id]) {
        peaks[SERVERS[i].id] = players;
      }
      console.log(`ArmaHQ: ${SERVERS[i].label} falling back to AMP "${ampInst.friendlyName}" — ${players}/${ampInst.players.max} players`);
      return {
        id: SERVERS[i].id,
        label: SERVERS[i].label,
        name: ampInst.friendlyName,
        players,
        maxPlayers: ampInst.players.max || 0,
        queue: 0,
        peak: peaks[SERVERS[i].id] || 0,
        status: "online",
        source: "amp",
      };
    }

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
