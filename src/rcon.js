// BattlEye RCON client for Arma Reforger servers
const { Socket } = require("@senfo/battleye");
const config = require("./config");

let socket = null;
const connections = [];

const AUTH_TIMEOUT_MS = 8000;
const PLAYERS_INTER_PACKET_MS = 1000;
const PLAYERS_OVERALL_TIMEOUT_MS = 10000;

function init() {
  const rconServers = config.rconServers || [];
  if (rconServers.length === 0) {
    console.log("RCON: no servers configured, skipping.");
    return;
  }

  socket = new Socket();
  socket.on("error", (err) => {
    console.error("RCON socket error:", err.message || err);
  });
  socket.on("listening", () => {
    console.log("RCON: UDP socket listening.");
  });

  for (const srv of rconServers) {
    if (!srv.address) {
      console.warn(`RCON [${srv.name}]: skipping — no address configured.`);
      continue;
    }

    const conn = {
      name: srv.name,
      address: srv.address,
      port: srv.port,
      password: srv.password,
      client: null,
      connected: false,
      lastError: null,
      messageBuffer: [],   // accumulates server messages between commands
      messageWaiters: [],  // promise resolvers waiting for messages
    };

    try {
      createConnection(conn);
      connections.push(conn);
      console.log(`RCON [${srv.name}]: connecting to ${srv.address}:${srv.port}...`);

      // After a few seconds, if still not connected, log a clearer reason
      setTimeout(() => {
        if (!conn.connected) {
          console.warn(`RCON [${conn.name}]: not connected after ${AUTH_TIMEOUT_MS}ms — likely wrong password, BE RCON disabled on server, or wrong RConPort.`);
        }
      }, AUTH_TIMEOUT_MS);
    } catch (err) {
      console.error(`RCON [${srv.name}]: failed to initialize:`, err.message);
      conn.lastError = err.message;
      connections.push(conn);
    }
  }
}

function createConnection(conn) {
  try {
    conn.client = socket.connection({
      name: conn.name,
      ip: conn.address,
      port: conn.port,
      password: conn.password,
    }, { reconnect: false });

    conn.client.on("connected", () => {
      console.log(`RCON [${conn.name}]: connected & authenticated`);
      conn.connected = true;
      conn.lastError = null;
    });

    conn.client.on("disconnected", (reason) => {
      const reasonMsg = reason?.message || reason || "no reason";
      console.log(`RCON [${conn.name}]: disconnected (${reasonMsg})`);
      conn.connected = false;
      if (conn.client && socket && socket.connections) {
        delete socket.connections[conn.client.id];
      }
    });

    conn.client.on("error", (err) => {
      const msg = err?.message || String(err);
      conn.lastError = msg;
      console.error(`RCON [${conn.name}]: error:`, msg);
      conn.connected = false;
    });

    // Server-broadcast messages (player list, kicks, chat, etc.)
    conn.client.on("message", (msg) => {
      const text = typeof msg === "string" ? msg : (msg?.toString?.() || "");
      conn.messageBuffer.push(text);
      // Notify any pending waiters
      for (const waiter of conn.messageWaiters) waiter(text);
    });
  } catch (err) {
    console.error(`RCON [${conn.name}]: connection error:`, err.message);
    conn.client = null;
    conn.connected = false;
    conn.lastError = err.message;
  }
}

async function reconnect() {
  const results = [];
  for (const conn of connections) {
    if (conn.connected) {
      results.push({ name: conn.name, status: "already connected" });
      continue;
    }
    try {
      if (conn.client) {
        const id = conn.client.id;
        try { conn.client.kill(); } catch {}
        if (socket && socket.connections) delete socket.connections[id];
      }
      conn.messageBuffer = [];
      conn.messageWaiters = [];
      createConnection(conn);
      // Wait for connection up to AUTH_TIMEOUT_MS
      await new Promise(resolve => setTimeout(resolve, AUTH_TIMEOUT_MS));
      results.push({
        name: conn.name,
        status: conn.connected ? "reconnected" : `failed${conn.lastError ? " — " + conn.lastError : ""}`,
      });
    } catch (err) {
      results.push({ name: conn.name, status: `error: ${err.message}` });
    }
  }
  return results;
}

// Send a command and collect server messages that arrive in response.
// Returns the concatenated message text (empty string if none arrived).
async function sendAndCollect(conn, command, { interPacketMs = PLAYERS_INTER_PACKET_MS, overallMs = PLAYERS_OVERALL_TIMEOUT_MS } = {}) {
  if (!conn.connected || !conn.client) {
    throw new Error("Not connected");
  }
  // Snapshot how many messages have already been buffered so we only return new ones
  const startIndex = conn.messageBuffer.length;

  let lastArrived = Date.now();
  const onMsg = () => { lastArrived = Date.now(); };
  conn.messageWaiters.push(onMsg);

  let cmdResult = "";
  try {
    const res = await conn.client.command(command);
    cmdResult = res?.data || "";
  } catch (err) {
    conn.messageWaiters = conn.messageWaiters.filter(w => w !== onMsg);
    throw err;
  }

  // Wait until either no new messages for `interPacketMs`, or `overallMs` elapses.
  const startedAt = Date.now();
  await new Promise(resolve => {
    const tick = setInterval(() => {
      const idle = Date.now() - lastArrived;
      const elapsed = Date.now() - startedAt;
      if (idle >= interPacketMs || elapsed >= overallMs) {
        clearInterval(tick);
        resolve();
      }
    }, 200);
  });

  conn.messageWaiters = conn.messageWaiters.filter(w => w !== onMsg);

  const newMessages = conn.messageBuffer.slice(startIndex);
  // Combine: command-reply data first (often empty for `players`), then broadcast messages
  return [cmdResult, ...newMessages].filter(Boolean).join("\n");
}

async function getPlayers() {
  const allPlayers = [];
  for (const conn of connections) {
    if (!conn.connected || !conn.client) continue;
    try {
      const response = await sendAndCollect(conn, "players");
      if (!response) continue;

      const lines = response.split(/\r?\n/);
      for (const line of lines) {
        // Match formats like:
        //   "1   123.45.67.89:1234  100  abc123def456...  Username (Lobby)"
        //   "1; abc123...; Username"
        let m = line.match(/^\s*(\d+)\s*;\s*(\S+)\s*;\s*(.+)$/);
        if (!m) {
          // BE-style players output: "<num> <ip:port> <ping> <guid>(OK) <name>"
          m = line.match(/^\s*(\d+)\s+\S+\s+\d+\s+([0-9a-f]{32,})(?:\([A-Z]+\))?\s+(.+?)\s*$/i);
        }
        if (m) {
          allPlayers.push({
            server: conn.name,
            number: parseInt(m[1], 10),
            guid: m[2].trim(),
            name: m[3].trim().replace(/\s*\(Lobby\)\s*$/i, ""),
          });
        }
      }
    } catch (err) {
      console.error(`RCON [${conn.name}]: getPlayers error:`, err.message);
    }
  }
  return allPlayers;
}

async function kickPlayer(guid) {
  const results = [];
  const players = await getPlayers();
  const matches = players.filter(p => p.guid.toLowerCase() === guid.toLowerCase());

  if (matches.length === 0) {
    return [{ server: "all", result: "Player not found on any server" }];
  }

  for (const player of matches) {
    const conn = connections.find(c => c.name === player.server);
    if (!conn || !conn.connected) {
      results.push({ server: player.server, result: "Not connected" });
      continue;
    }
    try {
      const response = await sendAndCollect(conn, `kick ${player.number}`, { overallMs: 5000 });
      results.push({ server: player.server, result: response || "Kick sent" });
      console.log(`RCON [${conn.name}]: kicked player #${player.number} (${player.name})`);
    } catch (err) {
      results.push({ server: player.server, result: `Error: ${err.message}` });
    }
  }
  return results;
}

function getStatus() {
  return connections.map(c => ({
    name: c.name,
    connected: c.connected,
    address: `${c.address}:${c.port}`,
    lastError: c.lastError || null,
  }));
}

module.exports = { init, reconnect, getPlayers, kickPlayer, getStatus };
