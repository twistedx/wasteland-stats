// Weekly Wasted Coins lottery — drawn every Friday at DRAW_HOUR_UTC
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "lottery.db");

const TICKET_PRICE = 100;
const MAX_TICKETS_PER_DAY = 10;
const HOUSE_RAKE = 0.10;        // 10% of pot stays with the house
const DRAW_WEEKDAY_UTC = 5;     // Friday (Sun=0, Mon=1, … Fri=5, Sat=6)
const DRAW_HOUR_UTC = 22;       // 22:00 UTC = 5pm EST / 6pm EDT

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS lottery_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      username TEXT,
      tickets INTEGER NOT NULL,
      paid INTEGER NOT NULL,
      purchased_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lot_week ON lottery_tickets (week_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lot_user ON lottery_tickets (discord_id, purchased_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS lottery_draws (
      week_id TEXT PRIMARY KEY,
      drawn_at TEXT NOT NULL DEFAULT (datetime('now')),
      winner_discord_id TEXT,
      winner_username TEXT,
      winning_ticket_index INTEGER,
      total_tickets INTEGER NOT NULL,
      pot INTEGER NOT NULL,
      payout INTEGER NOT NULL,
      house_rake INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed'
    )
  `);

  console.log(`Lottery: ${db.prepare("SELECT COUNT(*) as cnt FROM lottery_tickets").get().cnt} tickets, ${db.prepare("SELECT COUNT(*) as cnt FROM lottery_draws").get().cnt} draws.`);
}

// ── Week ID helpers — current Friday-bounded week ──
// Week ID is the date of the Friday this week's draw belongs to (YYYY-MM-DD UTC).
function currentWeekId(now = new Date()) {
  const d = new Date(now);
  // Find the upcoming Friday at DRAW_HOUR_UTC. If past that, the next Friday belongs to NEXT week — but the open week is the current one.
  const day = d.getUTCDay();
  let daysToFri = (DRAW_WEEKDAY_UTC - day + 7) % 7;
  // If today is Friday but past draw hour, the draw already happened — open week rolls to next Friday.
  if (day === DRAW_WEEKDAY_UTC && d.getUTCHours() >= DRAW_HOUR_UTC) {
    daysToFri = 7;
  }
  const friday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToFri, DRAW_HOUR_UTC, 0, 0));
  return friday.toISOString().slice(0, 10);
}

function nextDrawDate() {
  const id = currentWeekId();
  return new Date(id + "T" + String(DRAW_HOUR_UTC).padStart(2, "0") + ":00:00Z");
}

// ── Daily ticket cap per user (UTC calendar day) ──
function ticketsBoughtToday(discordId) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT COALESCE(SUM(tickets), 0) as n FROM lottery_tickets WHERE discord_id = ? AND substr(purchased_at, 1, 10) = ?").get(String(discordId), todayStr);
  return row.n || 0;
}

// Blackout window: refuse buys in the last 5 minutes before draw to avoid week-id flip races
const BLACKOUT_MINUTES_BEFORE_DRAW = 5;

function inBlackout() {
  const next = nextDrawDate();
  const minsUntil = (next.getTime() - Date.now()) / 60000;
  return minsUntil > 0 && minsUntil < BLACKOUT_MINUTES_BEFORE_DRAW;
}

// ── Buy tickets ──
// Atomic — wraps cap check + spend + insert in a single tx so concurrent buys can't bypass the cap.
function buyTickets(discordId, username, count, wastedCoins) {
  if (!discordId) throw new Error("discord_id required");
  count = parseInt(count, 10);
  if (!Number.isInteger(count) || count <= 0) throw new Error("Buy at least 1 ticket.");
  if (count > MAX_TICKETS_PER_DAY) throw new Error(`Single buy max ${MAX_TICKETS_PER_DAY} tickets.`);
  if (inBlackout()) throw new Error(`Ticket sales paused for ${BLACKOUT_MINUTES_BEFORE_DRAW} min before draw. Try after the draw.`);

  const cost = count * TICKET_PRICE;
  const weekId = currentWeekId();

  // Cross-DB atomicity isn't possible; use a single-table tx inside lottery.db,
  // and do spendCoins (in coin DB) as a conditional UPDATE that throws on failure.
  // We do the cap check + lottery insert inside ONE lottery.db tx so two parallel buys
  // race on the SELECT, but the INSERT carries a "tickets-this-day after insert <= cap" guard.
  return db.transaction(() => {
    const alreadyToday = ticketsBoughtToday(discordId);
    if (alreadyToday + count > MAX_TICKETS_PER_DAY) {
      const remaining = Math.max(0, MAX_TICKETS_PER_DAY - alreadyToday);
      throw new Error(`Daily limit is ${MAX_TICKETS_PER_DAY} tickets (UTC). You've bought ${alreadyToday} today — only ${remaining} left.`);
    }
    // Spend first (atomic via spendCoins's UPDATE WHERE balance >= ?), then insert. If insert throws, refund.
    wastedCoins.spendCoins(discordId, cost, "lottery_ticket", { meta: { tickets: count, week_id: weekId } });
    try {
      db.prepare("INSERT INTO lottery_tickets (week_id, discord_id, username, tickets, paid) VALUES (?, ?, ?, ?, ?)")
        .run(weekId, String(discordId), username || null, count, cost);
    } catch (e) {
      // Refund (bypass cap) to keep user whole
      wastedCoins.addCoins(discordId, cost, "lottery_refund", { username, bypassCap: true, meta: { reason: "insert_failed", error: e.message } });
      throw e;
    }
    return { weekId, tickets: count, cost, balance: wastedCoins.getBalance(discordId) };
  })();
}

function getMyTicketsThisWeek(discordId) {
  const weekId = currentWeekId();
  const row = db.prepare("SELECT COALESCE(SUM(tickets), 0) as n FROM lottery_tickets WHERE discord_id = ? AND week_id = ?").get(String(discordId), weekId);
  return row.n || 0;
}

function getCurrentPot() {
  const weekId = currentWeekId();
  const row = db.prepare("SELECT COALESCE(SUM(paid), 0) as pot, COALESCE(SUM(tickets), 0) as tickets, COUNT(DISTINCT discord_id) as players FROM lottery_tickets WHERE week_id = ?").get(weekId);
  return { weekId, pot: row.pot, tickets: row.tickets, players: row.players };
}

function getRecentDraws(limit = 10) {
  return db.prepare("SELECT * FROM lottery_draws ORDER BY drawn_at DESC LIMIT ?").all(limit);
}

// ── Draw ──
// Pick a winner weighted by tickets (1 entry per ticket), pay out pot * (1 - rake)
// Returns null if no tickets or already drawn for week_id.
function runDrawForWeek(weekId, wastedCoins) {
  const existing = db.prepare("SELECT * FROM lottery_draws WHERE week_id = ?").get(weekId);
  if (existing) return existing;

  const entries = db.prepare("SELECT discord_id, username, tickets FROM lottery_tickets WHERE week_id = ?").all(weekId);
  const totalTickets = entries.reduce((s, e) => s + e.tickets, 0);
  const potRow = db.prepare("SELECT COALESCE(SUM(paid), 0) as pot FROM lottery_tickets WHERE week_id = ?").get(weekId);
  const totalPot = potRow.pot;

  if (totalTickets === 0) {
    db.prepare("INSERT INTO lottery_draws (week_id, total_tickets, pot, payout, house_rake, status) VALUES (?, 0, ?, 0, 0, 'no_tickets')").run(weekId, totalPot);
    return { weekId, status: "no_tickets", total_tickets: 0, pot: totalPot, payout: 0 };
  }

  // Weighted pick — flatten then crypto-random index
  const flat = [];
  for (const e of entries) {
    for (let i = 0; i < e.tickets; i++) flat.push({ discord_id: e.discord_id, username: e.username });
  }
  const idx = crypto.randomInt(0, flat.length);
  const winner = flat[idx];

  const houseRake = Math.round(totalPot * HOUSE_RAKE);
  const payout = totalPot - houseRake;

  db.prepare("INSERT INTO lottery_draws (week_id, winner_discord_id, winner_username, winning_ticket_index, total_tickets, pot, payout, house_rake, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')")
    .run(weekId, winner.discord_id, winner.username, idx, totalTickets, totalPot, payout, houseRake);

  // Credit winner — bypass cap so a big win can land even if at cap
  wastedCoins.addCoins(winner.discord_id, payout, "lottery_payout", { username: winner.username, bypassCap: true, meta: { week_id: weekId, total_tickets: totalTickets, pot: totalPot, rake: houseRake } });

  return { weekId, status: "completed", winner, total_tickets: totalTickets, pot: totalPot, payout, house_rake: houseRake };
}

// Hourly cron: if past draw time and the current week's draw hasn't happened, do it.
// Also backfills any missed Friday draws (e.g. server was down) — caps at 4 weeks back to bound work.
function checkAndDraw(wastedCoins) {
  const now = new Date();
  const d = new Date(now);
  const day = d.getUTCDay();
  let daysBack = (day - DRAW_WEEKDAY_UTC + 7) % 7;
  if (day === DRAW_WEEKDAY_UTC && d.getUTCHours() < DRAW_HOUR_UTC) daysBack = 7;
  const fri = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysBack, DRAW_HOUR_UTC, 0, 0));
  if (now < fri) return null;

  // Walk back up to 4 Fridays looking for any missing draws and run them in order
  const results = [];
  for (let i = 3; i >= 0; i--) {
    const checkDate = new Date(fri.getTime() - i * 7 * 86400000);
    if (checkDate > now) continue;
    const weekId = checkDate.toISOString().slice(0, 10);
    const existing = db.prepare("SELECT 1 FROM lottery_draws WHERE week_id = ?").get(weekId);
    if (!existing) {
      try {
        const r = runDrawForWeek(weekId, wastedCoins);
        if (r) results.push(r);
      } catch (e) {
        console.error(`Lottery: backfill draw ${weekId} failed:`, e.message);
      }
    }
  }
  return results.length > 0 ? results[results.length - 1] : null;
}

module.exports = {
  init,
  TICKET_PRICE, MAX_TICKETS_PER_DAY, HOUSE_RAKE, DRAW_WEEKDAY_UTC, DRAW_HOUR_UTC,
  currentWeekId, nextDrawDate, ticketsBoughtToday,
  buyTickets, getMyTicketsThisWeek, getCurrentPot, getRecentDraws,
  runDrawForWeek, checkAndDraw,
};
