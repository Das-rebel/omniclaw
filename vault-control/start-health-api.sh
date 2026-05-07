#!/bin/bash
#
# OmniClaw Health API Server Startup
# Keeps the health endpoint running as a background service
#
# Usage:
#   ./start-health-api.sh          # Start in background
#   ./start-health-api.sh --stop  # Stop running instance
#   ./start-health-api.sh --restart  # Restart
#
# The server runs on PORT 8081 (or $PORT env var)
# Endpoints:
#   GET  /health        → JSON health report
#   GET  /health/report → Plain text report
#   POST /health/notify  → Send WhatsApp + return JSON
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="/tmp/omniclaw-health-api.pid"
LOG_FILE="/tmp/omniclaw-health-api.log"

start_server() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Health API already running (PID $(cat "$PID_FILE"))"
    return 1
  fi
  
  echo "Starting OmniClaw Health API on port ${PORT:-8081}..."
  nohup node "$SCRIPT_DIR/daily-health.js" --server >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "Health API started (PID $(cat "$PID_FILE"))"
  echo "Log: $LOG_FILE"
}

stop_server() {
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      echo "Stopping Health API (PID $PID)..."
      kill "$PID"
      rm -f "$PID_FILE"
      echo "Health API stopped"
    else
      echo "Health API not running (stale PID file)"
      rm -f "$PID_FILE"
    fi
  else
    echo "Health API not running"
  fi
}

case "${1:-}" in
  --stop)    stop_server ;;
  --restart) stop_server; start_server ;;
  --status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Running (PID $(cat "$PID_FILE"))"
    else
      echo "Not running"
    fi
    ;;
  *)         start_server ;;
esac
