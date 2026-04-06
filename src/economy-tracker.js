const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "economy.db");

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS atm_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      player_name TEXT,
      amount INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_atm_ts ON atm_transactions (created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_atm_type ON atm_transactions (type)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS economy_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total_cash INTEGER NOT NULL,
      player_count INTEGER NOT NULL,
      ts INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_econ_ts ON economy_snapshots (ts)`);

  // Prune old transactions (keep 90 days)
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().replace("T", " ").slice(0, 19);
  db.prepare("DELETE FROM atm_transactions WHERE created_at < ?").run(cutoff);

  const txCount = db.prepare("SELECT COUNT(*) as c FROM atm_transactions").get().c;
  console.log(`EconomyTracker: ${txCount} ATM transactions in database.`);
}

function recordTransaction(type, playerName, amount) {
  if (!db) return;
  db.prepare("INSERT INTO atm_transactions (type, player_name, amount) VALUES (?, ?, ?)")
    .run(type, playerName || null, Math.abs(amount));
}

function recordTransactionAt(type, playerName, amount, timestamp) {
  if (!db) return;
  db.prepare("INSERT INTO atm_transactions (type, player_name, amount, created_at) VALUES (?, ?, ?, ?)")
    .run(type, playerName || null, Math.abs(amount), timestamp);
}

function clearTransactions() {
  if (!db) return;
  db.prepare("DELETE FROM atm_transactions").run();
}

function recordSnapshot(totalCash, playerCount) {
  if (!db) return;
  db.prepare("INSERT INTO economy_snapshots (total_cash, player_count, ts) VALUES (?, ?, ?)")
    .run(totalCash, playerCount, Date.now());
}

function getStats() {
  if (!db) return null;

  const now = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);
  const weekStr = new Date(now - 7 * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const monthStr = new Date(now - 30 * 86400000).toISOString().replace("T", " ").slice(0, 19);

  // Today's stats
  const todayDeposits = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM atm_transactions WHERE type = 'deposit' AND created_at >= ?").get(todayStr);
  const todayWithdrawals = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM atm_transactions WHERE type = 'withdrawal' AND created_at >= ?").get(todayStr);

  // Week stats
  const weekDeposits = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM atm_transactions WHERE type = 'deposit' AND created_at >= ?").get(weekStr);
  const weekWithdrawals = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM atm_transactions WHERE type = 'withdrawal' AND created_at >= ?").get(weekStr);

  // Month stats
  const monthDeposits = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM atm_transactions WHERE type = 'deposit' AND created_at >= ?").get(monthStr);
  const monthWithdrawals = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM atm_transactions WHERE type = 'withdrawal' AND created_at >= ?").get(monthStr);

  // All time
  const allDeposits = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM atm_transactions WHERE type = 'deposit'").get();
  const allWithdrawals = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM atm_transactions WHERE type = 'withdrawal'").get();

  // Averages
  const avgDeposit = allDeposits.cnt > 0 ? Math.round(allDeposits.total / allDeposits.cnt) : 0;
  const avgWithdrawal = allWithdrawals.cnt > 0 ? Math.round(allWithdrawals.total / allWithdrawals.cnt) : 0;

  // Daily history (last 30 days)
  const dailyHistory = [];
  for (let i = 29; i >= 0; i--) {
    const dayStart = new Date(now - i * 86400000);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const dayStartStr = dayStart.toISOString().replace("T", " ").slice(0, 19);
    const dayEndStr = dayEnd.toISOString().replace("T", " ").slice(0, 19);

    const dep = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM atm_transactions WHERE type = 'deposit' AND created_at >= ? AND created_at < ?").get(dayStartStr, dayEndStr);
    const wth = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM atm_transactions WHERE type = 'withdrawal' AND created_at >= ? AND created_at < ?").get(dayStartStr, dayEndStr);

    dailyHistory.push({
      date: dayStart.toISOString().slice(0, 10),
      deposits: dep.total,
      depositCount: dep.cnt,
      withdrawals: wth.total,
      withdrawalCount: wth.cnt,
    });
  }

  // Recent transactions
  const recentTransactions = db.prepare("SELECT * FROM atm_transactions ORDER BY created_at DESC LIMIT 20").all();

  // Economy snapshots (last 30 days)
  const snapCutoff = now - 30 * 86400000;
  const snapshots = db.prepare("SELECT total_cash, player_count, ts FROM economy_snapshots WHERE ts >= ? ORDER BY ts ASC").all(snapCutoff);

  return {
    today: { deposits: todayDeposits, withdrawals: todayWithdrawals },
    week: { deposits: weekDeposits, withdrawals: weekWithdrawals },
    month: { deposits: monthDeposits, withdrawals: monthWithdrawals },
    all: { deposits: allDeposits, withdrawals: allWithdrawals },
    avgDeposit,
    avgWithdrawal,
    dailyHistory,
    recentTransactions,
    snapshots,
  };
}

module.exports = { init, recordTransaction, recordTransactionAt, recordSnapshot, clearTransactions, getStats };
