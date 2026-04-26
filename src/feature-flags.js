const fs = require("fs");
const path = require("path");

const FLAGS_FILE = path.join(__dirname, "..", "data", "feature-flags.json");

const DEFAULTS = {
  wasted_coins: true,
  lottery: true,
  skin_lottery: true,
  kill_wagers: true,
  outfits: false,
};

const LABELS = {
  wasted_coins: "Wasted Coins (/daily, /balance, coin economy)",
  lottery: "Weekly Coin Lottery (/lottery)",
  skin_lottery: "Weekly Skin Lottery (/skin-lottery)",
  kill_wagers: "Kill Wagers (/wager)",
  outfits: "Outfits & Wars (/outfit, /war)",
};

let flags = {};

function load() {
  try {
    if (fs.existsSync(FLAGS_FILE)) {
      flags = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FLAGS_FILE, "utf8")) };
    } else {
      flags = { ...DEFAULTS };
      save();
    }
  } catch (e) {
    console.warn("FeatureFlags: failed to load, using defaults:", e.message);
    flags = { ...DEFAULTS };
  }
  console.log("FeatureFlags:", Object.entries(flags).map(([k, v]) => `${k}=${v ? "ON" : "OFF"}`).join(", "));
}

function save() {
  try {
    const dir = path.dirname(FLAGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = FLAGS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(flags, null, 2));
    fs.renameSync(tmp, FLAGS_FILE);
  } catch (e) {
    console.error("FeatureFlags: failed to save:", e.message);
  }
}

function isEnabled(flag) {
  return !!flags[flag];
}

function setEnabled(flag, enabled) {
  if (!(flag in DEFAULTS)) throw new Error(`Unknown flag: ${flag}`);
  flags[flag] = !!enabled;
  save();
}

function getAll() {
  return Object.keys(DEFAULTS).map(k => ({
    key: k,
    label: LABELS[k] || k,
    enabled: !!flags[k],
  }));
}

module.exports = { load, isEnabled, setEnabled, getAll, LABELS };
