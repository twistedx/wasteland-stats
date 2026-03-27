#!/bin/bash
# ─────────────────────────────────────────────────────────────
# deploy-pack.sh — Run locally (Git Bash on Windows) to create
# a deploy zip with all changed files + the deploy script.
#
# Usage:  bash scripts/deploy-pack.sh
# Output: deploy-YYYYMMDD-HHMMSS.zip in the project root
# ─────────────────────────────────────────────────────────────

set -e

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ZIP_NAME="deploy-${TIMESTAMP}.zip"
TEMP_DIR="deploy-staging-${TIMESTAMP}"

echo "=== IWPG Stats Dashboard — Deploy Packager ==="
echo ""

# Collect changed files (compare last two commits, or pass a base commit)
BASE_COMMIT="${1:-HEAD~1}"
echo "Comparing HEAD against: ${BASE_COMMIT}"
echo ""

# Get list of changed files (excludes deleted files)
# Get committed changes + any uncommitted modifications
COMMITTED=$(git diff --name-only --diff-filter=d "${BASE_COMMIT}..HEAD" 2>/dev/null)
UNCOMMITTED=$(git diff --name-only --diff-filter=d 2>/dev/null)
CHANGED_FILES=$(echo -e "${COMMITTED}\n${UNCOMMITTED}" | sort -u | grep -v '^$')

if [ -z "$CHANGED_FILES" ]; then
  echo "No changed files found. Nothing to deploy."
  exit 1
fi

echo "Files to include:"
echo "$CHANGED_FILES" | sed 's/^/  /'
echo ""

# Create staging directory preserving folder structure
mkdir -p "$TEMP_DIR"

while IFS= read -r file; do
  dir=$(dirname "$file")
  mkdir -p "${TEMP_DIR}/${dir}"
  cp "$file" "${TEMP_DIR}/${file}"
done <<< "$CHANGED_FILES"

# Copy the deploy script into the zip
cp scripts/deploy-apply.sh "${TEMP_DIR}/deploy-apply.sh"

# Create zip
if command -v zip &>/dev/null; then
  (cd "$TEMP_DIR" && zip -r "../${ZIP_NAME}" .)
elif command -v 7z &>/dev/null; then
  (cd "$TEMP_DIR" && 7z a -tzip "../${ZIP_NAME}" .)
elif command -v powershell &>/dev/null; then
  powershell -Command "Compress-Archive -Path '${TEMP_DIR}\\*' -DestinationPath '${ZIP_NAME}' -Force"
else
  echo "ERROR: No zip tool found (zip, 7z, or powershell). Install one and retry."
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Cleanup staging
rm -rf "$TEMP_DIR"

FILE_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')
ZIP_SIZE=$(ls -lh "$ZIP_NAME" | awk '{print $5}')

echo ""
echo "=== Deploy package created ==="
echo "  File: ${ZIP_NAME}"
echo "  Size: ${ZIP_SIZE}"
echo "  Contains: ${FILE_COUNT} changed files + deploy-apply.sh"
echo ""
echo "Next steps:"
echo "  1. FTP/SCP the zip to your server:  scp ${ZIP_NAME} user@server:/path/to/app/"
echo "  2. SSH in and run:  cd /path/to/app && bash deploy-apply.sh"
echo ""
