#!/usr/bin/env python3
"""
Backfill IG captions for the 138 empty_caption posts detected by content_source.
Uses Playwright to open each URL and extract caption from the post page.
Updates bookmarks.content and content_source='scrape_success' on success.

Usage:
  python3 backfill_empty_captions.py [--limit 138] [--dry-run]
"""
import sys
import json
import time
import sqlite3
import argparse
from datetime import datetime, timezone
from pathlib import Path

DB = "/opt/vault-search/vault.db"
COOKIES = "/opt/vault-sync/instagram_cookies.json"

def log(msg):
    print(f"[BACKFILL] {datetime.now().isoformat()} {msg}", flush=True)

def get_empty_caption_posts(limit=None):
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    sql = """
        SELECT id, source_id, url FROM bookmarks
        WHERE source='instagram' AND content_source='empty_caption' AND is_active=1
        ORDER BY id ASC
    """
    if limit:
        sql += f" LIMIT {limit}"
    rows = cur.execute(sql).fetchall()
    conn.close()
    return [{"id": r[0], "source_id": r[1], "url": r[2]} for r in rows]

def build_js_code(posts_json):
    """Build Node.js + Playwright code to fetch each post's caption."""
    return f"""
const {{ chromium }} = require('playwright');
const fs = require('fs');

const POSTS = {posts_json};
const COOKIES_FILE = {json.dumps(COOKIES)};

async function extractCaption(page) {{
  // Try multiple selectors
  const selectors = [
    'h1[class*="Caption"]',
    'div[class*="Caption"]',
    'h1._a9z6',
    'h1._a9yh',
    'span._a9zc',
    'div._a9z6',
    'div._a9zr',
    'article h1',
    'article span',
  ];
  for (const sel of selectors) {{
    const el = await page.$(sel);
    if (el) {{
      const text = await el.innerText();
      if (text && text.length > 5) return text;
    }}
  }}
  // Fallback: extract from JSON-LD or page content
  const html = await page.content();
  const m = html.match(/"text":"([^"{{}}]+)"/);
  if (m && m[1].length > 5) return m[1];
  return null;
}}

async function main() {{
  const browser = await chromium.launch({{ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }});
  const context = await browser.newContext({{
    viewport: {{ width: 1280, height: 900 }},
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }});
  await context.addInitScript(() => {{
    Object.defineProperty(navigator, 'webdriver', {{ get: () => false }});
  }});

  // Load cookies - support both array and {"cookies": [...]} formats
  let cookiesLoaded = false;
  try {{
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    let cookieList = null;
    if (Array.isArray(cookies)) {{
      cookieList = cookies;
    }} else if (typeof cookies === 'object' && cookies !== null) {{
      if (Array.isArray(cookies.cookies)) {{
        cookieList = cookies.cookies;
      }} else {{
        // {{name: value, ...}} dict
        cookieList = Object.entries(cookies).map(([k, v]) => ({{ name: k, value: String(v), domain: '.instagram.com', path: '/' }}));
      }}
    }}
    if (cookieList && cookieList.length > 0) {{
      await context.addCookies(cookieList);
      cookiesLoaded = true;
    }} else {{
      console.error('No cookies found in ' + COOKIES_FILE);
    }}
  }} catch (e) {{
    console.error('Cookie load failed: ' + e.message);
  }}
  if (!cookiesLoaded) {{
    console.error('CRITICAL: cannot proceed without cookies');
    process.exit(1);
  }}

  const page = await context.newPage();
  const results = [];

  for (const post of POSTS) {{
    try {{
      await page.goto(post.url, {{ waitUntil: 'domcontentloaded', timeout: 30000 }});
      await page.waitForTimeout(2500);  // wait for content
      const caption = await extractCaption(page);
      results.push({{ id: post.id, source_id: post.source_id, url: post.url, caption, success: !!caption }});
    }} catch (e) {{
      results.push({{ id: post.id, source_id: post.source_id, url: post.url, caption: null, success: false, error: e.message }});
    }}
    // small delay between requests
    await page.waitForTimeout(1000);
  }}

  await browser.close();
  console.log(JSON.stringify(results));
}}

main().catch(e => {{ console.error(e); process.exit(1); }});
"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="Max posts to backfill (default: all 138)")
    ap.add_argument("--dry-run", action="store_true", help="Show what would be done without running")
    ap.add_argument("--output", default="/tmp/backfill_results.json", help="Output file for results")
    args = ap.parse_args()

    posts = get_empty_caption_posts(limit=args.limit)
    log(f"Found {len(posts)} empty_caption Instagram posts to backfill")

    if args.dry_run:
        log("DRY-RUN mode. Would scrape:")
        for p in posts[:5]:
            log(f"  id={p['id']} url={p['url']}")
        if len(posts) > 5:
            log(f"  ... and {len(posts) - 5} more")
        return

    posts_json = json.dumps(posts)
    js_code = build_js_code(posts_json)

    # Write JS to a temp file
    js_path = "/opt/vault-sync/backfill_captions.js"
    with open(js_path, "w") as f:
        f.write(js_code)
    log(f"JS written to {js_path}, launching Playwright...")

    # Run via node
    import subprocess
    result = subprocess.run(
        ["node", js_path],
        capture_output=True, text=True, timeout=3600,
        cwd="/opt/vault-sync"
    )
    if result.returncode != 0:
        log(f"Playwright failed: {result.stderr[:500]}")
        return

    # Parse results (last line of stdout should be JSON)
    output = result.stdout.strip()
    log(f"Playwright output: {len(output)} bytes")
    # Find JSON array at end
    last_brace = output.rfind("]")
    if last_brace < 0:
        log(f"No JSON found in output: {output[:500]}")
        return
    json_str = output[: last_brace + 1]
    try:
        results = json.loads(json_str)
    except json.JSONDecodeError as e:
        log(f"JSON parse failed: {e}, output: {output[:500]}")
        return

    # Save results
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2)
    log(f"Saved {len(results)} results to {args.output}")

    # Update DB - GUARD: if many captions match the cookie wall, abort
    success = sum(1 for r in results if r.get("success"))
    log(f"Success: {success}/{len(results)}")

    cookie_wall_hits = sum(1 for r in results if r.get("caption", "").startswith("By using Meta AI"))
    if cookie_wall_hits > 0:
        log(f"COOKIE WALL DETECTED: {cookie_wall_hits} captions look like the IG login wall")
        if cookie_wall_hits == len(results):
            log("ABORTING: ALL captions are cookie-wall text. Cookies are DEAD. Refresh via /opt/vault-sync/REFRESH_COOKIES.md before retrying.")
            return
        log(f"PROCEEDING with partial: only {len(results) - cookie_wall_hits} real captions will be written")

    conn = sqlite3.connect(DB)
    updated = 0
    for r in results:
        if r.get("success") and r.get("caption"):
            try:
                conn.execute(
                    "UPDATE bookmarks SET content = ?, content_source = 'scrape_success', updated_at = ? WHERE id = ?",
                    (r["caption"], datetime.now(timezone.utc).isoformat(), r["id"]),
                )
                updated += 1
            except Exception as e:
                log(f"  DB error for id={r['id']}: {e}")
    conn.commit()
    conn.close()
    log(f"Updated {updated} bookmarks with new captions")

    # Show remaining empty_caption count
    conn = sqlite3.connect(DB)
    remaining = conn.execute("SELECT COUNT(*) FROM bookmarks WHERE content_source='empty_caption'").fetchone()[0]
    conn.close()
    log(f"Remaining empty_caption posts: {remaining}")

if __name__ == "__main__":
    main()
