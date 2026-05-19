#!/bin/bash
#
# OpenWA Send - Send WhatsApp message via OpenWA REST API
# Usage:
#   ./openwa-send.sh <jid> <message>
#   echo "message" | ./openwa-send.sh <jid> -
#
# Environment:
#   OPENWA_URL      - API base (default: http://localhost:2785)
#   OPENWA_KEY      - API key (default: dev-admin-key)
#   OPENWA_SESSION  - Session ID (default: auto-detect active)
set -euo pipefail

OPENWA_URL="${OPENWA_URL:-http://localhost:2785}"
OPENWA_KEY="${OPENWA_KEY:-dev-admin-key}"
OPENWA_SESSION="${OPENWA_SESSION:-}"

# Auto-detect session if not set
if [ -z "$OPENWA_SESSION" ]; then
  OPENWA_SESSION=$(curl -sf "${OPENWA_URL}/api/sessions" \
    -H "X-API-Key: ${OPENWA_KEY}" | python3 -c "
import json,sys
try:
    sessions = json.load(sys.stdin)
    active = [s for s in sessions if s.get('status') == 'ready']
    print(active[0]['id'] if active else '')
except: print('')
" 2>/dev/null) || true
fi

TARGET_JID="$1"
shift || true

if [ -z "$TARGET_JID" ]; then
  echo "Usage: $0 <jid> [message]" >&2
  exit 1
fi

# Get message from args or stdin
if [ "${1:-}" = "-" ]; then
  MESSAGE=$(cat)
elif [ -n "${1:-}" ]; then
  MESSAGE="$*"
else
  echo "Error: No message provided" >&2
  exit 1
fi

if [ -z "$OPENWA_SESSION" ]; then
  echo "[OpenWA] No active session" >&2
  exit 1
fi

PAYLOAD=$(python3 -c "
import json,sys
msg = sys.argv[1]
print(json.dumps({'chatId': sys.argv[2], 'text': msg}))
" "$MESSAGE" "$TARGET_JID")

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "${OPENWA_URL}/api/sessions/${OPENWA_SESSION}/messages/send-text" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${OPENWA_KEY}" \
  -d "$PAYLOAD")

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "[OpenWA] Sent to ${TARGET_JID}"
  exit 0
else
  echo "[OpenWA] Failed (HTTP ${HTTP_CODE})" >&2
  exit 1
fi
