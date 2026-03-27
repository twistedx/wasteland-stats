#!/bin/bash
# ─────────────────────────────────────────────────────────────
# deploy-apply.sh — Run on the server after uploading the zip.
#
# Usage:
#   1. Upload the deploy zip to your app directory
#   2. Unzip it:        unzip -o deploy-*.zip
#   3. Run this script: bash deploy-apply.sh [pm2-app-name]
#
# Examples:
#   bash deploy-apply.sh              # auto-detects pm2 process
#   bash deploy-apply.sh iwpg-stats   # explicit pm2 process name
#
# What it does:
#   - Backs up current files to deploy-backup-TIMESTAMP/
#   - Copies updated files into place (preserves directory structure)
#   - Runs npm install (only if package.json changed)
#   - Restarts the pm2 process and shows status
# ─────────────────────────────────────────────────────────────

set -e

PM2_APP="${1:-}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="deploy-backup-${TIMESTAMP}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== IWPG Stats Dashboard — Deploy Script ==="
echo "  Server: $(hostname)"
echo "  Time:   $(date)"
echo "  Dir:    ${SCRIPT_DIR}"
echo ""

# Files to deploy (everything in the zip except this script and meta files)
DEPLOY_FILES=$(find . -type f \
  ! -name "deploy-apply.sh" \
  ! -name "deploy-pack.sh" \
  ! -path "./deploy-backup-*" \
  ! -name "*.zip" \
  | sed 's|^\./||')

if [ -z "$DEPLOY_FILES" ]; then
  echo "ERROR: No files found to deploy. Make sure you unzipped in the app directory."
  exit 1
fi

echo "Files to deploy:"
echo "$DEPLOY_FILES" | sed 's/^/  /'
echo ""

# ── Step 1: Backup existing files ──
echo "--- Creating backup in ${BACKUP_DIR}/ ---"
mkdir -p "$BACKUP_DIR"

BACKED_UP=0
while IFS= read -r file; do
  if [ -f "$file" ]; then
    dir=$(dirname "$file")
    mkdir -p "${BACKUP_DIR}/${dir}"
    cp "$file" "${BACKUP_DIR}/${file}"
    BACKED_UP=$((BACKED_UP + 1))
  fi
done <<< "$DEPLOY_FILES"
echo "  Backed up ${BACKED_UP} existing files"
echo ""

# ── Step 2: Apply updated files ──
echo "--- Applying updates ---"
UPDATED=0
while IFS= read -r file; do
  dir=$(dirname "$file")
  mkdir -p "$dir"
  if [ -f "$file" ]; then
    UPDATED=$((UPDATED + 1))
    echo "  Updated: $file"
  else
    echo "  NEW:     $file"
    UPDATED=$((UPDATED + 1))
  fi
done <<< "$DEPLOY_FILES"
echo ""
echo "  ${UPDATED} files applied"
echo ""

# ── Step 3: npm install if dependencies changed ──
if echo "$DEPLOY_FILES" | grep -q "^package.json$\|^package-lock.json$"; then
  echo "--- package.json changed, running npm install ---"
  npm install --production 2>&1 | tail -10
  echo ""
fi

# ── Step 4: Restart pm2 ──
echo "--- Restarting pm2 process ---"

if ! command -v pm2 &>/dev/null; then
  echo "  WARNING: pm2 not found in PATH."
  echo "  Try: export PATH=\$PATH:\$(npm root -g)/.bin"
  echo "  Then: pm2 restart <app-name>"
  echo ""
  echo "=== Deploy complete (manual restart needed) ==="
  exit 0
fi

# Auto-detect pm2 app name if not provided
if [ -z "$PM2_APP" ]; then
  # Get the first running pm2 process name
  PM2_APP=$(pm2 jlist 2>/dev/null | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try {
        const apps = JSON.parse(d);
        if (apps.length > 0) console.log(apps[0].name);
      } catch(e) {}
    });
  " 2>/dev/null)

  if [ -z "$PM2_APP" ]; then
    echo "  Could not auto-detect pm2 process name."
    echo "  Run: pm2 list"
    echo "  Then: pm2 restart <your-app-name>"
    echo ""
    echo "=== Deploy complete (manual restart needed) ==="
    exit 0
  fi

  echo "  Auto-detected pm2 process: ${PM2_APP}"
fi

echo "  Restarting: ${PM2_APP}"
pm2 restart "$PM2_APP"
echo ""

# Show status
echo "--- pm2 status ---"
pm2 show "$PM2_APP" | head -20
echo ""

# Quick health check — wait 3 seconds then check if process is online
sleep 3
PM2_STATUS=$(pm2 jlist 2>/dev/null | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try {
      const apps = JSON.parse(d);
      const app = apps.find(a => a.name === '${PM2_APP}');
      if (app) {
        console.log(app.pm2_env.status);
        if (app.pm2_env.restart_time > 5) console.error('WARNING: high restart count (' + app.pm2_env.restart_time + ')');
      }
    } catch(e) {}
  });
" 2>&1)

if echo "$PM2_STATUS" | grep -q "online"; then
  echo "  Health check: ONLINE"
else
  echo "  Health check: ${PM2_STATUS:-UNKNOWN}"
  echo "  Check logs:   pm2 logs ${PM2_APP} --lines 30"
fi

echo ""
echo "=== Deploy complete ==="
echo "  Backup:   ${BACKUP_DIR}/"
echo "  Rollback: cp -r ${BACKUP_DIR}/* . && pm2 restart ${PM2_APP}"
echo "  Logs:     pm2 logs ${PM2_APP} --lines 50"
echo ""
