#!/bin/bash
#
# OmniClaw Daily Summary Report
# Sends a WhatsApp message with vault data freshness status.
#
# Usage:
#   ./daily-summary.sh              # sends to DM (919003349852@s.whatsapp.net)
#   ./daily-summary.sh --group       # sends to AI and Embedded group
#   ./daily-summary.sh --dry-run     # print to stdout, don't send
#
# Cron: 7 AM IST = 1:30 AM UTC
#   30 1 * * * /Users/Subho/omniclaw/scripts/daily-summary.sh >> /tmp/omniclaw_openwa/daily-summary.log 2>&1
#
set -euo pipefail

# ─── CONFIG ────────────────────────────────────────────────
OUTBOX_DIR="/tmp/omniclaw_openwa/outbox"
OUTBOX_SENT="${OUTBOX_DIR}/sent"
GCS_BUCKET="gs://omniclaw-knowledge-graph"
GCS_PROJECT="omniclaw-personal-assistant"
TIMESTAMP=$(date +%s)

DEFAULT_JID="919003349852@s.whatsapp.net"
GROUP_JID="120363408616437592@g.us"

# ─── ARGS ──────────────────────────────────────────────────
TARGET_JID="${DEFAULT_JID}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --group)  TARGET_JID="${GROUP_JID}" ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: $0 [--group] [--dry-run]"
      exit 0
      ;;
  esac
done

# ─── HELPERS ───────────────────────────────────────────────

# Get GCS object metadata. Returns "<raw_date_string> <size>" or "MISSING 0"
gcs_info() {
  local path="$1"
  local stat
  stat=$(gsutil stat "${path}" 2>/dev/null) || true
  if [ -z "$stat" ]; then
    echo "MISSING 0"
    return
  fi
  local ctime=$(echo "$stat" | grep "Creation time:" | sed 's/Creation time:[[:space:]]*//' | xargs)
  local size=$(echo "$stat" | grep "Content-Length:" | awk '{print $2}')
  # Return raw date string with size
  echo "${ctime}|${size}"
}

# Extract the raw date string from gcs_info output
extract_date() {
  echo "$1" | cut -d'|' -f1
}

# Extract size from gcs_info output
extract_size() {
  echo "$1" | cut -d'|' -f2
}

# Format age: "X days ago" or "today" or "stale (>7d)"
format_age() {
  local iso_date="$1"
  if [ -z "$iso_date" ] || [ "$iso_date" = "MISSING" ]; then
    echo "MISSING"
    return
  fi
  
  # Use python3 for cross-platform date parsing
  local file_epoch
  file_epoch=$(python3 -c "
from datetime import datetime
try:
    dt = datetime.strptime('$iso_date', '%a, %d %b %Y %H:%M:%S %Z')
    import calendar
    print(calendar.timegm(dt.timetuple()))
except:
    print(0)
" 2>/dev/null) || file_epoch=0
  
  if [ "$file_epoch" = "0" ]; then
    echo "unknown"
    return
  fi
  
  local now_epoch=$(python3 -c "import calendar, time; print(calendar.timegm(time.gmtime()))")
  local diff=$(( (now_epoch - file_epoch) / 86400 ))
  
  if [ "$diff" -eq 0 ]; then
    echo "today"
  elif [ "$diff" -eq 1 ]; then
    echo "1 day ago"
  elif [ "$diff" -le 7 ]; then
    echo "${diff} days ago"
  else
    echo "STALE (${diff}d)"
  fi
}

# Count items in a JSON file from GCS (array length or dict key count)
gcs_count() {
  local path="$1"
  local count
  count=$(gsutil cat "${path}" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if isinstance(d, list):
        print(len(d))
    elif isinstance(d, dict):
        total = 0
        for v in d.values():
            if isinstance(v, list):
                total += len(v)
        print(total if total > 0 else len(d))
    else:
        print(0)
except:
    print(0)
" 2>/dev/null) || count="0"
  echo "${count}"
}

# Status emoji based on age
status_icon() {
  local age="$1"
  case "$age" in
    MISSING) echo "❌" ;;
    STALE*)  echo "⚠️" ;;
    "1 day ago") echo "✅" ;;
    today)   echo "✅" ;;
    "2 days ago") echo "✅" ;;
    *)       echo "✅" ;;  # 3-7 days
  esac
}

# ─── GATHER DATA ───────────────────────────────────────────

echo "[$(date)] Gathering OmniClaw vault status..."

# Vault files
TWITTER_INFO=$(gcs_info "${GCS_BUCKET}/vault/twitter_bookmarks_automated.json")
TWITTER_AGE=$(format_age "$(extract_date "$TWITTER_INFO")")
TWITTER_COUNT=$(gcs_count "${GCS_BUCKET}/vault/twitter_bookmarks_automated.json")

INSTAGRAM_INFO=$(gcs_info "${GCS_BUCKET}/vault/instagram_scrape.json")
INSTAGRAM_AGE=$(format_age "$(extract_date "$INSTAGRAM_INFO")")
INSTAGRAM_COUNT=$(gcs_count "${GCS_BUCKET}/vault/instagram_scrape.json")

BOOKMARK_INFO=$(gcs_info "${GCS_BUCKET}/vault/bookmarks_automated.json")
BOOKMARK_AGE=$(format_age "$(extract_date "$BOOKMARK_INFO")")
BOOKMARK_COUNT=$(gcs_count "${GCS_BUCKET}/vault/bookmarks_automated.json")

BROWSER_BM_INFO=$(gcs_info "${GCS_BUCKET}/vault/browser_bookmarks.json")
BROWSER_BM_AGE=$(format_age "$(extract_date "$BROWSER_BM_INFO")")
BROWSER_BM_COUNT=$(gcs_count "${GCS_BUCKET}/vault/browser_bookmarks.json")

# Knowledge graph
KG_INFO=$(gcs_info "${GCS_BUCKET}/unified_knowledge_graph.json")
KG_AGE=$(format_age "$(extract_date "$KG_INFO")")
KG_NODES=$(gsutil cat "${GCS_BUCKET}/unified_knowledge_graph.json" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    nodes = len(d.get('nodes', []))
    rels = len(d.get('relationships', []))
    print(f'{nodes} nodes, {rels} rels')
except:
    print('unknown')
" 2>/dev/null) || KG_NODES="unknown"

# ─── CHECK CLOUD SERVICES ─────────────────────────────────

# Check scheduler jobs status
SCHEDULER_STATUS=""
SCHEDULER_JOBS=$(gcloud scheduler jobs list \
  --project="${GCS_PROJECT}" \
  --location=us-central1 \
  --format="value(name,state)" 2>/dev/null) || true
FAILED_JOBS=""
while IFS=$'\t' read -r name state; do
  if [ -n "$name" ]; then
    SCHEDULER_STATUS="${SCHEDULER_STATUS}${name}: ${state}\n"
    if [ "$state" != "ENABLED" ]; then
      FAILED_JOBS="${FAILED_JOBS}${name} is ${state}; "
    fi
  fi
done <<< "$SCHEDULER_JOBS"

# ─── BUILD REPORT ──────────────────────────────────────────

REPORT_DATE=$(date -u +"%b %d, %Y")

# Collect issues
ISSUES=""

# Check for empty vault files (size 2 bytes = "[]")
TWITTER_SIZE=$(extract_size "$TWITTER_INFO")
INSTAGRAM_SIZE=$(extract_size "$INSTAGRAM_INFO")
if [ "$TWITTER_SIZE" = "2" ] || [ "$TWITTER_COUNT" = "0" ]; then
  ISSUES="${ISSUES}Twitter bookmarks file empty (scraper may have failed); "
fi
if [ "$INSTAGRAM_SIZE" = "2" ] || [ "$INSTAGRAM_COUNT" = "0" ]; then
  ISSUES="${ISSUES}Instagram saved file empty; "
fi

# Check stale data
if [[ "$INSTAGRAM_AGE" == STALE* ]]; then
  ISSUES="${ISSUES}Instagram data stale (${INSTAGRAM_AGE}); "
fi

# Check scheduler
if [ -n "$FAILED_JOBS" ]; then
  ISSUES="${ISSUES}Scheduler issues: ${FAILED_JOBS}"
fi

# Format the report
REPORT="OmniClaw Daily Report - ${REPORT_DATE}

$(status_icon "$TWITTER_AGE") Twitter: ${TWITTER_AGE} (${TWITTER_COUNT} items)
$(status_icon "$INSTAGRAM_AGE") Instagram: ${INSTAGRAM_AGE} (${INSTAGRAM_COUNT} items)
$(status_icon "$BOOKMARK_AGE") Bookmarks: ${BOOKMARK_AGE} (${BOOKMARK_COUNT} items)
$(status_icon "$BROWSER_BM_AGE") Browser BMs: ${BROWSER_BM_AGE} (${BROWSER_BM_COUNT} items)
$(status_icon "$KG_AGE") Knowledge Graph: ${KG_AGE} (${KG_NODES})"

if [ -n "$ISSUES" ]; then
  REPORT="${REPORT}

Issues: ${ISSUES}"
fi

REPORT="${REPORT}

---
Generated: $(date -u +"%H:%M UTC") | PID: $$"

# ─── OUTPUT ────────────────────────────────────────────────

if $DRY_RUN; then
  echo "=== DRY RUN ==="
  echo "Target: ${TARGET_JID}"
  echo "---"
  echo "$REPORT"
  echo "---"
  exit 0
fi

# Ensure outbox dirs exist
mkdir -p "${OUTBOX_DIR}" "${OUTBOX_SENT}"

# Write to outbox (first line = JID, rest = message)
MSG_FILE="${OUTBOX_DIR}/daily-summary-${TIMESTAMP}.msg"
printf '%s\n%s' "${TARGET_JID}" "${REPORT}" > "${MSG_FILE}"

echo "[$(date)] Queued daily summary to ${MSG_FILE}"
echo "[$(date)] Target: ${TARGET_JID}"

# Verify the bot is running
if pgrep -f "omniclaw_direct_whatsapp" > /dev/null 2>&1; then
  echo "[$(date)] Bot is running - message will be picked up from outbox"
else
  echo "[$(date)] WARNING: Bot not running! Message queued in outbox for when it starts."
  echo "[$(date)] Fallback: sending via OpenWA REST API..."
  # Try OpenWA REST API (replaces old baileys one-shot)
  if /Users/Subho/omniclaw/scripts/openwa-send.sh "${TARGET_JID}" "${REPORT}" 2>&1; then
    echo "[$(date)] Sent via OpenWA"
  else
    echo "[$(date)] OpenWA fallback also failed - message stays in outbox"
  fi
fi

# Clean up old sent files (older than 7 days)
find "${OUTBOX_SENT}" -name "*.sent" -mtime +7 -delete 2>/dev/null || true

echo "[$(date)] Done."
