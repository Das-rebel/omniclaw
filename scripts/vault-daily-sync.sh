#!/bin/bash
#
# Vault Daily Sync Pipeline
# Runs full scrape + ingest + sync nodes + push vault.db to GCS
# Cron: 4 AM UTC daily
#
set -euo pipefail

PIPELINE_DIR="/Users/Subho/omniclaw/services/vault-pipeline"
DEPLOY_DIR="/Users/Subho/omniclaw/infrastructure/cloud-functions/deploy"
PYTHON="/usr/local/bin/python3"
LOG="/tmp/vault_sync.log"

echo "===== Vault Daily Sync - $(date -u '+%Y-%m-%d %H:%M:%S UTC') =====" >> "$LOG" 2>&1

# --- Step 1: Run full sync pipeline (scrape twitter + instagram, ingest, export to GCS) ---
echo "[1/4] Running sync_pipeline.py (scrape + ingest + export)..." >> "$LOG" 2>&1
cd "$PIPELINE_DIR"
"$PYTHON" sync_pipeline.py >> "$LOG" 2>&1
SYNC_EXIT=$?
if [ $SYNC_EXIT -ne 0 ]; then
    echo "[ERROR] sync_pipeline.py exited with code $SYNC_EXIT" >> "$LOG" 2>&1
    exit $SYNC_EXIT
fi
echo "[1/4] sync_pipeline.py completed" >> "$LOG" 2>&1

# --- Step 2: Sync bookmarks (bookmarks table) → nodes table ---
echo "[2/4] Syncing bookmarks → nodes..." >> "$LOG" 2>&1
cd "$DEPLOY_DIR"
"$PYTHON" sync_bookmarks_to_nodes.py >> "$LOG" 2>&1
echo "[2/4] nodes sync complete" >> "$LOG" 2>&1

# --- Step 3: Upload updated vault.db to GCS so Cloud Run picks it up ---
echo "[3/4] Uploading vault.db to GCS..." >> "$LOG" 2>&1
VaultDB="$DEPLOY_DIR/learning_base/vault.db"
if [ -f "$VaultDB" ]; then
    gsutil cp "$VaultDB" "gs://omniclaw-knowledge-graph/learning_base/vault.db" >> "$LOG" 2>&1
    echo "[3/4] vault.db uploaded ($(stat -f%z "$VaultDB" 2>/dev/null || stat -c%s "$VaultDB" 2>/dev/null || echo '?') bytes)" >> "$LOG" 2>&1
else
    echo "[WARN] vault.db not found at $VaultDB" >> "$LOG" 2>&1
fi

# --- Step 4: Verify GCS files ---
echo "[4/4] Verifying GCS fingerprints..." >> "$LOG" 2>&1
/opt/homebrew/bin/gsutil ls -la gs://omniclaw-knowledge-graph/vault/unified_bookmarks.json >> "$LOG" 2>&1
/opt/homebrew/bin/gsutil ls -la gs://omniclaw-knowledge-graph/learning_base/vault.db >> "$LOG" 2>&1
echo "[4/4] Done" >> "$LOG" 2>&1

echo "===== Vault Daily Sync Complete - $(date -u '+%Y-%m-%d %H:%M:%S UTC') =====" >> "$LOG" 2>&1
echo "" >> "$LOG" 2>&1
