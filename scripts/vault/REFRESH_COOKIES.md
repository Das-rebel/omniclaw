# Instagram Cookie Refresh Workflow

## Why cookies expire
Instagram expires logged-in session cookies every ~30 days (sometimes sooner with
suspicious activity). The current cookies at `/opt/vault-sync/instagram_cookies.json`
(modified Oct 9) are dead — IG shows the "By using Meta AI" login wall instead of
actual post content. This is the **most common failure mode** for IG scraping.

## How to refresh

### Option A: Browser export (recommended)
1. Open Chrome/Brave on your MacBook
2. Go to https://www.instagram.com — log in if not already
3. Verify you can see posts (not the login wall)
4. Install browser extension: "Get cookies.txt LOCALLY" or "EditThisCookie"
5. Export cookies for `instagram.com` as JSON
6. Save to: `/opt/vault-sync/instagram_cookies.json`

### Option B: Playwright headless capture
```bash
ssh -i ~/.ssh/vps_key root@159.65.10.49
cd /opt/vault-sync
python3 -c "
import json
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=False, args=['--no-sandbox'])
    context = browser.new_context()
    page = context.new_page()
    page.goto('https://www.instagram.com')
    # Manually log in (will need to do interactively)
    # Then save cookies
    cookies = context.cookies()
    with open('/opt/vault-sync/instagram_cookies.json', 'w') as f:
        json.dump(cookies, f, indent=2)
    print(f'Saved {len(cookies)} cookies')
    browser.close()
"
```
(This requires interactive login — must run with `headless=False`)

### Option C: Reuse MacBook session via SCP
1. MacBook: extract cookies from local Chrome
2. SCP to droplet: `scp cookies.json root@159.65.10.49:/opt/vault-sync/instagram_cookies.json`

## Verify cookies are alive

```bash
ssh root@159.65.10.49 "python3 -c '
import json
import subprocess
with open(\"/opt/vault-sync/instagram_cookies.json\") as f:
    cookies = json.load(f)
print(f\"{len(cookies)} cookies loaded\")
# Test by fetching a real IG post
import requests
cookie_dict = {c[\"name\"]: c[\"value\"] for c in cookies}
r = requests.get(\"https://www.instagram.com/p/CwD1e2sM2zP/\", cookies=cookie_dict, timeout=15)
if \"By using Meta AI\" in r.text:
    print(\"DEAD: cookies are stale\")
elif \"caption\" in r.text.lower():
    print(\"ALIVE: cookies work\")
else:
    print(\"UNKNOWN: inspect HTML\")
'"
```

## Re-run backfill after refresh
```bash
ssh root@159.65.10.49
cd /opt/vault-sync
python3 /tmp/backfill_empty_captions.py
# Watch for: each row should have a UNIQUE caption, NOT the same Meta AI text
```

## Auto-detection (already in place)
- `classify_content_source()` in `unified_schema.py` flags cookie-wall text
- All ingest scripts use it since 2026-10-17
- `/scrape-fails` endpoint shows the live list: `curl http://159.65.10.49:8080/scrape-fails`
