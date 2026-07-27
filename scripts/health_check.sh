#!/bin/bash
# Enhanced Health Check with Daily Report
LOG_FILE="/var/log/vault-sync-health.log"
MAIN_HOST="159.65.10.49"
WHATSAPP_BOT="http://127.0.0.1:8090"
BOT_PHONE="917977110915"
WA_API_KEY="omniclaw-wa-secret"

send_wa() {
    curl -s -X POST "$WHATSAPP_BOT/send" \
        -H "Content-Type: application/json" \
        -H "x-api-key: $WA_API_KEY" \
        -d "{\"phone\":\"$BOT_PHONE\",\"message\":\"$1\"}" >> "$LOG_FILE" 2>&1
}

log() { echo "[$(date)] $1" >> "$LOG_FILE"; }

# Get stats
VAULT_TOTAL=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$MAIN_HOST "python3 -c 'import sqlite3; c=sqlite3.connect(\"/opt/vault-sync/vault.db\"); print(c.execute(\"SELECT COUNT(*) FROM bookmarks\").fetchone()[0])' 2>/dev/null" || echo "0")
TW_COUNT=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$MAIN_HOST "python3 -c 'import sqlite3; c=sqlite3.connect(\"/opt/vault-sync/vault.db\"); print(c.execute(\"SELECT COUNT(*) FROM bookmarks WHERE source=\\\"twitter\\\"\").fetchone()[0])' 2>/dev/null" || echo "0")
IG_COUNT=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$MAIN_HOST "python3 -c 'import sqlite3; c=sqlite3.connect(\"/opt/vault-sync/vault.db\"); print(c.execute(\"SELECT COUNT(*) FROM bookmarks WHERE source=\\\"instagram\\\"\").fetchone()[0])' 2>/dev/null" || echo "0")

MAIN_DISK=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$MAIN_HOST "df -h / | tail -1 | awk '{print \$5}'" 2>/dev/null || echo "0%")
VAULT_SEARCH=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$MAIN_HOST "curl -s http://localhost:8080/health" 2>/dev/null)
WA_BOT=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$MAIN_HOST "curl -s http://localhost:8090/health" 2>/dev/null)

# Format status
echo "$VAULT_SEARCH" | grep -q "ok" && VAULT_STR="✅" || VAULT_STR="❌"
echo "$WA_BOT" | grep -q "ok" && WA_STR="✅" || WA_STR="❌"
[ "${MAIN_DISK%\%}" -gt 80 ] && DISK_STR="$MAIN_DISK ⚠️" || DISK_STR="$MAIN_DISK ✅"

# Get recent additions (last 24h)
RECENT=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$MAIN_HOST "python3 -c 'import sqlite3; c=sqlite3.connect(\"/opt/vault-sync/vault.db\"); from datetime import datetime, timedelta; cutoff=(datetime.now()-timedelta(days=1)).isoformat(); print(c.execute(\"SELECT COUNT(*) FROM bookmarks WHERE created_at > ?\",(cutoff,)).fetchone()[0])' 2>/dev/null" || echo "?")

# Time-based greeting
HOUR=$(date +%H)
if [ "$HOUR" -lt 12 ]; then
    GREET="🌅 Good Morning!"
elif [ "$HOUR" -lt 17 ]; then
    GREET="☀️ Good Afternoon!"
else
    GREET="🌙 Good Evening!"
fi

# Build message
MSG="$GREET

📊 Daily Status $(date '+%b %d')

🔧 System:
• Vault-Search $VAULT_STR
• WhatsApp $WA_STR
• Disk: $DISK_STR

📚 Vault:
• Total: $VAULT_TOTAL items
• Twitter: $TW_COUNT
• Instagram: $IG_COUNT
• New (24h): +$RECENT"

send_wa "$MSG"
log "Health report sent: Vault=$VAULT_TOTAL, Recent=$RECENT"
