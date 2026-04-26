const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "store.db");

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS store_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price INTEGER NOT NULL,
      sale_price INTEGER DEFAULT NULL,
      image TEXT DEFAULT NULL,
      category TEXT NOT NULL DEFAULT 'loadout',
      active INTEGER NOT NULL DEFAULT 1,
      badge TEXT DEFAULT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Add Stripe columns if they don't exist (migration-safe)
  try { db.exec("ALTER TABLE store_products ADD COLUMN stripe_product_id TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE store_products ADD COLUMN stripe_price_id TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE store_products ADD COLUMN game_item_name TEXT DEFAULT NULL"); } catch {}

  // Backfill game_item_name for existing loadout products
  const GAME_NAME_MAP = {
    "The Sheen Out": "🌴 Wasteland Loadout Drop — The Sheen Out",
    "The Cowboy": "🤠 Wasteland Loadout Drop — The Cowboy",
    "The LumberJack": "🪓 Wasteland Loadout Drop — TheLumberJack",
    "The Corsair": "🏴‍☠️ Wasteland Loadout Drop — The Corsair",
    "The Burglar": "🔑 Wasteland Loadout Drop — The Burglar",
    "The Prepper": "🔫 Wasteland Loadout Drop — The Prepper",
    "The Slav Specter": "👻 Wasteland Loadout Drop — The Slav Specter",
    "The Packer": "🎒 Wasteland Loadout Drop — The Packer",
  };
  const backfillStmt = db.prepare("UPDATE store_products SET game_item_name = ? WHERE name = ? AND game_item_name IS NULL");
  for (const [storeName, gameName] of Object.entries(GAME_NAME_MAP)) {
    backfillStmt.run(gameName, storeName);
  }

  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_store_products_name ON store_products (name)"); } catch {}

  db.exec(`CREATE INDEX IF NOT EXISTS idx_store_category ON store_products (category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_store_active ON store_products (active)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS store_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_session_id TEXT,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_purchases_ts ON store_purchases (created_at)`);

  // Add discord user columns to existing databases
  try { db.exec(`ALTER TABLE store_purchases ADD COLUMN discord_id TEXT DEFAULT NULL`); } catch (e) { /* exists */ }
  try { db.exec(`ALTER TABLE store_purchases ADD COLUMN discord_username TEXT DEFAULT NULL`); } catch (e) { /* exists */ }

  // Prestige system — tracks players who reset their tier for prestige tiers
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_prestige (
      discord_id TEXT PRIMARY KEY,
      prestige_level INTEGER NOT NULL DEFAULT 0,
      total_spent_at_prestige INTEGER NOT NULL DEFAULT 0,
      prestiged_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS store_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Seed default categories if empty
  const catCount = db.prepare("SELECT COUNT(*) as cnt FROM store_categories").get().cnt;
  if (catCount === 0) {
    const catStmt = db.prepare("INSERT INTO store_categories (slug, label, description, sort_order) VALUES (?, ?, ?, ?)");
    catStmt.run("loadout", "Wasteland Loadout Skins", "Browse items and add them to your cart. When you're ready, checkout securely via Stripe.", 1);
    catStmt.run("supporter", "Support the Community", "One-time supporter tiers — help keep the servers running and earn exclusive perks.", 2);
  }

  // Seed default products if table is empty
  const count = db.prepare("SELECT COUNT(*) as cnt FROM store_products").get().cnt;
  if (count === 0) {
    seed();
  }

  console.log(`Store: ${db.prepare("SELECT COUNT(*) as cnt FROM store_products").get().cnt} products, ${db.prepare("SELECT COUNT(*) as cnt FROM store_categories").get().cnt} categories in database.`);
}

function seed() {
  const products = [
    { name: "The Sheen Out", description: "Clean casual look with cargo shorts and a fresh white tee.", price: 1999, image: "/img/store/charliesheen 1.png", category: "loadout", badge: "new", sort_order: 1, game_item_name: "🌴 Wasteland Loadout Drop — The Sheen Out" },
    { name: "The Cowboy", description: "Saddle up with a classic western hat and rugged denim.", price: 2499, image: "/img/store/cowboy.png", category: "loadout", badge: "new", sort_order: 2, game_item_name: "🤠 Wasteland Loadout Drop — The Cowboy" },
    { name: "The LumberJack", description: "Flannel and denim — built for chopping wood and enemies.", price: 2499, image: "/img/store/lumberjack 1.png", category: "loadout", badge: "new", sort_order: 3, game_item_name: "🪓 Wasteland Loadout Drop — TheLumberJack" },
    { name: "The Corsair", description: "Pirate-inspired loadout with a tricorn hat and leather boots.", price: 2999, image: "/img/store/pirate 1.png", category: "loadout", badge: "new", sort_order: 4, game_item_name: "🏴‍☠️ Wasteland Loadout Drop — The Corsair" },
    { name: "The Burglar", description: "Dark hoodie and tactical pants — move unseen in the shadows.", price: 2999, image: "/img/store/burgler 1.png", category: "loadout", badge: "new", sort_order: 5, game_item_name: "🔑 Wasteland Loadout Drop — The Burglar" },
    { name: "The Prepper", description: "Survival-ready gear with a cap and earth-tone fatigues.", price: 2999, image: "/img/store/prepper 1.png", category: "loadout", badge: "new", sort_order: 6, game_item_name: "🔫 Wasteland Loadout Drop — The Prepper" },
    { name: "The Slav Specter", description: "Full camo loadout for blending into the wilderness.", price: 2999, image: "/img/store/theslav 1.png", category: "loadout", badge: "new", sort_order: 7, game_item_name: "👻 Wasteland Loadout Drop — The Slav Specter" },
    { name: "The Packer", description: "Green tactical jacket and cargo pants — ready for anything.", price: 2999, image: "/img/store/thepacker 1.png", category: "loadout", badge: "new", sort_order: 8, game_item_name: "🎒 Wasteland Loadout Drop — The Packer" },
    { name: "Wanderer", description: "Start your journey — entry-level supporter tier with exclusive perks.", price: 2500, image: "/img/store/wanderer.png", category: "supporter", sort_order: 1 },
    { name: "Scout", description: "Survival tier — elevated supporter status with bonus rewards.", price: 5000, image: "/img/store/scout.png", category: "supporter", sort_order: 2 },
    { name: "Ranger", description: "Elite tier — serious commitment with premium community benefits.", price: 10000, image: "/img/store/ranger.png", category: "supporter", sort_order: 3 },
    { name: "Wasteland Hero", description: "Hero tier — top-level support with exclusive in-game recognition.", price: 25000, image: "/img/store/hero.png", category: "supporter", sort_order: 4 },
    { name: "Legendary Wastelander", description: "Ultimate supporter — the highest honor with all perks unlocked.", price: 47500, image: "/img/store/legendary.png", category: "supporter", sort_order: 5 },
    { name: "Warlord", description: "Warlord tier — command respect with top-tier recognition and rewards.", price: 65000, image: "/img/store/warlord.png", category: "supporter", sort_order: 6 },
    { name: "Overlord", description: "Overlord tier — dominate the wasteland with unmatched supporter status.", price: 85000, image: "/img/store/overlord.png", category: "supporter", sort_order: 7 },
    { name: "Immortal", description: "Immortal tier — the pinnacle of support. Your legacy lives forever.", price: 100000, image: "/img/store/immortal.png", category: "supporter", sort_order: 8 },
  ];

  const stmt = db.prepare(`
    INSERT INTO store_products (name, description, price, image, category, badge, sort_order)
    VALUES (@name, @description, @price, @image, @category, @badge, @sort_order)
  `);

  const tx = db.transaction(() => {
    for (const p of products) {
      stmt.run({ ...p, badge: p.badge || null });
    }
  });
  tx();
}

function getActiveProducts(category) {
  if (category) {
    return db.prepare("SELECT * FROM store_products WHERE active = 1 AND category = ? ORDER BY sort_order ASC").all(category);
  }
  return db.prepare("SELECT * FROM store_products WHERE active = 1 ORDER BY category, sort_order ASC").all();
}

function getAllProducts() {
  return db.prepare("SELECT * FROM store_products ORDER BY category, sort_order ASC").all();
}

function getProductById(id) {
  return db.prepare("SELECT * FROM store_products WHERE id = ?").get(id);
}

function createProduct({ name, description, price, sale_price, image, category, badge, sort_order }) {
  return db.prepare(`
    INSERT INTO store_products (name, description, price, sale_price, image, category, badge, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, description || "", price, sale_price || null, image || null, category || "loadout", badge || null, sort_order || 0);
}

function updateProduct(id, { name, description, price, sale_price, image, category, active, badge, sort_order }) {
  return db.prepare(`
    UPDATE store_products SET
      name = ?, description = ?, price = ?, sale_price = ?, image = ?,
      category = ?, active = ?, badge = ?, sort_order = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(name, description || "", price, sale_price || null, image || null, category, active, badge || null, sort_order || 0, id);
}

function deleteProduct(id) {
  return db.prepare("DELETE FROM store_products WHERE id = ?").run(id);
}

// Get the effective price (sale_price if set, otherwise price) — used for Stripe checkout
function getEffectivePrice(product) {
  return product.sale_price && product.sale_price > 0 ? product.sale_price : product.price;
}

// ── Categories ──
function getAllCategories() {
  return db.prepare("SELECT * FROM store_categories ORDER BY sort_order ASC").all();
}

function getCategoryBySlug(slug) {
  return db.prepare("SELECT * FROM store_categories WHERE slug = ?").get(slug);
}

function createCategory({ slug, label, description, sort_order }) {
  return db.prepare("INSERT INTO store_categories (slug, label, description, sort_order) VALUES (?, ?, ?, ?)").run(
    slug, label, description || "", sort_order || 0
  );
}

function updateCategory(id, { slug, label, description, sort_order }) {
  return db.prepare("UPDATE store_categories SET slug = ?, label = ?, description = ?, sort_order = ? WHERE id = ?").run(
    slug, label, description || "", sort_order || 0, id
  );
}

function deleteCategory(id) {
  return db.prepare("DELETE FROM store_categories WHERE id = ?").run(id);
}

function getCategoryById(id) {
  return db.prepare("SELECT * FROM store_categories WHERE id = ?").get(id);
}

// Get categories with their active products
function getCategoriesWithProducts() {
  const categories = getAllCategories();
  return categories.map(cat => ({
    ...cat,
    products: getActiveProducts(cat.slug),
  })).filter(cat => cat.products.length > 0);
}

// ── Production Sync (upsert) ──
function upsertSyncData({ products, categories }) {
  const summary = { products: { inserted: 0, updated: 0 }, categories: { inserted: 0, updated: 0 } };

  const tx = db.transaction(() => {
    if (categories && Array.isArray(categories)) {
      for (const c of categories) {
        const existing = db.prepare("SELECT id FROM store_categories WHERE slug = ?").get(c.slug);
        if (existing) {
          db.prepare("UPDATE store_categories SET label = ?, description = ?, sort_order = ? WHERE slug = ?")
            .run(c.label, c.description || "", c.sort_order || 0, c.slug);
          summary.categories.updated++;
        } else {
          db.prepare("INSERT INTO store_categories (slug, label, description, sort_order) VALUES (?, ?, ?, ?)")
            .run(c.slug, c.label, c.description || "", c.sort_order || 0);
          summary.categories.inserted++;
        }
      }
    }

    if (products && Array.isArray(products)) {
      for (const p of products) {
        const existing = db.prepare("SELECT id FROM store_products WHERE name = ?").get(p.name);
        if (existing) {
          db.prepare(`UPDATE store_products SET description = ?, price = ?, sale_price = ?, image = ?,
            category = ?, active = ?, badge = ?, sort_order = ?, updated_at = datetime('now') WHERE name = ?`)
            .run(p.description || "", p.price, p.sale_price || null, p.image || null,
              p.category || "loadout", p.active ?? 1, p.badge || null, p.sort_order || 0, p.name);
          summary.products.updated++;
        } else {
          db.prepare(`INSERT INTO store_products (name, description, price, sale_price, image, category, active, badge, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(p.name, p.description || "", p.price, p.sale_price || null, p.image || null,
              p.category || "loadout", p.active ?? 1, p.badge || null, p.sort_order || 0);
          summary.products.inserted++;
        }
      }
    }
  });

  tx();
  return summary;
}

// ── Stripe Sync ──
async function syncToStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.log("Store: Stripe not configured, skipping sync.");
    return { synced: 0, errors: [] };
  }
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  const products = getAllProducts();
  let synced = 0;
  const errors = [];

  for (const product of products) {
    try {
      let stripeProductId = product.stripe_product_id;

      // Create or update the Stripe product
      if (!stripeProductId) {
        const sp = await stripe.products.create({
          name: product.name,
          description: product.description || undefined,
          metadata: { store_id: String(product.id), category: product.category },
        });
        stripeProductId = sp.id;
        console.log(`Store: created Stripe product ${sp.id} for "${product.name}"`);
      } else {
        await stripe.products.update(stripeProductId, {
          name: product.name,
          description: product.description || undefined,
          active: !!product.active,
          metadata: { store_id: String(product.id), category: product.category },
        });
      }

      // Create a new price (Stripe prices are immutable — always create new on change)
      const effectivePrice = getEffectivePrice(product);
      let needsNewPrice = !product.stripe_price_id;

      if (product.stripe_price_id) {
        // Check if existing price matches
        try {
          const existingPrice = await stripe.prices.retrieve(product.stripe_price_id);
          if (existingPrice.unit_amount !== effectivePrice) {
            // Deactivate old price
            await stripe.prices.update(product.stripe_price_id, { active: false });
            needsNewPrice = true;
          }
        } catch {
          needsNewPrice = true;
        }
      }

      let stripePriceId = product.stripe_price_id;
      if (needsNewPrice) {
        const priceParams = {
          product: stripeProductId,
          unit_amount: effectivePrice,
          currency: "usd",
        };
        if (product.category === "subscriptions") {
          priceParams.recurring = { interval: "month" };
        }
        const price = await stripe.prices.create(priceParams);
        stripePriceId = price.id;
        console.log(`Store: created Stripe price ${price.id} ($${(effectivePrice / 100).toFixed(2)}) for "${product.name}"`);
      }

      // Save IDs back to DB
      db.prepare("UPDATE store_products SET stripe_product_id = ?, stripe_price_id = ? WHERE id = ?")
        .run(stripeProductId, stripePriceId, product.id);
      synced++;
    } catch (err) {
      console.error(`Store: Stripe sync error for "${product.name}":`, err.message);
      errors.push({ product: product.name, error: err.message });
    }
  }

  console.log(`Store: synced ${synced}/${products.length} products to Stripe.`);
  return { synced, total: products.length, errors };
}

// ── Purchases ──
function recordPurchase({ stripe_session_id, product_name, quantity, amount, discord_id, discord_username }) {
  return db.prepare(`
    INSERT INTO store_purchases (stripe_session_id, product_name, quantity, amount, discord_id, discord_username)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(stripe_session_id || null, product_name, quantity || 1, amount, discord_id || null, discord_username || null);
}

function getStoreStats() {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStr = todayStart.toISOString().replace("T", " ").slice(0, 19);
  const weekStr = new Date(now - 7 * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const monthStr = new Date(now - 30 * 86400000).toISOString().replace("T", " ").slice(0, 19);

  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM store_purchases WHERE status = 'completed'").get().total;
  const totalOrders = db.prepare("SELECT COUNT(*) as cnt FROM store_purchases WHERE status = 'completed'").get().cnt;
  const todayRevenue = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM store_purchases WHERE status = 'completed' AND created_at >= ?").get(todayStr).total;
  const todayOrders = db.prepare("SELECT COUNT(*) as cnt FROM store_purchases WHERE status = 'completed' AND created_at >= ?").get(todayStr).cnt;
  const weekRevenue = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM store_purchases WHERE status = 'completed' AND created_at >= ?").get(weekStr).total;
  const weekOrders = db.prepare("SELECT COUNT(*) as cnt FROM store_purchases WHERE status = 'completed' AND created_at >= ?").get(weekStr).cnt;
  const monthRevenue = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM store_purchases WHERE status = 'completed' AND created_at >= ?").get(monthStr).total;
  const monthOrders = db.prepare("SELECT COUNT(*) as cnt FROM store_purchases WHERE status = 'completed' AND created_at >= ?").get(monthStr).cnt;
  // Year-to-date — Jan 1 of current year (UTC) through now
  const ytdStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const ytdStr = ytdStart.toISOString().replace("T", " ").slice(0, 19);
  const ytdRevenue = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM store_purchases WHERE status = 'completed' AND created_at >= ?").get(ytdStr).total;
  const ytdOrders = db.prepare("SELECT COUNT(*) as cnt FROM store_purchases WHERE status = 'completed' AND created_at >= ?").get(ytdStr).cnt;

  // Top selling products
  const topProducts = db.prepare(`
    SELECT product_name, SUM(quantity) as sold, SUM(amount) as revenue
    FROM store_purchases WHERE status = 'completed'
    GROUP BY product_name ORDER BY revenue DESC LIMIT 10
  `).all();

  // Unique sessions (proxy for unique buyers without PII)
  const uniqueBuyers = db.prepare("SELECT COUNT(DISTINCT stripe_session_id) as cnt FROM store_purchases WHERE status = 'completed' AND stripe_session_id IS NOT NULL").get().cnt;
  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

  // Average daily income — total revenue / days since first sale (rounded up to at least 1)
  const firstSaleRow = db.prepare("SELECT MIN(created_at) as first_at FROM store_purchases WHERE status = 'completed'").get();
  let daysActive = 1;
  if (firstSaleRow?.first_at) {
    const firstMs = new Date(firstSaleRow.first_at + "Z").getTime();
    const ms = Date.now() - firstMs;
    daysActive = Math.max(1, Math.ceil(ms / 86400000));
  }
  const avgDailyIncome = totalRevenue > 0 ? Math.round(totalRevenue / daysActive) : 0;

  // Daily revenue for last 30 days
  const dailyRevenue = [];
  for (let i = 29; i >= 0; i--) {
    const dayStart = new Date(now - i * 86400000);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const dayStartStr = dayStart.toISOString().replace("T", " ").slice(0, 19);
    const dayEndStr = dayEnd.toISOString().replace("T", " ").slice(0, 19);
    const row = db.prepare("SELECT COALESCE(SUM(amount), 0) as revenue, COUNT(*) as orders FROM store_purchases WHERE status = 'completed' AND created_at >= ? AND created_at < ?").get(dayStartStr, dayEndStr);
    dailyRevenue.push({
      date: dayStart.toISOString().slice(0, 10),
      revenue: row.revenue,
      orders: row.orders,
    });
  }

  const recentPurchases = db.prepare(`
    SELECT product_name, quantity, amount, discord_username, discord_id, created_at FROM store_purchases WHERE status = 'completed'
    ORDER BY created_at DESC LIMIT 15
  `).all();

  // Format cents to dollars for display
  const fmt = (cents) => (cents / 100).toFixed(2);

  return {
    totalRevenue: fmt(totalRevenue), totalOrders,
    todayRevenue: fmt(todayRevenue), todayOrders,
    weekRevenue: fmt(weekRevenue), weekOrders,
    monthRevenue: fmt(monthRevenue), monthOrders,
    ytdRevenue: fmt(ytdRevenue), ytdOrders,
    uniqueBuyers, avgOrderValue: fmt(avgOrderValue),
    avgDailyIncome: fmt(avgDailyIncome), daysActive,
    topProducts: topProducts.map(p => ({ ...p, revenue: fmt(p.revenue) })),
    dailyRevenue: dailyRevenue.map(d => ({ ...d, revenue: d.revenue / 100 })),
    recentPurchases: recentPurchases.map(p => ({ ...p, amount: fmt(p.amount) })),
  };
}

function updatePurchaseStatus(stripeSessionId, status) {
  if (!db) return;
  db.prepare("UPDATE store_purchases SET status = ? WHERE stripe_session_id = ?").run(status, stripeSessionId);
}

function getPurchasesByDiscordId(discordId) {
  if (!db) return [];
  return db.prepare("SELECT product_name, quantity, amount, created_at FROM store_purchases WHERE discord_id = ? AND status = 'completed' ORDER BY created_at DESC").all(discordId);
}

function getTotalSpentByDiscordId(discordId) {
  if (!db) return 0;
  const row = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM store_purchases WHERE discord_id = ? AND status = 'completed'").get(discordId);
  return row.total;
}

function getPrestige(discordId) {
  if (!db) return null;
  return db.prepare("SELECT * FROM store_prestige WHERE discord_id = ?").get(discordId) || null;
}

function activatePrestige(discordId, totalSpentAtPrestige) {
  if (!db) return;
  const existing = getPrestige(discordId);
  if (existing) {
    db.prepare("UPDATE store_prestige SET prestige_level = prestige_level + 1, total_spent_at_prestige = ?, prestiged_at = datetime('now') WHERE discord_id = ?")
      .run(totalSpentAtPrestige, discordId);
  } else {
    db.prepare("INSERT INTO store_prestige (discord_id, prestige_level, total_spent_at_prestige) VALUES (?, 1, ?)")
      .run(discordId, totalSpentAtPrestige);
  }
}

module.exports = {
  init, getActiveProducts, getAllProducts, getProductById, createProduct, updateProduct, deleteProduct, getEffectivePrice, updatePurchaseStatus,
  getAllCategories, getCategoryBySlug, getCategoryById, createCategory, updateCategory, deleteCategory, getCategoriesWithProducts,
  recordPurchase, getStoreStats, syncToStripe, upsertSyncData, getPurchasesByDiscordId, getTotalSpentByDiscordId,
  getPrestige, activatePrestige,
};
