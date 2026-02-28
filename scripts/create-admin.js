#!/usr/bin/env node
require("dotenv").config();

const readline = require("readline");
const adminUsers = require("../src/admin-users");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function main() {
  adminUsers.init();

  console.log("\n--- Create Admin User ---\n");

  const email = (await ask("Email: ")).trim();
  if (!email || !email.includes("@")) {
    console.error("Invalid email.");
    process.exit(1);
  }

  const existing = adminUsers.getByEmail(email);
  if (existing) {
    console.error(`User with email "${email}" already exists.`);
    process.exit(1);
  }

  const username = (await ask("Display name: ")).trim();
  if (!username) {
    console.error("Display name is required.");
    process.exit(1);
  }

  const password = (await ask("Password: ")).trim();
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const isWriteAdmin = (await ask("Write-admin access? (y/N): ")).trim().toLowerCase() === "y";
  const isBlogAdmin = (await ask("Blog-admin access? (y/N): ")).trim().toLowerCase() === "y";
  const discordId = (await ask("Discord ID (optional, press enter to skip): ")).trim() || null;

  await adminUsers.createUser(email, password, username, {
    isAdmin: true,
    isWriteAdmin,
    isBlogAdmin,
    discordId,
  });

  console.log(`\nAdmin user "${username}" (${email}) created successfully.`);
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
