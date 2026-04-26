// URL slug helpers for public player profiles at /profile/:slug.
//
// Two players can share the same arma_username; we disambiguate with a `--a` / `--b` suffix.
// The mapping is deterministic — we sort all candidates by arma_id and assign suffixes by index.
//
//   "Twisted"               + arma_id A → /profile/twisted
//   "Twisted"               + arma_id B → /profile/twisted--a   (alphabetically-second arma_id)
//   "Twisted"               + arma_id C → /profile/twisted--b
//   "Twisted Player Name 🔫" → /profile/twisted-player-name
//
// The `--` separator can never appear in a slugified username because slugify collapses runs of
// non-alphanumerics to a single `-`. So `--` always means "suffix follows".

function slugify(username) {
  return String(username || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")           // strip combining marks
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

// Split "twisted--b" → { base: "twisted", index: 2 }; "twisted" → { base, index: 0 }.
// Returns { base: null } when the slug is empty.
function parseSlug(slug) {
  const s = String(slug || "").toLowerCase();
  if (!s) return { base: null, index: 0 };
  const idx = s.lastIndexOf("--");
  if (idx === -1) return { base: s, index: 0 };
  const suffix = s.slice(idx + 2);
  if (!/^[a-z]+$/.test(suffix)) return { base: s, index: 0 };
  let index = 0;
  for (const ch of suffix) index = index * 26 + (ch.charCodeAt(0) - 96);
  return { base: s.slice(0, idx), index };
}

// 0 → "", 1 → "--a", 2 → "--b", 26 → "--z", 27 → "--aa".
function indexToSuffix(i) {
  if (!i || i < 1) return "";
  let s = "";
  let n = i;
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return "--" + s;
}

// Given a player's arma_username and arma_id, plus the full list of arma_ids that share the same
// slugified name, return the canonical slug for this player. List sorted ascending by arma_id.
function buildSlug(armaUsername, armaId, sameNameArmaIds) {
  const base = slugify(armaUsername);
  if (!base) return null;
  if (!Array.isArray(sameNameArmaIds) || sameNameArmaIds.length <= 1) return base;
  const sorted = [...sameNameArmaIds].sort((a, b) => String(a).localeCompare(String(b)));
  const idx = sorted.findIndex(id => String(id) === String(armaId));
  if (idx < 0) return base;
  return base + indexToSuffix(idx);
}

module.exports = { slugify, parseSlug, indexToSuffix, buildSlug };
