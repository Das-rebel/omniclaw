#!/bin/bash
# ============================================================================
# Launch Chrome with remote debugging for CDP mode
# Usage: ./launch-chrome-cdp.sh [port]
# Then use: cmd-headless --cdp --json "go to ..."
# ============================================================================
PORT="${1:-9222}"
echo "🚀 Launching Chrome with remote debugging on port $PORT..."
open -a "Google Chrome" --args --remote-debugging-port=$PORT --no-first-run --no-default-browser-check --user-data-dir=/tmp/chrome-cdp-$PORT
echo "✅ Chrome running on http://localhost:$PORT"
echo "   Use: cmd-headless --cdp --cdp-port $PORT ..."
