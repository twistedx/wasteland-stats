const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "arms-dealer.db");

// ── Constants ──
const ENTRY_COST = 500;
const STARTING_CASH = 5000;
const STARTING_DEBT = 3000;
const INTEREST_RATE = 0.08; // 8% per day
const MAX_DAYS = 20;
const MAX_INVENTORY = 100;
const DAILY_PLAYS = 2;
const TRAVEL_COST = 200;

const LOCATIONS = [
  { id: "fob", name: "Forward Operating Base", emoji: "🏕️", description: "Military surplus — cheap ammo, pricey medical" },
  { id: "blackmarket", name: "Black Market", emoji: "🕶️", description: "High risk, wild prices on everything" },
  { id: "refugee", name: "Refugee Camp", emoji: "⛺", description: "Medical supplies in demand, cheap fuel" },
  { id: "airfield", name: "Abandoned Airfield", emoji: "✈️", description: "Vehicle parts galore, explosives available" },
  { id: "harbor", name: "Smuggler's Harbor", emoji: "🚢", description: "Import hub — bulk deals on heavy ordnance" },
  { id: "factory", name: "Ruined Factory", emoji: "🏭", description: "Scavenger central — cheap parts, rare finds" },
];

const COMMODITIES = [
  { id: "ammo",     name: "5.56 Ammo Crates",  emoji: "🔫", basePrice: 300,  volatility: 0.4 },
  { id: "rpg",      name: "RPG Rounds",        emoji: "🚀", basePrice: 1200, volatility: 0.6 },
  { id: "medical",  name: "Medical Supplies",   emoji: "💊", basePrice: 500,  volatility: 0.5 },
  { id: "parts",    name: "Vehicle Parts",      emoji: "⚙️", basePrice: 400,  volatility: 0.45 },
  { id: "c4",       name: "C4 Explosives",      emoji: "💣", basePrice: 1500, volatility: 0.7 },
  { id: "fuel",     name: "Fuel Barrels",       emoji: "⛽", basePrice: 200,  volatility: 0.35 },
];

// Location price modifiers — some locations have cheaper/more expensive goods
const LOCATION_MODS = {
  fob:         { ammo: 0.7, rpg: 1.0, medical: 1.4, parts: 1.1, c4: 1.2, fuel: 1.0 },
  blackmarket: { ammo: 1.2, rpg: 0.8, medical: 1.1, parts: 1.3, c4: 0.7, fuel: 1.4 },
  refugee:     { ammo: 1.3, rpg: 1.5, medical: 0.6, parts: 1.0, c4: 1.6, fuel: 0.7 },
  airfield:    { ammo: 1.0, rpg: 1.1, medical: 1.2, parts: 0.6, c4: 0.9, fuel: 1.1 },
  harbor:      { ammo: 0.9, rpg: 0.7, medical: 1.0, parts: 0.9, c4: 0.8, fuel: 0.8 },
  factory:     { ammo: 1.1, rpg: 1.3, medical: 1.3, parts: 0.5, c4: 1.1, fuel: 0.9 },
};

const EVENTS = [
  { id: "ambush", chance: 0.12, msg: "Bandits ambushed your convoy!", effect: "lose_goods" },
  { id: "stash", chance: 0.08, msg: "You found a hidden weapons stash!", effect: "free_goods" },
  { id: "price_spike", chance: 0.10, msg: "Demand just spiked!", effect: "price_up" },
  { id: "market_crash", chance: 0.10, msg: "Market flooded — prices crashed!", effect: "price_down" },
  { id: "theft", chance: 0.08, msg: "A thief stole some of your cash!", effect: "lose_cash" },
  { id: "tip", chance: 0.07, msg: "A contact tipped you off about cheap goods nearby!", effect: "discount" },
  { id: "checkpoint", chance: 0.06, msg: "Military checkpoint — they confiscated contraband!", effect: "lose_contraband" },
  { id: "windfall", chance: 0.05, msg: "You found cash in an abandoned vehicle!", effect: "gain_cash" },
];

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`CREATE TABLE IF NOT EXISTS dealer_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    username TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    day INTEGER NOT NULL DEFAULT 1,
    cash INTEGER NOT NULL DEFAULT ${STARTING_CASH},
    debt INTEGER NOT NULL DEFAULT ${STARTING_DEBT},
    location TEXT NOT NULL DEFAULT 'fob',
    inventory TEXT NOT NULL DEFAULT '{}',
    prices TEXT NOT NULL DEFAULT '{}',
    event_log TEXT NOT NULL DEFAULT '[]',
    entry_cost INTEGER NOT NULL DEFAULT ${ENTRY_COST},
    payout INTEGER DEFAULT 0,
    message_id TEXT,
    channel_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS dealer_leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    username TEXT,
    profit INTEGER NOT NULL,
    days_survived INTEGER NOT NULL,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.exec("CREATE INDEX IF NOT EXISTS idx_dealer_discord ON dealer_games(discord_id, status)");

  const total = db.prepare("SELECT COUNT(*) as n FROM dealer_games").get().n;
  console.log(`ArmsDealer: ${total} games played.`);
}

// ── Price Engine ──
function generatePrices(locationId) {
  const mods = LOCATION_MODS[locationId] || {};
  const prices = {};
  for (const c of COMMODITIES) {
    const mod = mods[c.id] || 1.0;
    const base = c.basePrice * mod;
    // Random swing based on volatility
    const swing = 1 + (Math.random() - 0.5) * 2 * c.volatility;
    prices[c.id] = Math.max(10, Math.round(base * swing));
  }
  return prices;
}

function generateEventPrices(prices, effect) {
  const newPrices = { ...prices };
  if (effect === "price_up") {
    const item = COMMODITIES[Math.floor(Math.random() * COMMODITIES.length)];
    newPrices[item.id] = Math.round(newPrices[item.id] * (1.5 + Math.random() * 0.5));
  } else if (effect === "price_down") {
    const item = COMMODITIES[Math.floor(Math.random() * COMMODITIES.length)];
    newPrices[item.id] = Math.max(10, Math.round(newPrices[item.id] * (0.3 + Math.random() * 0.2)));
  } else if (effect === "discount") {
    const item = COMMODITIES[Math.floor(Math.random() * COMMODITIES.length)];
    newPrices[item.id] = Math.max(10, Math.round(newPrices[item.id] * 0.4));
  }
  return newPrices;
}

// ── Game Functions ──

function playsToday(discordId) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare("SELECT COUNT(*) as n FROM dealer_games WHERE discord_id = ? AND substr(created_at, 1, 10) = ?").get(String(discordId), today).n;
}

function getActiveGame(discordId) {
  return db.prepare("SELECT * FROM dealer_games WHERE discord_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(String(discordId)) || null;
}

function startGame(discordId, username, wastedCoins) {
  if (getActiveGame(discordId)) throw new Error("You already have an active game! Finish it first.");
  if (playsToday(discordId) >= DAILY_PLAYS) throw new Error(`You've used all ${DAILY_PLAYS} dealer runs for today. Come back tomorrow!`);

  wastedCoins.spendCoins(discordId, ENTRY_COST, "dealer_entry", { meta: { game: "arms_dealer" } });

  const startLoc = "fob";
  const prices = generatePrices(startLoc);

  const r = db.prepare("INSERT INTO dealer_games (discord_id, username, location, prices, inventory) VALUES (?, ?, ?, ?, ?)")
    .run(String(discordId), username, startLoc, JSON.stringify(prices), JSON.stringify({}));

  return { id: r.lastInsertRowid, day: 1, cash: STARTING_CASH, debt: STARTING_DEBT, location: startLoc, prices };
}

function getGameState(gameId) {
  const game = db.prepare("SELECT * FROM dealer_games WHERE id = ?").get(gameId);
  if (!game) return null;
  game.inventoryObj = JSON.parse(game.inventory || "{}");
  game.pricesObj = JSON.parse(game.prices || "{}");
  game.eventLogArr = JSON.parse(game.event_log || "[]");
  return game;
}

function getInventoryCount(inv) {
  return Object.values(inv).reduce((s, n) => s + n, 0);
}

function getNetWorth(game) {
  const inv = typeof game.inventory === "string" ? JSON.parse(game.inventory) : game.inventoryObj || {};
  const prices = typeof game.prices === "string" ? JSON.parse(game.prices) : game.pricesObj || {};
  let goodsValue = 0;
  for (const [id, qty] of Object.entries(inv)) {
    goodsValue += (prices[id] || 0) * qty;
  }
  return game.cash + goodsValue - game.debt;
}

function buy(gameId, commodityId, qty) {
  const game = getGameState(gameId);
  if (!game || game.status !== "active") throw new Error("No active game.");
  const price = game.pricesObj[commodityId];
  if (!price) throw new Error("Invalid item.");
  if (qty <= 0) throw new Error("Invalid quantity.");

  const cost = price * qty;
  if (cost > game.cash) throw new Error(`Not enough cash. Need $${cost.toLocaleString()}, have $${game.cash.toLocaleString()}.`);

  const currentCount = getInventoryCount(game.inventoryObj);
  if (currentCount + qty > MAX_INVENTORY) throw new Error(`Can't carry that much. Space: ${MAX_INVENTORY - currentCount} units.`);

  game.inventoryObj[commodityId] = (game.inventoryObj[commodityId] || 0) + qty;
  const newCash = game.cash - cost;

  db.prepare("UPDATE dealer_games SET cash = ?, inventory = ? WHERE id = ?")
    .run(newCash, JSON.stringify(game.inventoryObj), gameId);

  return { cash: newCash, spent: cost, item: commodityId, qty, inventory: game.inventoryObj };
}

function sell(gameId, commodityId, qty) {
  const game = getGameState(gameId);
  if (!game || game.status !== "active") throw new Error("No active game.");
  const price = game.pricesObj[commodityId];
  if (!price) throw new Error("Invalid item.");

  const owned = game.inventoryObj[commodityId] || 0;
  if (qty <= 0 || qty > owned) throw new Error(`You only have ${owned} of that.`);

  const revenue = price * qty;
  game.inventoryObj[commodityId] = owned - qty;
  if (game.inventoryObj[commodityId] <= 0) delete game.inventoryObj[commodityId];
  const newCash = game.cash + revenue;

  db.prepare("UPDATE dealer_games SET cash = ?, inventory = ? WHERE id = ?")
    .run(newCash, JSON.stringify(game.inventoryObj), gameId);

  return { cash: newCash, earned: revenue, item: commodityId, qty, inventory: game.inventoryObj };
}

function payDebt(gameId, amount) {
  const game = getGameState(gameId);
  if (!game || game.status !== "active") throw new Error("No active game.");
  if (amount <= 0) throw new Error("Invalid amount.");
  if (amount > game.cash) throw new Error("Not enough cash.");
  if (amount > game.debt) amount = game.debt;

  const newCash = game.cash - amount;
  const newDebt = game.debt - amount;

  db.prepare("UPDATE dealer_games SET cash = ?, debt = ? WHERE id = ?").run(newCash, newDebt, gameId);
  return { cash: newCash, debt: newDebt, paid: amount };
}

function travel(gameId, locationId) {
  const game = getGameState(gameId);
  if (!game || game.status !== "active") throw new Error("No active game.");
  if (game.location === locationId) throw new Error("You're already there.");
  if (!LOCATIONS.find(l => l.id === locationId)) throw new Error("Unknown location.");
  if (game.cash < TRAVEL_COST) throw new Error(`Travel costs $${TRAVEL_COST}. You have $${game.cash.toLocaleString()}.`);

  const newDay = game.day + 1;
  const newCash = game.cash - TRAVEL_COST;

  // Apply daily interest on debt
  let newDebt = Math.round(game.debt * (1 + INTEREST_RATE));

  // Generate new prices at destination
  let newPrices = generatePrices(locationId);

  // Random event check
  let event = null;
  const roll = Math.random();
  let cumulative = 0;
  for (const e of EVENTS) {
    cumulative += e.chance;
    if (roll < cumulative) { event = e; break; }
  }

  let eventMsg = null;
  let eventDetail = null;
  const inv = game.inventoryObj;

  if (event) {
    eventMsg = event.msg;
    switch (event.effect) {
      case "lose_goods": {
        const items = Object.keys(inv);
        if (items.length > 0) {
          const loseItem = items[Math.floor(Math.random() * items.length)];
          const loseQty = Math.ceil(inv[loseItem] * (0.2 + Math.random() * 0.3));
          inv[loseItem] = Math.max(0, inv[loseItem] - loseQty);
          if (inv[loseItem] <= 0) delete inv[loseItem];
          const c = COMMODITIES.find(x => x.id === loseItem);
          eventDetail = `Lost ${loseQty} ${c?.name || loseItem}`;
        } else {
          eventMsg = "Bandits ambushed you but you had nothing to steal!";
        }
        break;
      }
      case "free_goods": {
        const freeItem = COMMODITIES[Math.floor(Math.random() * COMMODITIES.length)];
        const freeQty = Math.floor(2 + Math.random() * 5);
        const space = MAX_INVENTORY - getInventoryCount(inv);
        const actualQty = Math.min(freeQty, space);
        if (actualQty > 0) {
          inv[freeItem.id] = (inv[freeItem.id] || 0) + actualQty;
          eventDetail = `Found ${actualQty} ${freeItem.name}`;
        }
        break;
      }
      case "lose_cash": {
        const loseCash = Math.round(newCash * (0.1 + Math.random() * 0.15));
        eventDetail = `Lost $${loseCash.toLocaleString()}`;
        break;
      }
      case "gain_cash": {
        const gainCash = Math.round(500 + Math.random() * 1500);
        eventDetail = `Found $${gainCash.toLocaleString()}`;
        break;
      }
      case "lose_contraband": {
        if (inv.c4 > 0 || inv.rpg > 0) {
          const loseId = inv.c4 > 0 ? "c4" : "rpg";
          const loseQty = Math.ceil((inv[loseId] || 0) * 0.5);
          inv[loseId] = Math.max(0, (inv[loseId] || 0) - loseQty);
          if (inv[loseId] <= 0) delete inv[loseId];
          const c = COMMODITIES.find(x => x.id === loseId);
          eventDetail = `Confiscated ${loseQty} ${c?.name || loseId}`;
        } else {
          eventMsg = "Military checkpoint — they searched you but found nothing.";
        }
        break;
      }
      case "price_up":
      case "price_down":
      case "discount": {
        newPrices = generateEventPrices(newPrices, event.effect);
        const affected = COMMODITIES.find(c => newPrices[c.id] !== generatePrices(locationId)[c.id]);
        eventDetail = event.effect === "discount" ? "One item is dirt cheap right now!" : null;
        break;
      }
    }

    // Apply cash effects
    if (event.effect === "lose_cash") {
      const loseCash = Math.round(newCash * (0.1 + Math.random() * 0.15));
      // recalculate since we set eventDetail above
    }
    if (event.effect === "gain_cash") {
      const gainCash = Math.round(500 + Math.random() * 1500);
    }
  }

  // Properly apply cash events (fix the scoping above)
  if (event?.effect === "lose_cash") {
    const loss = parseInt((eventDetail || "0").replace(/[^0-9]/g, ""), 10) || 0;
    if (loss > 0) {
      const actualLoss = Math.min(loss, newCash);
      // Already computed in eventDetail, just apply
    }
  }

  // Simpler approach for cash events
  let cashDelta = 0;
  if (event) {
    if (event.effect === "lose_cash") {
      cashDelta = -Math.round(newCash * (0.1 + Math.random() * 0.15));
      eventDetail = `Lost $${Math.abs(cashDelta).toLocaleString()}`;
    } else if (event.effect === "gain_cash") {
      cashDelta = Math.round(500 + Math.random() * 1500);
      eventDetail = `Found $${cashDelta.toLocaleString()}`;
    }
  }
  const finalCash = Math.max(0, newCash + cashDelta);

  // Check if game over (max days)
  const gameOver = newDay > MAX_DAYS;

  const eventLogArr = game.eventLogArr;
  if (event) eventLogArr.push({ day: newDay, event: event.id, msg: eventMsg, detail: eventDetail });

  if (gameOver) {
    // Sell all inventory at current prices
    let goodsValue = 0;
    for (const [id, qty] of Object.entries(inv)) {
      goodsValue += (newPrices[id] || 0) * qty;
    }
    const totalNetWorth = finalCash + goodsValue - newDebt;
    const payout = Math.max(0, Math.floor(totalNetWorth / 10));

    db.prepare("UPDATE dealer_games SET day = ?, cash = ?, debt = ?, location = ?, inventory = ?, prices = ?, event_log = ?, payout = ?, status = 'finished', ended_at = datetime('now') WHERE id = ?")
      .run(newDay, finalCash, newDebt, locationId, JSON.stringify(inv), JSON.stringify(newPrices), JSON.stringify(eventLogArr), payout, gameId);

    db.prepare("INSERT INTO dealer_leaderboard (discord_id, username, profit, days_survived) VALUES (?, ?, ?, ?)")
      .run(game.discord_id, game.username, payout, newDay);

    return { gameOver: true, day: newDay, cash: finalCash, debt: newDebt, netWorth: totalNetWorth, goodsValue, payout, location: locationId, event: eventMsg, eventDetail, prices: newPrices, inventory: inv };
  }

  db.prepare("UPDATE dealer_games SET day = ?, cash = ?, debt = ?, location = ?, inventory = ?, prices = ?, event_log = ? WHERE id = ?")
    .run(newDay, finalCash, newDebt, locationId, JSON.stringify(inv), JSON.stringify(newPrices), JSON.stringify(eventLogArr), gameId);

  return { gameOver: false, day: newDay, cash: finalCash, debt: newDebt, location: locationId, event: eventMsg, eventDetail, prices: newPrices, inventory: inv };
}

function endGame(gameId, wastedCoins) {
  const game = getGameState(gameId);
  if (!game || game.status !== "active") throw new Error("No active game.");

  // Sell all inventory at current prices
  let goodsValue = 0;
  for (const [id, qty] of Object.entries(game.inventoryObj)) {
    goodsValue += (game.pricesObj[id] || 0) * qty;
  }
  const totalCash = game.cash + goodsValue;
  const netWorth = totalCash - game.debt;

  // Convert net worth to coin payout (ratio: $10 game dollars = 1 coin, minimum 0)
  const payout = Math.max(0, Math.floor(netWorth / 10));

  db.prepare("UPDATE dealer_games SET status = 'finished', payout = ?, ended_at = datetime('now') WHERE id = ?")
    .run(payout, gameId);

  db.prepare("INSERT INTO dealer_leaderboard (discord_id, username, profit, days_survived) VALUES (?, ?, ?, ?)")
    .run(game.discord_id, game.username, payout, game.day);

  if (payout > 0) {
    wastedCoins.addCoins(game.discord_id, payout, "dealer_payout", { username: game.username, bypassCap: true, meta: { game_id: gameId, net_worth: netWorth, days: game.day } });
  }

  return { payout, netWorth, goodsValue, cash: game.cash, debt: game.debt, days: game.day };
}

function getLeaderboard(limit = 10) {
  return db.prepare("SELECT * FROM dealer_leaderboard ORDER BY profit DESC LIMIT ?").all(limit);
}

function getStats(discordId) {
  const total = db.prepare("SELECT COUNT(*) as n FROM dealer_games WHERE discord_id = ?").get(String(discordId)).n;
  const best = db.prepare("SELECT MAX(payout) as n FROM dealer_games WHERE discord_id = ?").get(String(discordId)).n || 0;
  const totalPayout = db.prepare("SELECT COALESCE(SUM(payout), 0) as n FROM dealer_games WHERE discord_id = ?").get(String(discordId)).n;
  return { total, best, totalPayout, playsToday: playsToday(discordId), maxPlays: DAILY_PLAYS };
}

// ── Helpers for display ──

function formatPriceBoard(prices, inventory) {
  return COMMODITIES.map(c => {
    const price = prices[c.id] || 0;
    const owned = inventory[c.id] || 0;
    const trend = price > c.basePrice * 1.2 ? "📈" : price < c.basePrice * 0.8 ? "📉" : "";
    return `${c.emoji} **${c.name}** — $${price.toLocaleString()} ${trend}${owned > 0 ? ` (own: ${owned})` : ""}`;
  }).join("\n");
}

function formatInventory(inventory, prices) {
  const entries = Object.entries(inventory).filter(([, q]) => q > 0);
  if (entries.length === 0) return "Empty";
  return entries.map(([id, qty]) => {
    const c = COMMODITIES.find(x => x.id === id);
    const val = (prices[id] || 0) * qty;
    return `${c?.emoji || ""} ${c?.name || id}: ${qty} ($${val.toLocaleString()})`;
  }).join("\n");
}

function getLocation(id) {
  return LOCATIONS.find(l => l.id === id);
}

module.exports = {
  init, ENTRY_COST, STARTING_CASH, STARTING_DEBT, MAX_DAYS, MAX_INVENTORY,
  DAILY_PLAYS, TRAVEL_COST, INTEREST_RATE, LOCATIONS, COMMODITIES,
  startGame, getActiveGame, getGameState, getNetWorth,
  buy, sell, payDebt, travel, endGame,
  getLeaderboard, getStats, playsToday,
  formatPriceBoard, formatInventory, getLocation,
};
