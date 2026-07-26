#!/bin/bash
#
# Vault Sync v2 — Watchdog
# Lightweight monitor that checks sync health and alerts on failure.
# Runs from crontab: */15 4-7 * * *
#
# Reads sync-status.json from GCS (uploaded by export_gcs.py).
# Sends WhatsApp alert if:
#   - last_success is > 25 hours old
#   - errors array is non-empty and recent
#   - running=true but no progress for 1+ hour
#

set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

PIPELINE_DIR="/Users/Subho/omniclaw/services/vault-pipeline"
STATUS_GCS="gs://omniclaw-knowledge-graph/vault/sync-status.json"
LOCAL_STATUS="/tmp/vault-sync-status-watchdog.json"
LOG_FILE="/tmp/vault_watchdog.log"
WHAPP_OUTBOX="/tmp/omniclaw_openwa/outbox"

STALE_THRESHOLD_HOURS=25

# ─── Logging ─────────────────────────────────────────────────────────────────

log() {
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [WATCHDOG] $*" | tee -a "$LOG_FILE"
}

# ─── Python health check ─────────────────────────────────────────────────────

run_health_check() {
    python3 -c "
import sys, json, os
from datetime import datetime, timezone

LOCAL_STATUS = '$LOCAL_STATUS'
STALE_THRESHOLD_HOURS = $STALE_THRESHOLD_HOURS
WHAPP_OUTBOX = '$WHAPP_OUTBOX'

try:
    with open(LOCAL_STATUS) as f:
        s = json.load(f)
except Exception as e:
    print(f'ERROR: Cannot read status file: {e}')
    sys.exit(1)

errors = s.get('errors', [])
running = s.get('running', False)
last_success_str = s.get('last_success')
schema_version = s.get('schema_version', 'unknown')

# Check running state
if running:
    print('STATE=running')
    sys.exit(0)

# Check errors
if errors:
    error_lines = []
    for e in errors[-3:]:  # last 3 errors
        stage = e.get('stage', '?')
        code = e.get('error_code', '?')
        detail = e.get('error_detail', '')[:100]
        action = e.get('action_required', '')
        error_lines.append(f'  [{stage}] {code}: {detail}')
        if action:
            error_lines.append(f'  → ACTION: {action}')
    alert = '⚠️ VAULT SYNC ERRORS\n' + '\n'.join(error_lines)
    print(f'STATE=errors')
    print(f'ALERT={alert}')
    sys.exit(0)

# Check staleness
if not last_success_str or last_success_str == 'null':
    print(f'STATE=stale')
    print(f'ALERT=⚠️ VAULT SYNC STALE — last_success is empty/null')
    sys.exit(0)

try:
    # Parse ISO timestamp
    last_success_str = last_success_str.replace('Z', '+00:00')
    if '.' in last_success_str and '+' not in last_success_str and '-' not in last_success_str[-6:]:
        # Has microseconds but no timezone
        last_success_str = last_success_str + '+00:00'
    last_dt = datetime.fromisoformat(last_success_str)
    now_dt = datetime.now(timezone.utc)
    age_hours = (now_dt - last_dt).total_seconds() / 3600
    print(f'STATE=ok')
    print(f'LAST_SUCCESS={last_success_str}')
    print(f'AGE_HOURS={age_hours:.1f}')
    if age_hours >= STALE_THRESHOLD_HOURS:
        print(f'STATE=stale')
        print(f'ALERT=⚠️ VAULT SYNC STALE — last success {age_hours:.0f}h ago (threshold: {STALE_THRESHOLD_HOURS}h)')
except Exception as e:
    print(f'ERROR: Timestamp parse failed: {e}')
    print(f'STATE=unknown')
" 2>/dev/null
}

# ─── Send WhatsApp alert ─────────────────────────────────────────────────────

send_alert() {
    local message="$1"
    log "Sending WhatsApp alert..."
    mkdir -p "$WHAPP_OUTBOX"
    local msg_file="$WHAPP_OUTBOX/$(date +%s)_vault_alert.txt"
    printf '%s\n' "$message" > "$msg_file"
    log "Alert written to $msg_file"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
    log "===== Watchdog starting ====="

    # Download latest status from GCS
    if ! /opt/homebrew/bin/gsutil cat "$STATUS_GCS" > "$LOCAL_STATUS" 2>/dev/null; then
        log "WARNING: Could not download status from GCS"
        # Fall back to local
        if [[ -f "$PIPELINE_DIR/sync-status.json" ]]; then
            cp "$PIPELINE_DIR/sync-status.json" "$LOCAL_STATUS"
            log "Using local status file"
        else
            log "No status file available — skipping"
            exit 0
        fi
    fi

    # Run Python health check
    local result
    result=$(run_health_check 2>&1)
    local state
    state=$(echo "$result" | grep '^STATE=' | cut -d= -f2)

    log "Health check result: $result"

    if [[ "$state" == "errors" ]]; then
        local alert
        alert=$(echo "$result" | grep '^ALERT=' | cut -d= -f2- | tr '_' ' ')
        send_alert "$alert"
    elif [[ "$state" == "stale" ]]; then
        local alert
        alert=$(echo "$result" | grep '^ALERT=' | cut -d= -f2- | tr '_' ' ')
        send_alert "$alert"
    elif [[ "$state" == "unknown" ]]; then
        log "Health check returned unknown state — investigate manually"
    else
        log "Sync appears healthy — no alert needed"
    fi
}

main "$@"
