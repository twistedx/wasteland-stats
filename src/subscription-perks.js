const axios = require("axios");
const config = require("./config");
const skinDraw = require("./skin-draw");
const { sendWebhook, sendWebhookError } = require("./webhook");

const apiClient = axios.create({ baseURL: config.apiBaseUrl, timeout: 15000, headers: { "Content-Type": "application/json" } });

const DEFAULT_BANK_LIMIT = 150000;

const SUBSCRIPTION_TIERS = {
  "Bronze Package +":            { bankLimit: 300000, skinsPerMonth: 0 },
  "Silver Discord Supporter":    { bankLimit: 500000, skinsPerMonth: 1 },
  "Gold Discord Supporter":      { bankLimit: 500000, skinsPerMonth: 2 },
  "Amazing Discord Support":     { bankLimit: 500000, skinsPerMonth: 3 },
  "Super Discord Supporter":     { bankLimit: 750000, skinsPerMonth: 3 },
  "Platinum Discord Supporter":  { bankLimit: 750000, skinsPerMonth: 3 },
  "Diamond Discord Supporter":   { bankLimit: 1000000, skinsPerMonth: 4 },
  "Legendary Discord Supporter": { bankLimit: 1000000, skinsPerMonth: 5 },
};

function getTierForProduct(productName) {
  return SUBSCRIPTION_TIERS[productName] || null;
}

async function resolveArmaId(discordId) {
  try {
    const res = await apiClient({ method: "GET", url: "/user/getAllPlayerStatsByDiscordID", data: { discord_id: discordId, token: config.apiToken } });
    if (res.data?.arma_id) return res.data.arma_id;
    // Some responses don't have arma_id but have arma_username — try to get arma_id from username
    if (res.data?.arma_username) {
      const idRes = await apiClient({ method: "GET", url: "/user/getPlayerIDsByName", data: { arma_username: res.data.arma_username, token: config.apiToken } });
      if (idRes.data?.data?.[0]?.arma_id) return idRes.data.data[0].arma_id;
    }
    return null;
  } catch (err) {
    console.error("SubscriptionPerks: failed to resolve arma_id for", discordId, err.message);
    return null;
  }
}

async function setBankLimit(armaId, limit) {
  try {
    const res = await axios.post(`${config.apiBaseUrl}/admin/atm-limit`, {
      token: config.adminApiToken,
      arma_id: armaId,
      atm_limit: limit,
    }, { timeout: 10000 });
    console.log(`SubscriptionPerks: set bank limit ${limit} for arma_id ${armaId}:`, res.data?.message || res.status);
    return true;
  } catch (err) {
    console.error(`SubscriptionPerks: failed to set bank limit for ${armaId}:`, err.response?.data?.message || err.message);
    return false;
  }
}

async function grantSkins(discordId, count) {
  // Draw all skins first, then grant in parallel
  const skins = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const skin = skinDraw.draw();
    if (!skin) {
      console.warn("SubscriptionPerks: skin draw pool is empty, cannot grant skin");
      break;
    }
    skinDraw.recordDraw({
      discord_id: discordId,
      result_name: skin.name,
      result_rarity: skin.rarity,
      stripe_session_id: `sub-perk-${discordId}-${now}-${i}`,
    });
    skins.push(skin);
  }

  const results = await Promise.all(skins.map(async (skin) => {
    try {
      await apiClient.post(
        "/itemsUser/updateDiscordUserItemFromDiscord",
        { discord_id: discordId, item_name: skin.name, request_type: "set", quantity: 1 },
        { params: { token: config.backendToken } }
      );
      console.log(`SubscriptionPerks: granted "${skin.name}" (${skin.rarity}) to ${discordId}`);
      return { name: skin.name, rarity: skin.rarity, success: true };
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`SubscriptionPerks: failed to grant "${skin.name}" to ${discordId}:`, msg);
      return { name: skin.name, rarity: skin.rarity, success: false, error: msg };
    }
  }));

  return results;
}

async function applyPerks(discordId, productName, cachedArmaId) {
  const tier = getTierForProduct(productName);
  if (!tier) {
    console.log(`SubscriptionPerks: no tier mapping for "${productName}", skipping`);
    return;
  }

  console.log(`SubscriptionPerks: applying perks for "${productName}" to ${discordId} — bank: ${tier.bankLimit}, skins: ${tier.skinsPerMonth}`);

  const armaId = cachedArmaId || await resolveArmaId(discordId);
  const results = { bankLimit: false, skins: [] };

  if (armaId) {
    results.bankLimit = await setBankLimit(armaId, tier.bankLimit);
  } else {
    console.warn(`SubscriptionPerks: could not resolve arma_id for ${discordId}, skipping bank limit`);
  }

  if (tier.skinsPerMonth > 0) {
    results.skins = await grantSkins(discordId, tier.skinsPerMonth);
  }

  // Webhook notification
  const skinSummary = results.skins.length > 0
    ? `\nSkins: ${results.skins.map(s => `${s.name} (${s.rarity})${s.success ? "" : " FAILED"}`).join(", ")}`
    : "";
  sendWebhook({
    title: "Subscription Perks Applied",
    description: `**${productName}**\nBank limit: ${results.bankLimit ? tier.bankLimit.toLocaleString() : "FAILED"}${skinSummary}`,
    color: 0x22c55e,
  });

  return results;
}

async function revokePerks(discordId) {
  console.log(`SubscriptionPerks: revoking perks for ${discordId}`);

  const armaId = await resolveArmaId(discordId);
  if (armaId) {
    await setBankLimit(armaId, DEFAULT_BANK_LIMIT);
    sendWebhook({
      title: "Subscription Perks Revoked",
      description: `Bank limit reset to ${DEFAULT_BANK_LIMIT.toLocaleString()} for Discord user ${discordId}`,
      color: 0xf04747,
    });
  } else {
    sendWebhookError("Subscription Revoke Failed", `Could not resolve arma_id for ${discordId} to reset bank limit`);
  }
}

module.exports = { applyPerks, revokePerks, grantSkins, getTierForProduct, resolveArmaId, SUBSCRIPTION_TIERS, DEFAULT_BANK_LIMIT };
