// Discord server statistics module
// Collects guild stats from the Discord.js client and caches them
// Snapshots online count every 15 minutes for historical tracking

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "discord-stats.db");

let client = null;
let guildId = null;
let cachedStats = null;
let lastFetch = 0;
let db = null;
let snapshotInterval = null;
const CACHE_TTL = 60000; // 1 minute
const SNAPSHOT_INTERVAL = 15 * 60 * 1000; // 15 minutes
const RETENTION_DAYS = 30;

function initDb() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS online_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      online INTEGER NOT NULL DEFAULT 0,
      idle INTEGER NOT NULL DEFAULT 0,
      dnd INTEGER NOT NULL DEFAULT 0,
      total_humans INTEGER NOT NULL DEFAULT 0,
      in_voice INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON online_snapshots (ts)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS member_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      discord_id TEXT,
      username TEXT,
      ts INTEGER NOT NULL,
      membership_days INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_member_events_ts ON member_events (ts)`);
  try { db.exec("ALTER TABLE member_events ADD COLUMN membership_days INTEGER"); } catch (e) { /* exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS member_roles (
      discord_id TEXT NOT NULL,
      role_name TEXT NOT NULL,
      role_color TEXT NOT NULL DEFAULT '#99aab5',
      position INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (discord_id, role_name)
    )
  `);

  // Prune old data
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  db.prepare("DELETE FROM online_snapshots WHERE ts < ?").run(cutoff);
  db.prepare("DELETE FROM member_events WHERE ts < ?").run(cutoff);
}

async function fetchMembersWithRetry(guild, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await guild.members.fetch();
      return true;
    } catch (err) {
      if (err.message.includes("rate limited") && i < retries - 1) {
        const delay = Math.min((i + 1) * 2000, 10000);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  return false;
}

async function takeSnapshot() {
  if (!client || !client.isReady() || !db) return;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    await fetchMembersWithRetry(guild);
    const members = guild.members.cache;
    const humans = members.filter(m => !m.user.bot).size;
    const online = members.filter(m => m.presence?.status === "online").size;
    const idle = members.filter(m => m.presence?.status === "idle").size;
    const dnd = members.filter(m => m.presence?.status === "dnd").size;
    const voiceStates = guild.voiceStates.cache.filter(vs => vs.channelId);
    const inVoice = voiceStates.size;

    db.prepare("INSERT INTO online_snapshots (ts, online, idle, dnd, total_humans, in_voice) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Date.now(), online, idle, dnd, humans, inVoice);
  } catch (err) {
    console.error("DiscordStats: snapshot error:", err.message);
  }
}

function getOnlineHistory(days) {
  if (!db) return [];
  const cutoff = Date.now() - days * 86400000;
  return db.prepare("SELECT ts, online, idle, dnd, total_humans, in_voice FROM online_snapshots WHERE ts >= ? ORDER BY ts ASC").all(cutoff);
}

function recordMemberEvent(type, member) {
  if (!db) return;
  let membershipDays = null;
  if (type === "leave" && member.joinedAt) {
    membershipDays = Math.floor((Date.now() - member.joinedAt.getTime()) / 86400000);
  }
  db.prepare("INSERT INTO member_events (event_type, discord_id, username, ts, membership_days) VALUES (?, ?, ?, ?, ?)")
    .run(type, member.id || null, member.user?.username || member.displayName || null, Date.now(), membershipDays);
}

function getMemberEventHistory(days) {
  if (!db) return [];
  const now = Date.now();
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = new Date(now - i * 86400000);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const joins = db.prepare("SELECT COUNT(*) as c FROM member_events WHERE event_type = 'join' AND ts >= ? AND ts < ?").get(dayStart.getTime(), dayEnd.getTime()).c;
    const leaves = db.prepare("SELECT COUNT(*) as c FROM member_events WHERE event_type = 'leave' AND ts >= ? AND ts < ?").get(dayStart.getTime(), dayEnd.getTime()).c;
    result.push({ date: dayStart.toISOString().slice(0, 10), joins, leaves });
  }
  return result;
}

function init(discordClient, discordGuildId) {
  client = discordClient;
  guildId = discordGuildId;
  initDb();

  // Take first snapshot after a short delay, then every 15 minutes
  setTimeout(() => {
    takeSnapshot();
    snapshotInterval = setInterval(takeSnapshot, SNAPSHOT_INTERVAL);
  }, 30000);
  console.log("DiscordStats: initialized, snapshots every 15 minutes.");
}

async function getStats() {
  if (!client || !client.isReady()) {
    return null;
  }

  // Return cached if fresh
  if (cachedStats && Date.now() - lastFetch < CACHE_TTL) {
    return cachedStats;
  }

  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;

    // Fetch all members (needed for accurate counts)
    await fetchMembersWithRetry(guild);

    const members = guild.members.cache;
    const totalMembers = guild.memberCount;
    const bots = members.filter(m => m.user.bot).size;
    const humans = totalMembers - bots;

    // Online status (requires GuildPresences intent)
    const online = members.filter(m => m.presence?.status === "online").size;
    const idle = members.filter(m => m.presence?.status === "idle").size;
    const dnd = members.filter(m => m.presence?.status === "dnd").size;
    const offline = humans - online - idle - dnd;

    // Role breakdown (top roles by member count, excluding @everyone)
    const roles = guild.roles.cache
      .filter(r => r.id !== guild.id) // exclude @everyone
      .map(r => ({ name: r.name, color: r.hexColor, count: r.members.size, position: r.position }))
      .sort((a, b) => b.count - a.count);

    const topRoles = roles.slice(0, 15);

    // Boost stats
    const boostCount = guild.premiumSubscriptionCount || 0;
    const boostTier = guild.premiumTier || 0;

    // Channel stats
    const textChannels = guild.channels.cache.filter(c => c.type === 0).size; // GuildText
    const voiceChannels = guild.channels.cache.filter(c => c.type === 2).size; // GuildVoice
    const categories = guild.channels.cache.filter(c => c.type === 4).size; // GuildCategory

    // Voice channel activity — who's in voice right now
    const voiceStates = guild.voiceStates.cache.filter(vs => vs.channelId);
    const inVoice = voiceStates.size;
    const voiceChannelBreakdown = [];
    const voiceChannelMap = {};
    voiceStates.forEach(vs => {
      const ch = vs.channel;
      if (!ch) return;
      if (!voiceChannelMap[ch.id]) {
        voiceChannelMap[ch.id] = { name: ch.name, members: [] };
      }
      voiceChannelMap[ch.id].members.push(vs.member?.displayName || vs.id);
    });
    for (const chId of Object.keys(voiceChannelMap)) {
      voiceChannelBreakdown.push(voiceChannelMap[chId]);
    }

    // New members (joined in last 7 days / 30 days)
    const now = Date.now();
    const weekAgo = now - 7 * 86400000;
    const monthAgo = now - 30 * 86400000;
    const newThisWeek = members.filter(m => !m.user.bot && m.joinedTimestamp >= weekAgo).size;
    const newThisMonth = members.filter(m => !m.user.bot && m.joinedTimestamp >= monthAgo).size;

    // Join/leave history — daily for last 30 days
    const joinHistory = [];
    const leaveHistory = getMemberEventHistory(30);
    const leaveMap = {};
    leaveHistory.forEach(d => { leaveMap[d.date] = d.leaves; });

    for (let i = 29; i >= 0; i--) {
      const dayStart = new Date(now - i * 86400000);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const dateStr = dayStart.toISOString().slice(0, 10);
      const count = members.filter(m =>
        !m.user.bot && m.joinedTimestamp >= dayStart.getTime() && m.joinedTimestamp < dayEnd.getTime()
      ).size;
      joinHistory.push({
        date: dateStr,
        joins: count,
        leaves: leaveMap[dateStr] || 0,
      });
    }

    // Top members by role count (most roles = most engaged)
    const topMembers = members
      .filter(m => !m.user.bot)
      .map(m => ({
        name: m.displayName,
        username: m.user.username,
        roles: m.roles.cache.size - 1, // exclude @everyone
        joinedAt: m.joinedAt?.toISOString() || null,
        avatar: m.user.displayAvatarURL({ size: 32 }),
      }))
      .sort((a, b) => b.roles - a.roles)
      .slice(0, 10);

    // Server info
    const serverInfo = {
      name: guild.name,
      icon: guild.iconURL({ size: 64 }) || null,
      createdAt: guild.createdAt.toISOString(),
      ownerId: guild.ownerId,
    };

    // Count leaves from DB
    const leftThisWeek = db ? db.prepare("SELECT COUNT(*) as c FROM member_events WHERE event_type = 'leave' AND ts >= ?").get(weekAgo).c : 0;
    const leftThisMonth = db ? db.prepare("SELECT COUNT(*) as c FROM member_events WHERE event_type = 'leave' AND ts >= ?").get(monthAgo).c : 0;

    cachedStats = {
      serverInfo,
      totalMembers,
      humans,
      bots,
      online,
      idle,
      dnd,
      offline,
      boostCount,
      boostTier,
      textChannels,
      voiceChannels,
      categories,
      inVoice,
      voiceChannelBreakdown,
      newThisWeek,
      newThisMonth,
      leftThisWeek,
      leftThisMonth,
      joinHistory,
      topRoles,
      topMembers,
    };

    lastFetch = Date.now();
    return cachedStats;
  } catch (err) {
    console.error("DiscordStats: error fetching stats:", err.message);
    return cachedStats; // return stale cache on error
  }
}

function getRecentDepartures(limit = 30) {
  if (!db) return [];
  return db.prepare("SELECT username, discord_id, ts, membership_days FROM member_events WHERE event_type = 'leave' ORDER BY ts DESC LIMIT ?").all(limit);
}

function ensureDb() {
  if (!db) initDb();
}

function saveMemberRoles(discordId, roles) {
  ensureDb();
  if (!db) return;
  const del = db.prepare("DELETE FROM member_roles WHERE discord_id = ?");
  const ins = db.prepare("INSERT INTO member_roles (discord_id, role_name, role_color, position) VALUES (?, ?, ?, ?)");
  const tx = db.transaction((id, roleList) => {
    del.run(id);
    for (const r of roleList) {
      ins.run(id, r.name, r.color, r.position);
    }
  });
  tx(discordId, roles);
}

function getMemberRoles(discordId) {
  ensureDb();
  if (!db) return [];
  return db.prepare("SELECT role_name as name, role_color as color FROM member_roles WHERE discord_id = ? ORDER BY position DESC").all(discordId);
}

module.exports = { init, getStats, getOnlineHistory, recordMemberEvent, getMemberEventHistory, getRecentDepartures, saveMemberRoles, getMemberRoles };
