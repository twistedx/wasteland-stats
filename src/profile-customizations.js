const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "profile-customizations.db");

const TYPES = ["background", "badge", "name_color"];

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price INTEGER NOT NULL,
      image TEXT DEFAULT NULL,
      css_value TEXT DEFAULT NULL,
      rarity TEXT NOT NULL DEFAULT 'common',
      stripe_product_id TEXT DEFAULT NULL,
      stripe_price_id TEXT DEFAULT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_unlocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      source TEXT DEFAULT 'purchase',
      stripe_session_id TEXT DEFAULT NULL,
      unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(discord_id, item_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_settings (
      discord_id TEXT PRIMARY KEY,
      background_id INTEGER DEFAULT NULL,
      name_color_id INTEGER DEFAULT NULL,
      badge_ids TEXT DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_unlocks_discord ON profile_unlocks (discord_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_items_type ON profile_items (type, active)");

  // Seed a few starter items if empty
  const count = db.prepare("SELECT COUNT(*) as cnt FROM profile_items").get().cnt;
  if (count === 0) seed();

  console.log(`ProfileCustomizations: ${db.prepare("SELECT COUNT(*) as cnt FROM profile_items").get().cnt} items, ${db.prepare("SELECT COUNT(*) as cnt FROM profile_unlocks").get().cnt} unlocks in database.`);
}

function seed() {
  const items = [
    { type: "background", name: "Wasteland Sunset", description: "Warm orange-to-purple gradient.", price: 499, css_value: "linear-gradient(135deg,#7c2d12 0%,#7e22ce 100%)", rarity: "common", sort_order: 1 },
    { type: "background", name: "Toxic Glow", description: "Acid-green radial glow.", price: 699, css_value: "radial-gradient(circle at 30% 30%,#22c55e 0%,#052e16 80%)", rarity: "rare", sort_order: 2 },
    { type: "background", name: "Blood Moon", description: "Deep red night sky.", price: 999, css_value: "linear-gradient(180deg,#000 0%,#7f1d1d 100%)", rarity: "epic", sort_order: 3 },
    { type: "name_color", name: "Crimson", description: "Bold red username.", price: 299, css_value: "#ef4444", rarity: "common", sort_order: 1 },
    { type: "name_color", name: "Cyber Cyan", description: "Electric cyan glow.", price: 299, css_value: "#22d3ee", rarity: "common", sort_order: 2 },
    { type: "name_color", name: "Royal Gold", description: "Premium gold.", price: 599, css_value: "#fbbf24", rarity: "rare", sort_order: 3 },
    { type: "badge", name: "Veteran", description: "Mark of a long-time player.", price: 399, css_value: "&#9876;&#65039;", rarity: "common", sort_order: 1 },
    { type: "badge", name: "Skull", description: "For the ruthless.", price: 399, css_value: "&#128128;", rarity: "common", sort_order: 2 },
    { type: "badge", name: "Specter", description: "Haunt your enemies from beyond.", price: 999, css_value: "&#128123;", rarity: "epic", sort_order: 3 },
  ];
  const stmt = db.prepare("INSERT INTO profile_items (type, name, description, price, css_value, rarity, sort_order) VALUES (@type, @name, @description, @price, @css_value, @rarity, @sort_order)");
  const tx = db.transaction(() => { for (const it of items) stmt.run(it); });
  tx();
}

// ── Catalog ──
function getCatalog(type) {
  if (type) {
    return db.prepare("SELECT * FROM profile_items WHERE active = 1 AND type = ? ORDER BY sort_order ASC, id ASC").all(type);
  }
  return db.prepare("SELECT * FROM profile_items WHERE active = 1 ORDER BY type, sort_order ASC, id ASC").all();
}

function getAllItems() {
  return db.prepare("SELECT * FROM profile_items ORDER BY type, sort_order ASC, id ASC").all();
}

function getItem(id) {
  return db.prepare("SELECT * FROM profile_items WHERE id = ?").get(id);
}

function createItem({ type, name, description, price, image, css_value, rarity, sort_order }) {
  return db.prepare("INSERT INTO profile_items (type, name, description, price, image, css_value, rarity, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(type, name, description || "", price, image || null, css_value || null, rarity || "common", sort_order || 0);
}

function updateItem(id, { type, name, description, price, image, css_value, rarity, active, sort_order }) {
  return db.prepare("UPDATE profile_items SET type = ?, name = ?, description = ?, price = ?, image = ?, css_value = ?, rarity = ?, active = ?, sort_order = ? WHERE id = ?")
    .run(type, name, description || "", price, image || null, css_value || null, rarity || "common", active ?? 1, sort_order || 0, id);
}

function deleteItem(id) {
  return db.prepare("DELETE FROM profile_items WHERE id = ?").run(id);
}

function setStripeIds(id, stripeProductId, stripePriceId) {
  return db.prepare("UPDATE profile_items SET stripe_product_id = ?, stripe_price_id = ? WHERE id = ?").run(stripeProductId, stripePriceId, id);
}

// ── Unlocks ──
function unlock(discordId, itemId, { source = "purchase", stripe_session_id = null } = {}) {
  if (!discordId || !itemId) return null;
  try {
    return db.prepare("INSERT INTO profile_unlocks (discord_id, item_id, source, stripe_session_id) VALUES (?, ?, ?, ?)")
      .run(String(discordId), itemId, source, stripe_session_id);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return { changes: 0 };
    throw e;
  }
}

function getUnlocks(discordId) {
  if (!discordId) return [];
  return db.prepare(`
    SELECT i.*, u.unlocked_at, u.source
    FROM profile_unlocks u
    JOIN profile_items i ON i.id = u.item_id
    WHERE u.discord_id = ?
    ORDER BY i.type, i.sort_order ASC
  `).all(String(discordId));
}

function ownsItem(discordId, itemId) {
  if (!discordId || !itemId) return false;
  const row = db.prepare("SELECT 1 FROM profile_unlocks WHERE discord_id = ? AND item_id = ?").get(String(discordId), itemId);
  return !!row;
}

// ── Equipped settings ──
function getSettings(discordId) {
  if (!discordId) return null;
  let row = db.prepare("SELECT * FROM profile_settings WHERE discord_id = ?").get(String(discordId));
  if (!row) {
    db.prepare("INSERT INTO profile_settings (discord_id) VALUES (?)").run(String(discordId));
    row = db.prepare("SELECT * FROM profile_settings WHERE discord_id = ?").get(String(discordId));
  }
  let badges = [];
  try { badges = JSON.parse(row.badge_ids || "[]"); } catch {}
  return { ...row, badge_ids: badges };
}

// Returns { background, name_color, badges: [items] } resolved against catalog
function getEquipped(discordId) {
  const settings = getSettings(discordId);
  if (!settings) return { background: null, name_color: null, badges: [] };
  const background = settings.background_id ? getItem(settings.background_id) : null;
  const name_color = settings.name_color_id ? getItem(settings.name_color_id) : null;
  const badges = (settings.badge_ids || []).map(id => getItem(id)).filter(Boolean);
  return { background, name_color, badges };
}

function equip(discordId, type, itemId) {
  if (!discordId) throw new Error("discord_id required");
  if (!TYPES.includes(type)) throw new Error("invalid type");
  // Verify ownership unless clearing (itemId null)
  if (itemId && !ownsItem(discordId, itemId)) throw new Error("not unlocked");
  // Verify item type matches
  if (itemId) {
    const item = getItem(itemId);
    if (!item || item.type !== type) throw new Error("type mismatch");
  }
  // Ensure row exists
  getSettings(discordId);

  if (type === "background") {
    db.prepare("UPDATE profile_settings SET background_id = ?, updated_at = datetime('now') WHERE discord_id = ?").run(itemId || null, String(discordId));
  } else if (type === "name_color") {
    db.prepare("UPDATE profile_settings SET name_color_id = ?, updated_at = datetime('now') WHERE discord_id = ?").run(itemId || null, String(discordId));
  } else if (type === "badge") {
    // Toggle the badge in the JSON array (max 3)
    const cur = getSettings(discordId).badge_ids;
    let next;
    if (cur.includes(itemId)) {
      next = cur.filter(x => x !== itemId);
    } else {
      next = [...cur, itemId].slice(-3);
    }
    db.prepare("UPDATE profile_settings SET badge_ids = ?, updated_at = datetime('now') WHERE discord_id = ?").run(JSON.stringify(next), String(discordId));
  }
  return getEquipped(discordId);
}

// ── Stripe sync ──
async function syncToStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { synced: 0, errors: ["Stripe not configured"] };
  }
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  const items = getAllItems();
  let synced = 0;
  const errors = [];

  for (const item of items) {
    try {
      let stripeProductId = item.stripe_product_id;
      const productPayload = {
        name: `Profile: ${item.name}`,
        description: item.description || undefined,
        active: !!item.active,
        metadata: { profile_item_id: String(item.id), type: item.type, rarity: item.rarity },
      };

      if (!stripeProductId) {
        const sp = await stripe.products.create(productPayload);
        stripeProductId = sp.id;
      } else {
        await stripe.products.update(stripeProductId, productPayload);
      }

      let stripePriceId = item.stripe_price_id;
      let needsNewPrice = !stripePriceId;
      if (stripePriceId) {
        try {
          const existing = await stripe.prices.retrieve(stripePriceId);
          if (existing.unit_amount !== item.price) {
            await stripe.prices.update(stripePriceId, { active: false });
            needsNewPrice = true;
          }
        } catch {
          needsNewPrice = true;
        }
      }

      if (needsNewPrice) {
        const price = await stripe.prices.create({
          product: stripeProductId,
          unit_amount: item.price,
          currency: "usd",
        });
        stripePriceId = price.id;
      }

      setStripeIds(item.id, stripeProductId, stripePriceId);
      synced++;
    } catch (err) {
      errors.push({ item: item.name, error: err.message });
    }
  }

  return { synced, total: items.length, errors };
}

module.exports = {
  init, TYPES,
  getCatalog, getAllItems, getItem, createItem, updateItem, deleteItem, setStripeIds,
  unlock, getUnlocks, ownsItem,
  getSettings, getEquipped, equip,
  syncToStripe,
};
