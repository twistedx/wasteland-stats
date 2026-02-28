const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");

const DB_DIR = process.platform === "win32"
  ? path.join(__dirname, "..", "data")
  : "/var/data";
const DB_FILE = path.join(DB_DIR, "admin-users.db");

const SALT_ROUNDS = 12;
const CODE_EXPIRY = 10 * 60 * 1000; // 10 minutes

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS verify_codes (
      code TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Clean up expired codes on startup
  db.prepare("DELETE FROM verify_codes WHERE created_at < ?").run(Date.now() - CODE_EXPIRY);

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

function getByDiscordId(discordId) {
  return db.prepare("SELECT * FROM admin_users WHERE discord_id = ?").get(discordId) || null;
}

function linkDiscord(email, discordId) {
  db.prepare("UPDATE admin_users SET discord_id = ? WHERE email = ?").run(discordId, email.toLowerCase().trim());
}

function setRoles(email, roles) {
  db.prepare(`
    UPDATE admin_users SET is_admin = ?, is_write_admin = ?, is_blog_admin = ? WHERE email = ?
  `).run(
    roles.isAdmin ? 1 : 0,
    roles.isWriteAdmin ? 1 : 0,
    roles.isBlogAdmin ? 1 : 0,
    email.toLowerCase().trim()
  );
}

// Generate a 6-char verification code for an email account
function generateVerifyCode(email) {
  // Remove any existing code for this email
  db.prepare("DELETE FROM verify_codes WHERE email = ?").run(email.toLowerCase().trim());
  // Clean expired codes
  db.prepare("DELETE FROM verify_codes WHERE created_at < ?").run(Date.now() - CODE_EXPIRY);

  const code = crypto.randomBytes(3).toString("hex").toUpperCase(); // e.g. "A3F1B2"
  db.prepare("INSERT INTO verify_codes (code, email, created_at) VALUES (?, ?, ?)").run(
    code, email.toLowerCase().trim(), Date.now()
  );
  console.log(`AdminUsers: generated verify code ${code} for ${email}`);
  return code;
}

function updateUsername(email, newUsername) {
  db.prepare("UPDATE admin_users SET username = ? WHERE email = ?").run(
    newUsername.trim(), email.toLowerCase().trim()
  );
}

function updateEmail(oldEmail, newEmail) {
  const existing = getByEmail(newEmail);
  if (existing) return false;
  db.prepare("UPDATE admin_users SET email = ? WHERE email = ?").run(
    newEmail.toLowerCase().trim(), oldEmail.toLowerCase().trim()
  );
  // Update any pending verify codes to the new email
  db.prepare("UPDATE verify_codes SET email = ? WHERE email = ?").run(
    newEmail.toLowerCase().trim(), oldEmail.toLowerCase().trim()
  );
  return true;
}

async function updatePassword(email, currentPassword, newPassword) {
  const user = db.prepare("SELECT * FROM admin_users WHERE email = ?").get(email.toLowerCase().trim());
  if (!user) return false;
  const match = await bcrypt.compare(currentPassword, user.password_hash);
  if (!match) return false;
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  db.prepare("UPDATE admin_users SET password_hash = ? WHERE email = ?").run(hash, email.toLowerCase().trim());
  return true;
}

// Redeem a verification code — returns the email if valid, null if expired/invalid
function redeemVerifyCode(code) {
  const row = db.prepare("SELECT * FROM verify_codes WHERE code = ?").get(code.toUpperCase().trim());
  if (!row) {
    console.log(`AdminUsers: redeem code ${code} — not found`);
    return null;
  }
  if (Date.now() - row.created_at > CODE_EXPIRY) {
    console.log(`AdminUsers: redeem code ${code} — expired (created ${Math.round((Date.now() - row.created_at) / 1000)}s ago)`);
    db.prepare("DELETE FROM verify_codes WHERE code = ?").run(code);
    return null;
  }
  // Delete the code so it can't be reused
  db.prepare("DELETE FROM verify_codes WHERE code = ?").run(code);
  console.log(`AdminUsers: redeem code ${code} — success, email=${row.email}`);
  return row.email;
}

module.exports = {
  init, createUser, register, authenticate,
  getByEmail, getByDiscordId, linkDiscord, setRoles,
  updateUsername, updateEmail, updatePassword,
  generateVerifyCode, redeemVerifyCode,
};
