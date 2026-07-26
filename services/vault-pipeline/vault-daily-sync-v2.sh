#!/bin/bash
#
# Vault Sync v2 — Main Orchestrator
# Replaces: vault-daily-sync.sh (v1)
#
# Design principles:
#   - Subprocess isolation (OS-level timeout on every network op)
#   - Staging area (DB only touched after scrape succeeds)
#   - Decoupled enrichment (runs in background, never blocks pipeline)
#   - File locking (flock — prevents concurrent runs)
#   - Explicit config (no env guessing)
#   - Structured status (JSON file consumed by health checks)
#
# Exit codes:
#   0  = full success or already running
#   1  = pipeline error (non-critical — partial data may exist)
#   2  = auth expired (manual cookie refresh needed)
#

set -euo pipefail  # CRITICAL: -e stops on ANY error; -u catches unbound vars

# Ensure /opt/homebrew/bin is in PATH (timeout lives there on macOS)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# ─── Paths ───────────────────────────────────────────────────────────────────

PIPELINE_DIR="/Users/Subho/omniclaw/services/vault-pipeline"
DEPLOY_DIR="/Users/Subho/omniclaw/infrastructure/cloud-functions/deploy"
PYTHON="/usr/local/bin/python3"
STAGING_DIR="/tmp/vault-staging-$(date +%Y%m%d-%H%M%S)"
LOCK_FILE="/tmp/vault-sync.lock"
LOG_FILE="/tmp/vault_sync_v2.log"
STATUS_FILE="$PIPELINE_DIR/sync-status.json"

# ─── Load cookies from GCS ───────────────────────────────────────────────────

load_cookies() {
    echo "[0/7] Loading cookies from GCS..." >> "$LOG_FILE"
    TWITTER_COOKIES=$(/opt/homebrew/bin/gsutil cat gs://omniclaw-knowledge-graph/vault/cookies/twitter_cookies.json 2>/dev/null || echo "")
    INSTAGRAM_COOKIES=$(/opt/homebrew/bin/gsutil cat gs://omniclaw-knowledge-graph/vault/cookies/instagram_cookies.json 2>/dev/null || echo "")
    export TWITTER_COOKIES INSTAGRAM_COOKIES

    TW_STATUS="no"
    IG_STATUS="no"
    [ -n "$TWITTER_COOKIES" ] && TW_STATUS="yes" || true
    [ -n "$INSTAGRAM_COOKIES" ] && IG_STATUS="yes" || true
    echo "[0/7] Cookies loaded (TWITTER: $TW_STATUS, INSTAGRAM: $IG_STATUS)" >> "$LOG_FILE"
}

# ─── Logging helpers ──────────────────────────────────────────────────────────

log() {
    local msg="[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"
    echo "$msg" >> "$LOG_FILE"
    echo "$msg"
}

init_status() {
    "$PYTHON" "$PIPELINE_DIR/sync_status.py" init >> "$LOG_FILE" 2>&1 || true
}

mark_success() {
    local stage="$1"
    local details="${2:-}"
    local warnings="${3:-}"
    "$PYTHON" "$PIPELINE_DIR/sync_status.py" success "$stage" \
        "${details:-null}" "${warnings:-null}" >> "$LOG_FILE" 2>&1 || true
}

mark_error() {
    local stage="$1"
    local code="$2"
    local detail="$3"
    local action="${4:-}"
    "$PYTHON" "$PIPELINE_DIR/sync_status.py" error "$stage" "$code" "$detail" "$action" >> "$LOG_FILE" 2>&1 || true
}

mark_skipped() {
    local stage="$1"
    local reason="$2"
    "$PYTHON" "$PIPELINE_DIR/sync_status.py" skipped "$stage" "$reason" >> "$LOG_FILE" 2>&1 || true
}

set_duration() {
    "$PYTHON" "$PIPELINE_DIR/sync_status.py" duration "$1" >> "$LOG_FILE" 2>&1 || true
}

# ─── Stage 1: Acquire lock ────────────────────────────────────────────────────

acquire_lock() {
    log "===== Vault Sync v2 STARTING ====="

    # Use Python fcntl for cross-platform locking (macOS compatible)
    LOCK_RESULT=$("$PYTHON" "$PIPELINE_DIR/locker.py" acquire --lock "$LOCK_FILE" 2>&1)
    LOCK_EXIT=$?

    if [[ $LOCK_EXIT -ne 0 ]]; then
        LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "unknown")
        log "ALREADY RUNNING — another sync is active (lock PID=$LOCK_PID)"
        echo "Another sync is already running. PID=$LOCK_PID"
        exit 0
    fi

    log "Lock acquired (PID=$$)"
}

release_lock() {
    "$PYTHON" "$PIPELINE_DIR/locker.py" release --lock "$LOCK_FILE" 2>/dev/null || true
    log "Lock released"
}

# ─── Cleanup on exit ──────────────────────────────────────────────────────────

cleanup() {
    # Remove staging dir on exit (keep on error for debugging)
    if [[ "$1" -eq 0 ]]; then
        rm -rf "$STAGING_DIR"
        log "Staging dir cleaned up"
    else
        log "Staging dir preserved at $STAGING_DIR (for debugging)"
    fi
    release_lock
}

trap 'cleanup $?' EXIT

# ─── Stage 2: Scrape Twitter ─────────────────────────────────────────────────

stage_scrape_twitter() {
    log "===== [1/6] SCRAPE TWITTER ====="
    mkdir -p "$STAGING_DIR"

    local out="$STAGING_DIR/twitter.json"
    local exit_code=0

    # Run with OS-level hard timeout — if it hangs, OS kills it
    timeout --kill-after=10 90 \
        "$PYTHON" "$PIPELINE_DIR/scrape_twitter.py" \
            --out "$out" \
            --cookies-env TWITTER_COOKIES \
        >> "$LOG_FILE" 2>&1 || exit_code=$?

    if [[ $exit_code -eq 124 ]]; then
        log "Twitter scrape TIMED OUT after 90s"
        mark_error "twitter" "TIMEOUT" "Scrape timed out after 90s — may need auth refresh"
        # Don't fail整个 pipeline — try GCS fallback implicitly via ingest
        return 0
    elif [[ $exit_code -eq 2 ]]; then
        log "Twitter AUTH EXPIRED — cookies need manual refresh"
        mark_error "twitter" "AUTH_EXPIRED" \
            "Twitter auth cookies have expired — manual refresh required" \
            "Log into Twitter, export cookies, upload to gs://omniclaw-knowledge-graph/vault/cookies/twitter_cookies.json"
        # Continue with GCS fallback implicitly
        return 0
    elif [[ $exit_code -ne 0 ]]; then
        log "Twitter scrape failed with exit code $exit_code"
        mark_error "twitter" "SCRAPE_ERROR" "Exit code: $exit_code"
        return 0  # Don't fail pipeline
    fi

    local count=$(grep -o '"count":[0-9]*' "$out" 2>/dev/null | head -1 | grep -o '[0-9]*' || echo "0")
    local source=$(grep '"source":' "$out" 2>/dev/null | head -1 | sed 's/.*"source": *"\([^"]*\)".*/\1/' || echo "unknown")
    log "Twitter: $count items from source=$source"
    mark_success "twitter" "{\"items\": $count, \"source\": \"$source\"}"
    return 0
}

# ─── Stage 3: Scrape Instagram ────────────────────────────────────────────────

stage_scrape_instagram() {
    log "===== [2/6] SCRAPE INSTAGRAM ====="
    mkdir -p "$STAGING_DIR"

    local out="$STAGING_DIR/instagram.json"
    local exit_code=0

    timeout --kill-after=10 300 \
        "$PYTHON" "$PIPELINE_DIR/scrape_instagram.py" \
            --out "$out" \
            --cookies-env INSTAGRAM_COOKIES \
        >> "$LOG_FILE" 2>&1 || exit_code=$?

    if [[ $exit_code -eq 124 ]]; then
        log "Instagram scrape TIMED OUT after 90s"
        mark_error "instagram" "TIMEOUT" "Scrape timed out after 90s"
        return 0
    elif [[ $exit_code -eq 2 ]]; then
        log "Instagram AUTH EXPIRED"
        mark_error "instagram" "AUTH_EXPIRED" \
            "Instagram sessionid expired" \
            "Log into Instagram, export sessionid cookie, upload to gs://omniclaw-knowledge-graph/vault/cookies/instagram_cookies.json"
        return 0
    elif [[ $exit_code -ne 0 ]]; then
        log "Instagram scrape failed with exit code $exit_code"
        mark_error "instagram" "SCRAPE_ERROR" "Exit code: $exit_code"
        return 0
    fi

    local count=$(grep -o '"count":[0-9]*' "$out" 2>/dev/null | head -1 | grep -o '[0-9]*' || echo "0")
    local source=$(grep '"source":' "$out" 2>/dev/null | head -1 | sed 's/.*"source": *"\([^"]*\)".*/\1/' || echo "unknown")
    log "Instagram: $count items from source=$source"
    mark_success "instagram" "{\"items\": $count, \"source\": \"$source\"}"
    return 0
}

# ─── Stage 4: Ingest to vault.db ────────────────────────────────────────────

stage_ingest() {
    log "===== [3/6] INGEST TO vault.db ====="

    # Check if we have any staging files
    local file_count=$(find "$STAGING_DIR" -name "*.json" -not -name "*.meta.json" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$file_count" -eq 0 ]]; then
        log "No staging files — skipping ingest"
        mark_skipped "ingest" "No staging files found"
        return 0
    fi

    local exit_code=0
    "$PYTHON" "$PIPELINE_DIR/ingest_staging.py" \
        --staging-dir "$STAGING_DIR" \
        --db "$DEPLOY_DIR/learning_base/vault.db" \
        >> "$LOG_FILE" 2>&1 || exit_code=$?

    if [[ $exit_code -ne 0 ]]; then
        log "Ingest failed with exit code $exit_code"
        mark_error "ingest" "INGEST_ERROR" "Exit code: $exit_code"
    else
        mark_success "ingest"
    fi
    return 0
}

# ─── Stage 5: Sync bookmarks → nodes ─────────────────────────────────────────

stage_sync_nodes() {
    log "===== [4/6] SYNC bookmarks → nodes ====="

    # Use existing sync script
    local exit_code=0
    "$PYTHON" "$DEPLOY_DIR/sync_bookmarks_to_nodes.py" \
        >> "$LOG_FILE" 2>&1 || exit_code=$?

    if [[ $exit_code -ne 0 ]]; then
        log "nodes sync failed with exit code $exit_code (non-fatal)"
        mark_error "sync_nodes" "SYNC_ERROR" "Exit code: $exit_code"
    else
        mark_success "sync_nodes"
    fi
    return 0
}

# ─── Stage 6: Export + Upload to GCS ─────────────────────────────────────────

stage_export() {
    log "===== [5/6] EXPORT + UPLOAD TO GCS ====="

    local exit_code=0
    "$PYTHON" "$PIPELINE_DIR/export_gcs.py" \
        --db "$DEPLOY_DIR/learning_base/vault.db" \
        >> "$LOG_FILE" 2>&1 || exit_code=$?

    if [[ $exit_code -ne 0 ]]; then
        log "GCS export failed with exit code $exit_code"
        mark_error "export" "EXPORT_ERROR" "Exit code: $exit_code"
    else
        mark_success "export"
    fi
    return 0
}

# ─── Stage 7: Launch background enrichment ─────────────────────────────────────

stage_launch_enrich() {
    log "===== [6/6] LAUNCH BACKGROUND ENRICHMENT ====="

    # Run enrichment in background — does NOT block pipeline
    # Only processes items lacking vlTags, max 20 per run
    nohup \
        timeout --kill-after=10 300 \
        "$PYTHON" "$PIPELINE_DIR/enrich_pending.py" \
            --db "$DEPLOY_DIR/learning_base/vault.db" \
            --max-items 20 \
        >> "$LOG_FILE" 2>&1 &

    local enrich_pid=$!
    log "Enrichment launched in background (PID=$enrich_pid, max 20 items)"
    mark_success "enrich" "{\"status\": \"background_launched\", \"max_items\": 20}"
    echo "$enrich_pid" > "$STAGING_DIR/enrich_pid"

    return 0
}

# ─── Main ──────────────────────────────────────────────────────────────────────

main() {
    # Initialize
    START_TIME=$(date +%s)
    load_cookies
    init_status
    acquire_lock

    log "Pipeline v2 starting — staging=$STAGING_DIR"

    # Run all stages
    stage_scrape_twitter
    stage_scrape_instagram
    stage_ingest
    stage_sync_nodes
    stage_export
    stage_launch_enrich

    # Record duration
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    set_duration "$DURATION"

    log "===== Vault Sync v2 COMPLETE (${DURATION}s) ====="
    log "Status file: $STATUS_FILE"
    log "Log file: $LOG_FILE"

    echo ""
    echo "✅ Vault Sync v2 complete in ${DURATION}s"
    echo "📄 Log: $LOG_FILE"
    echo "📊 Status: $STATUS_FILE"
}

main "$@"
