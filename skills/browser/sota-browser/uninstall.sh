#!/bin/bash
# ============================================================================
# sota-browser — Uninstall script
# ============================================================================
set -e

echo "🗑️  Uninstalling sota-browser..."

python3 -m pip uninstall -y sota-browser 2>/dev/null || echo "Package not installed"

# Remove symlinks
rm -f ~/bin/cmd-headless
rm -f /usr/local/bin/cmd-headless

USER_BIN=$(python3 -m site --user-base 2>/dev/null)/bin
rm -f "$USER_BIN/cmd-headless"

echo "✅ sota-browser uninstalled"
echo "   To reinstall: cd ~/omniclaw/skills/browser/sota-browser && ./install.sh"
