const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");

const DB_DIR = process.platform === "win32"
  ? path.join(__dirname, "..", "data")
  : "/var/data";
const DB_FILE = path.join(DB_DIR, "admin-users.db");

const SALT_ROUNDS = 12;

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      username TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_write_admin INTEGER NOT NULL DEFAULT 0,
      is_blog_admin INTEGER NOT NULL DEFAULT 0,
      discord_id TEXT,
      created_at INTEGER NOT NULL,
      last_login INTEGER
    )
  `);

  const count = db.prepare("SELECT COUNT(*) as cnt FROM admin_users").get().cnt;
  console.log(`AdminUsers: ${count} accounts in database.`);
}

// CLI-only: create user with specific roles (for scripts/create-admin.js)
async function createUser(email, password, username, roles = {}) {
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  db.prepare(`
    INSERT INTO admin_users (email, password_hash, username, is_admin, is_write_admin, is_blog_admin, discord_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    email.toLowerCase().trim(),
    hash,
    username,
    roles.isAdmin ? 1 : 0,
    roles.isWriteAdmin ? 1 : 0,
    roles.isBlogAdmin ? 1 : 0,
    roles.discordId || null,
    Date.now()
  );
}

// Public registration — no admin roles
async function register(email, password, username) {
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  db.prepare(`
    INSERT INTO admin_users (email, password_hash, username, is_admin, is_write_admin, is_blog_admin, created_at)
    VALUES (?, ?, ?, 0, 0, 0, ?)
  `).run(
    email.toLowerCase().trim(),
    hash,
    username.trim(),
    Date.now()
  );
}

async function authenticate(email, password) {
  const user = db.prepare("SELECT * FROM admin_users WHERE email = ?").get(email.toLowerCase().trim());
  if (!user) return null;

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return null;

  db.prepare("UPDATE admin_users SET last_login = ? WHERE id = ?").run(Date.now(), user.id);
  return user;
}

function getByEmail(email) {
  return db.prepare("SELECT * FROM admin_users WHERE email = ?").get(email.toLowerCase().trim()) || null;
}

module.exports = { init, createUser, register, authenticate, getByEmail };
