const express = require("express");
const config = require("../config");
const outfits = require("../outfits");
const router = express.Router();

function buildAvatar(user) {
  if (!user) return;
  if (user.avatar && user.discord_id) {
    user.avatarUrl = `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png?size=128`;
  } else if (user.discord_id) {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  }
}

// ── Public: outfit directory ──
router.get("/", async (req, res) => {
  const user = req.session.user || null;
  buildAvatar(user);
  try {
    const allOutfits = await outfits.getOutfitLeaderboard(100);
    const enriched = [];
    for (const o of allOutfits) {
      const members = await outfits.getMembers(o.id);
      const record = await outfits.getOutfitWarRecord(o.id);
      enriched.push({ ...o, members, record });
    }
    const myOutfit = user?.discord_id ? await outfits.getMemberOutfit(user.discord_id) : null;
    const activeWars = await outfits.getAllActiveWars();
    res.render("outfits-directory", {
      page: "outfits",
      pageTitle: "Outfits",
      pageDescription: "Mercenary outfits competing in Arma Wasteland.",
      user,
      outfitList: enriched,
      myOutfit,
      activeWars,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error("Outfits directory error:", err.message);
    res.render("outfits-directory", {
      page: "outfits", pageTitle: "Outfits", pageDescription: "Mercenary outfits competing in Arma Wasteland.",
      user, outfitList: [], myOutfit: null, error: "Failed to load outfits.",
    });
  }
});

// ── Public: outfit detail page ──
router.get("/:id(\\d+)", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const outfit = await outfits.getOutfit(id);
    if (!outfit) return res.redirect("/outfits?error=" + encodeURIComponent("Outfit not found."));
    const user = req.session.user || null;
    buildAvatar(user);
    const members = await outfits.getMembers(id);
    const record = await outfits.getOutfitWarRecord(id);
    const warList = await outfits.getOutfitWars(id, 20);
    const wars = [];
    for (const w of warList) {
      const c = await outfits.getOutfit(w.challenger_outfit_id);
      const d = await outfits.getOutfit(w.defender_outfit_id);
      wars.push({ ...w, challenger: c, defender: d });
    }
    const ACTIVE_STATUSES = new Set(["pending", "active", "accepted"]);
    const currentWars = wars.filter(w => ACTIVE_STATUSES.has(String(w.status || "").toLowerCase()));

    // Incoming attacks: pending wars where this outfit is the defender (needs Don action)
    const incomingAttacks = wars.filter(w =>
      String(w.status || "").toLowerCase() === "pending" && w.defender_outfit_id === id
    );
    // Active wars where this outfit is the defender (under attack right now)
    const activeAttacks = wars.filter(w => {
      const s = String(w.status || "").toLowerCase();
      return (s === "active" || s === "accepted") && w.defender_outfit_id === id;
    });
    const myMember = user?.discord_id ? await outfits.getMemberRole(id, user.discord_id) : null;
    const pendingInvites = (myMember === "don" || myMember === "capo") ? await outfits.getPendingInvitesForOutfit(id) : [];

    // Wasted Coins balance for the deposit form (members only)
    let myCoinsBalance = null;
    if (myMember && user?.discord_id) {
      try { myCoinsBalance = require("../wasted-coins").getBalance(user.discord_id); } catch {}
    }

    // Don-only: list eligible war targets (other outfits) with computed dynamic cost
    let warTargets = [];
    if (myMember === "don") {
      try {
        const all = await outfits.getOutfitLeaderboard(100);
        const others = all.filter(o => o.id !== id);
        warTargets = await Promise.all(others.map(async o => {
          let cost = outfits.WAR_BASE_COST;
          let wins = 0, losses = 0, diff = 0;
          try {
            const c = await outfits.calculateWarCost(id, o.id);
            cost = c.cost; wins = c.wins; losses = c.losses; diff = c.diff;
          } catch {}
          return {
            id: o.id, tag: o.tag, name: o.name, color: o.color,
            members: o.member_count || (o.members?.length || 0),
            warCost: cost,
            h2h: `${wins}W / ${losses}L`,
            affordable: outfit.treasury >= cost,
          };
        }));
        warTargets.sort((a, b) => a.warCost - b.warCost);
      } catch (e) {
        console.error("warTargets fetch failed:", e.message);
      }
    }

    res.render("outfit-detail", {
      page: "outfits",
      pageTitle: `[${outfit.tag}] ${outfit.name}`,
      pageDescription: `${outfit.name} — a mercenary outfit in Arma Wasteland.`,
      user,
      outfit,
      members,
      record,
      wars,
      currentWars,
      incomingAttacks,
      activeAttacks,
      myMember,
      pendingInvites,
      warTargets,
      myCoinsBalance,
      successMessage: req.query.success || null,
      errorMessage: req.query.error || null,
    });
  } catch (err) {
    console.error("Outfit detail error:", err.message);
    res.redirect("/outfits?error=" + encodeURIComponent("Failed to load outfit."));
  }
});

// ── Invite accept page (must be logged in) ──
router.get("/invite/:token", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect(`/auth/discord?returnTo=${encodeURIComponent(req.originalUrl)}`);
  buildAvatar(user);
  try {
    const invite = await outfits.getInviteByToken(req.params.token);
    if (!invite) return res.status(404).render("outfit-invite", { page: "outfits", pageTitle: "Invite Not Found", user, invite: null, error: "Invite not found or invalid link." });
    const expired = invite.status !== "pending" || new Date(invite.expires_at + "Z") < new Date();
    const wrongUser = invite.target_discord_id !== user.discord_id;
    const alreadyInOutfit = !!(await outfits.getMemberOutfit(user.discord_id));
    res.render("outfit-invite", {
      page: "outfits",
      pageTitle: `Outfit Invite — ${invite.outfit_name}`,
      user,
      invite,
      expired,
      wrongUser,
      alreadyInOutfit,
      error: null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error("Invite page error:", err.response?.status, err.response?.data || err.message);
    const detail = err.response?.data?.error || err.response?.data?.message || err.message;
    res.status(500).render("outfit-invite", { page: "outfits", pageTitle: "Error", user, invite: null, error: `Failed to load invite: ${detail}` });
  }
});

router.post("/invite/:token/accept", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  try {
    const result = await outfits.acceptInvite(req.params.token, user.discord_id);
    if (result?.id) return res.redirect(`/outfits/${result.id}?success=${encodeURIComponent("Welcome to the crew!")}`);
    // Fallback: server didn't echo the outfit id — let /outfit resolve via getMemberOutfit
    return res.redirect("/outfit?success=" + encodeURIComponent("Welcome to the crew!"));
  } catch (err) {
    console.error("Accept invite route error:", err.message);
    res.redirect(`/outfits/invite/${req.params.token}?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/invite/:token/decline", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  try {
    await outfits.declineInvite(req.params.token, user.discord_id);
    res.redirect("/outfits?declined=1");
  } catch (err) {
    res.redirect(`/outfits/invite/${req.params.token}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── Accept a pending war declaration (Don only — defender side) ──
router.post("/:id(\\d+)/wars/:warId(\\d+)/accept", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  const outfitId = parseInt(req.params.id, 10);
  const warId = parseInt(req.params.warId, 10);
  try {
    const role = await outfits.getMemberRole(outfitId, user.discord_id);
    if (role !== "don") return res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent("Only the Don can respond to attacks.")}`);
    await outfits.acceptWar(warId, user.discord_id);
    res.redirect(`/outfits/${outfitId}?success=${encodeURIComponent("War accepted. 48-hour clock has started.")}`);
  } catch (err) {
    console.error("Accept war route error:", err.message);
    res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent(`Accept failed: ${err.message}`)}`);
  }
});

// ── Decline a pending war declaration (Don only — defender side) ──
router.post("/:id(\\d+)/wars/:warId(\\d+)/decline", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  const outfitId = parseInt(req.params.id, 10);
  const warId = parseInt(req.params.warId, 10);
  try {
    const role = await outfits.getMemberRole(outfitId, user.discord_id);
    if (role !== "don") return res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent("Only the Don can respond to attacks.")}`);
    await outfits.declineWar(warId, user.discord_id);
    res.redirect(`/outfits/${outfitId}?success=${encodeURIComponent("War declined.")}`);
  } catch (err) {
    console.error("Decline war route error:", err.message);
    res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent(`Decline failed: ${err.message}`)}`);
  }
});

// ── Deposit Wasted Coins into outfit treasury (any member) ──
router.post("/:id(\\d+)/deposit", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  const outfitId = parseInt(req.params.id, 10);
  const amount = parseInt(req.body.amount, 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent("Deposit amount must be a positive whole number.")}`);
  }
  try {
    const wastedCoins = require("../wasted-coins");
    const newTreasury = await outfits.deposit(outfitId, user.discord_id, amount, wastedCoins);
    res.redirect(`/outfits/${outfitId}?success=${encodeURIComponent(`Deposited 💀 ${amount.toLocaleString()}. Treasury now 💀 ${Number(newTreasury).toLocaleString()}.`)}`);
  } catch (err) {
    console.error("Outfit deposit route error:", err.message);
    res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent(`Deposit failed: ${err.message}`)}`);
  }
});

// ── Declare war on another outfit (Don only) ──
router.post("/:id(\\d+)/declare-war", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  const outfitId = parseInt(req.params.id, 10);
  const targetId = parseInt(req.body.target_outfit_id, 10);
  if (!targetId || targetId === outfitId) {
    return res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent("Pick a valid target outfit.")}`);
  }
  try {
    const wastedCoins = require("../wasted-coins");
    const result = await outfits.declareWar(outfitId, targetId, user.discord_id, wastedCoins);

    // DM the defender's Don and Capos so they know they're under attack
    notifyDefenderLeadership(result).catch(err => console.error("notifyDefenderLeadership failed:", err.message));

    res.redirect(`/outfits/${outfitId}?success=${encodeURIComponent("War declared! 48-hour clock has started.")}`);
  } catch (err) {
    console.error("Declare war route error:", err.message);
    res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent(`Declare failed: ${err.message}`)}`);
  }
});

async function notifyDefenderLeadership(warResult) {
  const { challenger, defender, id: warId, cost, durationHours, expiresAt } = warResult;
  if (!defender?.id) return;
  const members = await outfits.getMembers(defender.id);
  const targets = members.filter(m => m.role === "don" || m.role === "capo");
  if (!targets.length) return;

  const { getClient } = require("../discord-bot");
  const bot = getClient();
  if (!bot?.isReady()) return;
  const guild = bot.guilds.cache.get(config.discordGuildId);
  if (!guild) return;

  const link = `${config.siteUrl}/outfits/${defender.id}`;
  const description = [
    `**[${challenger.tag}] ${challenger.name}** has declared war on **[${defender.tag}] ${defender.name}**.`,
    cost ? `Wager: 💀 **${Number(cost).toLocaleString()}**` : null,
    `Duration: **${durationHours || 48}h** once accepted.`,
    expiresAt ? `Pending until: <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:R>` : null,
    "",
    `**[Respond on the website →](${link})**`,
    "Only the Don can accept or decline.",
  ].filter(Boolean).join("\n");

  await Promise.allSettled(targets.map(async (m) => {
    if (!m.discord_id) return;
    try {
      const member = await guild.members.fetch(m.discord_id).catch(() => null);
      if (!member) return;
      await member.send({
        embeds: [{
          color: 0xef4444,
          title: `🚨 Your outfit is under attack`,
          description,
        }],
      });
    } catch (err) {
      console.warn(`War-declare DM to ${m.discord_id} failed:`, err.message);
    }
  }));
}

// ── Promote a Soldier to Capo (Don only) ──
router.post("/:id(\\d+)/members/:discordId/promote", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  const outfitId = parseInt(req.params.id, 10);
  try {
    const role = await outfits.getMemberRole(outfitId, user.discord_id);
    if (role !== "don") return res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent("Only the Don can promote.")}`);
    await outfits.promoteMember(outfitId, req.params.discordId);
    res.redirect(`/outfits/${outfitId}?success=${encodeURIComponent("Promoted to Capo.")}`);
  } catch (err) {
    res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent(`Promote failed: ${err.message}`)}`);
  }
});

// ── Demote a Capo to Soldier (Don only) ──
router.post("/:id(\\d+)/members/:discordId/demote", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  const outfitId = parseInt(req.params.id, 10);
  try {
    const role = await outfits.getMemberRole(outfitId, user.discord_id);
    if (role !== "don") return res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent("Only the Don can demote.")}`);
    await outfits.demoteMember(outfitId, req.params.discordId);
    res.redirect(`/outfits/${outfitId}?success=${encodeURIComponent("Demoted to Soldier.")}`);
  } catch (err) {
    res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent(`Demote failed: ${err.message}`)}`);
  }
});

// ── Cancel a pending invite (Don/Capo only) ──
router.post("/:id(\\d+)/invites/:token/cancel", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  const outfitId = parseInt(req.params.id, 10);
  try {
    await outfits.cancelInvite(req.params.token, user.discord_id);
    res.redirect(`/outfits/${outfitId}?success=${encodeURIComponent("Invite cancelled.")}`);
  } catch (err) {
    res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent(`Cancel failed: ${err.message}`)}`);
  }
});

// ── Web-based invite by searching Arma username → resolve discord_id → create invite → DM ──
router.post("/:id/invite", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  const outfitId = parseInt(req.params.id, 10);
  const searchUsername = (req.body.search_username || "").trim();
  if (!searchUsername) return res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent("Username required.")}`);

  try {
    const axios = require("axios");
    const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });

    const searchRes = await apiClient({ method: "GET", url: "/user/searchUsersByUsername/", data: { search: searchUsername, token: config.apiToken } });
    const players = searchRes.data?.users || searchRes.data?.data || searchRes.data;
    const match = Array.isArray(players) ? players.find(p => (p.arma_username || "").toLowerCase() === searchUsername.toLowerCase()) || players[0] : null;
    if (!match || !match.arma_id) throw new Error(`Player "${searchUsername}" not found.`);

    const { getClient } = require("../discord-bot");
    const bot = getClient();
    if (!bot?.isReady()) throw new Error("Discord bot not connected.");
    const guild = bot.guilds.cache.get(config.discordGuildId);
    if (!guild) throw new Error("Guild not found.");

    const fetched = await guild.members.search({ query: searchUsername, limit: 5 });
    const discordMember = fetched.first();
    if (!discordMember) throw new Error(`Couldn't find a Discord member matching "${searchUsername}". They need to be in the Discord server.`);

    const targetDiscordId = discordMember.id;

    const invite = await outfits.createInvite(outfitId, targetDiscordId, user.discord_id);
    const link = `${config.siteUrl}/outfits/invite/${invite.token}`;

    try {
      await discordMember.send({
        embeds: [{
          color: 0x5865F2,
          title: `⚔️ Outfit Invite — [${invite.outfitTag}] ${invite.outfitName}`,
          description: `**${user.username}** invited you to join **[${invite.outfitTag}] ${invite.outfitName}**.\n\n**[Click here to accept →](${link})**\n\nExpires in ${outfits.INVITE_EXPIRE_HOURS}h.`,
        }],
      });
    } catch {}

    res.redirect(`/outfits/${outfitId}?success=${encodeURIComponent(`Invite sent to ${discordMember.user.username}. They'll get a DM with the accept link.`)}`);
  } catch (err) {
    res.redirect(`/outfits/${outfitId}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── Dedicated create page ──
router.get("/create", async (req, res) => {
  const user = req.session.user || null;
  buildAvatar(user);
  let userOutfit = null;
  let wastedCoinsBalance = null;
  let balanceWarning = false;
  if (user?.discord_id) {
    try { userOutfit = await outfits.getMemberOutfit(user.discord_id); } catch {}
    try {
      const wc = require("../wasted-coins");
      wastedCoinsBalance = wc.getBalance(user.discord_id);
      if (wastedCoinsBalance < outfits.CREATE_COST) balanceWarning = true;
    } catch {}
  }
  res.render("outfit-create", {
    page: "outfits",
    pageTitle: "Create an Outfit",
    pageDescription: "Form a mercenary outfit on Arma Wasteland. Wage wars, share treasury, climb the leaderboard.",
    user,
    userOutfit,
    wastedCoinsBalance,
    balanceWarning,
    constants: {
      MAX_MEMBERS_DEFAULT: outfits.MAX_MEMBERS_DEFAULT,
      CREATE_COST: outfits.CREATE_COST,
    },
    errorMessage: req.query.error || null,
  });
});

// ── Create outfit via web ──
router.post("/create", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/discord");
  const { name, tag, motto, color } = req.body;
  try {
    const wastedCoins = require("../wasted-coins");
    const outfit = await outfits.createOutfit(user.discord_id, name, tag, { username: user.username, wastedCoins });
    if (motto || color) {
      await outfits.updateOutfit(outfit.id, { motto, color });
    }
    res.redirect(`/outfits/${outfit.id}`);
  } catch (err) {
    res.redirect("/outfits?error=" + encodeURIComponent(err.message));
  }
});

module.exports = router;
