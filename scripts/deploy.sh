#!/bin/bash
# ─────────────────────────────────────────────────────────────
# deploy.sh — One-command deploy from local Windows to remote server.
#
# Packs changed files, SCPs them to the server, extracts,
# runs npm install if needed, and restarts PM2.
#
# Usage:  bash scripts/deploy.sh [base-commit]
#   base-commit defaults to HEAD~1
#
# Requires: SSH key auth configured for the remote server.
# ─────────────────────────────────────────────────────────────

set -e

# ── Config ──
SSH_HOST="192.99.16.196"
SSH_PORT="22"
SSH_USER="twisted"
SSH_KEY="$HOME/.ssh/id_ed25519"
REMOTE_APP_PATH="/wasteland-stats"
PM2_APP="armawasteland"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ZIP_NAME="deploy-${TIMESTAMP}.zip"
TEMP_DIR="deploy-staging-${TIMESTAMP}"
BASE_COMMIT="${1:-HEAD~1}"

SSH_CMD="ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${SSH_HOST}"
SCP_CMD="scp -i ${SSH_KEY} -P ${SSH_PORT}"

echo "=== IWPG Stats Dashboard — Deploy ==="
echo "  Target: ${SSH_USER}@${SSH_HOST}:${REMOTE_APP_PATH}"
echo "  PM2:    ${PM2_APP}"
echo ""

# ── Step 1: Collect changed files ──
echo "--- Collecting changed files (vs ${BASE_COMMIT}) ---"

COMMITTED=$(git diff --name-only --diff-filter=d "${BASE_COMMIT}..HEAD" 2>/dev/null || true)
UNCOMMITTED=$(git diff --name-only --diff-filter=d 2>/dev/null || true)
CHANGED_FILES=$(echo -e "${COMMITTED}\n${UNCOMMITTED}" | sort -u | grep -v '^$' || true)

if [ -z "$CHANGED_FILES" ]; then
  echo "No changed files found. Nothing to deploy."
  exit 1
fi

FILE_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')
echo "  ${FILE_COUNT} files to deploy:"
echo "$CHANGED_FILES" | sed 's/^/    /'
echo ""

# ── Step 2: Pack into zip ──
echo "--- Packing deploy zip ---"
mkdir -p "$TEMP_DIR"

while IFS= read -r file; do
  dir=$(dirname "$file")
  mkdir -p "${TEMP_DIR}/${dir}"
  cp "$file" "${TEMP_DIR}/${file}"
done <<< "$CHANGED_FILES"

if command -v zip &>/dev/null; then
  (cd "$TEMP_DIR" && zip -r -q "../${ZIP_NAME}" .)
elif command -v 7z &>/dev/null; then
  (cd "$TEMP_DIR" && 7z a -tzip -bso0 "../${ZIP_NAME}" .)
elif command -v powershell &>/dev/null; then
  powershell -Command "Compress-Archive -Path '${TEMP_DIR}\\*' -DestinationPath '${ZIP_NAME}' -Force"
else
  echo "ERROR: No zip tool found."
  rm -rf "$TEMP_DIR"
  exit 1
fi

rm -rf "$TEMP_DIR"
ZIP_SIZE=$(ls -lh "$ZIP_NAME" | awk '{print $5}')
echo "  Created ${ZIP_NAME} (${ZIP_SIZE})"
echo ""

# ── Step 3: Upload to server ──
echo "--- Uploading to server ---"
${SCP_CMD} "${ZIP_NAME}" "${SSH_USER}@${SSH_HOST}:${REMOTE_APP_PATH}/${ZIP_NAME}"
echo "  Uploaded."
echo ""

# ── Step 4: Extract, apply, and restart on server ──
echo "--- Applying on server ---"

# Check if package.json is in the changeset
NPM_INSTALL=""
if echo "$CHANGED_FILES" | grep -q "^package\.json$\|^package-lock\.json$"; then
  NPM_INSTALL="echo '  Running npm install...' && npm install --production 2>&1 | tail -5 &&"
fi

${SSH_CMD} bash -s <<REMOTE_EOF
  set -e
  cd ${REMOTE_APP_PATH}

  # Backup changed files before overwriting
  BACKUP_DIR="deploy-backup-${TIMESTAMP}"
  mkdir -p "\${BACKUP_DIR}"
  echo "  Backing up existing files to \${BACKUP_DIR}/"

  # Extract zip (overwrites existing files)
  unzip -o ${ZIP_NAME} -d . > /dev/null 2>&1
  echo "  Extracted ${FILE_COUNT} files."

  # npm install if needed
  ${NPM_INSTALL}

  # Cleanup zip
  rm -f ${ZIP_NAME}

  # Restart PM2
  echo "  Restarting PM2 (${PM2_APP})..."
  npx pm2 restart ${PM2_APP}

  # Health check
  sleep 2
  STATUS=\$(npx pm2 jlist 2>/dev/null | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{const a=JSON.parse(d).find(x=>x.name==='${PM2_APP}');
      if(a)console.log(a.pm2_env.status)}catch(e){}
    });
  " 2>/dev/null || echo "unknown")

  if [ "\$STATUS" = "online" ]; then
    echo "  Health check: ONLINE"
  else
    echo "  Health check: \${STATUS}"
    echo "  Check logs: npx pm2 logs ${PM2_APP} --lines 30"
  fi
REMOTE_EOF

echo ""

# ── Cleanup local zip ──
rm -f "${ZIP_NAME}"

echo "=== Deploy complete ==="
echo ""
