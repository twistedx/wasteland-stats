// BattlEye RCON client for Arma Reforger servers
const { BattlEye } = require("@senfo/battleye");
const config = require("./config");

const connections = [];

function init() {
  const rconServers = config.rconServers || [];
  if (rconServers.length === 0) {
    console.log("RCON: no servers configured, skipping.");
    return;
  }

  for (const srv of rconServers) {
    const conn = {
      name: srv.name,
      address: srv.address,
      port: srv.port,
      password: srv.password,
      client: null,
      connected: false,
    };

    try {
      conn.client = new BattlEye({
        ip: srv.address,
        port: srv.port,
        password: srv.password,
      });

      conn.client.on("connected", () => {
        console.log(`RCON [${srv.name}]: connected`);
        conn.connected = true;
      });

      conn.client.on("disconnected", () => {
        console.log(`RCON [${srv.name}]: disconnected`);
        conn.connected = false;
      });

      conn.client.on("error", (err) => {
        console.error(`RCON [${srv.name}]: error:`, err.message || err);
        conn.connected = false;
      });

      conn.client.on("message", (msg) => {
        // Debug: log server messages
      });

      conn.client.connect();
      connections.push(conn);
      console.log(`RCON [${srv.name}]: connecting to ${srv.address}:${srv.port}...`);
    } catch (err) {
      console.error(`RCON [${srv.name}]: failed to initialize:`, err.message);
    }
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
        conn.client.disconnect();
      }
      conn.client = new BattlEye({
        ip: conn.address,
        port: conn.port,
        password: conn.password,
      });

      conn.client.on("connected", () => { conn.connected = true; });
      conn.client.on("disconnected", () => { conn.connected = false; });
      conn.client.on("error", () => { conn.connected = false; });

      conn.client.connect();

      // Wait a bit for connection
      await new Promise(resolve => setTimeout(resolve, 3000));
      results.push({ name: conn.name, status: conn.connected ? "reconnected" : "failed" });
    } catch (err) {
      results.push({ name: conn.name, status: `error: ${err.message}` });
    }
  }
  return results;
}

async function getPlayers() {
  const allPlayers = [];
  for (const conn of connections) {
    if (!conn.connected || !conn.client) continue;
    try {
      const response = await sendCommand(conn, "players");
      if (!response) continue;

      // Parse player list from RCON response
      const lines = response.split("\n");
      for (const line of lines) {
        // Format: "PlayerNumber ; GUID ; Name"
        const match = line.match(/^\s*(\d+)\s*;\s*(\S+)\s*;\s*(.+)$/);
        if (match) {
          allPlayers.push({
            server: conn.name,
            number: parseInt(match[1]),
            guid: match[2].trim(),
            name: match[3].trim(),
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
      const response = await sendCommand(conn, `kick ${player.number}`);
      results.push({ server: player.server, result: response || "Kick sent" });
      console.log(`RCON [${conn.name}]: kicked player #${player.number} (${player.name})`);
    } catch (err) {
      results.push({ server: player.server, result: `Error: ${err.message}` });
    }
  }
  return results;
}

function sendCommand(conn, command) {
  return new Promise((resolve, reject) => {
    if (!conn.connected || !conn.client) {
      return reject(new Error("Not connected"));
    }

    let response = "";
    const timeout = setTimeout(() => {
      resolve(response || null);
    }, 5000);

    const handler = (msg) => {
      response += (response ? "\n" : "") + msg;
    };

    conn.client.on("message", handler);

    conn.client.send(command).then(() => {
      // Wait for response messages
      setTimeout(() => {
        clearTimeout(timeout);
        conn.client.removeListener("message", handler);
        resolve(response || null);
      }, 2000);
    }).catch(err => {
      clearTimeout(timeout);
      conn.client.removeListener("message", handler);
      reject(err);
    });
  });
}

function getStatus() {
  return connections.map(c => ({
    name: c.name,
    connected: c.connected,
    address: `${c.address}:${c.port}`,
  }));
}

module.exports = { init, reconnect, getPlayers, kickPlayer, getStatus };
