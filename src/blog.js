const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "blog.json");
const WRITE_INTERVAL = 30_000;

let posts = [];
let dirty = false;
let flushTimer = null;

function init() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      posts = Array.isArray(parsed.posts) ? parsed.posts : [];
    } catch (err) {
      console.error("Blog: failed to load data file, starting fresh.", err.message);
      posts = [];
    }
  }

  flushTimer = setInterval(() => {
    if (dirty) flush();
  }, WRITE_INTERVAL);

  const shutdown = () => {
    if (dirty) flush();
    if (flushTimer) clearInterval(flushTimer);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Blog: loaded ${posts.length} posts from disk.`);
}

function flush() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ posts }));
    dirty = false;
  } catch (err) {
    console.error("Blog: flush error", err.message);
  }
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

function getPosts(publishedOnly) {
  let list = publishedOnly ? posts.filter((p) => p.published) : posts;
  return list.slice().sort((a, b) => b.createdAt - a.createdAt);
}

function getPost(slug) {
  return posts.find((p) => p.slug === slug) || null;
}

function getPostById(id) {
  return posts.find((p) => p.id === id) || null;
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
    tags: parseTags(tags),
    author,
    authorId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    published: !!published,
  };
  posts.push(post);
  dirty = true;
  flush();
  return post;
}

function updatePost(id, { title, description, content, tags, published }) {
  const post = posts.find((p) => p.id === id);
  if (!post) return null;

  if (title && title !== post.title) {
    post.title = title;
    post.slug = generateSlug(title);
  }
  if (description !== undefined) post.description = description;
  if (content !== undefined) post.content = content;
  if (tags !== undefined) post.tags = parseTags(tags);
  if (published !== undefined) post.published = !!published;
  post.updatedAt = Date.now();

  dirty = true;
  flush();
  return post;
}

function deletePost(id) {
  const idx = posts.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  posts.splice(idx, 1);
  dirty = true;
  flush();
  return true;
}

function getAllTags() {
  const tagSet = new Set();
  for (const p of posts) {
    if (p.published && p.tags) {
      p.tags.forEach((t) => tagSet.add(t));
    }
  }
  return Array.from(tagSet).sort();
}

function getPostsByTag(tag) {
  return posts
    .filter((p) => p.published && p.tags && p.tags.includes(tag.toLowerCase()))
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = { init, getPosts, getPost, getPostById, createPost, updatePost, deletePost, getAllTags, getPostsByTag };
