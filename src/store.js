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
    { name: "The Sheen Out", description: "Clean casual look with cargo shorts and a fresh white tee.", price: 1999, image: "/img/store/charliesheen 1.png", category: "loadout", badge: "new", sort_order: 1 },
    { name: "The Cowboy", description: "Saddle up with a classic western hat and rugged denim.", price: 2499, image: "/img/store/cowboy.png", category: "loadout", badge: "new", sort_order: 2 },
    { name: "The LumberJack", description: "Flannel and denim — built for chopping wood and enemies.", price: 2499, image: "/img/store/lumberjack 1.png", category: "loadout", badge: "new", sort_order: 3 },
    { name: "The Corsair", description: "Pirate-inspired loadout with a tricorn hat and leather boots.", price: 2999, image: "/img/store/pirate 1.png", category: "loadout", badge: "new", sort_order: 4 },
    { name: "The Burglar", description: "Dark hoodie and tactical pants — move unseen in the shadows.", price: 2999, image: "/img/store/burgler 1.png", category: "loadout", badge: "new", sort_order: 5 },
    { name: "The Prepper", description: "Survival-ready gear with a cap and earth-tone fatigues.", price: 2999, image: "/img/store/prepper 1.png", category: "loadout", badge: "new", sort_order: 6 },
    { name: "The Slav Specter", description: "Full camo loadout for blending into the wilderness.", price: 2999, image: "/img/store/theslav 1.png", category: "loadout", badge: "new", sort_order: 7 },
    { name: "The Packer", description: "Green tactical jacket and cargo pants — ready for anything.", price: 2999, image: "/img/store/thepacker 1.png", category: "loadout", badge: "new", sort_order: 8 },
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

// ── Purchases ──
function recordPurchase({ stripe_session_id, product_name, quantity, amount }) {
  return db.prepare(`
    INSERT INTO store_purchases (stripe_session_id, product_name, quantity, amount)
    VALUES (?, ?, ?, ?)
  `).run(stripe_session_id || null, product_name, quantity || 1, amount);
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

  // Top selling products
  const topProducts = db.prepare(`
    SELECT product_name, SUM(quantity) as sold, SUM(amount) as revenue
    FROM store_purchases WHERE status = 'completed'
    GROUP BY product_name ORDER BY revenue DESC LIMIT 10
  `).all();

  // Unique sessions (proxy for unique buyers without PII)
  const uniqueBuyers = db.prepare("SELECT COUNT(DISTINCT stripe_session_id) as cnt FROM store_purchases WHERE status = 'completed' AND stripe_session_id IS NOT NULL").get().cnt;
  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

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

  // Recent purchases (no PII, just product/amount/time)
  const recentPurchases = db.prepare(`
    SELECT product_name, quantity, amount, created_at FROM store_purchases WHERE status = 'completed'
    ORDER BY created_at DESC LIMIT 15
  `).all();

  // Format cents to dollars for display
  const fmt = (cents) => (cents / 100).toFixed(2);

  return {
    totalRevenue: fmt(totalRevenue), totalOrders,
    todayRevenue: fmt(todayRevenue), todayOrders,
    weekRevenue: fmt(weekRevenue), weekOrders,
    monthRevenue: fmt(monthRevenue), monthOrders,
    uniqueBuyers, avgOrderValue: fmt(avgOrderValue),
    topProducts: topProducts.map(p => ({ ...p, revenue: fmt(p.revenue) })),
    dailyRevenue: dailyRevenue.map(d => ({ ...d, revenue: d.revenue / 100 })),
    recentPurchases: recentPurchases.map(p => ({ ...p, amount: fmt(p.amount) })),
  };
}

module.exports = {
  init, getActiveProducts, getAllProducts, getProductById, createProduct, updateProduct, deleteProduct, getEffectivePrice,
  getAllCategories, getCategoryBySlug, getCategoryById, createCategory, updateCategory, deleteCategory, getCategoriesWithProducts,
  recordPurchase, getStoreStats,
};
