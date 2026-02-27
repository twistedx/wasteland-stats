const axios = require("axios");
const config = require("./config");

let sessionID = null;
let serverData = [];
let lastFetch = null;

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

// Login through the ADS proxy to a remote instance and get its real-time status
async function getInstanceRealTimeStatus(instanceId, friendlyName) {
  try {
    // Login to the remote instance through the ADS proxy
    const loginRes = await axios.post(`${config.amp.url}/API/ADSModule/Servers/${instanceId}/API/Core/Login`, {
      SESSIONID: sessionID,
      username: config.amp.username,
      password: config.amp.password,
      token: "",
      rememberMe: false,
    }, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    if (!loginRes.data?.success && !loginRes.data?.sessionID) {
      console.log(`AMP: proxy login failed for "${friendlyName}":`, JSON.stringify(loginRes.data).slice(0, 200));
      return null;
    }

    const remoteSession = loginRes.data.sessionID;

    // Now call GetStatus on the remote instance using ITS session
    const statusRes = await axios.post(`${config.amp.url}/API/ADSModule/Servers/${instanceId}/API/Core/GetStatus`, {
      SESSIONID: remoteSession,
    }, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    const s = statusRes.data;
    if (s?.Title === "Unauthorized Access") {
      console.log(`AMP: proxy GetStatus still unauthorized for "${friendlyName}":`, s.Message || s.Title);
      return null;
    }

    console.log(`AMP: real-time "${friendlyName}" metrics:`, JSON.stringify(s?.Metrics || {}).slice(0, 300));
    return s;
  } catch (err) {
    console.error(`AMP: proxy status error for "${friendlyName}":`, err.message);
    return null;
  }
}

async function fetchInstances() {
  const response = await apiCall("ADSModule/GetInstances", { ForceIncludeSelf: true });

  const targets = Array.isArray(response) ? response : (response?.result || response || []);
  if (!Array.isArray(targets)) {
    console.error("AMP: unexpected GetInstances response:", JSON.stringify(response).slice(0, 200));
    return;
  }

  const instances = [];
  for (const target of targets) {
    if (!target.AvailableInstances) continue;
    for (const inst of target.AvailableInstances) {
      if (inst.Module === "ADS") continue;

      const metrics = inst.Metrics || {};
      const cpu = metrics["CPU Usage"] || {};
      const ram = metrics["Memory Usage"] || {};
      const users = metrics["Active Users"] || {};
      console.log(`AMP: (cached) "${inst.FriendlyName}" running=${inst.Running} appState=${inst.AppState} cpu=${cpu.RawValue}% ram=${ram.RawValue}MB players=${users.RawValue}/${users.MaxValue}`);

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

  // Try to get real-time status from each running instance via ADS proxy
  // AppState: 0=Undefined, 2=Stopped, 3=PreStart, 5=Starting, 10=Ready/Running, 20=Restarting, 30=Stopping, -1=Failed
  for (const inst of instances) {
    if (!inst.running || inst.appState < 5) continue;
    const realTime = await getInstanceRealTimeStatus(inst.instanceId, inst.friendlyName);
    if (realTime?.Metrics) {
      const m = realTime.Metrics;
      const cpu = m["CPU Usage"] || {};
      const ram = m["Memory Usage"] || {};
      const users = m["Active Users"] || {};
      console.log(`AMP: (real-time) "${inst.friendlyName}" cpu=${cpu.RawValue}% ram=${ram.RawValue}MB players=${users.RawValue}/${users.MaxValue}`);

      inst.cpu = {
        value: Number(cpu.RawValue) || inst.cpu.value,
        max: Number(cpu.MaxValue) || inst.cpu.max,
        percent: Number(cpu.Percent) || inst.cpu.percent,
        units: cpu.Units || inst.cpu.units,
      };
      inst.memory = {
        value: Number(ram.RawValue) || inst.memory.value,
        max: Number(ram.MaxValue) || inst.memory.max,
        percent: Number(ram.Percent) || inst.memory.percent,
        units: ram.Units || inst.memory.units,
      };
      inst.players = {
        current: Number(users.RawValue) ?? inst.players.current,
        max: Number(users.MaxValue) || inst.players.max,
        percent: Number(users.Percent) || inst.players.percent,
      };
    }
  }

  serverData = instances;
  lastFetch = new Date().toISOString();
  console.log(`AMP: fetched ${instances.length} instances, ${instances.reduce((s, i) => s + i.players.current, 0)} total players`);
}

function init() {
  if (!config.amp.url || !config.amp.username || !config.amp.password) {
    console.log("AMP: skipping init (no credentials configured).");
    return;
  }
  console.log("AMP: initialized (on-demand only, no DB).");
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

async function getFreshStatus() {
  // Force a new session so AMP doesn't return cached data
  sessionID = null;
  await login();
  await fetchInstances();
  return getStatus();
}

module.exports = { init, getStatus, getFreshStatus, apiCall };
