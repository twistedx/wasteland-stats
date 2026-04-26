const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "wasted-coins.db");

// ── Economy constants ──
const EMOJI = "💀";
const NAME = "Wasted Coins";
const COINS_PER_USD = 300;            // $5 = 1500 coins
const DAILY_BASE = 500;               // a $5 item takes ~3 days of daily claims
const DAILY_VARIANCE = 100;           // +/- so it's not always exactly 500
const STREAK_BONUS_PER_DAY = 50;      // +50 per consecutive day, capped
const STREAK_BONUS_CAP = 500;         // max +500 streak bonus
const STREAK_RESET_HOURS = 48;        // miss > 48h = streak reset
const CLAIM_COOLDOWN_HOURS = 22;      // can claim every ~22h to be lenient
const PURCHASE_BONUS_PER_USD = 300;   // 1:1 with normal earning rate — buying $5 = 1500 bonus coins
const CASH_TRANSFER_FEE = 500;        // flat fee per transfer
const CASH_PER_COIN = 1;              // 1 coin = $1 in-game (admin can recalibrate)
const MIN_TRANSFER_COINS = 1000;      // can't do tiny dust transfers
const DAILY_TRANSFER_CAP = 5000;            // max coins transferred to in-game cash per day
const DAILY_TRANSFER_CAP_SUBSCRIBER = 10000;// subscribers get 2x the transfer cap
// Legacy wallet caps kept for backward compat (now effectively unlimited)
const MAX_BALANCE = Number.MAX_SAFE_INTEGER;
const MAX_BALANCE_SUBSCRIBER = Number.MAX_SAFE_INTEGER;

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS coin_balances (
      discord_id TEXT PRIMARY KEY,
      username TEXT,
      balance INTEGER NOT NULL DEFAULT 0,
      total_earned INTEGER NOT NULL DEFAULT 0,
      total_spent INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS coin_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      type TEXT NOT NULL,           -- 'daily' | 'purchase_bonus' | 'redeem_profile' | 'transfer_cash' | 'admin_adjust'
      amount INTEGER NOT NULL,      -- positive = earn, negative = spend
      balance_after INTEGER NOT NULL,
      meta TEXT,                    -- JSON, source-specific details
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS coin_streaks (
      discord_id TEXT PRIMARY KEY,
      streak INTEGER NOT NULL DEFAULT 0,
      last_claim_at TEXT
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_coin_tx_discord ON coin_transactions (discord_id, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_coin_balance ON coin_balances (balance DESC)");

  console.log(`WastedCoins: ${db.prepare("SELECT COUNT(*) as cnt FROM coin_balances").get().cnt} accounts, ${db.prepare("SELECT COUNT(*) as cnt FROM coin_transactions").get().cnt} transactions in database.`);
}

function ensureAccount(discordId, username) {
  if (!discordId) throw new Error("discord_id required");
  const existing = db.prepare("SELECT * FROM coin_balances WHERE discord_id = ?").get(String(discordId));
  if (!existing) {
    db.prepare("INSERT INTO coin_balances (discord_id, username) VALUES (?, ?)").run(String(discordId), username || null);
  } else if (username && existing.username !== username) {
    db.prepare("UPDATE coin_balances SET username = ? WHERE discord_id = ?").run(username, String(discordId));
  }
}

// Strip Discord display-name characters that could break Markdown / mention spam in webhook embeds
function sanitizeName(name) {
  if (!name) return "Unknown";
  return String(name)
    .replace(/[`*_~|@]/g, "")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/https?:\/\//gi, "")
    .slice(0, 32);
}

function getBalance(discordId) {
  if (!discordId) return 0;
  const row = db.prepare("SELECT balance FROM coin_balances WHERE discord_id = ?").get(String(discordId));
  return row?.balance || 0;
}

function getAccount(discordId) {
  if (!discordId) return null;
  return db.prepare("SELECT * FROM coin_balances WHERE discord_id = ?").get(String(discordId)) || null;
}

function recordTransaction(discordId, type, amount, balanceAfter, meta) {
  db.prepare("INSERT INTO coin_transactions (discord_id, type, amount, balance_after, meta) VALUES (?, ?, ?, ?, ?)")
    .run(String(discordId), type, amount, balanceAfter, meta ? JSON.stringify(meta) : null);
}

// Cheap subscriber check: look at the user's store purchase history for a known subscription tier.
// Mirrors the existing logic in /profile (src/app.js).
function isSubscriber(discordId) {
  if (!discordId) return false;
  try {
    const store = require("./store");
    const subscriptionPerks = require("./subscription-perks");
    const purchases = store.getPurchasesByDiscordId(discordId) || [];
    for (const p of purchases) {
      if (subscriptionPerks.getTierForProduct(p.product_name)) return true;
    }
  } catch {}
  return false;
}

function getMaxBalance(discordId) {
  return isSubscriber(discordId) ? MAX_BALANCE_SUBSCRIBER : MAX_BALANCE;
}

// Returns { added, capped } so callers can tell when the cap clipped the reward.
// `bypassCap: true` credits the full amount regardless of wallet cap (use for refunds, lottery/wager payouts).
function addCoins(discordId, amount, type, { username, meta, bypassCap = false } = {}) {
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10_000_000) throw new Error("amount must be a positive integer ≤ 10M");
  ensureAccount(discordId, username);
  const cap = getMaxBalance(discordId);
  const tx = db.transaction(() => {
    const before = getBalance(discordId);
    const actual = bypassCap ? amount : Math.min(amount, Math.max(0, cap - before));
    if (actual > 0) {
      db.prepare("UPDATE coin_balances SET balance = balance + ?, total_earned = total_earned + ?, updated_at = datetime('now') WHERE discord_id = ?")
        .run(actual, actual, String(discordId));
    }
    const after = getBalance(discordId);
    if (actual > 0) {
      recordTransaction(discordId, type, actual, after, { ...(meta || {}), capped: !bypassCap && actual < amount, attempted: amount, bypass_cap: bypassCap });
    }
    return { newBalance: after, added: actual, capped: !bypassCap && actual < amount, cap };
  });
  return tx();
}

// Atomic conditional debit — only succeeds if the user actually has enough at write time
function spendCoins(discordId, amount, type, { meta } = {}) {
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10_000_000) throw new Error("amount must be a positive integer ≤ 10M");
  ensureAccount(discordId);
  const tx = db.transaction(() => {
    const r = db.prepare("UPDATE coin_balances SET balance = balance - ?, total_spent = total_spent + ?, updated_at = datetime('now') WHERE discord_id = ? AND balance >= ?")
      .run(amount, amount, String(discordId), amount);
    if (r.changes !== 1) {
      const cur = getBalance(discordId);
      throw new Error(`Not enough ${EMOJI} ${NAME}. You have ${cur.toLocaleString()}, need ${amount.toLocaleString()}.`);
    }
    const after = getBalance(discordId);
    recordTransaction(discordId, type, -amount, after, meta);
    return after;
  });
  return tx();
}

// Hard caps on a single admin adjustment (per call) — prevents runaway adjustments
const ADMIN_ADJUST_MAX = 100_000;

function adminAdjust(discordId, delta, adminUsername) {
  if (!Number.isInteger(delta)) throw new Error("delta must be an integer");
  if (delta === 0) throw new Error("delta must be non-zero");
  if (Math.abs(delta) > ADMIN_ADJUST_MAX) throw new Error(`Single adjustment cannot exceed ±${ADMIN_ADJUST_MAX.toLocaleString()} coins`);
  ensureAccount(discordId);
  const tx = db.transaction(() => {
    const cur = getBalance(discordId);
    const newBal = Math.max(0, cur + delta);
    const realDelta = newBal - cur;
    db.prepare("UPDATE coin_balances SET balance = ?, total_earned = total_earned + ?, total_spent = total_spent + ?, updated_at = datetime('now') WHERE discord_id = ?")
      .run(newBal, realDelta > 0 ? realDelta : 0, realDelta < 0 ? -realDelta : 0, String(discordId));
    recordTransaction(discordId, "admin_adjust", realDelta, newBal, { admin: adminUsername, requested: delta });
    return newBal;
  });
  return tx();
}

// ── Daily claim ──
function getStreak(discordId) {
  return db.prepare("SELECT * FROM coin_streaks WHERE discord_id = ?").get(String(discordId)) || { streak: 0, last_claim_at: null };
}

// Atomic — uses an UPDATE WHERE guard that rejects double-claims even if two requests race.
// Anchored to UTC calendar day so users get 1 claim per day, no rolling-window confusion.
function claimDaily(discordId, username) {
  ensureAccount(discordId, username);
  const now = Date.now();

  // Read current streak first (race-tolerant: we re-validate via UPDATE WHERE below)
  const streak = getStreak(discordId);
  const last = streak.last_claim_at ? new Date(streak.last_claim_at + (streak.last_claim_at.includes("T") ? "" : "Z")) : null;
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const lastStr = last ? new Date(last).toISOString().slice(0, 10) : null;

  if (lastStr === todayStr) {
    const tomorrow = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
    const hoursLeft = Math.ceil((tomorrow.getTime() - now) / 3600000);
    const err = new Error(`You already claimed today. Next claim resets at 00:00 UTC (~${hoursLeft}h).`);
    err.code = "COOLDOWN";
    err.hoursLeft = hoursLeft;
    throw err;
  }

  // Streak continuity: yesterday's UTC date keeps streak; older = reset
  const yesterdayStr = new Date(now - 86400000).toISOString().slice(0, 10);
  const newStreak = (lastStr === yesterdayStr) ? (streak.streak || 0) + 1 : 1;

  const variance = Math.floor(Math.random() * (DAILY_VARIANCE * 2 + 1)) - DAILY_VARIANCE;
  const streakBonus = Math.min((newStreak - 1) * STREAK_BONUS_PER_DAY, STREAK_BONUS_CAP);
  const reward = Math.max(50, DAILY_BASE + variance + streakBonus);

  const tx = db.transaction(() => {
    // Atomic guard: the UPDATE only succeeds if last_claim_at's date != today (or row missing)
    let r;
    if (streak.last_claim_at) {
      r = db.prepare("UPDATE coin_streaks SET streak = ?, last_claim_at = datetime('now') WHERE discord_id = ? AND substr(last_claim_at, 1, 10) != ?")
        .run(newStreak, String(discordId), todayStr);
    } else {
      try {
        r = db.prepare("INSERT INTO coin_streaks (discord_id, streak, last_claim_at) VALUES (?, ?, datetime('now'))").run(String(discordId), newStreak);
      } catch (e) {
        // race: another claim raced in and inserted first
        r = { changes: 0 };
      }
    }
    if (r.changes !== 1) {
      const err = new Error("Already claimed today (race).");
      err.code = "COOLDOWN";
      throw err;
    }
    const result = addCoins(discordId, reward, "daily", { username, meta: { streak: newStreak, base: DAILY_BASE, variance, streak_bonus: streakBonus } });
    return {
      reward: result.added,
      attempted: reward,
      capped: result.capped,
      cap: result.cap,
      streak: newStreak,
      streakBonus,
      newBalance: result.newBalance,
    };
  });
  return tx();
}

// ── Transfer coins → in-game cash ──
// How many coins this user has already transferred to in-game cash today (UTC)
function getTransferredToday(discordId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT COALESCE(SUM(json_extract(meta, '$.coins_transferred')), 0) as total " +
    "FROM coin_transactions WHERE discord_id = ? AND type = 'transfer_cash_escrow' AND substr(created_at, 1, 10) = ?"
  ).get(String(discordId), today);
  return row?.total || 0;
}

function getTransferCap(discordId) {
  return isSubscriber(discordId) ? DAILY_TRANSFER_CAP_SUBSCRIBER : DAILY_TRANSFER_CAP;
}

// Atomic two-phase: ESCROW (debit) first, then call backend, refund if backend fails.
async function transferToCash(discordId, coinsToTransfer, { armaId, axiosClient, backendToken, username }) {
  if (!discordId) throw new Error("discord_id required");
  if (!armaId) throw new Error("No linked Arma account.");
  if (!Number.isInteger(coinsToTransfer) || coinsToTransfer <= 0) throw new Error("Invalid transfer amount.");
  if (coinsToTransfer > 1_000_000) throw new Error("Single-transfer max is 1,000,000 coins.");
  if (coinsToTransfer < MIN_TRANSFER_COINS) throw new Error(`Minimum transfer is ${MIN_TRANSFER_COINS.toLocaleString()} ${EMOJI} (you'd just lose the fee otherwise).`);

  const cap = getTransferCap(discordId);
  const total = coinsToTransfer + CASH_TRANSFER_FEE;
  const cashGranted = coinsToTransfer * CASH_PER_COIN;

  // Phase 1: atomic cap-check + debit in a single transaction (prevents concurrent cap bypass)
  const capCheckAndDebit = db.transaction(() => {
    const already = getTransferredToday(discordId);
    const remaining = Math.max(0, cap - already);
    if (remaining <= 0) {
      const err = new Error(`You've hit your daily transfer cap of ${cap.toLocaleString()} ${EMOJI}. Try again tomorrow (resets at UTC midnight).`);
      err.code = "CAP_HIT"; throw err;
    }
    if (coinsToTransfer > remaining) {
      const err = new Error(`That would exceed your daily transfer cap. You can transfer **${remaining.toLocaleString()} ${EMOJI}** more today (cap: ${cap.toLocaleString()}).`);
      err.code = "CAP_EXCEEDED"; throw err;
    }
    spendCoins(discordId, total, "transfer_cash_escrow", {
      meta: { coins_transferred: coinsToTransfer, fee: CASH_TRANSFER_FEE, cash_granted: cashGranted, arma_id: armaId, username, phase: "escrow" },
    });
  });
  capCheckAndDebit();

  // Phase 2: read current balance, then set new balance (API is set-based, not additive)
  try {
    const balRes = await axiosClient({ method: "GET", url: "/user/getUserCash/", data: { arma_id: armaId, token: backendToken } });
    const currentCash = balRes.data?.arma_cash_balance || 0;
    await axiosClient.post("/user/updateUserCash/", {
      arma_id: armaId,
      amount: currentCash + cashGranted,
      token: backendToken,
    });
  } catch (err) {
    addCoins(discordId, total, "transfer_cash_refund", {
      username,
      bypassCap: true,
      meta: { reason: "backend_failure", error: err.message, coins_refunded: total, arma_id: armaId },
    });
    throw new Error(`Backend cash deposit failed (refunded). Try again later. Reason: ${err.response?.data?.message || err.message}`);
  }

  return { coinsSpent: total, coinsTransferred: coinsToTransfer, cashGranted, fee: CASH_TRANSFER_FEE };
}

// ── Convert USD cents → coins (for showing dual-priced items) ──
function centsToCoins(cents) {
  return Math.round((cents / 100) * COINS_PER_USD);
}

function coinsToUsdLabel(coins) {
  return (coins / COINS_PER_USD).toFixed(2);
}

// ── Leaderboard / tx log ──
function getLeaderboard(limit = 10) {
  return db.prepare("SELECT discord_id, username, balance, total_earned, total_spent FROM coin_balances ORDER BY balance DESC LIMIT ?").all(limit);
}

function getAllTimeLeaderboard(limit = 100) {
  return db.prepare("SELECT discord_id, username, balance, total_earned, total_spent FROM coin_balances WHERE total_earned > 0 ORDER BY total_earned DESC LIMIT ?").all(limit);
}

function getRecentTransactions(discordId, limit = 20) {
  if (discordId) {
    return db.prepare("SELECT * FROM coin_transactions WHERE discord_id = ? ORDER BY id DESC LIMIT ?").all(String(discordId), limit);
  }
  return db.prepare("SELECT t.*, b.username FROM coin_transactions t LEFT JOIN coin_balances b ON b.discord_id = t.discord_id ORDER BY t.id DESC LIMIT ?").all(limit);
}

// Total coins in circulation — used by admin health dashboard
function getCirculation() {
  const r = db.prepare("SELECT COALESCE(SUM(balance), 0) as total, COALESCE(SUM(total_earned), 0) as earned, COALESCE(SUM(total_spent), 0) as spent, COUNT(*) as accounts FROM coin_balances").get();
  return { total: r.total, earned: r.earned, spent: r.spent, accounts: r.accounts };
}

// Sums of inflow vs outflow by transaction type for a given window (default last 24h)
function getFlow(sinceMs = 24 * 3600 * 1000) {
  const since = new Date(Date.now() - sinceMs).toISOString().replace("T", " ").slice(0, 19);
  const inflow = db.prepare("SELECT type, COALESCE(SUM(amount),0) as total, COUNT(*) as cnt FROM coin_transactions WHERE created_at >= ? AND amount > 0 GROUP BY type ORDER BY total DESC").all(since);
  const outflow = db.prepare("SELECT type, COALESCE(SUM(-amount),0) as total, COUNT(*) as cnt FROM coin_transactions WHERE created_at >= ? AND amount < 0 GROUP BY type ORDER BY total DESC").all(since);
  return { inflow, outflow, sinceMs };
}

// Wipe a user's coin balance (ban cleanup) — atomic, audit-logged
function purgeUser(discordId, reason, adminUsername) {
  const cur = getBalance(discordId);
  if (cur === 0) return { purged: 0 };
  const tx = db.transaction(() => {
    db.prepare("UPDATE coin_balances SET balance = 0, total_spent = total_spent + ?, updated_at = datetime('now') WHERE discord_id = ?")
      .run(cur, String(discordId));
    recordTransaction(discordId, "admin_purge", -cur, 0, { reason, admin: adminUsername });
  });
  tx();
  return { purged: cur };
}

module.exports = {
  init,
  EMOJI, NAME, COINS_PER_USD, DAILY_BASE, PURCHASE_BONUS_PER_USD, CASH_TRANSFER_FEE, CASH_PER_COIN, MIN_TRANSFER_COINS,
  MAX_BALANCE, MAX_BALANCE_SUBSCRIBER, DAILY_TRANSFER_CAP, DAILY_TRANSFER_CAP_SUBSCRIBER,
  isSubscriber, getMaxBalance, getTransferCap, getTransferredToday,
  ensureAccount, getBalance, getAccount, addCoins, spendCoins, adminAdjust, purgeUser,
  claimDaily, getStreak, transferToCash,
  centsToCoins, coinsToUsdLabel, sanitizeName,
  getLeaderboard, getAllTimeLeaderboard, getRecentTransactions,
  getCirculation, getFlow,
};
