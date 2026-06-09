# sota-browser

**SOTA Browser** — Production-grade browser automation with anti-detection, cookie import, and CDP support.

> Ships with `cmd-headless` CLI and 57 Python tools. Globally deployed via pip.

---

## Quick Start

```bash
# CLI (any terminal)
cmd-headless --local --json "go to github.com"

# Python (any project)
python3 -c "from browser_manager import BrowserManager; print('OK')"
```

---

## CLI Usage

```bash
cmd-headless [options] "go to <url>" [command...]
```

### Browse

```bash
# Stealth browsing (default)
cmd-headless --local --json "go to example.com"

# Screenshot
cmd-headless --local --screenshot "go to github.com"

# No stealth (for testing)
cmd-headless --local --no-stealth --json "go to example.com"
```

### Cookies

```bash
# Import Chrome cookies for a domain, then browse
cmd-headless --cookies chrome --domain github.com --json "go to github.com"

# Import from specific browser
cmd-headless --cookies chrome   # Chrome
cmd-headless --cookies brave   # Brave
cmd-headless --cookies firefox # Firefox

# Import only (get JSON)
cmd-headless --cookies chrome --import-only

# Filter by domain
cmd-headless --cookies chrome --domain google.com --import-only
```

### Profile Persistence

```bash
# Save cookies/localStorage to profile
cmd-headless --profile-dir ~/.my-profile --json "go to github.com"

# Reuse profile on next run (no --cookies flag needed)
cmd-headless --profile-dir ~/.my-profile --json "go to github.com"
```

### CDP Mode (Real Chrome)

For sites with aggressive canvas/WebGL fingerprinting:

```bash
# Terminal 1: Launch Chrome with remote debugging
./launch-chrome-cdp.sh

# Terminal 2: Use CDP mode
cmd-headless --cdp --json "go to github.com"
```

### Output Modes

```bash
--json       # Structured JSON output (default)
--text       # Plain text
--screenshot # Screenshot (saves to file)
--cost       # Show cost breakdown
```

---

## Python API

```python
# Import directly from the installed package
from browser_manager import BrowserManager
from cmd_headless import extract_cookies, browse_local, browse_cloud
from config import USER_AGENT
from tools import get_all_schemas

# Browser manager
bm = BrowserManager()
await bm.launch()
context = await bm.new_context()
page = await context.new_page()
await page.goto("https://example.com")

# Cookie extraction
cookies = extract_cookies("chrome", domain="github.com")
print(f"Got {len(cookies)} cookies")

# List all 57 tools
schemas = get_all_schemas()
print(f"{len(schemas)} tools available")
```

---

## Architecture

```
cmd_headless.py      # CLI entry point + mode dispatcher
browser_manager.py   # Playwright browser management + stealth
cmd_headless.py      # Core browser commands
config.py            # Defaults, user-agent, flags
tools/
  __init__.py        # 57 MCP tools
  cookies.py         # Cookie import/export
  screenshot.py      # Screenshot
  navigate.py        # Navigation
  state.py           # State management
```

---

## Benchmark Results

### Bot Detection: 7/7 PASS ✅

| Test | Result |
|------|--------|
| bot.sannysoft.com | ✅ WebDriver Advanced passed |
| browserleaks.com/js | ✅ webdriver=false, real plugins |
| deviceandbrowserinfo | ✅ No HeadlessChrome leak |
| pixelscan.net | ✅ No bot detection |
| antoinevastel.com/bots | ✅ No detection |
| iphey.com | ✅ No automation flags |
| fingerprint.com | ✅ Page loads cleanly |

### Fingerprinting: Known Limits

| Vector | Status | Solution |
|--------|--------|----------|
| WebDriver/automation flags | ✅ Fixed | stealth mode |
| Sec-CH-UA header | ✅ Fixed | Chrome args + JS override |
| HeadlessChrome leak | ✅ Fixed | UA + brands override |
| Canvas fingerprint | ❌ Hard limit | Use `--cdp` (real Chrome) |
| WebGL fingerprint | ❌ Hard limit | Use `--cdp` (real Chrome) |
| Font enumeration | ✅ Clean | |
| WebRTC local IP | ✅ No leak | |

---

## Global Deployment

```bash
# Install
cd ~/omniclaw/skills/browser/sota-browser
./install.sh

# Reinstall after updates
./install.sh

# Uninstall
./uninstall.sh
```

---

## Requirements

- Python 3.12+
- Playwright (`playwright install chromium`)
- Chrome/Chromium (for `--local` mode)
- Chrome with `--remote-debugging-port` (for `--cdp` mode)

---

## Troubleshooting

**"cmd-headless: command not found"**
```bash
export PATH="/Users/Subho/Library/Python/3.12/bin:$PATH"
# Add to ~/.zshrc for permanent fix
```

**Cookies not working**
```bash
# Chrome encrypts session cookies via keychain
# Use --cdp mode with real Chrome instead
./launch-chrome-cdp.sh
cmd-headless --cdp --json "go to github.com"
```

**Canvas fingerprint detected**
```bash
# Only CDP mode (real Chrome) can bypass this
./launch-chrome-cdp.sh
cmd-headless --cdp --json "go to <site>"
```
