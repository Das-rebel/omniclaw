#!/bin/bash
# OpenWA Send - Send WhatsApp message via OpenWA REST API
# Auto-detects cloud session if local not available
set -euo pipefail

OPENWA_URL="${OPENWA_URL:-}"
OPENWA_KEY="${OPENWA_KEY:-dev-admin-key}"
OPENWA_SESSION="${OPENWA_SESSION:-}"

# If no URL provided, try cloud first, then local
if [ -z "$OPENWA_URL" ]; then
  # Try cloud first (for 24/7 operation)
  CLOUD_URL="https://openwa-api-338789220059.asia-south1.run.app"
  
  # Check if cloud has active session
  CLOUD_SESSIONS=$(curl -sf -s "${CLOUD_URL}/api/sessions" -H "X-API-Key: ${OPENWA_KEY}" 2>/dev/null | python3 -c "
import json,sys
try:
    sessions = json.load(sys.stdin)
    active = [s for s in sessions if s.get('status') == 'ready']
    if active:
        print(active[0]['id'])
    else:
        print('')
except:
    print('')
" 2>/dev/null) || CLOUD_SESSIONS=""
  
  if [ -n "$CLOUD_SESSIONS" ]; then
    OPENWA_URL="$CLOUD_URL"
    OPENWA_SESSION="$CLOUD_SESSIONS"
    echo "[OpenWA] Using cloud session: $OPENWA_SESSION"
  else
    # Fall back to local
    OPENWA_URL="http://localhost:2785"
    # Auto-detect local session
    OPENWA_SESSION=$(curl -sf -s "${OPENWA_URL}/api/sessions" \
      -H "X-API-Key: ${OPENWA_KEY}" | python3 -c "
import json,sys
try:
    sessions = json.load(sys.stdin)
    active = [s for s in sessions if s.get('status') == 'ready']
    print(active[0]['id'] if active else '')
except: print('')
" 2>/dev/null) || true
  fi
fi

# If still no session, error
if [ -z "$OPENWA_SESSION" ]; then
  echo "[OpenWA] ERROR: No active WhatsApp session found"
  echo "[OpenWA] Cloud: https://openwa-api-338789220059.asia-south1.run.app"
  echo "[OpenWA] Local: http://localhost:2785"
  exit 1
fi

JID="${1:-}"
MESSAGE="${2:-}"

if [ -z "$JID" ] || [ -z "$MESSAGE" ] || [ "$JID" = "-" ]; then
  echo "Usage: openwa-send.sh <jid> <message>"
  echo "   or: echo 'message' | openwa-send.sh <jid> -"
  exit 1
fi

# Send message
RESP=$(curl -sf -s -X POST "${OPENWA_URL}/api/sessions/${OPENWA_SESSION}/messages/send-text" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${OPENWA_KEY}" \
  -d "{\"chatId\":\"${JID}\",\"text\":\"${MESSAGE}\"}" 2>&1) || {
  echo "[OpenWA] Send failed: $RESP"
  exit 1
}

echo "[OpenWA] Sent to $JID: $MESSAGE"
