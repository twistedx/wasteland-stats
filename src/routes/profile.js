const express = require("express");
const config = require("../config");
const profileCustomizations = require("../profile-customizations");
const wastedCoins = require("../wasted-coins");
const { sendWebhook, sendPublicWebhook } = require("../webhook");
const router = express.Router();

function requireUser(req, res, next) {
  if (!req.session.user || !req.session.user.discord_id) {
    return res.redirect("/auth/discord");
  }
  next();
}

// Find the user's most recent active (or scheduled-to-cancel) subscription on Stripe
async function findActiveSubscription(discordId) {
  if (!process.env.STRIPE_SECRET_KEY || !discordId) return null;
  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    // Use Stripe Search API to find active subscriptions for this discord_id
    const result = await stripe.subscriptions.search({
      query: `status:'active' AND metadata['discord_id']:'${discordId}'`,
      limit: 5,
    });
    if (!result.data.length) return null;
    // Pick the most recent
    const sub = result.data.sort((a, b) => b.created - a.created)[0];
    let productName = null;
    try {
      const cartItems = sub.metadata?.cart_items ? JSON.parse(sub.metadata.cart_items) : [];
      productName = cartItems[0]?.name || null;
    } catch {}
    return {
      id: sub.id,
      status: sub.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodEnd: sub.current_period_end,
      productName,
    };
  } catch (err) {
    console.error("findActiveSubscription error:", err.message);
    return null;
  }
}

// GET /profile/customize — catalog + equipped + owned
router.get("/customize", requireUser, async (req, res) => {
  const user = req.session.user;
  const discordId = user.discord_id;

  const allCatalog = profileCustomizations.getCatalog();
  const unlocks = profileCustomizations.getUnlocks(discordId);
  const equipped = profileCustomizations.getEquipped(discordId);
  const ownedIds = new Set(unlocks.map(u => u.id));
  const equippedBadgeIds = new Set(equipped.badges.map(b => b.id));

  const activeSubscription = await findActiveSubscription(discordId);
  if (activeSubscription?.currentPeriodEnd) {
    activeSubscription.currentPeriodEndDisplay = new Date(activeSubscription.currentPeriodEnd * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }

  const coinBalance = wastedCoins.getBalance(discordId);

  const grouped = {};
  for (const item of allCatalog) {
    if (!grouped[item.type]) grouped[item.type] = [];
    const coinPrice = wastedCoins.centsToCoins(item.price);
    grouped[item.type].push({
      ...item,
      owned: ownedIds.has(item.id),
      isEquipped: (item.type === "background" && equipped.background?.id === item.id)
        || (item.type === "name_color" && equipped.name_color?.id === item.id)
        || (item.type === "badge" && equippedBadgeIds.has(item.id)),
      priceFormatted: (item.price / 100).toFixed(2),
      coinPrice,
      canAffordCoins: coinBalance >= coinPrice,
    });
  }

  // Build avatar URL for header
  if (user.avatar && user.discord_id) {
    user.avatarUrl = `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png?size=128`;
  } else if (user.discord_id) {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  }

  res.render("profile-customize", {
    page: "profile",
    pageTitle: "Customize Profile",
    pageDescription: "Customize your player profile with backgrounds, badges, and name effects.",
    user,
    backgrounds: grouped.background || [],
    nameColors: grouped.name_color || [],
    badges: grouped.badge || [],
    equipped,
    activeSubscription,
    coinBalance,
    coinEmoji: wastedCoins.EMOJI,
    coinName: wastedCoins.NAME,
    successMessage: req.query.success || null,
    errorMessage: req.query.error || null,
  });
});

// POST /profile/customize/cancel-subscription — cancel at period end
router.post("/customize/cancel-subscription", requireUser, async (req, res) => {
  const user = req.session.user;
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.redirect("/profile/customize?error=" + encodeURIComponent("Subscription management not configured."));
  }
  try {
    const sub = await findActiveSubscription(user.discord_id);
    if (!sub) {
      return res.redirect("/profile/customize?error=" + encodeURIComponent("No active subscription found."));
    }
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    console.log(`Subscription scheduled to cancel: ${sub.id} for ${user.discord_id}`);
    try {
      const { sendWebhook } = require("../webhook");
      sendWebhook({
        title: "Subscription Cancellation Scheduled",
        description: `<@${user.discord_id}> scheduled cancellation of their **${sub.productName || "subscription"}** at period end.`,
        color: 0xF59E0B,
      });
    } catch {}
    res.redirect("/profile/customize?success=" + encodeURIComponent("Subscription will end on " + (sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000).toLocaleDateString("en-US") : "the next billing date") + ". You keep access until then."));
  } catch (err) {
    console.error("Cancel subscription error:", err.message);
    res.redirect("/profile/customize?error=" + encodeURIComponent("Failed to cancel: " + err.message));
  }
});

// POST /profile/customize/resume-subscription — undo a scheduled cancellation
router.post("/customize/resume-subscription", requireUser, async (req, res) => {
  const user = req.session.user;
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.redirect("/profile/customize?error=" + encodeURIComponent("Subscription management not configured."));
  }
  try {
    const sub = await findActiveSubscription(user.discord_id);
    if (!sub) {
      return res.redirect("/profile/customize?error=" + encodeURIComponent("No subscription found."));
    }
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    res.redirect("/profile/customize?success=" + encodeURIComponent("Subscription resumed — auto-renewal is back on."));
  } catch (err) {
    console.error("Resume subscription error:", err.message);
    res.redirect("/profile/customize?error=" + encodeURIComponent("Failed to resume: " + err.message));
  }
});

// POST /profile/customize/buy/:itemId — create Stripe checkout for a single profile item
router.post("/customize/buy/:itemId", requireUser, async (req, res) => {
  const user = req.session.user;
  const itemId = parseInt(req.params.itemId, 10);
  const item = profileCustomizations.getItem(itemId);

  if (!item || !item.active) {
    return res.redirect("/profile/customize?error=" + encodeURIComponent("Item not found."));
  }

  if (profileCustomizations.ownsItem(user.discord_id, itemId)) {
    return res.redirect("/profile/customize?error=" + encodeURIComponent("You already own this item."));
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.redirect("/profile/customize?error=" + encodeURIComponent("Payments are not configured."));
  }

  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const lineItem = item.stripe_price_id
      ? { price: item.stripe_price_id, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: "usd",
            product_data: {
              name: `Profile: ${item.name}`,
              description: item.description || undefined,
            },
            unit_amount: item.price,
          },
        };
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [lineItem],
      success_url: `${config.siteUrl}/profile/customize?success=${encodeURIComponent("Unlocked! Equip it below.")}`,
      cancel_url: `${config.siteUrl}/profile/customize?error=${encodeURIComponent("Purchase canceled.")}`,
      metadata: {
        app: "armawasteland",
        profile_item_id: String(itemId),
        discord_id: user.discord_id,
        username: user.username || "",
      },
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error("Profile buy checkout error:", err.message);
    res.redirect("/profile/customize?error=" + encodeURIComponent("Checkout failed: " + err.message));
  }
});

// POST /profile/customize/redeem-coins/:itemId — buy a profile item with Wasted Coins
router.post("/customize/redeem-coins/:itemId", requireUser, (req, res) => {
  const user = req.session.user;
  const itemId = parseInt(req.params.itemId, 10);
  const item = profileCustomizations.getItem(itemId);

  if (!item || !item.active) {
    return res.redirect("/profile/customize?error=" + encodeURIComponent("Item not found."));
  }
  if (profileCustomizations.ownsItem(user.discord_id, itemId)) {
    return res.redirect("/profile/customize?error=" + encodeURIComponent("You already own this item."));
  }

  const coinPrice = wastedCoins.centsToCoins(item.price);
  try {
    wastedCoins.spendCoins(user.discord_id, coinPrice, "redeem_profile", {
      meta: { item_id: itemId, item_name: item.name, type: item.type },
    });
    profileCustomizations.unlock(user.discord_id, itemId, { source: "coins" });

    try {
      sendPublicWebhook({
        title: "💀 Profile Item Redeemed",
        description: `<@${user.discord_id}> redeemed **${item.name}** (${item.type}) for **${coinPrice.toLocaleString()} 💀**`,
        color: 0x8B5CF6,
      });
    } catch {}

    res.redirect("/profile/customize?success=" + encodeURIComponent(`Unlocked "${item.name}" for ${coinPrice.toLocaleString()} 💀!`));
  } catch (err) {
    res.redirect("/profile/customize?error=" + encodeURIComponent(err.message));
  }
});

// POST /profile/customize/equip — equip / clear an item
router.post("/customize/equip", requireUser, (req, res) => {
  const user = req.session.user;
  const { type, item_id } = req.body;
  const itemId = item_id ? parseInt(item_id, 10) : null;

  try {
    profileCustomizations.equip(user.discord_id, type, itemId);
    res.redirect("/profile/customize?success=" + encodeURIComponent("Updated."));
  } catch (err) {
    res.redirect("/profile/customize?error=" + encodeURIComponent(err.message));
  }
});

module.exports = router;
