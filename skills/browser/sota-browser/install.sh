#!/bin/bash
# ============================================================================
# sota-browser — One-command install script
# Installs cmd-headless globally for all projects on this system
# ============================================================================
set -e

SOTA_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "🚀 Installing sota-browser from: $SOTA_DIR"

# 1. Install dependencies
echo ""
echo "📦 Installing Python dependencies..."
python3 -m pip install --user playwright playwright-stealth browser_cookie3 httpx 2>&1 | tail -3

# 2. Install Playwright browsers (if needed)
echo ""
echo "🌐 Checking Playwright browsers..."
python3 -m playwright install chromium 2>&1 | tail -3

# 3. Install sota-browser package globally
echo ""
echo "📦 Installing sota-browser..."
cd "$SOTA_DIR"
python3 -m pip install --user -e ".[cookies]" 2>&1 | tail -3

# 4. Ensure PATH includes user bin
USER_BIN=$(python3 -m site --user-base)/bin
if ! echo "$PATH" | grep -q "$USER_BIN"; then
    echo ""
    echo "⚠️  Adding $USER_BIN to PATH..."
    echo "Add this to your ~/.zshrc:"
    echo "  export PATH=\"$USER_BIN:\$PATH\""
fi

# 5. Verify
echo ""
echo "============================================"
CMD=$(which cmd-headless 2>/dev/null || echo "$USER_BIN/cmd-headless")
echo "✅ sota-browser installed!"
echo "   CLI: $CMD"
echo "   Python: python3 -c 'from browser_manager import BrowserManager'"
echo ""
$CMD --version
echo "============================================"
