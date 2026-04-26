// PvP kill-count wagers — challenger and target ante up Wasted Coins,
// 24-hour window starts on accept, whoever gains more kills wins the pot (minus rake).
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const axios = require("axios");
const config = require("./config");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "kill-wagers.db");

const MIN_WAGER = 100;
const MAX_WAGER = 2500;                   // less than half of base wallet cap
const MAX_INITIATED_PER_DAY = 5;
const MAX_PENDING_PER_USER = 3;           // across both challenger + target roles combined
const ACCEPT_WINDOW_HOURS = 6;
const WAGER_DURATION_HOURS = 24;
const HOUSE_RAKE = 0.05;
const MAX_PAIR_PER_WEEK = 3;             // cap same-pair wagers per UTC week to prevent collusion farming

let db = null;

const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS kill_wagers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenger_discord_id TEXT NOT NULL,
      challenger_username TEXT,
      target_discord_id TEXT NOT NULL,
      target_username TEXT,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | active | settled | expired | cancelled | declined | failed
      challenger_arma_id TEXT,
      target_arma_id TEXT,
      challenger_kills_start INTEGER,
      target_kills_start INTEGER,
      challenger_kills_end INTEGER,
      target_kills_end INTEGER,
      winner_discord_id TEXT,
      house_rake INTEGER,
      payout INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      accepted_at TEXT,
      expires_at TEXT,
      settled_at TEXT,
      note TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_kw_challenger ON kill_wagers (challenger_discord_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_kw_target ON kill_wagers (target_discord_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_kw_status ON kill_wagers (status, expires_at)");

  console.log(`KillWagers: ${db.prepare("SELECT COUNT(*) as cnt FROM kill_wagers").get().cnt} wagers in database.`);
}

async function fetchKillCount(discordId) {
  try {
    const res = await apiClient({ method: "GET", url: "/user/getAllPlayerStatsByDiscordID", data: { discord_id: discordId, token: config.apiToken } });
    let armaId = res.data?.arma_id || null;
    const kills = parseInt(res.data?.kill_count, 10);
    // Fallback: if arma_id missing but username present, resolve via search
    if (!armaId && res.data?.arma_username) {
      try {
        const search = await apiClient({ method: "GET", url: "/user/searchUsersByUsername/", data: { search: res.data.arma_username, token: config.apiToken } });
        const players = search.data?.users || search.data?.data || search.data;
        if (Array.isArray(players) && players.length > 0) {
          armaId = players[0].arma_id || null;
        }
      } catch {}
    }
    return { armaId, kills: Number.isFinite(kills) ? kills : 0 };
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

function initiatedToday(discordId) {
  const todayStr = new Date().toISOString().slice(0, 10);
  return db.prepare("SELECT COUNT(*) as n FROM kill_wagers WHERE challenger_discord_id = ? AND substr(created_at, 1, 10) = ?").get(String(discordId), todayStr).n || 0;
}

// Count pending/active wagers where user is EITHER challenger or target
function pendingForUser(discordId) {
  return db.prepare("SELECT COUNT(*) as n FROM kill_wagers WHERE (challenger_discord_id = ? OR target_discord_id = ?) AND status IN ('pending','active')").get(String(discordId), String(discordId)).n || 0;
}

// Anti-collusion: cap same-pair wagers per UTC week
function pairThisWeek(a, b) {
  const [lo, hi] = [a, b].sort();
  // Get Monday of this week
  const d = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mondayStr = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff)).toISOString().slice(0, 10);
  return db.prepare(`SELECT COUNT(*) as n FROM kill_wagers
    WHERE ((challenger_discord_id = ? AND target_discord_id = ?) OR (challenger_discord_id = ? AND target_discord_id = ?))
    AND created_at >= ?`).get(lo, hi, hi, lo, mondayStr).n || 0;
}

async function createWager(challengerId, challengerUsername, targetId, targetUsername, amount, wastedCoins) {
  if (!challengerId || !targetId) throw new Error("Both users required");
  if (challengerId === targetId) throw new Error("You can't challenge yourself.");
  amount = parseInt(amount, 10);
  if (!Number.isFinite(amount) || amount < MIN_WAGER) throw new Error(`Min wager is ${MIN_WAGER} 💀.`);
  if (amount > MAX_WAGER) throw new Error(`Max wager is ${MAX_WAGER} 💀.`);

  if (initiatedToday(challengerId) >= MAX_INITIATED_PER_DAY) {
    throw new Error(`You can only initiate ${MAX_INITIATED_PER_DAY} wagers per day.`);
  }
  if (pendingForUser(challengerId) >= MAX_PENDING_PER_USER) {
    throw new Error(`You already have ${MAX_PENDING_PER_USER} pending/active wagers — finish those first.`);
  }
  if (pairThisWeek(challengerId, targetId) >= MAX_PAIR_PER_WEEK) {
    throw new Error(`You and this player have already wagered ${MAX_PAIR_PER_WEEK} times this week. Try a different opponent.`);
  }

  // Verify both players have linked Arma accounts
  const challengerStats = await fetchKillCount(challengerId);
  if (!challengerStats || !challengerStats.armaId) throw new Error("You don't have a linked Arma account. Use `/verify` in-game first.");
  const targetStats = await fetchKillCount(targetId);
  if (!targetStats || !targetStats.armaId) throw new Error(`<@${targetId}> doesn't have a linked Arma account.`);

  // Challenger antes up immediately (escrow)
  wastedCoins.spendCoins(challengerId, amount, "wager_ante", { meta: { role: "challenger", target: targetId, amount } });

  const expiresAt = new Date(Date.now() + ACCEPT_WINDOW_HOURS * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const result = db.prepare(`
    INSERT INTO kill_wagers (challenger_discord_id, challenger_username, target_discord_id, target_username, amount, status,
      challenger_arma_id, challenger_kills_start, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(String(challengerId), challengerUsername || null, String(targetId), targetUsername || null, amount,
    challengerStats.armaId, challengerStats.kills, expiresAt);

  return { id: result.lastInsertRowid, amount, expiresAt };
}

async function acceptWager(wagerId, accepterId, accepterUsername, wastedCoins) {
  const w = db.prepare("SELECT * FROM kill_wagers WHERE id = ?").get(wagerId);
  if (!w) throw new Error("Wager not found.");
  if (w.target_discord_id !== String(accepterId)) throw new Error("This wager isn't yours to accept.");
  if (w.status !== "pending") throw new Error(`Wager is ${w.status}.`);
  if (new Date(w.expires_at + "Z") < new Date()) {
    // Atomic expire + refund
    const r = db.prepare("UPDATE kill_wagers SET status='expired', settled_at=datetime('now') WHERE id=? AND status='pending'").run(wagerId);
    if (r.changes === 1) {
      wastedCoins.addCoins(w.challenger_discord_id, w.amount, "wager_refund", { username: w.challenger_username, bypassCap: true, meta: { reason: "expired", wager_id: wagerId } });
    }
    throw new Error("Wager has expired.");
  }

  // Atomic state claim — prevents double-accept race
  const lockResult = db.prepare("UPDATE kill_wagers SET status='accepting' WHERE id=? AND status='pending'").run(wagerId);
  if (lockResult.changes !== 1) throw new Error("Wager is no longer pending (may have been declined, expired, or already accepted).");

  let targetStats;
  try {
    targetStats = await fetchKillCount(accepterId);
    if (!targetStats || !targetStats.armaId) {
      // Roll back to pending so challenger isn't stuck
      db.prepare("UPDATE kill_wagers SET status='pending' WHERE id=? AND status='accepting'").run(wagerId);
      throw new Error("You don't have a linked Arma account. Use `/verify` in-game first.");
    }
  } catch (err) {
    if (err.message.includes("linked Arma")) throw err;
    db.prepare("UPDATE kill_wagers SET status='pending' WHERE id=? AND status='accepting'").run(wagerId);
    throw err;
  }

  // Accepter antes up
  try {
    wastedCoins.spendCoins(accepterId, w.amount, "wager_ante", { meta: { role: "target", challenger: w.challenger_discord_id, amount: w.amount, wager_id: wagerId } });
  } catch (err) {
    db.prepare("UPDATE kill_wagers SET status='pending' WHERE id=? AND status='accepting'").run(wagerId);
    throw err;
  }

  const settleAt = new Date(Date.now() + WAGER_DURATION_HOURS * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  db.prepare(`UPDATE kill_wagers SET status='active', target_arma_id=?, target_kills_start=?, target_username=?, accepted_at=datetime('now'), expires_at=? WHERE id=?`)
    .run(targetStats.armaId, targetStats.kills, accepterUsername || w.target_username, settleAt, wagerId);

  return { id: wagerId, settleAt, amount: w.amount, challenger: w.challenger_discord_id, target: accepterId };
}

async function declineWager(wagerId, accepterId, wastedCoins) {
  const w = db.prepare("SELECT * FROM kill_wagers WHERE id = ?").get(wagerId);
  if (!w) throw new Error("Wager not found.");
  if (w.target_discord_id !== String(accepterId)) throw new Error("This wager isn't yours to decline.");
  // Atomic state guard
  const r = db.prepare("UPDATE kill_wagers SET status='declined', settled_at=datetime('now') WHERE id=? AND status='pending'").run(wagerId);
  if (r.changes !== 1) throw new Error(`Wager is no longer pending.`);
  wastedCoins.addCoins(w.challenger_discord_id, w.amount, "wager_refund", { username: w.challenger_username, bypassCap: true, meta: { reason: "declined", wager_id: wagerId } });
  return { id: wagerId, refund: w.amount, challenger: w.challenger_discord_id };
}

async function cancelWager(wagerId, challengerId, wastedCoins) {
  const w = db.prepare("SELECT * FROM kill_wagers WHERE id = ?").get(wagerId);
  if (!w) throw new Error("Wager not found.");
  if (w.challenger_discord_id !== String(challengerId)) throw new Error("Not your wager.");
  // Atomic state guard
  const r = db.prepare("UPDATE kill_wagers SET status='cancelled', settled_at=datetime('now') WHERE id=? AND status='pending'").run(wagerId);
  if (r.changes !== 1) throw new Error("Can only cancel pending wagers.");
  wastedCoins.addCoins(challengerId, w.amount, "wager_refund", { username: w.challenger_username, bypassCap: true, meta: { reason: "cancelled", wager_id: wagerId } });
  return { id: wagerId, refund: w.amount };
}

async function settleWager(w, wastedCoins) {
  // Fetch end kills for both
  let challengerEnd, targetEnd;
  try {
    const c = await fetchKillCount(w.challenger_discord_id);
    const t = await fetchKillCount(w.target_discord_id);
    challengerEnd = c?.kills ?? null;
    targetEnd = t?.kills ?? null;
  } catch (err) {
    db.prepare("UPDATE kill_wagers SET status='failed', note=?, settled_at=datetime('now') WHERE id=?").run(`API error: ${err.message}`, w.id);
    return { id: w.id, status: "failed" };
  }

  if (challengerEnd === null || targetEnd === null || w.challenger_kills_start === null || w.target_kills_start === null) {
    // Refund both — couldn't settle fairly (bypass cap so escrowed coins aren't lost)
    wastedCoins.addCoins(w.challenger_discord_id, w.amount, "wager_refund", { username: w.challenger_username, bypassCap: true, meta: { reason: "stat_unavailable", wager_id: w.id } });
    wastedCoins.addCoins(w.target_discord_id, w.amount, "wager_refund", { username: w.target_username, bypassCap: true, meta: { reason: "stat_unavailable", wager_id: w.id } });
    db.prepare("UPDATE kill_wagers SET status='failed', note='stat unavailable', settled_at=datetime('now') WHERE id=?").run(w.id);
    return { id: w.id, status: "failed_refunded" };
  }

  const challengerDelta = Math.max(0, challengerEnd - w.challenger_kills_start);
  const targetDelta = Math.max(0, targetEnd - w.target_kills_start);
  const pot = w.amount * 2;
  const houseRake = Math.round(pot * HOUSE_RAKE);
  const payout = pot - houseRake;

  let winnerId = null;
  if (challengerDelta > targetDelta) winnerId = w.challenger_discord_id;
  else if (targetDelta > challengerDelta) winnerId = w.target_discord_id;
  // tie → split (refund both their original ante, no rake)

  if (winnerId) {
    const winnerUsername = winnerId === w.challenger_discord_id ? w.challenger_username : w.target_username;
    wastedCoins.addCoins(winnerId, payout, "wager_payout", { username: winnerUsername, bypassCap: true, meta: { wager_id: w.id, challenger_delta: challengerDelta, target_delta: targetDelta, pot, rake: houseRake } });
  } else {
    // Tie — refund antes (bypass cap so escrow is fully returned)
    wastedCoins.addCoins(w.challenger_discord_id, w.amount, "wager_refund", { username: w.challenger_username, bypassCap: true, meta: { reason: "tie", wager_id: w.id } });
    wastedCoins.addCoins(w.target_discord_id, w.amount, "wager_refund", { username: w.target_username, bypassCap: true, meta: { reason: "tie", wager_id: w.id } });
  }

  db.prepare(`
    UPDATE kill_wagers
    SET status='settled', challenger_kills_end=?, target_kills_end=?, winner_discord_id=?, house_rake=?, payout=?, settled_at=datetime('now')
    WHERE id=?
  `).run(challengerEnd, targetEnd, winnerId, winnerId ? houseRake : 0, winnerId ? payout : 0, w.id);

  return {
    id: w.id, status: "settled",
    winner: winnerId,
    challengerDelta, targetDelta,
    pot, payout, houseRake,
    challenger: w.challenger_discord_id, target: w.target_discord_id,
    challengerUsername: w.challenger_username, targetUsername: w.target_username,
    isTie: !winnerId,
  };
}

// Cron tick — expire stale pendings, settle finished actives
async function tick(wastedCoins) {
  const now = new Date();
  const events = [];

  // Expire pending past their accept window — atomic guard to prevent race with concurrent accept
  const stale = db.prepare("SELECT * FROM kill_wagers WHERE status='pending' AND expires_at < ?").all(now.toISOString().replace("T", " ").slice(0, 19));
  for (const w of stale) {
    const r = db.prepare("UPDATE kill_wagers SET status='expired', settled_at=datetime('now') WHERE id=? AND status='pending'").run(w.id);
    if (r.changes === 1) {
      wastedCoins.addCoins(w.challenger_discord_id, w.amount, "wager_refund", { username: w.challenger_username, bypassCap: true, meta: { reason: "expired", wager_id: w.id } });
      events.push({ kind: "expired", wager: w });
    }
  }

  // Settle actives whose duration is up
  const ready = db.prepare("SELECT * FROM kill_wagers WHERE status='active' AND expires_at < ?").all(now.toISOString().replace("T", " ").slice(0, 19));
  for (const w of ready) {
    try {
      const settled = await settleWager(w, wastedCoins);
      events.push({ kind: "settled", result: settled, wager: w });
    } catch (err) {
      console.error("KillWagers settle error:", w.id, err.message);
    }
  }

  return events;
}

function getWager(id) {
  return db.prepare("SELECT * FROM kill_wagers WHERE id = ?").get(id);
}

function getPendingWagerFrom(targetDiscordId, challengerDiscordId) {
  return db.prepare("SELECT * FROM kill_wagers WHERE target_discord_id = ? AND challenger_discord_id = ? AND status = 'pending'").get(String(targetDiscordId), String(challengerDiscordId)) || null;
}

function getPendingWagerForTarget(targetDiscordId) {
  return db.prepare("SELECT * FROM kill_wagers WHERE target_discord_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(String(targetDiscordId)) || null;
}

function getMyWagers(discordId, limit = 10) {
  return db.prepare(`
    SELECT * FROM kill_wagers
    WHERE challenger_discord_id = ? OR target_discord_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(String(discordId), String(discordId), limit);
}

// Ban cleanup: cancel/refund all pending wagers involving this user, forfeit active wagers to opponent
async function purgeUser(discordId, wastedCoins) {
  const events = [];
  // Cancel pending wagers where banned user is challenger
  const myPending = db.prepare("SELECT * FROM kill_wagers WHERE challenger_discord_id = ? AND status = 'pending'").all(String(discordId));
  for (const w of myPending) {
    const r = db.prepare("UPDATE kill_wagers SET status='cancelled', settled_at=datetime('now'), note='banned' WHERE id=? AND status='pending'").run(w.id);
    if (r.changes === 1) {
      wastedCoins.addCoins(discordId, w.amount, "wager_refund", { bypassCap: true, meta: { reason: "banned_self", wager_id: w.id } });
      events.push({ kind: "cancelled", wager: w });
    }
  }
  // Cancel pending wagers where banned user is target — refund challenger
  const theirPending = db.prepare("SELECT * FROM kill_wagers WHERE target_discord_id = ? AND status = 'pending'").all(String(discordId));
  for (const w of theirPending) {
    const r = db.prepare("UPDATE kill_wagers SET status='cancelled', settled_at=datetime('now'), note='target_banned' WHERE id=? AND status='pending'").run(w.id);
    if (r.changes === 1) {
      wastedCoins.addCoins(w.challenger_discord_id, w.amount, "wager_refund", { username: w.challenger_username, bypassCap: true, meta: { reason: "opponent_banned", wager_id: w.id } });
      events.push({ kind: "cancelled", wager: w });
    }
  }
  // Forfeit active wagers — refund the clean opponent their ante (no payout from pot, just their own ante back)
  const myActive = db.prepare("SELECT * FROM kill_wagers WHERE (challenger_discord_id = ? OR target_discord_id = ?) AND status = 'active'").all(String(discordId), String(discordId));
  for (const w of myActive) {
    const r = db.prepare("UPDATE kill_wagers SET status='settled', settled_at=datetime('now'), note='opponent_banned', winner_discord_id=NULL WHERE id=? AND status='active'").run(w.id);
    if (r.changes === 1) {
      const cleanSide = w.challenger_discord_id === String(discordId) ? w.target_discord_id : w.challenger_discord_id;
      const cleanUsername = w.challenger_discord_id === String(discordId) ? w.target_username : w.challenger_username;
      wastedCoins.addCoins(cleanSide, w.amount, "wager_refund", { username: cleanUsername, bypassCap: true, meta: { reason: "opponent_banned", wager_id: w.id } });
      events.push({ kind: "forfeited", wager: w, refundedTo: cleanSide });
    }
  }
  return events;
}

module.exports = {
  init,
  MIN_WAGER, MAX_WAGER, MAX_INITIATED_PER_DAY, MAX_PENDING_PER_USER, MAX_PAIR_PER_WEEK,
  ACCEPT_WINDOW_HOURS, WAGER_DURATION_HOURS, HOUSE_RAKE,
  createWager, acceptWager, declineWager, cancelWager, settleWager, tick, purgeUser,
  getWager, getMyWagers, getPendingWagerFrom, getPendingWagerForTarget, initiatedToday, pendingForUser, pairThisWeek,
};
