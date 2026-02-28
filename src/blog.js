const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "blog.db");

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      author TEXT NOT NULL,
      authorId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      published INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Migrate from old JSON file if it exists and DB is empty
  const count = db.prepare("SELECT COUNT(*) AS c FROM posts").get().c;
  const oldFile = path.join(__dirname, "..", "data", "blog.json");
  if (count === 0 && fs.existsSync(oldFile)) {
    try {
      const raw = fs.readFileSync(oldFile, "utf-8");
      const parsed = JSON.parse(raw);
      const oldPosts = Array.isArray(parsed.posts) ? parsed.posts : [];
      const insert = db.prepare(`
        INSERT OR IGNORE INTO posts (id, title, slug, description, content, tags, author, authorId, createdAt, updatedAt, published)
        VALUES (@id, @title, @slug, @description, @content, @tags, @author, @authorId, @createdAt, @updatedAt, @published)
      `);
      const migrate = db.transaction((posts) => {
        for (const p of posts) {
          insert.run({
            id: p.id,
            title: p.title,
            slug: p.slug,
            description: p.description || "",
            content: p.content,
            tags: JSON.stringify(p.tags || []),
            author: p.author,
            authorId: p.authorId,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            published: p.published ? 1 : 0,
          });
        }
      });
      migrate(oldPosts);
      console.log(`Blog: migrated ${oldPosts.length} posts from JSON to SQLite.`);
    } catch (err) {
      console.error("Blog: migration from JSON failed", err.message);
    }
  }

  const total = db.prepare("SELECT COUNT(*) AS c FROM posts").get().c;
  console.log(`Blog: ${total} posts in database (${DB_FILE}).`);
}

function generateSlug(title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

function rowToPost(row) {
  if (!row) return null;
  return {
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    published: !!row.published,
  };
}

function getPosts(publishedOnly) {
  const sql = publishedOnly
    ? "SELECT * FROM posts WHERE published = 1 ORDER BY createdAt DESC"
    : "SELECT * FROM posts ORDER BY createdAt DESC";
  return db.prepare(sql).all().map(rowToPost);
}

function getPost(slug) {
  const row = db.prepare("SELECT * FROM posts WHERE slug = ?").get(slug);
  return rowToPost(row);
}

function getPostById(id) {
  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
  return rowToPost(row);
}

function parseTags(raw) {
  if (!raw) return [];
  return raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
}

function createPost({ title, description, content, tags, author, authorId, published }) {
  const post = {
    id: crypto.randomBytes(8).toString("hex"),
    title,
    slug: generateSlug(title),
    description: description || "",
    content,
    tags: JSON.stringify(parseTags(tags)),
    author,
    authorId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    published: published ? 1 : 0,
  };

  db.prepare(`
    INSERT INTO posts (id, title, slug, description, content, tags, author, authorId, createdAt, updatedAt, published)
    VALUES (@id, @title, @slug, @description, @content, @tags, @author, @authorId, @createdAt, @updatedAt, @published)
  `).run(post);

  return rowToPost(post);
}

function updatePost(id, { title, description, content, tags, published }) {
  const existing = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
  if (!existing) return null;

  const updates = { updatedAt: Date.now() };

  if (title && title !== existing.title) {
    updates.title = title;
    updates.slug = generateSlug(title);
  }
  if (description !== undefined) updates.description = description;
  if (content !== undefined) updates.content = content;
  if (tags !== undefined) updates.tags = JSON.stringify(parseTags(tags));
  if (published !== undefined) updates.published = published ? 1 : 0;

  const setClauses = Object.keys(updates).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE posts SET ${setClauses} WHERE id = @id`).run({ id, ...updates });

  return getPostById(id);
}

function deletePost(id) {
  const result = db.prepare("DELETE FROM posts WHERE id = ?").run(id);
  return result.changes > 0;
}

function getAllTags() {
  const rows = db.prepare("SELECT tags FROM posts WHERE published = 1").all();
  const tagSet = new Set();
  for (const row of rows) {
    const tags = JSON.parse(row.tags || "[]");
    tags.forEach((t) => tagSet.add(t));
  }
  return Array.from(tagSet).sort();
}

function getPostsByTag(tag) {
  const allPublished = db.prepare("SELECT * FROM posts WHERE published = 1 ORDER BY createdAt DESC").all();
  const needle = tag.toLowerCase();
  return allPublished
    .filter((row) => {
      const tags = JSON.parse(row.tags || "[]");
      return tags.includes(needle);
    })
    .map(rowToPost);
}

module.exports = { init, getPosts, getPost, getPostById, createPost, updatePost, deletePost, getAllTags, getPostsByTag };
