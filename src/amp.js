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

      const metrics = inst.Metrics || {};
      const cpu = metrics["CPU Usage"] || {};
      const ram = metrics["Memory Usage"] || {};
      const users = metrics["Active Users"] || {};
      console.log(`AMP:   "${inst.FriendlyName}" players=${users.RawValue}/${users.MaxValue} cpu=${cpu.RawValue}% ram=${ram.RawValue}MB`);

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
