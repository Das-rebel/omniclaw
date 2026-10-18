#!/bin/bash
#
# Vault Daily Sync Pipeline (Mac side, simplified)
# Runs scrape + ingest locally; exports to local vault.db only.
# GCS export was disabled 2026-10-18 because the omniclaw-knowledge-graph
# bucket no longer exists. The droplet's cron (run_daily_sync.sh) handles
# the real daily sync and writes to /opt/vault-search/vault.db there.
#
# Cron: 4 AM UTC daily (disabled by default — uncomment the cron entry
# in crontab if you want the Mac to also run sync)
#
set -euo pipefail

PIPELINE_DIR="/Users/Subho/omniclaw/services/vault-pipeline"
DEPLOY_DIR="/Users/Subho/omniclaw/infrastructure/cloud-functions/deploy"
PYTHON="/usr/local/bin/python3"
LOG="/tmp/vault_sync.log"

echo "===== Vault Daily Sync - $(date -u '+%Y-%m-%d %H:%M:%S UTC') =====" >> "$LOG" 2>&1

# --- Step 0: Local cookie check (no GCS) ---
echo "[0/3] Cookie check (local files only)..." >> "$LOG" 2>&1
TWITTER_COOKIES_FILE="$HOME/.twscrape_cookies.json"
INSTAGRAM_COOKIES_FILE="$HOME/.instagram_cookies.json"
if [ -f "$TWITTER_COOKIES_FILE" ]; then
  export TWITTER_COOKIES=$(cat "$TWITTER_COOKIES_FILE")
fi
if [ -f "$INSTAGRAM_COOKIES_FILE" ]; then
  export INSTAGRAM_COOKIES=$(cat "$INSTAGRAM_COOKIES_FILE")
fi
export TWITTER_USERNAME="Subhojit_Sarkar"
export INSTAGRAM_USERNAME="subhojit.sarkar"
echo "[0/3] Twitter cookies: $([ -f "$TWITTER_COOKIES_FILE" ] && echo yes || echo no), Instagram cookies: $([ -f "$INSTAGRAM_COOKIES_FILE" ] && echo yes || echo no)" >> "$LOG" 2>&1

# --- Step 1: Run sync_pipeline (scrape + ingest, no GCS export) ---
echo "[1/3] Running sync_pipeline.py..." >> "$LOG" 2>&1
cd "$PIPELINE_DIR"
"$PYTHON" sync_pipeline.py --db "$DEPLOY_DIR/learning_base/vault.db" --no-export >> "$LOG" 2>&1
SYNC_EXIT=$?
if [ $SYNC_EXIT -ne 0 ]; then
    echo "[ERROR] sync_pipeline.py exited with $SYNC_EXIT" >> "$LOG" 2>&1
    # Don't exit — let the rest run
fi
echo "[1/3] sync_pipeline.py completed" >> "$LOG" 2>&1

# --- Step 2: Skip nodes table (deprecated since 2026-10-18) ---
# The nodes table was the legacy schema that search_api_v2.py used to query.
# As of the VaultBrain fixes (commits 0024373, 59b3955), queries go directly
# to the bookmarks table. We no longer sync to nodes.
echo "[2/3] Skipping nodes table sync (deprecated 2026-10-18)" >> "$LOG" 2>&1

# --- Step 3: GCS export disabled ---
# The omniclaw-knowledge-graph bucket was deleted. The droplet's
# /opt/vault-search/vault.db is the authoritative source now.
echo "[3/3] GCS export disabled (bucket omniclaw-knowledge-graph not found 2026-10-18)" >> "$LOG" 2>&1

echo "===== Vault Daily Sync Complete - $(date -u '+%Y-%m-%d %H:%M:%S UTC') =====" >> "$LOG" 2>&1
echo "" >> "$LOG" 2>&1
