const axios = require("axios");
const config = require("./config");

// ── Constants (per outfits plan 2026-04-24) ──
const MAX_TAG_LENGTH = 5;
const MIN_TAG_LENGTH = 2;
const MAX_NAME_LENGTH = 32;
const CREATE_COST = 5000;
const MAX_MEMBERS_DEFAULT = 10;       // plan: max 10 per outfit
const MIN_MEMBERS_FOR_WAR = 3;
const REJOIN_COOLDOWN_DAYS = 30;      // plan: 30-day cooldown after leaving before rejoining any outfit
const WAR_DURATION_HOURS = 48;        // plan: fixed 48h wars
const WAR_ACCEPT_HOURS = 24;
const WAR_HOUSE_RAKE = 0.05;
const INVITE_EXPIRE_HOURS = 72;

// War cost formula (plan: dynamic based on W/L vs. specific opponent)
const WAR_BASE_COST = 20000;
const WAR_COST_STEP = 2000;           // per W/L differential against this opponent
const WAR_MAX_DISCOUNT = 18000;       // floor at 2,000 coins

// Ranks — crime boss theme (Don / Capo / Soldier)
const RANK_DON = "don";
const RANK_CAPO = "capo";
const RANK_SOLDIER = "soldier";
const RANK_LABEL = { don: "Don", capo: "Capo", soldier: "Soldier" };
const RANK_ORDER = { don: 0, capo: 1, soldier: 2 };
const RANK_EMOJI = { don: "🎩", capo: "🥃", soldier: "🔫" };

// Leaderboard scoring (plan)
const LB_POINTS_PER_WAR = 1;
const LB_POINTS_PER_POSITIVE_OPPONENT = 10;

const api = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });
const TOKEN = config.adminApiToken;

function init() {
  console.log("Outfits: using game-server API at", config.apiBaseUrl);
}

// ── Outfit CRUD ──

// Game-server returns { outfit: {...}, members: [...] } from /outfit/details — flatten so the outfit
// object carries its members along (getMembers reads outfit.members/outfit.roster).
function unwrapOutfit(data) {
  if (!data) return null;
  if (data.outfit) return { ...data.outfit, members: data.members || data.roster || [] };
  return data;
}

async function getOutfit(id) {
  try {
    const res = await api.get("/outfit/details", { params: { id, token: TOKEN } });
    return unwrapOutfit(res.data);
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function getOutfitByTag(tag) {
  try {
    const res = await api.get("/outfit/details", { params: { tag, token: TOKEN } });
    return unwrapOutfit(res.data);
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function getOutfitByName(name) {
  const all = await getAllOutfits();
  return all.find(o => o.name?.toLowerCase() === name.toLowerCase()) || null;
}

async function getAllOutfits() {
  try {
    const res = await api.get("/outfit/", { params: { token: TOKEN } });
    const raw = res.data;
    return Array.isArray(raw) ? raw : (Array.isArray(raw?.outfits) ? raw.outfits : []);
  } catch {
    return [];
  }
}

async function createOutfit(leaderDiscordId, name, tag, { username, wastedCoins } = {}) {
  if (!leaderDiscordId) throw new Error("discord_id required");
  name = (name || "").trim();
  tag = (tag || "").trim().toUpperCase();
  if (name.length < 3 || name.length > MAX_NAME_LENGTH) throw new Error(`Outfit name must be 3–${MAX_NAME_LENGTH} characters.`);
  if (tag.length < MIN_TAG_LENGTH || tag.length > MAX_TAG_LENGTH) throw new Error(`Tag must be ${MIN_TAG_LENGTH}–${MAX_TAG_LENGTH} characters.`);
  if (!/^[A-Z0-9]+$/.test(tag)) throw new Error("Tag can only contain letters and numbers.");

  const existing = await getMemberOutfit(leaderDiscordId);
  if (existing) throw new Error("You're already in an outfit. Leave first.");

  // 30-day rejoin cooldown — backend exposes `last_left_at` on the member-me payload when not in an outfit
  await assertRejoinAllowed(leaderDiscordId);

  if (wastedCoins) {
    wastedCoins.spendCoins(leaderDiscordId, CREATE_COST, "outfit_create", { meta: { outfit_name: name, tag } });
  }

  try {
    const res = await api.post("/outfit/create", { token: TOKEN, name, tag, leader_discord_id: String(leaderDiscordId), max_members: MAX_MEMBERS_DEFAULT });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error("[outfits.createOutfit] API error", status, body, "— sent:", { name, tag, leader_discord_id: String(leaderDiscordId) });

    // Game-server may complete the insert and then fail a post-step (e.g. adding the leader as a member),
    // returning non-2xx even though the outfit row exists. Verify before refunding so we don't double-grant.
    try {
      const verify = await getMemberOutfit(leaderDiscordId);
      if (verify && (verify.outfit_tag === tag || verify.outfit?.tag === tag)) {
        console.warn("[outfits.createOutfit] API returned non-2xx but outfit was created — treating as success.");
        return verify.outfit || { id: verify.outfit_id, name: verify.outfit_name || name, tag };
      }
    } catch (verifyErr) {
      console.error("[outfits.createOutfit] post-error verification failed:", verifyErr.message);
    }

    // Genuine failure — refund and surface the error
    if (wastedCoins) {
      wastedCoins.addCoins(leaderDiscordId, CREATE_COST, "outfit_create_refund", { username, bypassCap: true, meta: { reason: "api_error", error: err.message } });
    }
    const detail = body?.error || body?.message || (typeof body === "string" ? body : null) || err.message;
    throw new Error(`Outfit create failed (HTTP ${status || "?"}): ${detail}`);
  }
}

async function updateOutfit(id, { motto, color, name, tag, max_members, logo_url }) {
  const body = { token: TOKEN, id };
  if (motto !== undefined) body.motto = String(motto).slice(0, 200);
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) body.color = color;
  if (name !== undefined) body.name = name;
  if (tag !== undefined) body.tag = tag;
  if (max_members !== undefined) body.max_members = max_members;
  if (logo_url !== undefined) body.logo_url = logo_url;
  await api.post("/outfit/update", body);
}

async function disbandOutfit(outfitId, discordId, { wastedCoins } = {}) {
  const outfit = await getOutfit(outfitId);
  if (!outfit) throw new Error("Outfit not found.");
  if (outfit.leader_discord_id !== String(discordId)) throw new Error("Only the Don can disband.");

  const activeWar = await getActiveWarForOutfit(outfitId);
  if (activeWar && (activeWar.status === "pending" || activeWar.status === "active")) {
    throw new Error("Can't disband during an active or pending war.");
  }

  // Delete first — only refund treasury if delete succeeds (prevents double-refund hack on retries)
  await api.post("/outfit/delete", { token: TOKEN, id: outfitId });

  if (wastedCoins && outfit.treasury > 0) {
    wastedCoins.addCoins(discordId, outfit.treasury, "outfit_disband_refund", { bypassCap: true, meta: { outfit_id: outfitId, outfit_name: outfit.name } });
  }
}

// ── Members ──

async function getMembers(outfitId) {
  const outfit = await getOutfit(outfitId);
  if (!outfit) return [];
  const members = outfit.members || outfit.roster || [];
  members.sort((a, b) => (RANK_ORDER[a.role] ?? 2) - (RANK_ORDER[b.role] ?? 2));
  return members;
}

async function getMemberCount(outfitId) {
  const members = await getMembers(outfitId);
  return members.length;
}

async function getMemberOutfit(discordId) {
  try {
    const res = await api.get("/outfit/members/me", { params: { discord_id: String(discordId), token: TOKEN } });
    const data = res.data;
    if (!data) return null;
    // Game-server returns { outfit, membership, members } — flatten the fields callers expect
    // while preserving the nested objects for callers that want them.
    if (data.outfit && data.membership) {
      return {
        outfit_id: data.outfit.id,
        outfit_tag: data.outfit.tag,
        outfit_name: data.outfit.name,
        role: data.membership.role,
        outfit: data.outfit,
        membership: data.membership,
        members: data.members || [],
      };
    }
    return data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function getMemberRole(outfitId, discordId) {
  const members = await getMembers(outfitId);
  const m = members.find(m => m.discord_id === String(discordId));
  return m?.role || null;
}

async function isDonOrCapo(outfitId, discordId) {
  const role = await getMemberRole(outfitId, discordId);
  return role === RANK_DON || role === RANK_CAPO;
}
// Backwards-compat alias

// 30-day rejoin cooldown — backend should expose `last_left_at` on getMemberOutfit when discord_id is not in an outfit.
// If absent, no cooldown is enforced (graceful fallback until backend supports it).
async function assertRejoinAllowed(discordId) {
  try {
    const res = await api.get("/outfit/members/me", { params: { discord_id: String(discordId), token: TOKEN } });
    const lastLeft = res.data?.last_left_at;
    if (!lastLeft) return; // never been in one, or backend doesn't track this yet
    const left = new Date(lastLeft + (lastLeft.endsWith("Z") ? "" : "Z")).getTime();
    if (isNaN(left)) return;
    const daysAgo = (Date.now() - left) / 86400000;
    if (daysAgo < REJOIN_COOLDOWN_DAYS) {
      const daysLeft = Math.ceil(REJOIN_COOLDOWN_DAYS - daysAgo);
      throw new Error(`You left an outfit ${Math.floor(daysAgo)} day(s) ago. Wait ${daysLeft} more day(s) before joining another (${REJOIN_COOLDOWN_DAYS}-day cooldown).`);
    }
  } catch (e) {
    if (e.message?.startsWith("You left")) throw e;
    // 404 (no record) or other errors → allow (don't block on bug)
  }
}

async function removeMember(outfitId, discordId) {
  try {
    await api.post("/outfit/members/remove", { token: TOKEN, outfit_id: outfitId, discord_id: String(discordId) });
  } catch (err) {
    throw new Error(err.response?.data?.error || err.message);
  }
}

async function promoteMember(outfitId, discordId) {
  try {
    await api.post("/outfit/members/role", { token: TOKEN, outfit_id: outfitId, discord_id: String(discordId), role: RANK_CAPO });
  } catch (err) {
    throw new Error(err.response?.data?.error || err.message);
  }
}

async function demoteMember(outfitId, discordId) {
  try {
    await api.post("/outfit/members/role", { token: TOKEN, outfit_id: outfitId, discord_id: String(discordId), role: RANK_SOLDIER });
  } catch (err) {
    throw new Error(err.response?.data?.error || err.message);
  }
}

async function transferLeadership(outfitId, currentLeaderId, newLeaderId) {
  try {
    await api.post("/outfit/members/transfer-leadership", { token: TOKEN, outfit_id: outfitId, current_leader_id: String(currentLeaderId), new_leader_id: String(newLeaderId) });
  } catch (err) {
    throw new Error(err.response?.data?.error || err.message);
  }
}

// ── Invites ──

async function createInvite(outfitId, targetDiscordId, inviterDiscordId) {
  try {
    const res = await api.post("/outfit/invites/create", {
      token: TOKEN,
      outfit_id: outfitId,
      target_discord_id: String(targetDiscordId),
      invited_by: String(inviterDiscordId),
    });
    const data = res.data;
    return {
      token: data.token,
      expiresAt: data.expires_at,
      outfitName: data.outfit_name || data.outfitName,
      outfitTag: data.outfit_tag || data.outfitTag,
    };
  } catch (err) {
    throw new Error(err.response?.data?.error || err.message);
  }
}

// Look up an invite by its public token. Game-server returns { count, invites: [...] }
// with the matching row in the array (or empty array if no match).
async function getInviteByToken(inviteToken) {
  try {
    const res = await api.get("/outfit/invites", { params: { invite_token: inviteToken, token: TOKEN } });
    const list = Array.isArray(res.data) ? res.data : (res.data?.invites || []);
    return list[0] || null;
  } catch (err) {
    console.error("[outfits.getInviteByToken] failed", err.response?.status, err.response?.data || err.message);
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function getPendingInvitesForUser(discordId) {
  try {
    const res = await api.get("/outfit/invites", { params: { discord_id: String(discordId), token: TOKEN } });
    const list = Array.isArray(res.data) ? res.data : (res.data?.invites || []);
    return list.filter(i => i.status === "pending");
  } catch {
    return [];
  }
}

async function getPendingInvitesForOutfit(outfitId) {
  try {
    const res = await api.get("/outfit/invites", { params: { outfit_id: outfitId, token: TOKEN } });
    const list = Array.isArray(res.data) ? res.data : (res.data?.invites || []);
    return list.filter(i => i.status === "pending");
  } catch (err) {
    console.error("[outfits.getPendingInvitesForOutfit] failed", err.response?.status, err.response?.data || err.message);
    return [];
  }
}

async function acceptInvite(token, discordId) {
  // Enforce rejoin cooldown before accepting
  await assertRejoinAllowed(discordId);
  const reqBody = { token: TOKEN, invite_token: token, accept: true, discord_id: String(discordId) };
  try {
    const res = await api.post("/outfit/invites/respond", reqBody);
    const data = res.data || {};
    // Game-server may return: { outfit_id }, { outfit: {...} }, or the outfit row directly
    const outfitId = data.outfit_id ?? data.outfit?.id ?? data.id ?? null;
    return { ...data, id: outfitId };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    // Log full body sent (with token redacted) so we can confirm the right protocol fields shipped
    const logBody = { ...reqBody, token: "<redacted>" };
    console.error("[outfits.acceptInvite] failed", status, body, "— sent:", logBody);
    throw new Error(body?.error || body?.message || err.message);
  }
}

async function declineInvite(token, discordId) {
  try {
    await api.post("/outfit/invites/respond", { token: TOKEN, invite_token: token, accept: false, discord_id: String(discordId) });
  } catch (err) {
    throw new Error(err.response?.data?.error || err.message);
  }
}

// Don/Capo (or original inviter) cancels an outgoing invite. Game-server enforces the auth check
// against canceller_discord_id and stamps cancelled_at / cancelled_by for audit.
async function cancelInvite(inviteToken, cancellerDiscordId) {
  const body = {
    token: TOKEN,
    invite_token: inviteToken,
    canceller_discord_id: String(cancellerDiscordId),
  };
  try {
    const res = await api.post("/outfit/invites/cancel", body);
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error("[outfits.cancelInvite] failed", status, data, "— sent:", { invite_token: inviteToken, canceller_discord_id: String(cancellerDiscordId) });
    const detail = data?.error || data?.message || (typeof data === "string" ? data : null) || err.message;
    throw new Error(`(HTTP ${status || "?"}) ${detail}`);
  }
}

// ── Treasury ──
// Plan: only the Don can spend from treasury (declare war OR distribute to members).
// Anyone can deposit (donations).

async function deposit(outfitId, discordId, amount, wastedCoins) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount must be a positive integer");
  const outfit = await getOutfit(outfitId);
  if (!outfit) throw new Error("Outfit not found.");

  const role = await getMemberRole(outfitId, discordId);
  if (!role) throw new Error("Not a member of this outfit.");

  wastedCoins.spendCoins(discordId, amount, "outfit_deposit", { meta: { outfit_id: outfitId, outfit_name: outfit.name } });

  try {
    const res = await api.post("/outfit/treasury/update", { token: TOKEN, outfit_id: outfitId, amount });
    return res.data?.treasury ?? (outfit.treasury + amount);
  } catch (err) {
    wastedCoins.addCoins(discordId, amount, "outfit_deposit_refund", { bypassCap: true, meta: { outfit_id: outfitId, reason: "api_error" } });
    throw new Error(err.response?.data?.error || err.message);
  }
}

// Distribute treasury to members. Modes: even | rank-high | rank-low | custom (custom requires splitMap)
// Don-only operation.
async function distributeTreasury(outfitId, donDiscordId, mode, { amount = null, splitMap = null, wastedCoins }) {
  if (!wastedCoins) throw new Error("wasted-coins module required");
  const outfit = await getOutfit(outfitId);
  if (!outfit) throw new Error("Outfit not found.");
  if (outfit.leader_discord_id !== String(donDiscordId)) throw new Error("Only the Don can distribute the treasury.");

  const total = amount && Number.isInteger(amount) ? Math.min(amount, outfit.treasury) : outfit.treasury;
  if (total <= 0) throw new Error("No coins to distribute.");

  const members = await getMembers(outfitId);
  if (members.length === 0) throw new Error("No members.");

  // Compute split per member
  let splits = {}; // discord_id → coins
  if (mode === "even") {
    const each = Math.floor(total / members.length);
    members.forEach(m => { splits[m.discord_id] = each; });
  } else if (mode === "rank-high") {
    // Don 50%, Capos share 30%, Soldiers share 20%
    const dons = members.filter(m => m.role === RANK_DON);
    const capos = members.filter(m => m.role === RANK_CAPO);
    const soldiers = members.filter(m => m.role === RANK_SOLDIER);
    const donShare = Math.floor(total * 0.5 / Math.max(1, dons.length));
    const capoShare = capos.length ? Math.floor(total * 0.3 / capos.length) : 0;
    const soldierShare = soldiers.length ? Math.floor(total * 0.2 / soldiers.length) : 0;
    dons.forEach(m => { splits[m.discord_id] = donShare; });
    capos.forEach(m => { splits[m.discord_id] = capoShare; });
    soldiers.forEach(m => { splits[m.discord_id] = soldierShare; });
  } else if (mode === "rank-low") {
    // Soldiers 50%, Capos 30%, Don 20%
    const dons = members.filter(m => m.role === RANK_DON);
    const capos = members.filter(m => m.role === RANK_CAPO);
    const soldiers = members.filter(m => m.role === RANK_SOLDIER);
    const soldierShare = soldiers.length ? Math.floor(total * 0.5 / soldiers.length) : 0;
    const capoShare = capos.length ? Math.floor(total * 0.3 / capos.length) : 0;
    const donShare = Math.floor(total * 0.2 / Math.max(1, dons.length));
    dons.forEach(m => { splits[m.discord_id] = donShare; });
    capos.forEach(m => { splits[m.discord_id] = capoShare; });
    soldiers.forEach(m => { splits[m.discord_id] = soldierShare; });
  } else if (mode === "custom" && splitMap) {
    // splitMap: discord_id → percent (0-100). Must sum to ≤100.
    const sum = Object.values(splitMap).reduce((s, n) => s + Number(n || 0), 0);
    if (sum > 100) throw new Error("Custom split totals over 100%.");
    Object.entries(splitMap).forEach(([id, pct]) => {
      splits[id] = Math.floor(total * (Number(pct) / 100));
    });
  } else {
    throw new Error("Invalid distribution mode.");
  }

  const totalDistributed = Object.values(splits).reduce((s, n) => s + n, 0);
  if (totalDistributed <= 0) throw new Error("Nothing to distribute.");

  // Atomic-ish: deduct from treasury first, then credit each member. If a credit fails, log it (refund handled by admin).
  await api.post("/outfit/treasury/update", { token: TOKEN, outfit_id: outfitId, amount: -totalDistributed });

  const credited = [];
  for (const [discordId, coins] of Object.entries(splits)) {
    if (coins <= 0) continue;
    try {
      const m = members.find(x => x.discord_id === discordId);
      wastedCoins.addCoins(discordId, coins, "outfit_distribution", {
        username: m?.username,
        bypassCap: true,
        meta: { outfit_id: outfitId, outfit_name: outfit.name, mode },
      });
      credited.push({ discord_id: discordId, coins });
    } catch (e) {
      console.error(`Outfit distribution: failed to credit ${discordId}: ${e.message}`);
    }
  }
  return { mode, total: totalDistributed, recipients: credited.length, splits: credited };
}

// ── War Cost (plan: dynamic by W/L vs. opponent) ──
// Base 20,000; -2,000 per loss differential (max -18,000); +2,000 per win differential (no cap).
async function calculateWarCost(challengerOutfitId, defenderOutfitId) {
  const wars = await getOutfitWars(challengerOutfitId, 1000);
  // Wars where this challenger faced this specific opponent
  const headToHead = wars.filter(w =>
    w.status === "settled" &&
    ((w.challenger_outfit_id === challengerOutfitId && w.defender_outfit_id === defenderOutfitId) ||
     (w.challenger_outfit_id === defenderOutfitId && w.defender_outfit_id === challengerOutfitId))
  );
  const wins = headToHead.filter(w => w.winner_outfit_id === challengerOutfitId).length;
  const losses = headToHead.filter(w => w.winner_outfit_id && w.winner_outfit_id !== challengerOutfitId).length;
  const diff = wins - losses; // positive = we win more vs them
  let cost = WAR_BASE_COST;
  if (diff > 0) {
    cost += diff * WAR_COST_STEP; // we keep beating them → more expensive
  } else if (diff < 0) {
    const discount = Math.min(WAR_MAX_DISCOUNT, Math.abs(diff) * WAR_COST_STEP);
    cost -= discount;
  }
  return { cost, wins, losses, diff, base: WAR_BASE_COST };
}

// ── Wars ──

async function declareWar(challengerOutfitId, defenderOutfitId, discordId, wastedCoins) {
  if (!defenderOutfitId) throw new Error("Target outfit not found.");

  // Don-only (plan)
  const role = await getMemberRole(challengerOutfitId, discordId);
  if (role !== RANK_DON) throw new Error("Only the Don can declare war.");

  // Calculate dynamic cost
  const costInfo = await calculateWarCost(challengerOutfitId, defenderOutfitId);
  const challenger = await getOutfit(challengerOutfitId);
  if (!challenger) throw new Error("Challenger outfit not found.");
  if (challenger.treasury < costInfo.cost) {
    throw new Error(`Treasury has ${challenger.treasury.toLocaleString()} coins, need ${costInfo.cost.toLocaleString()} to declare war (base ${WAR_BASE_COST.toLocaleString()}, ${costInfo.diff >= 0 ? "+" : ""}${costInfo.diff} W/L vs. them). Players can /outfit deposit to top it off.`);
  }

  try {
    const res = await api.post("/outfit/wars/declare", {
      token: TOKEN,
      challenger_outfit_id: challengerOutfitId,
      defender_outfit_id: defenderOutfitId,
      wager: costInfo.cost,
      duration_hours: WAR_DURATION_HOURS,
    });
    const war = res.data;
    const defender = await getOutfit(defenderOutfitId);
    return {
      id: war.id || war.war_id,
      challenger,
      defender,
      cost: costInfo.cost,
      costInfo,
      durationHours: WAR_DURATION_HOURS,
      expiresAt: war.ends_at,
    };
  } catch (err) {
    const apiMsg = err.response?.data?.error || err.response?.data?.message;
    const status = err.response?.status;
    const detail = apiMsg || JSON.stringify(err.response?.data || {}).slice(0, 200) || err.message;
    console.error(`declareWar ${challengerOutfitId} → ${defenderOutfitId} failed [${status}]:`, err.response?.data || err.message);
    throw new Error(`[${status || "?"}] ${detail}`);
  }
}

async function acceptWar(warId, discordId) {
  let war;
  try {
    const res = await api.post("/outfit/wars/respond", { token: TOKEN, war_id: warId, accept: true, discord_id: String(discordId) });
    war = res.data?.war || res.data || {};
  } catch (err) {
    const apiMsg = err.response?.data?.error || err.response?.data?.message;
    const status = err.response?.status;
    console.error(`acceptWar ${warId} failed [${status}]:`, err.response?.data || err.message);
    throw new Error(`[${status || "?"}] ${apiMsg || err.message}`);
  }

  // Best-effort enrichment — never let a missing field fail the accept
  let challenger = null, defender = null;
  if (war.challenger_outfit_id) { try { challenger = await getOutfit(war.challenger_outfit_id); } catch {} }
  if (war.defender_outfit_id) { try { defender = await getOutfit(war.defender_outfit_id); } catch {} }
  return { id: warId, startsAt: war.starts_at, endsAt: war.ends_at, challenger, defender };
}

// Plan: winner = whichever outfit generated more coins through gameplay during the war window.
// Score field below is server-provided coins-generated-during-war (was kill-count under old design).
async function settleWar(warId) {
  try {
    const res = await api.post("/outfit/wars/settle", { token: TOKEN, war_id: warId });
    const r = res.data;
    const challenger = await getOutfit(r.challenger_outfit_id);
    const defender = await getOutfit(r.defender_outfit_id);
    return {
      id: warId,
      challengerScore: r.challenger_score ?? r.challenger_coins ?? 0,
      defenderScore: r.defender_score ?? r.defender_coins ?? 0,
      winnerId: r.winner_outfit_id || null,
      payout: r.payout || 0,
      houseRake: r.house_rake || 0,
      isTie: !r.winner_outfit_id,
      challenger,
      defender,
    };
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function declineWar(warId, discordId) {
  try {
    await api.post("/outfit/wars/respond", { token: TOKEN, war_id: warId, accept: false, discord_id: String(discordId) });
  } catch (err) {
    const apiMsg = err.response?.data?.error || err.response?.data?.message;
    const status = err.response?.status;
    console.error(`declineWar ${warId} failed [${status}]:`, err.response?.data || err.message);
    throw new Error(`[${status || "?"}] ${apiMsg || err.message}`);
  }
}

async function cancelWar(warId, discordId) {
  try {
    await api.post("/outfit/wars/respond", { token: TOKEN, war_id: warId, accept: false, discord_id: String(discordId) });
  } catch (err) {
    throw new Error(err.response?.data?.error || err.message);
  }
}

async function getWar(id) {
  try {
    const res = await api.get("/outfit/wars", { params: { war_id: id, token: TOKEN } });
    const wars = Array.isArray(res.data) ? res.data : [res.data];
    return wars[0] || null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function getActiveWarForOutfit(outfitId) {
  try {
    const res = await api.get("/outfit/wars", { params: { outfit_id: outfitId, token: TOKEN } });
    const wars = Array.isArray(res.data) ? res.data : [];
    return wars.find(w => w.status === "active" || w.status === "pending") || null;
  } catch {
    return null;
  }
}

async function getWarScores(warId) {
  const war = await getWar(warId);
  return war?.scores || war?.war_scores || [];
}

async function getOutfitWars(outfitId, limit = 20) {
  try {
    const res = await api.get("/outfit/wars", { params: { outfit_id: outfitId, token: TOKEN } });
    const wars = Array.isArray(res.data?.wars) ? res.data.wars : (Array.isArray(res.data) ? res.data : []);
    return wars.slice(0, limit);
  } catch {
    return [];
  }
}

// All currently-active or pending wars across every outfit (homepage + cron)
async function getAllActiveWars() {
  try {
    const res = await api.get("/outfit/wars", { params: { token: TOKEN } });
    const wars = Array.isArray(res.data?.wars) ? res.data.wars : (Array.isArray(res.data) ? res.data : []);
    const ACTIVE = new Set(["pending", "active", "accepted"]);
    return wars
      .filter(w => ACTIVE.has(String(w.status || "").toLowerCase()))
      .sort((a, b) => new Date(b.declared_at || 0) - new Date(a.declared_at || 0));
  } catch (err) {
    console.error("getAllActiveWars failed:", err.message);
    return [];
  }
}

async function getOutfitWarRecord(outfitId) {
  const wars = await getOutfitWars(outfitId, 1000);
  const settled = wars.filter(w => w.status === "settled");
  const wins = settled.filter(w => w.winner_outfit_id === outfitId).length;
  const losses = settled.filter(w => w.winner_outfit_id && w.winner_outfit_id !== outfitId).length;
  const ties = settled.filter(w => !w.winner_outfit_id).length;
  return { wins, losses, ties, total: settled.length };
}

async function tick(wastedCoins) {
  const events = [];
  try {
    const res = await api.get("/outfit/wars", { params: { token: TOKEN } });
    const wars = Array.isArray(res.data?.wars) ? res.data.wars : (Array.isArray(res.data) ? res.data : []);
    const now = new Date();

    for (const w of wars) {
      if (w.status === "pending" && w.ends_at && new Date(w.ends_at + (w.ends_at.endsWith("Z") ? "" : "Z")) < now) {
        try {
          await api.post("/outfit/wars/respond", { token: TOKEN, war_id: w.id, accept: false });
          events.push({ kind: "expired", war: w });
        } catch {}
      }
      if (w.status === "active" && w.ends_at && new Date(w.ends_at + (w.ends_at.endsWith("Z") ? "" : "Z")) < now) {
        try {
          const result = await settleWar(w.id);
          if (result) events.push({ kind: "settled", result, war: w });
        } catch (err) {
          console.error(`Outfits: war ${w.id} settle error:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error("Outfits: tick error:", err.message);
  }
  return events;
}

// ── Leaderboard (plan: 1pt per war + 10pt per opponent with positive W/L ratio) ──

async function getOutfitLeaderboard(limit = 20) {
  try {
    const res = await api.get("/outfit/leaderboard", { params: { token: TOKEN, limit } });
    if (Array.isArray(res.data) && res.data.length && res.data[0].score !== undefined) {
      // Backend returns pre-scored leaderboard
      return res.data.slice(0, limit);
    }
  } catch {}

  // Fallback: compute scores client-side from war history of all outfits
  const all = await getAllOutfits();
  const scored = [];
  for (const o of all) {
    try {
      const wars = await getOutfitWars(o.id, 1000);
      const settled = wars.filter(w => w.status === "settled");
      const totalWars = settled.length;
      let wins = 0, losses = 0, ties = 0;

      // Group by opponent + tally W/L/T totals
      const opponentRecords = {};
      for (const w of settled) {
        const oppId = w.challenger_outfit_id === o.id ? w.defender_outfit_id : w.challenger_outfit_id;
        if (!opponentRecords[oppId]) opponentRecords[oppId] = { wins: 0, losses: 0 };
        if (w.winner_outfit_id === o.id) { opponentRecords[oppId].wins++; wins++; }
        else if (w.winner_outfit_id) { opponentRecords[oppId].losses++; losses++; }
        else ties++;
      }
      const positiveOpponents = Object.values(opponentRecords).filter(r => r.wins > r.losses).length;
      const score = totalWars * LB_POINTS_PER_WAR + positiveOpponents * LB_POINTS_PER_POSITIVE_OPPONENT;

      scored.push({ ...o, score, wins, losses, ties, total_wars: totalWars, positive_opponents: positiveOpponents });
    } catch {
      scored.push({ ...o, score: 0, wins: 0, losses: 0, ties: 0, total_wars: 0, positive_opponents: 0 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

module.exports = {
  init,
  CREATE_COST, MAX_TAG_LENGTH, MIN_TAG_LENGTH, MAX_NAME_LENGTH, MAX_MEMBERS_DEFAULT, MIN_MEMBERS_FOR_WAR,
  WAR_HOUSE_RAKE, WAR_ACCEPT_HOURS, INVITE_EXPIRE_HOURS, WAR_DURATION_HOURS,
  WAR_BASE_COST, WAR_COST_STEP, WAR_MAX_DISCOUNT,
  REJOIN_COOLDOWN_DAYS,
  RANK_DON, RANK_CAPO, RANK_SOLDIER, RANK_LABEL, RANK_ORDER, RANK_EMOJI,
  LB_POINTS_PER_WAR, LB_POINTS_PER_POSITIVE_OPPONENT,
  getOutfit, getOutfitByTag, getOutfitByName, getAllOutfits, createOutfit, updateOutfit, disbandOutfit,
  getMembers, getMemberCount, getMemberOutfit, getMemberRole, isDonOrCapo, assertRejoinAllowed,
  removeMember, promoteMember, demoteMember, transferLeadership,
  createInvite, getInviteByToken, getPendingInvitesForUser, getPendingInvitesForOutfit, acceptInvite, declineInvite, cancelInvite,
  deposit, distributeTreasury,
  calculateWarCost, declareWar, acceptWar, settleWar, declineWar, cancelWar,
  getWar, getActiveWarForOutfit, getWarScores, getOutfitWars, getOutfitWarRecord, getAllActiveWars, tick,
  getOutfitLeaderboard,
};
