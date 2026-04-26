# ArmaWasteland Site — CLAUDE.md

Project context for Claude Code. Load-bearing info to know at the start of every session.

## What this is

**IWPG Stats Dashboard** — the player stats, store, blog, and admin site for the ArmaWasteland (Arma Reforger) community server. Node.js/Express web app that talks to a backend game-server API, Discord (OAuth + bot), AMP game-server panel, Steam API, BattleMetrics (armahq), and Stripe.

- **Entry point:** [server.js](server.js) → [src/app.js](src/app.js)
- **Runs on:** port `3001` locally, PM2 process `armawasteland` on the production server
- **Public URL:** https://armawasteland.com
- **Templating:** express-handlebars (`.hbs` files in [views/](views/))
- **Data layer:** `better-sqlite3` — multiple `.db` files in [data/](data/), one per concern
- **Session store:** `session-file-store` → [sessions/](sessions/)

## Tech stack

- Node.js + Express 4
- Handlebars views (layouts + partials)
- better-sqlite3 (synchronous, WAL-mode SQLite)
- Discord OAuth (login) + discord.js bot (role checks, webhooks)
- Helmet, csrf-sync, express-rate-limit for hardening
- Stripe (store payments), Multer + Sharp (image uploads), Marked + DOMPurify (blog markdown)
- node-cron for scheduled tasks (VAC scans, economy tracking, metrics snapshots)

## Project layout

```
src/
  app.js              ← main Express app: middleware, IP auto-block, routes wiring, CSP, CSRF
  config.js           ← env-var loading + required-var validation
  routes/
    admin.js          ← /admin/** — requires Discord admin role
    api.js            ← /api/** — JSON endpoints, proxies to backend game-server API
    auth.js           ← /auth/discord/** — Discord OAuth flow
    blog.js           ← /blog/** — public blog + admin editing
  admin-users.js      ← local admin user db
  amp.js              ← AMP game-server panel client (start/stop/logs)
  analytics.js        ← page-view + visitor tracking
  armahq.js           ← BattleMetrics-style player lookups
  audit-log.js        ← admin action audit trail
  blog.js             ← blog post CRUD
  discord-bot.js      ← discord.js client init
  discord-stats.js    ← discord presence/member stats
  economy-tracker.js  ← in-game money tracking + ATM backfill
  ip-block.js         ← persistent IP ban list (auto + manual)
  metrics-history.js  ← time-series server metrics
  skin-draw.js        ← skin raffle/draw system
  steam-store.js      ← steam id cache
  store.js            ← in-game item store (Stripe-backed)
  subscription-perks.js ← recurring perk grants
  system-stats.js     ← OS/host stats
  tasks.js            ← player task/quest system
  vac-checker.js      ← single VAC lookup
  vac-scanner.js      ← scheduled bulk VAC scans + webhook alerts
  webhook.js          ← Discord webhook sender

views/                ← .hbs templates (main layout in views/layouts/main.hbs)
public/               ← static assets (css, js, img, favicons)
data/                 ← SQLite databases (many) + JSON caches
scripts/
  deploy.sh           ← bash: zip-changed-files → scp → npm i → pm2 restart
  deploy-run.js       ← Windows wrapper: invokes deploy.sh through Git Bash
  compress-images.js  ← image pipeline
  create-admin.js     ← create local admin user
sessions/             ← file-backed express-session store
```

## Running the app

```bash
npm start        # node server.js
npm run dev      # nodemon
npm run deploy   # scripts/deploy-run.js → packs & deploys changed files
```

## Deployment — important

Deploy is **incremental, not full sync**. `scripts/deploy.sh` diffs against `HEAD~1` by default (or a base commit you pass), zips just those files, scps to the server, extracts into `/home/twisted/wasteland-stats`, runs `npm install --production`, and `pm2 restart armawasteland`.

- Remote: `twisted@192.99.16.196:/home/twisted/wasteland-stats`
- PM2 app name: `armawasteland`
- SSH key: `C:/Users/SeanMainPC/.ssh/id_ed25519`
- **If you change files outside the last commit**, pass an older base commit: `npm run deploy -- HEAD~3`
- Uncommitted changes are included in the zip alongside committed ones.

## Environment

All config is env-driven via [src/config.js](src/config.js), loaded from [.env](.env). Required vars (app will throw on boot if missing):

- `API_BASE_URL`, `SERVER_READ_ONLY_TOKEN` — backend game-server API
- `SESSION_SECRET`
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`
- `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`

Plus role lists (`ADMIN_ROLE_IDS`, `ADMIN_WRITE_ROLE_IDS`, `BLOG_ROLE_IDS`), AMP creds, Stripe keys, Steam API key, SSH deploy config, webhook URLs.

**NEVER commit `.env`** — it contains live Discord bot tokens, Stripe live keys, and SSH config.

## Security model

- Sits behind Cloudflare — real client IP comes from `cf-connecting-ip` header; `trust proxy` is set to `1`.
- **Aggressive IP auto-block** in [src/app.js](src/app.js): instant permanent block for WordPress/PHP probe paths, suspicious file extensions, and request floods (>200 req/min). Persistent via [src/ip-block.js](src/ip-block.js) (`data/ip-blocks.db`). Whitelist is `WHITELISTED_IPS` env.
- CSRF: `csrf-sync` on all state-changing routes.
- CSP + hardening: `helmet` with a custom CSP.
- Admin gate: Discord OAuth → check session user's guild roles against `ADMIN_ROLE_IDS` / `ADMIN_WRITE_ROLE_IDS`.
- Blog editor gate: `BLOG_ROLE_IDS`.
- Markdown from blog posts is sanitized with DOMPurify before render.

## Data / SQLite conventions

- One db file per concern in `data/` (admin-users, analytics, audit, blog, discord-stats, economy, ip-blocks, metrics, steam, store, tasks, vac-scan).
- WAL mode is on (`.db-shm` + `.db-wal` siblings). **Do not delete `-shm`/`-wal` files** while the app is running.
- better-sqlite3 is synchronous — prepared statements are cached at module load.

## Conventions to follow

- **Keep new functionality scoped to an existing `src/*.js` module** when it fits; only add a new module for a genuinely new concern.
- Routes go under `src/routes/` and are wired in [src/app.js](src/app.js).
- All views extend `views/layouts/main.hbs`. Shared UI lives in `views/partials/`.
- Client-side assets are plain JS/CSS in `public/` — no bundler, no build step.
- Use `config.<key>` — don't read `process.env` directly outside [src/config.js](src/config.js).
- Log admin actions through `audit-log.js` where relevant.
- Don't bypass the IP-block or CSRF middleware.

## Things not to break

- Required env var validation in [src/config.js](src/config.js) — the app is meant to crash loudly on misconfig.
- The `trust proxy` + `cf-connecting-ip` chain — getting this wrong breaks rate limiting and IP bans.
- Incremental deploy assumption — if you rename/move files, make sure the old path is cleaned up on the server (deploy only *adds/updates*, it does not delete).
- SQLite WAL files — leave them alone.

## Quick commands

```bash
# Run locally
npm run dev

# Deploy last commit's changes
npm run deploy

# Deploy last 3 commits worth
npm run deploy -- HEAD~3

# Create a local admin user
node scripts/create-admin.js

# Compress new images in public/img
node scripts/compress-images.js
```
