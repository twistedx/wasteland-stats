// Dev helper: grant Wasted Coins to a discord_id directly via the local SQLite DB.
// Usage:  node scripts/grant-coins.js <discord_id> <amount>
// Example: node scripts/grant-coins.js 123456789012345678 50000

const wastedCoins = require("../src/wasted-coins");
wastedCoins.init();

const [, , discordId, amountStr] = process.argv;

if (!discordId || !amountStr) {
  console.error("Usage: node scripts/grant-coins.js <discord_id> <amount>");
  process.exit(1);
}

const amount = parseInt(amountStr, 10);
if (!Number.isInteger(amount) || amount === 0) {
  console.error("Amount must be a non-zero integer.");
  process.exit(1);
}

try {
  const newBalance = wastedCoins.adminAdjust(discordId, amount, "dev-script");
  console.log(`OK — ${amount > 0 ? "added" : "removed"} ${Math.abs(amount).toLocaleString()} coins.`);
  console.log(`New balance for ${discordId}: ${newBalance.toLocaleString()} 💀`);
} catch (err) {
  console.error("Failed:", err.message);
  process.exit(1);
}
