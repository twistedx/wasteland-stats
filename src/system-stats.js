const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DATA_DIR = path.join(__dirname, "..", "data");
const startedAt = Date.now();

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(d + "d");
  if (h > 0) parts.push(h + "h");
  parts.push(m + "m");
  return parts.join(" ");
}

function getDirSize(dirPath) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        total += fs.statSync(fullPath).size;
      } else if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      }
    }
  } catch {
    // ignore permission errors
  }
  return total;
}

function getDisk() {
  try {
    if (process.platform === "win32") {
      return null; // skip on Windows dev
    }
    const output = execSync("df -B1 /home 2>/dev/null || df -B1 / 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const lines = output.trim().split("\n");
    if (lines.length < 2) return null;
    const parts = lines[1].split(/\s+/);
    return {
      total: Number(parts[1]) || 0,
      used: Number(parts[2]) || 0,
      available: Number(parts[3]) || 0,
      usedPercent: parseInt(parts[4]) || 0,
      mount: parts[5] || "/",
    };
  } catch {
    return null;
  }
}

function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times)) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  return {
    cores: cpus.length,
    model: cpus[0]?.model || "Unknown",
    usagePercent: Math.round((1 - totalIdle / totalTick) * 100),
  };
}

function getStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const procMem = process.memoryUsage();
  const cpu = getCpuUsage();
  const disk = getDisk();
  const dataSize = getDirSize(DATA_DIR);

  const load = os.loadavg();

  return {
    // System
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    osUptime: formatUptime(os.uptime()),
    osUptimeSeconds: os.uptime(),
    loadAvg: {
      one: load[0].toFixed(2),
      five: load[1].toFixed(2),
      fifteen: load[2].toFixed(2),
    },

    // CPU
    cpuModel: cpu.model,
    cpuCores: cpu.cores,
    cpuUsage: cpu.usagePercent,

    // Memory
    memTotal: formatBytes(totalMem),
    memUsed: formatBytes(usedMem),
    memFree: formatBytes(freeMem),
    memPercent: Math.round((usedMem / totalMem) * 100),
    memTotalRaw: totalMem,
    memUsedRaw: usedMem,

    // Disk
    disk: disk
      ? {
          total: formatBytes(disk.total),
          used: formatBytes(disk.used),
          available: formatBytes(disk.available),
          usedPercent: disk.usedPercent,
          mount: disk.mount,
        }
      : null,

    // Node.js process
    nodeVersion: process.version,
    pid: process.pid,
    processUptime: formatUptime(process.uptime()),
    processUptimeSeconds: process.uptime(),
    appStartedAt: new Date(startedAt).toISOString(),
    heapUsed: formatBytes(procMem.heapUsed),
    heapTotal: formatBytes(procMem.heapTotal),
    rss: formatBytes(procMem.rss),
    heapPercent: Math.round((procMem.heapUsed / procMem.heapTotal) * 100),

    // Data directory
    dataSize: formatBytes(dataSize),
    dataSizeRaw: dataSize,
  };
}

module.exports = { getStats };
