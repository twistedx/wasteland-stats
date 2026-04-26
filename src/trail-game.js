const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DB_DIR, "trail-game.db");

// ── Constants ──
const ENTRY_COST = 500;
const TOTAL_STAGES = 10;
const DAILY_PLAYS = 3;
const PAYOUT_TABLE = [0, 0, 100, 200, 350, 500, 750, 1000, 1500, 2500, 5000]; // index = stages survived

const STAGES = [
  {
    title: "The Journey Begins",
    text: "You set out from Independence, Missouri with a wagon, some supplies, and a dream of reaching the West Coast. The trail stretches out before you.",
    emoji: "🏕️",
  },
  {
    title: "River Crossing",
    text: "A swollen river blocks your path. The water is fast and deep.",
    emoji: "🌊",
    choices: [
      { label: "Ford the river", emoji: "🏊", id: "ford" },
      { label: "Find a bridge", emoji: "🌉", id: "bridge" },
      { label: "Build a raft", emoji: "🪵", id: "raft" },
    ],
    outcomes: {
      ford:   { survive: 0.55, deathMsg: "The current swept your wagon away. You drowned.", surviveMsg: "You made it across soaking wet, but alive!" },
      bridge: { survive: 0.80, deathMsg: "The bridge collapsed under the wagon's weight.", surviveMsg: "You found a rickety bridge upstream. It held!" },
      raft:   { survive: 0.70, deathMsg: "The raft broke apart in the rapids.", surviveMsg: "Your makeshift raft held together. Onward!" },
    },
  },
  {
    title: "Bandit Ambush",
    text: "Riders appear on the ridge. They don't look friendly.",
    emoji: "🤠",
    choices: [
      { label: "Stand and fight", emoji: "⚔️", id: "fight" },
      { label: "Outrun them", emoji: "🏃", id: "run" },
      { label: "Negotiate", emoji: "🤝", id: "negotiate" },
    ],
    outcomes: {
      fight:     { survive: 0.60, deathMsg: "They outnumbered you. You died in a hail of gunfire.", surviveMsg: "You drove them off! Found some supplies in their saddlebags." },
      run:       { survive: 0.70, deathMsg: "Your wagon wheel snapped mid-chase. They caught up.", surviveMsg: "You outran them! Lost some supplies but you're alive." },
      negotiate: { survive: 0.50, deathMsg: "Negotiations broke down. They shot first.", surviveMsg: "You talked your way out and even traded for fresh water." },
    },
  },
  {
    title: "Hunting Grounds",
    text: "Your food supplies are running low. You spot a herd of buffalo in the distance.",
    emoji: "🦬",
    choices: [
      { label: "Hunt the buffalo", emoji: "🔫", id: "hunt" },
      { label: "Forage for berries", emoji: "🫐", id: "forage" },
      { label: "Push on hungry", emoji: "😤", id: "push" },
    ],
    outcomes: {
      hunt:   { survive: 0.80, deathMsg: "A buffalo charged and trampled you.", surviveMsg: "You bagged a buffalo! Enough meat for weeks." },
      forage: { survive: 0.65, deathMsg: "The berries were poisonous. You didn't make it.", surviveMsg: "You found wild berries, nuts, and clean water. Enough to keep going." },
      push:   { survive: 0.50, deathMsg: "Starvation took you three days later.", surviveMsg: "Sheer willpower kept you going. You found a trading post ahead!" },
    },
  },
  {
    title: "Mountain Pass",
    text: "The Rocky Mountains loom ahead. Snow is already falling on the peaks.",
    emoji: "🏔️",
    choices: [
      { label: "Take the high pass", emoji: "⛰️", id: "high" },
      { label: "Go through the canyon", emoji: "🪨", id: "canyon" },
      { label: "Wait for spring", emoji: "⏳", id: "wait" },
    ],
    outcomes: {
      high:   { survive: 0.50, deathMsg: "A blizzard hit at the summit. You froze to death.", surviveMsg: "You crossed the pass just before the big snow. Incredible views!" },
      canyon: { survive: 0.65, deathMsg: "A rockslide buried the trail and your wagon.", surviveMsg: "Narrow, dark, and cold — but you made it through the canyon." },
      wait:   { survive: 0.75, deathMsg: "Supplies ran out waiting. You starved before the thaw.", surviveMsg: "Spring came. The pass was clear and you crossed easily." },
    },
  },
  {
    title: "Cholera Outbreak",
    text: "Members of your party are falling ill. The water may be contaminated.",
    emoji: "🤒",
    choices: [
      { label: "Boil all water", emoji: "🔥", id: "boil" },
      { label: "Push through it", emoji: "💪", id: "push" },
      { label: "Find fresh spring", emoji: "💧", id: "spring" },
    ],
    outcomes: {
      boil:   { survive: 0.80, deathMsg: "Too late — the disease had already spread.", surviveMsg: "Boiling the water stopped the outbreak. You recovered." },
      push:   { survive: 0.40, deathMsg: "You have died of dysentery.", surviveMsg: "Your iron constitution pulled you through somehow." },
      spring: { survive: 0.65, deathMsg: "The 'fresh' spring was also contaminated.", surviveMsg: "You found clean water up the hill. The sick recovered." },
    },
  },
  {
    title: "Native Territory",
    text: "You've entered tribal lands. A war party approaches your wagon.",
    emoji: "🪶",
    choices: [
      { label: "Offer gifts", emoji: "🎁", id: "gifts" },
      { label: "Show strength", emoji: "💪", id: "strength" },
      { label: "Detour south", emoji: "🧭", id: "detour" },
    ],
    outcomes: {
      gifts:    { survive: 0.80, deathMsg: "Your gifts were seen as an insult. Arrows flew.", surviveMsg: "They accepted your gifts and showed you a safer route west." },
      strength: { survive: 0.45, deathMsg: "They were not impressed. You were overwhelmed.", surviveMsg: "They respected your courage and let you pass." },
      detour:   { survive: 0.70, deathMsg: "The southern route led through a scorching desert. You didn't make it.", surviveMsg: "The detour cost you time but you avoided conflict." },
    },
  },
  {
    title: "Desert Crossing",
    text: "Nothing but sand and sun for miles. Your water barrels are half empty.",
    emoji: "🏜️",
    choices: [
      { label: "Travel at night", emoji: "🌙", id: "night" },
      { label: "Ration water hard", emoji: "🥵", id: "ration" },
      { label: "Race through fast", emoji: "🐎", id: "race" },
    ],
    outcomes: {
      night:  { survive: 0.75, deathMsg: "You lost the trail in the darkness and wandered in circles.", surviveMsg: "Cool nights, slow days. You crossed the desert safely." },
      ration: { survive: 0.55, deathMsg: "The rationing was too severe. Dehydration took you.", surviveMsg: "Every drop counted. You made it to the other side." },
      race:   { survive: 0.50, deathMsg: "The horses collapsed from exhaustion. You were stranded.", surviveMsg: "A mad dash! You burst through to green hills beyond." },
    },
  },
  {
    title: "Broken Wagon",
    text: "A wheel shatters on a rock. You're stuck in the wilderness.",
    emoji: "🛞",
    choices: [
      { label: "Repair it", emoji: "🔧", id: "repair" },
      { label: "Continue on foot", emoji: "🥾", id: "walk" },
      { label: "Wait for help", emoji: "🙏", id: "wait" },
    ],
    outcomes: {
      repair: { survive: 0.70, deathMsg: "The repair failed and the wagon rolled off a cliff.", surviveMsg: "MacGyver'd a fix with spare wood. Back on the trail!" },
      walk:   { survive: 0.55, deathMsg: "You couldn't carry enough supplies on foot. You collapsed.", surviveMsg: "You abandoned the wagon but walked to the next settlement." },
      wait:   { survive: 0.60, deathMsg: "Nobody came. Wolves found you first.", surviveMsg: "Another wagon train came through and helped you out." },
    },
  },
  {
    title: "The Final Stretch",
    text: "You can see the Pacific coast! But one last mountain range stands between you and Oregon.",
    emoji: "🌅",
    choices: [
      { label: "Push through", emoji: "🏁", id: "push" },
      { label: "Take the safe path", emoji: "🛤️", id: "safe" },
      { label: "Celebrate early", emoji: "🎉", id: "celebrate" },
    ],
    outcomes: {
      push:      { survive: 0.70, deathMsg: "So close... an avalanche on the final pass buried you.", surviveMsg: "YOU MADE IT! The green valleys of Oregon stretch before you!" },
      safe:      { survive: 0.85, deathMsg: "The 'safe' path had a washed-out bridge. You fell.", surviveMsg: "The long way around, but you arrived safely in Oregon!" },
      celebrate: { survive: 0.45, deathMsg: "You celebrated too hard and got careless on the final pass. A fall ended it all.", surviveMsg: "After the party, you stumbled into Oregon with a smile!" },
    },
  },
];

let db = null;

function init() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  db.exec(`CREATE TABLE IF NOT EXISTS trail_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    username TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    stage INTEGER NOT NULL DEFAULT 0,
    entry_cost INTEGER NOT NULL DEFAULT ${ENTRY_COST},
    payout INTEGER DEFAULT 0,
    choices TEXT DEFAULT '[]',
    message_id TEXT,
    channel_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS trail_leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    username TEXT,
    stages_survived INTEGER NOT NULL,
    payout INTEGER NOT NULL,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.exec("CREATE INDEX IF NOT EXISTS idx_trail_discord ON trail_games(discord_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_trail_lb ON trail_leaderboard(stages_survived DESC, payout DESC)");

  const total = db.prepare("SELECT COUNT(*) as n FROM trail_games").get().n;
  console.log(`TrailGame: ${total} games played.`);
}

function playsToday(discordId) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare("SELECT COUNT(*) as n FROM trail_games WHERE discord_id = ? AND substr(created_at, 1, 10) = ?").get(String(discordId), today).n;
}

function getActiveGame(discordId) {
  return db.prepare("SELECT * FROM trail_games WHERE discord_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(String(discordId)) || null;
}

function startGame(discordId, username, wastedCoins) {
  if (getActiveGame(discordId)) throw new Error("You already have an active trail run! Finish it first.");
  if (playsToday(discordId) >= DAILY_PLAYS) throw new Error(`You've used all ${DAILY_PLAYS} trail runs for today. Come back tomorrow!`);

  wastedCoins.spendCoins(discordId, ENTRY_COST, "trail_entry", { meta: { game: "trail" } });

  const r = db.prepare("INSERT INTO trail_games (discord_id, username, entry_cost) VALUES (?, ?, ?)").run(String(discordId), username, ENTRY_COST);
  return { id: r.lastInsertRowid, stage: 0 };
}

function getStage(stageIndex) {
  if (stageIndex < 0 || stageIndex >= STAGES.length) return null;
  return STAGES[stageIndex];
}

function processChoice(gameId, choiceId, wastedCoins) {
  const game = db.prepare("SELECT * FROM trail_games WHERE id = ?").get(gameId);
  if (!game || game.status !== "active") throw new Error("No active game.");

  let stage = STAGES[game.stage];
  // If current stage has no outcomes (intro), find the stage that owns this choice
  if (!stage || !stage.outcomes || !stage.outcomes[choiceId]) {
    const found = STAGES.findIndex(s => s.outcomes && s.outcomes[choiceId]);
    if (found >= 0) {
      db.prepare("UPDATE trail_games SET stage = ? WHERE id = ?").run(found, gameId);
      stage = STAGES[found];
    } else {
      throw new Error("Invalid stage.");
    }
  }

  const outcome = stage.outcomes[choiceId];
  if (!outcome) throw new Error("Invalid choice.");

  // Randomize survival odds: base ±20%, clamped to 0.15–0.90
  // Plus a per-game "luck shuffle" so the best choice varies each run
  const baseSurvive = outcome.survive;
  const swing = (Math.random() - 0.5) * 0.40; // -0.20 to +0.20
  const stageLuck = (Math.random() - 0.5) * 0.15; // per-stage jitter
  const effectiveSurvive = Math.max(0.15, Math.min(0.90, baseSurvive + swing + stageLuck));
  const survived = Math.random() < effectiveSurvive;
  const choices = JSON.parse(game.choices || "[]");
  choices.push({ stage: game.stage, choice: choiceId, survived });

  if (survived) {
    const newStage = game.stage + 1;
    if (newStage >= TOTAL_STAGES) {
      // Won the whole trail!
      const payout = PAYOUT_TABLE[TOTAL_STAGES];
      db.prepare("UPDATE trail_games SET stage = ?, status = 'won', payout = ?, choices = ?, ended_at = datetime('now') WHERE id = ?")
        .run(newStage, payout, JSON.stringify(choices), gameId);
      db.prepare("INSERT INTO trail_leaderboard (discord_id, username, stages_survived, payout) VALUES (?, ?, ?, ?)")
        .run(game.discord_id, game.username, TOTAL_STAGES, payout);
      if (payout > 0) {
        wastedCoins.addCoins(game.discord_id, payout, "trail_payout", { username: game.username, bypassCap: true, meta: { game_id: gameId, stages: TOTAL_STAGES } });
      }
      return { survived: true, won: true, stage: newStage, payout, msg: outcome.surviveMsg, game };
    }
    db.prepare("UPDATE trail_games SET stage = ?, choices = ? WHERE id = ?").run(newStage, JSON.stringify(choices), gameId);
    return { survived: true, won: false, stage: newStage, currentPayout: PAYOUT_TABLE[newStage], msg: outcome.surviveMsg, game };
  } else {
    // Dead
    db.prepare("UPDATE trail_games SET status = 'dead', choices = ?, ended_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(choices), gameId);
    db.prepare("INSERT INTO trail_leaderboard (discord_id, username, stages_survived, payout) VALUES (?, ?, ?, ?)")
      .run(game.discord_id, game.username, game.stage, 0);
    return { survived: false, won: false, stage: game.stage, payout: 0, msg: outcome.deathMsg, game };
  }
}

function cashOut(gameId, wastedCoins) {
  const game = db.prepare("SELECT * FROM trail_games WHERE id = ?").get(gameId);
  if (!game || game.status !== "active") throw new Error("No active game.");
  if (game.stage < 2) throw new Error("You need to survive at least 2 stages before cashing out.");

  const payout = PAYOUT_TABLE[game.stage] || 0;
  db.prepare("UPDATE trail_games SET status = 'cashout', payout = ?, ended_at = datetime('now') WHERE id = ?").run(payout, gameId);
  db.prepare("INSERT INTO trail_leaderboard (discord_id, username, stages_survived, payout) VALUES (?, ?, ?, ?)")
    .run(game.discord_id, game.username, game.stage, payout);
  if (payout > 0) {
    wastedCoins.addCoins(game.discord_id, payout, "trail_cashout", { username: game.username, bypassCap: true, meta: { game_id: gameId, stages: game.stage } });
  }
  return { payout, stage: game.stage };
}

function getLeaderboard(limit = 10) {
  return db.prepare("SELECT * FROM trail_leaderboard ORDER BY stages_survived DESC, payout DESC LIMIT ?").all(limit);
}

function getStats(discordId) {
  const total = db.prepare("SELECT COUNT(*) as n FROM trail_games WHERE discord_id = ?").get(String(discordId)).n;
  const wins = db.prepare("SELECT COUNT(*) as n FROM trail_games WHERE discord_id = ? AND status = 'won'").get(String(discordId)).n;
  const best = db.prepare("SELECT MAX(stage) as n FROM trail_games WHERE discord_id = ?").get(String(discordId)).n || 0;
  const totalPayout = db.prepare("SELECT COALESCE(SUM(payout), 0) as n FROM trail_games WHERE discord_id = ?").get(String(discordId)).n;
  return { total, wins, best, totalPayout, playsToday: playsToday(discordId), maxPlays: DAILY_PLAYS };
}

function advanceStage(gameId, newStage) {
  db.prepare("UPDATE trail_games SET stage = ? WHERE id = ? AND status = 'active'").run(newStage, gameId);
}

function updateMessageId(gameId, messageId, channelId) {
  db.prepare("UPDATE trail_games SET message_id = ?, channel_id = ? WHERE id = ?").run(messageId, channelId, gameId);
}

module.exports = {
  init, ENTRY_COST, TOTAL_STAGES, DAILY_PLAYS, PAYOUT_TABLE, STAGES,
  startGame, getActiveGame, getStage, processChoice, cashOut, advanceStage,
  getLeaderboard, getStats, playsToday, updateMessageId,
};
