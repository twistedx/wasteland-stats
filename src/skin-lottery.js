// Weekly Skin Lottery — buy tickets with Wasted Coins, win a random skin from the existing draw pool.
// Drawn alongside the cash lottery on Friday at DRAW_HOUR_UTC.
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const axios = require("axios");
const config = require("./config");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "skin-lottery.db");

const TICKET_PRICE = 250;             // a bit more than the cash lottery — skin prizes are worth more
const MAX_TICKETS_PER_DAY = 10;
const DRAW_WEEKDAY_UTC = 5;           // Friday
const DRAW_HOUR_UTC = 22;

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS skin_lottery_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      username TEXT,
      tickets INTEGER NOT NULL,
      paid INTEGER NOT NULL,
      purchased_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sl_week ON skin_lottery_tickets (week_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sl_user ON skin_lottery_tickets (discord_id, purchased_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS skin_lottery_draws (
      week_id TEXT PRIMARY KEY,
      drawn_at TEXT NOT NULL DEFAULT (datetime('now')),
      winner_discord_id TEXT,
      winner_username TEXT,
      total_tickets INTEGER NOT NULL,
      pot INTEGER NOT NULL,
      skin_name TEXT,
      skin_rarity TEXT,
      grant_status TEXT,        -- 'granted' | 'pending' | 'failed'
      grant_error TEXT,
      status TEXT NOT NULL DEFAULT 'completed' -- 'completed' | 'no_tickets'
    )
  `);

  console.log(`SkinLottery: ${db.prepare("SELECT COUNT(*) as cnt FROM skin_lottery_tickets").get().cnt} tickets, ${db.prepare("SELECT COUNT(*) as cnt FROM skin_lottery_draws").get().cnt} draws.`);
}

function currentWeekId(now = new Date()) {
  const d = new Date(now);
  const day = d.getUTCDay();
  let daysToFri = (DRAW_WEEKDAY_UTC - day + 7) % 7;
  if (day === DRAW_WEEKDAY_UTC && d.getUTCHours() >= DRAW_HOUR_UTC) daysToFri = 7;
  const friday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToFri, DRAW_HOUR_UTC, 0, 0));
  return friday.toISOString().slice(0, 10);
}

function nextDrawDate() {
  const id = currentWeekId();
  return new Date(id + "T" + String(DRAW_HOUR_UTC).padStart(2, "0") + ":00:00Z");
}

function ticketsBoughtToday(discordId) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT COALESCE(SUM(tickets), 0) as n FROM skin_lottery_tickets WHERE discord_id = ? AND substr(purchased_at, 1, 10) = ?").get(String(discordId), todayStr);
  return row.n || 0;
}

const BLACKOUT_MINUTES_BEFORE_DRAW = 5;
function inBlackout() {
  const next = nextDrawDate();
  const minsUntil = (next.getTime() - Date.now()) / 60000;
  return minsUntil > 0 && minsUntil < BLACKOUT_MINUTES_BEFORE_DRAW;
}

function buyTickets(discordId, username, count, wastedCoins) {
  if (!discordId) throw new Error("discord_id required");
  count = parseInt(count, 10);
  if (!Number.isInteger(count) || count <= 0) throw new Error("Buy at least 1 ticket.");
  if (count > MAX_TICKETS_PER_DAY) throw new Error(`Single buy max ${MAX_TICKETS_PER_DAY} tickets.`);
  if (inBlackout()) throw new Error(`Ticket sales paused for ${BLACKOUT_MINUTES_BEFORE_DRAW} min before draw. Try after the draw.`);

  const cost = count * TICKET_PRICE;
  const weekId = currentWeekId();

  return db.transaction(() => {
    const alreadyToday = ticketsBoughtToday(discordId);
    if (alreadyToday + count > MAX_TICKETS_PER_DAY) {
      const remaining = Math.max(0, MAX_TICKETS_PER_DAY - alreadyToday);
      throw new Error(`Daily skin-lottery limit is ${MAX_TICKETS_PER_DAY} tickets (UTC). You've bought ${alreadyToday} today — only ${remaining} left.`);
    }
    wastedCoins.spendCoins(discordId, cost, "skin_lottery_ticket", { meta: { tickets: count, week_id: weekId } });
    try {
      db.prepare("INSERT INTO skin_lottery_tickets (week_id, discord_id, username, tickets, paid) VALUES (?, ?, ?, ?, ?)")
        .run(weekId, String(discordId), username || null, count, cost);
    } catch (e) {
      wastedCoins.addCoins(discordId, cost, "skin_lottery_refund", { username, bypassCap: true, meta: { reason: "insert_failed", error: e.message } });
      throw e;
    }
    return { weekId, tickets: count, cost, balance: wastedCoins.getBalance(discordId) };
  })();
}

function getMyTicketsThisWeek(discordId) {
  const weekId = currentWeekId();
  const row = db.prepare("SELECT COALESCE(SUM(tickets), 0) as n FROM skin_lottery_tickets WHERE discord_id = ? AND week_id = ?").get(String(discordId), weekId);
  return row.n || 0;
}

function getCurrentPot() {
  const weekId = currentWeekId();
  const row = db.prepare("SELECT COALESCE(SUM(paid), 0) as pot, COALESCE(SUM(tickets), 0) as tickets, COUNT(DISTINCT discord_id) as players FROM skin_lottery_tickets WHERE week_id = ?").get(weekId);
  return { weekId, pot: row.pot, tickets: row.tickets, players: row.players };
}

function getRecentDraws(limit = 10) {
  return db.prepare("SELECT * FROM skin_lottery_draws ORDER BY drawn_at DESC LIMIT ?").all(limit);
}

async function grantSkinToWinner(discordId, gameItemName) {
  const apiBaseUrl = config.apiBaseUrl;
  const backendToken = config.backendToken;
  await axios.post(
    `${apiBaseUrl}/itemsUser/updateDiscordUserItemFromDiscord`,
    { discord_id: discordId, item_name: gameItemName, request_type: "set", quantity: 1 },
    { params: { token: backendToken }, timeout: 15000, headers: { "Content-Type": "application/json" } }
  );
}

// Pick a weighted random ticket holder + a weighted random skin from the existing pool.
async function runDrawForWeek(weekId) {
  const existing = db.prepare("SELECT * FROM skin_lottery_draws WHERE week_id = ?").get(weekId);
  if (existing) return existing;

  const entries = db.prepare("SELECT discord_id, username, tickets FROM skin_lottery_tickets WHERE week_id = ?").all(weekId);
  const totalTickets = entries.reduce((s, e) => s + e.tickets, 0);
  const potRow = db.prepare("SELECT COALESCE(SUM(paid), 0) as pot FROM skin_lottery_tickets WHERE week_id = ?").get(weekId);
  const totalPot = potRow.pot;

  if (totalTickets === 0) {
    db.prepare("INSERT INTO skin_lottery_draws (week_id, total_tickets, pot, status) VALUES (?, 0, 0, 'no_tickets')").run(weekId);
    return { weekId, status: "no_tickets", total_tickets: 0, pot: 0 };
  }

  // Weighted ticket-holder pick
  const flat = [];
  for (const e of entries) {
    for (let i = 0; i < e.tickets; i++) flat.push({ discord_id: e.discord_id, username: e.username });
  }
  const winner = flat[crypto.randomInt(0, flat.length)];

  // Weighted skin pick from existing draw pool — re-use the existing draw infrastructure
  const skinDraw = require("./skin-draw");
  const skin = skinDraw.draw();   // null if pool empty
  if (!skin) {
    db.prepare("INSERT INTO skin_lottery_draws (week_id, winner_discord_id, winner_username, total_tickets, pot, status, grant_status, grant_error) VALUES (?, ?, ?, ?, ?, 'completed', 'failed', 'pool empty')")
      .run(weekId, winner.discord_id, winner.username, totalTickets, totalPot);
    return { weekId, status: "completed", winner, total_tickets: totalTickets, pot: totalPot, skin: null, grant_status: "failed", grant_error: "pool empty" };
  }

  // Try to grant the skin in-game
  let grantStatus = "granted";
  let grantError = null;
  const gameItemName = skin.game_item_name || skin.name;
  try {
    await grantSkinToWinner(winner.discord_id, gameItemName);
  } catch (err) {
    grantStatus = "failed";
    grantError = err.response?.data?.message || err.message;
    console.error(`SkinLottery: failed to grant ${skin.name} to ${winner.discord_id}:`, grantError);
  }

  db.prepare(`
    INSERT INTO skin_lottery_draws (week_id, winner_discord_id, winner_username, total_tickets, pot, skin_name, skin_rarity, grant_status, grant_error, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')
  `).run(weekId, winner.discord_id, winner.username, totalTickets, totalPot, skin.name, skin.rarity, grantStatus, grantError);

  // Record the draw in the existing skin_draw_history too so it shows up in normal stats
  try {
    skinDraw.recordDraw({
      discord_id: winner.discord_id,
      result_name: skin.name,
      result_rarity: skin.rarity,
      stripe_session_id: `skin-lottery-${weekId}`,
    });
  } catch (e) { console.warn("SkinLottery: history record failed:", e.message); }

  return {
    weekId, status: "completed",
    winner, total_tickets: totalTickets, pot: totalPot,
    skin: { name: skin.name, rarity: skin.rarity, game_item_name: gameItemName },
    grant_status: grantStatus, grant_error: grantError,
  };
}

async function checkAndDraw() {
  const now = new Date();
  const d = new Date(now);
  const day = d.getUTCDay();
  let daysBack = (day - DRAW_WEEKDAY_UTC + 7) % 7;
  if (day === DRAW_WEEKDAY_UTC && d.getUTCHours() < DRAW_HOUR_UTC) daysBack = 7;
  const fri = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysBack, DRAW_HOUR_UTC, 0, 0));
  if (now < fri) return null;

  // Backfill up to 4 missed Fridays
  const results = [];
  for (let i = 3; i >= 0; i--) {
    const checkDate = new Date(fri.getTime() - i * 7 * 86400000);
    if (checkDate > now) continue;
    const weekId = checkDate.toISOString().slice(0, 10);
    const existing = db.prepare("SELECT 1 FROM skin_lottery_draws WHERE week_id = ?").get(weekId);
    if (!existing) {
      try {
        const r = await runDrawForWeek(weekId);
        if (r) results.push(r);
      } catch (e) {
        console.error(`SkinLottery: backfill draw ${weekId} failed:`, e.message);
      }
    }
  }
  return results.length > 0 ? results[results.length - 1] : null;
}

module.exports = {
  init,
  TICKET_PRICE, MAX_TICKETS_PER_DAY, DRAW_WEEKDAY_UTC, DRAW_HOUR_UTC,
  currentWeekId, nextDrawDate, ticketsBoughtToday,
  buyTickets, getMyTicketsThisWeek, getCurrentPot, getRecentDraws,
  runDrawForWeek, checkAndDraw,
};
