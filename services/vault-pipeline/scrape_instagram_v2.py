#!/usr/bin/env python3
"""
Instagram Bookmark Scraper v2 - Improved
- Smart scroll: until no new posts for N consecutive attempts (detects end of feed)
- Captures URL + post type (reel/post/carousel)
- RETHINK FIX: captions captured IN-FLIGHT from graphql pagination responses
  (page.on response → walk for shortcode+caption) — zero extra fetches, no throttle risk
- For /backfill mode: also fetches per-post HTML for caption extraction (legacy)
- Output: /tmp/ig_saved_result.json

Usage:
  python3 scrape_instagram_v2.py             # daily incremental
  python3 scrape_instagram_v2.py --backfill   # one-time deep backfill (slower)
"""

import json
import subprocess
import sys
import time
from datetime import datetime, timezone

OUTPUT_PATH = "/tmp/ig_saved_result.json"
BACKFILL_MODE = "--backfill" in sys.argv

def log(msg):
    print(f"[IG-V2] {datetime.now().isoformat()} {msg}", flush=True)

def build_js_code():
    """Build the Node.js + Playwright code that does the actual scraping."""
    # For daily mode: just URLs + type
    # For backfill mode: also extract caption via per-post HTML fetch
    js_template = r"""
const { chromium } = require('playwright');
const fs = require('fs');

const BACKFILL = __BACKFILL__;

async function scrape() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  const page = await context.newPage();

  // RETHINK: capture captions from in-flight graphql/feed responses during scrolling
  const apiCaptions = new Map();
  function walkMedia(node) {
    if (Array.isArray(node)) { node.forEach(walkMedia); return; }
    if (node && typeof node === 'object') {
      // Try all possible shortcode field names
      const code = node.shortcode || node.code || node.media_key || node.pk;
      if (code) {
        let cap = '';
        if (typeof code === 'string' && !apiCaptions.has(code)) {
          cap = node.caption_text || node.text || '';
          if (!cap && node.edge_media_to_caption && node.edge_media_to_caption.edges &&
              node.edge_media_to_caption.edges[0] && node.edge_media_to_caption.edges[0].node) {
            cap = node.edge_media_to_caption.edges[0].node.text || '';
          }
          // Try nested caption field
          if (!cap && node.caption) cap = node.caption;
          if (cap) apiCaptions.set(code, String(cap).slice(0, 2000));
        }
      }
      for (const v of Object.values(node)) walkMedia(v);
    }
  }
  // Robust response interceptor with fallback HTML parsing
  page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (u.indexOf('graphql') !== -1 || u.indexOf('/api/v1/feed') !== -1) {
        const data = await resp.json().catch(() => ({}));
        // Try nested data extraction (Instagram GraphQL wraps in data.*)
        walkMedia(data);
        walkMedia(data.data);
      }
    } catch (e) { /* non-json or gone body — ignore */ }
  });

  // Fallback: after page load, scrape captions from DOM
  try {
    await page.waitForSelector('article', { timeout: 60000 });
    const results = await page.evaluate(() => {
      const out = {};
      const articles = Array.from(document.querySelectorAll('article'));
      for (const art of articles) {
        let url = '', cap = '';
        // permalink link
        const a = art.querySelector('a[href^="/p/"]');
        if (a) url = 'https://www.instagram.com' + a.getAttribute('href');
        // caption in description or caption text
        const desc = art.querySelector('span._aamk, div._aame');
        if (desc && desc.textContent.trim()) cap = desc.textContent.trim();
        const caption = art.querySelector('[role="document"]');
        if (caption) {
          const nodes = caption.querySelectorAll('p');
          for (const n of nodes) {
            const t = n.textContent.trim();
            if (t && t.length > 10 && cap.length < t.length) cap = t;
          }
        }
        if (url && !out[url]) {
          out[url] = { type: art.querySelector('div[role="presentation"]') ? 'carousel' : 'post', caption: cap };
        }
      }
      return out;
    });
    console.log('[IG-NODE] fallback HTML parse: ' + Object.keys(results).length + ' posts');
    for (const [url, r] of Object.entries(results)) {
      if (!apiCaptionsMap.has(url)) {
        apiCaptionsMap.set(url, { type: r.type, caption: r.caption });
      }
    }
  } catch (e) {
    console.log('[IG-NODE] fallback parse error: ' + String(e));
  }

  // Load cookies
  const cookiesData = JSON.parse(fs.readFileSync('/opt/vault-sync/instagram_cookies.json'));
  const cookieArray = Object.entries(cookiesData.cookies).map(([n, v]) => ({
    name: n, value: String(v), domain: '.instagram.com', path: '/', sameSite: 'Lax'
  }));
  await context.addCookies(cookieArray);

  // Navigate
  console.log('[IG-NODE] navigating to saved page...');
  try {
    await page.goto('https://www.instagram.com/dasrebel/saved/all-posts/', { waitUntil: 'load', timeout: 60000 });
  } catch (e) {
    console.log('[IG-NODE] nav timeout, continuing');
  }

  // FIX: wait for first GraphQL response to arrive before starting scroll.
  // This ensures captions from the initial batch are captured even when the
  // page is served from Instagram's CDN cache (domcontentloaded fires too early).
  try {
    await page.waitForResponse(
      resp => resp.url().includes('graphql') || resp.url().includes('/api/v1/feed'),
      { timeout: 30000 }
    );
    console.log('[IG-NODE] first GraphQL response received — scroll starting');
  } catch (e) {
    console.log('[IG-NODE] no GraphQL response within 30s, proceeding anyway');
  }

  // Wait for initial posts to be visible (not just skeleton placeholders)
  try { await page.waitForSelector('article img', { timeout: 30000 }); }
  catch { console.log('[IG-NODE] no article img, retrying...'); await page.waitForTimeout(5000); }

  // SMART SCROLL: until no new posts for N consecutive attempts
  console.log('[IG-NODE] smart scrolling ' + (BACKFILL ? '(BACKFILL - aggressive)' : '(daily)') + '...');
  const seen = new Map(); // url -> type
  let consecutiveNoNew = 0;
  const MAX_NO_NEW = BACKFILL ? 8 : 5;
  const MAX_SCROLLS = BACKFILL ? 400 : 100;
  const SCROLL_DELAY = BACKFILL ? 1200 : 1500;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    // Grab current posts with type
    const found = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('article a[href*="/p/"], article a[href*="/reel/"]').forEach(a => {
        const h = a.getAttribute('href');
        if (!h) return;
        if (h.includes('/liked_by') || h.includes('/tagged/')) return;
        const url = 'https://www.instagram.com' + h.split('?')[0];
        if (!out[url]) {
          // Detect type: reel if has /reel/ in url or video tag nearby
          const isReel = h.includes('/reel/');
          const isCarousel = a.closest('article')?.querySelector('svg[aria-label*=Carousel]') !== null;
          const thumb = a.querySelector('img')?.src || '';  // v7.1: post thumbnail for reels b-roll
          out[url] = { t: (isReel ? 'reel' : (isCarousel ? 'carousel' : 'image')), thumb: thumb };
        }
      });
      return out;
    });
    let newCount = 0;
    for (const [url, val] of Object.entries(found)) {
      if (!seen.has(url)) {
        seen.set(url, val);
        newCount++;
      }
    }
    if (newCount > 0) {
      consecutiveNoNew = 0;
      console.log('[IG-NODE] scroll ' + (i+1) + ': ' + seen.size + ' total posts (' + newCount + ' new)');
    } else {
      consecutiveNoNew++;
      console.log('[IG-NODE] scroll ' + (i+1) + ': no new (' + consecutiveNoNew + '/' + MAX_NO_NEW + ')');
      if (consecutiveNoNew >= MAX_NO_NEW) {
        console.log('[IG-NODE] end of feed reached after ' + (i+1) + ' scrolls');
        break;
      }
    }
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(SCROLL_DELAY);
  }

  console.log('[IG-NODE] scroll done: ' + seen.size + ' unique posts, ' + apiCaptions.size + ' captions from API');
  const codeOf = (u) => { const m = u.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/); return m ? m[1] : null; };
  const urls = [...seen.entries()].map(([url, val]) => ({ url, type: val.t, caption: (apiCaptions.get(codeOf(url)) || ''), thumbnail_url: val.thumb || '' }));

  // BACKFILL: extract caption from each post's HTML (slow, only when --backfill)
  if (BACKFILL) {
    console.log('[IG-NODE] BACKFILL: extracting captions from ' + urls.length + ' posts (this will be slow)...');
    let i = 0;
    for (const item of urls) {
      i++;
      try {
        const resp = await page.context().request.fetch(item.url, { headers: { 'Accept': 'text/html' } });
        const html = await resp.text();
        // Extract og:description (caption)
        const m = html.match(/<meta property=\"og:description\" content=\"([^\"]+)\"/);
        if (m) {
          item.caption = m[1].slice(0, 1500);
        }
        // Detect username from og:title (usually "Username (@handle) on Instagram: ...")
        const t = html.match(/<meta property=\"og:title\" content=\"([^\"]+)\"/);
        if (t) item.title = t[1].slice(0, 200);
      } catch (e) { /* skip */ }
      if (i % 25 === 0) console.log('[IG-NODE] backfill progress: ' + i + '/' + urls.length);
    }
    console.log('[IG-NODE] backfill complete');
  }

  console.log('FINAL_RESULT:' + JSON.stringify(urls));
  await browser.close();
}

function log(m) { console.log('[IG-NODE] ' + m); }

scrape().catch(e => { console.error('FATAL:' + e.stack); process.exit(1); });
"""
    return js_template.replace('__BACKFILL__', 'true' if BACKFILL_MODE else 'false')

def run_scraper():
    js_code = build_js_code()
    timeout_sec = 1800 if BACKFILL_MODE else 600  # 30 min for backfill, 10 for daily
    mode = "BACKFILL" if BACKFILL_MODE else "DAILY"
    log(f'=== Instagram Scraper v2 ({mode} mode) ===')
    try:
        log('launching headless browser (timeout: ' + str(timeout_sec) + 's)')
        result = subprocess.run(['node', '-e', js_code], cwd='/opt/vault-sync', capture_output=True, text=True, timeout=timeout_sec, env={'NODE_PATH': '/opt/vault-sync/node_modules'})
        output = result.stdout + '\n' + result.stderr
        if 'FINAL_RESULT:' in output:
            start = output.find('FINAL_RESULT:') + len('FINAL_RESULT:')
            end = output.find('\n[IG-NODE]', start)
            if end == -1: end = len(output)
            posts = json.loads(output[start:end].strip())
            log(f'scraped {len(posts)} posts')
            return posts
        else:
            log(f'no FINAL_RESULT marker, output tail: {output[-300:]}')
    except subprocess.TimeoutExpired:
        log(f'TIMEOUT after {timeout_sec}s')
    except Exception as e:
        log(f'ERROR: {e}')
    return []

def main():
    posts = run_scraper()
    if posts:
        with open(OUTPUT_PATH, 'w') as f:
            json.dump(posts, f, indent=1)
        log(f'saved {len(posts)} posts to {OUTPUT_PATH}')
        # stats
        by_type = {}
        with_caption = 0
        for p in posts:
            t = p.get('type', 'unknown')
            by_type[t] = by_type.get(t, 0) + 1
            if p.get('caption'): with_caption += 1
        log(f'by type: {by_type}')
        log(f'with caption: {with_caption}/{len(posts)}')
    else:
        log('no posts scraped')

if __name__ == '__main__':
    main()
