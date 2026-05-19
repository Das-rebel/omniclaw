#!/bin/bash
# Start OmniClaw WhatsApp Auto-Reply with OpenWA

SCRIPT_DIR="/tmp/omniclaw_openwa"
BOT_SCRIPT="/Users/Subho/omniclaw/scripts/omniclaw_direct_whatsapp.js"
LOG_FILE="/tmp/omniclaw_openwa/bot.log"

# Ensure dirs exist
mkdir -p "${SCRIPT_DIR}/outbox" "${SCRIPT_DIR}/outbox/sent"

if pgrep -f "omniclaw_direct_whatsapp.js" > /dev/null; then
    echo "OmniClaw is already running (PID: $(pgrep -f "omniclaw_direct_whatsapp.js"))"
    exit 0
fi

# Set OpenWA env
export OPENWA_URL="${OPENWA_URL:-http://localhost:2785}"
export OPENWA_KEY="${OPENWA_KEY:-dev-admin-key}"

nohup node "${BOT_SCRIPT}" > "${LOG_FILE}" 2>&1 &
sleep 3

if pgrep -f "omniclaw_direct_whatsapp.js" > /dev/null; then
    echo "OmniClaw started (PID: $(pgrep -f "omniclaw_direct_whatsapp.js"))"
    echo "  Logs: tail -f ${LOG_FILE}"
    echo "  Outbox: ${SCRIPT_DIR}/outbox/"
else
    echo "Failed to start — check ${LOG_FILE}"
    tail -10 "${LOG_FILE}" 2>/dev/null
fi
