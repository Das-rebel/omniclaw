#!/bin/bash
#
# Vault Sync v2 — Rollback Script
# Switches from v2 to v1 pipeline in one command.
# Use when v2 fails and you need to restore v1 quickly.
#
# Usage:
#   bash rollback-v2.sh [--reason "your reason here"]
#

set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

PLIST="$HOME/Library/LaunchAgents/com.omniclaw.vault-daily-sync.plist"
REASON="${1:-manual trigger}"
LOG="$HOME/omniclaw/services/vault-pipeline/incident-log.md"

log() {
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [ROLLBACK] $*"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
    log "===== ROLLBACK v2 → v1 STARTING ====="
    log "Reason: $REASON"

    # 1. Kill any running v2 processes
    log "[1/5] Killing running vault sync processes..."
    pkill -f "vault-daily-sync" 2>/dev/null || true
    pkill -f "scrape_twitter.py" 2>/dev/null || true
    pkill -f "scrape_instagram.py" 2>/dev/null || true
    pkill -f "enrich_pending.py" 2>/dev/null || true
    pkill -f "ingest_staging.py" 2>/dev/null || true

    # 2. Remove stale lock
    log "[2/5] Removing stale lock..."
    rm -f /tmp/vault-sync.lock

    # 3. Switch launchd to v1 script
    log "[3/5] Switching launchd to v1..."
    if [[ -f "$PLIST" ]]; then
        # Backup v2 plist
        cp "$PLIST" "${PLIST}.v2.bak.$(date +%Y%m%d%H%M%S)"

        # Swap to v1 script
        sed -i '' \
            's|vault-daily-sync-v2\.sh|vault-daily-sync.sh|g' \
            "$PLIST"

        # Reload launchd
        launchctl unload "$PLIST" 2>/dev/null || true
        launchctl load "$PLIST" 2>/dev/null || true
        log "Launchd switched to v1"
    else
        log "WARNING: Launchd plist not found at $PLIST"
    fi

    # 4. Write incident log
    log "[4/5] Writing incident log..."
    mkdir -p "$(dirname "$LOG")"
    cat >> "$LOG" <<EOF

## Incident $(date -u '+%Y-%m-%dT%H:%M:%SZ')
**Type:** v2 rollback
**Reason:** $REASON
**Triggered by:** $(whoami)

Pipeline v2 was rolled back to v1.
Investigate v2 failure and fix before redeploying.
EOF
    log "Incident logged to $LOG"

    # 5. WhatsApp alert
    log "[5/5] Sending WhatsApp alert..."
    WHAPP_OUTBOX="/tmp/omniclaw_openwa/outbox"
    ALERT_MSG="🔄 VAULT SYNC ROLLED BACK
v2 → v1 (reason: $REASON)
Mac Mini: investigate and fix v2.
v1 is now running via launchd."
    mkdir -p "$WHAPP_OUTBOX"
    echo "$ALERT_MSG" > "$WHAPP_OUTBOX/$(date +%s)_rollback.txt"
    log "Alert sent"

    log "===== ROLLBACK COMPLETE ====="
    echo ""
    echo "✅ Rolled back to v1"
    echo "📋 Incident logged: $LOG"
    echo "🔧 To re-deploy v2: edit launchd plist to point to vault-daily-sync-v2.sh"
}

main "$@"
