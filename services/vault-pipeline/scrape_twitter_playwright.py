#!/usr/bin/env python3
"""
Twitter Bookmark Scraper using Playwright
Bypasses Cloudflare by using real browser automation
"""

import json
import subprocess
from datetime import datetime, timezone

TWITTER_COOKIES_PATH = "/opt/vault-sync/twitter_cookies.json"
OUTPUT_PATH = "/tmp/twitter_scrape_result.json"

def log(msg):
    print(f"[TWITTER-PLAYWRIGHT] {datetime.now().isoformat()} {msg}", flush=True)

def scrape_with_playwright():
    """Scrape Twitter bookmarks using Node.js Playwright"""
    
    js_code = """
const { chromium } = require('playwright');
const fs = require('fs');

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  const page = await context.newPage();
  
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  
  const cookiesData = JSON.parse(fs.readFileSync('/opt/vault-sync/twitter_cookies.json'));
  const cookieArray = Object.entries(cookiesData.cookies).map(([n, v]) => ({
    name: n, value: v, domain: '.x.com', path: '/', sameSite: 'Lax'
  }));
  await context.addCookies(cookieArray);
  
  console.log('Going to bookmarks...');
  await page.goto('https://x.com/i/bookmarks', { timeout: 60000 });
  await page.waitForTimeout(5000);
  
  // v2 (Oct 12 2026): collect INCREMENTALLY while scrolling. x.com virtualizes the
  // bookmarks list — articles unmount as you scroll, so parsing once at the end only
  // saw the last screenful (~8 tweets/day). Collector runs every step into window.__seen.
  await page.evaluate(() => { window.__seen = {}; });
  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      if (!window.__collect) {
        window.__collect = () => {
          const articles = document.querySelectorAll('article');
          articles.forEach((article) => {
            const textEl = article.querySelector('[data-testid=tweetText]');
            const text = textEl ? textEl.innerText : '';
            const links = Array.from(article.querySelectorAll('a'));
            let url = '';
            links.forEach(a => {
              if (a.href && a.href.includes('/status/') && !a.href.includes('/analytics')) {
                url = a.href.split('?')[0];
              }
            });
            const timeEl = article.querySelector('time');
            const time = timeEl ? timeEl.getAttribute('datetime') : '';
            const authorLinks = Array.from(article.querySelectorAll('a[role=link]'));
            let author = '';
            authorLinks.forEach(a => {
              if (a.href && a.href.includes('/') && !a.href.includes('/status/') && a.querySelector('span')) {
                const span = a.querySelector('span');
                if (span && span.innerText) author = span.innerText;
              }
            });
            if (text && url) window.__seen[url] = { text, url, time, author };
          });
          return Object.keys(window.__seen).length;
        };
      }
      window.__collect();
    });
  }
  const tweets = await page.evaluate(() => Object.values(window.__seen));
  
  console.log('SCRAPE_RESULT:' + JSON.stringify(tweets));
  
  await browser.close();
}

scrape().catch(e => { console.error('ERROR:' + e.message); process.exit(1); });
"""
    
    try:
        result = subprocess.run(
            ['node', '-e', js_code],
            capture_output=True,
            text=True,
            timeout=180
        )
        
        output = result.stdout + result.stderr
        
        if 'SCRAPE_RESULT:' in output:
            start = output.find('SCRAPE_RESULT:') + len('SCRAPE_RESULT:')
            tweets_json = output[start:].strip()
            tweets = json.loads(tweets_json)
            log(f'Scraped {len(tweets)} tweets')
            return tweets
        elif 'ERROR:' in output:
            log(f'Playwright error: {output}')
        else:
            log(f'Unknown error: {output[:500]}')
            
    except subprocess.TimeoutExpired:
        log('Timeout')
    except Exception as e:
        log(f'Error: {e}')
    
    return []

def normalize_tweet(raw):
    tweet_id = raw.get('url', '').split('/status/')[-1] if '/status/' in raw.get('url', '') else ''
    author = raw.get('author', '')
    text = raw.get('text', '')
    url = raw.get('url', '')
    
    return {
        'source': 'twitter',
        'source_id': tweet_id,
        'url': url,
        'title': f'@{author}' if author else '',
        'content': text,
        'bookmarked_at': raw.get('time', ''),
        'scraped_at': datetime.now(timezone.utc).isoformat(),
        'metadata': {
            'author': author,
            'platform': 'twitter'
        }
    }

def main():
    log('=== Twitter Bookmark Scraper (Playwright) ===')
    
    tweets = scrape_with_playwright()
    
    if tweets:
        bookmarks = [normalize_tweet(t) for t in tweets]
        
        with open(OUTPUT_PATH, 'w') as f:
            json.dump(bookmarks, f, ensure_ascii=False, indent=2)
        
        log(f'Saved {len(bookmarks)} bookmarks to {OUTPUT_PATH}')
        
        for bm in bookmarks[:3]:
            log(f"  - {bm['content'][:50]}... | {bm['url']}")
    else:
        log('No tweets scraped')

if __name__ == '__main__':
    main()
