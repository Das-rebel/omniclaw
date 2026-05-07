#!/usr/bin/env python3
"""
Twitter Bookmark Scraper with GCS Cookie Support
Fetches bookmarks using cookies from GCS or environment
"""

import os
import json
import asyncio
from datetime import datetime
from pathlib import Path

# Try to import twscrape
try:
    import twscrape
    from twscrape import AccountsPool, API
    TWSCRAPE_AVAILABLE = True
except ImportError:
    TWSCRAPE_AVAILABLE = False
    print("[TWITTER] twscrape not installed, install with: pip3 install --break-system-packages twscrape")

# Google Cloud Storage
try:
    from google.cloud import storage
    GCS_AVAILABLE = True
except ImportError:
    GCS_AVAILABLE = False
    print("[TWITTER] google-cloud-storage not installed")

# Configuration
BUCKET_NAME = "omniclaw-knowledge-graph"
COOKIE_FILE = "vault/cookies/twitter_cookies.json"

# Environment variables
TWITTER_COOKIES = os.getenv("TWITTER_COOKIES", "")
TWITTER_USERNAME = os.getenv("TWITTER_USERNAME", "")
TWITTER_PASSWORD = os.getenv("TWITTER_PASSWORD", "")
TWITTER_EMAIL = os.getenv("TWITTER_EMAIL", "")
VAULT_DIR = os.getenv("VAULT_DIR", "/home/ubuntu/vault_data")
TWITTER_OUTPUT = os.path.join(VAULT_DIR, "twitter_bookmarks_automated.json")
LAST_RUN_FILE = os.path.join(VAULT_DIR, "twitter_last_run.json")

def log(message):
    """Log with timestamp"""
    print(f"[TWITTER] {datetime.now().isoformat()} {message}")

def load_cookies_from_gcs():
    """Load cookies from GCS"""
    if not GCS_AVAILABLE:
        log("GCS not available, skipping GCS cookie fetch")
        return None

    try:
        client = storage.Client()
        bucket = client.bucket(BUCKET_NAME)
        blob = bucket.blob(COOKIE_FILE)

        if not blob.exists():
            log(f"No cookies found in GCS: {COOKIE_FILE}")
            return None

        # Download and parse cookie file
        contents = blob.download_as_text()
        cookie_data = json.loads(contents)

        # Check if cookies are expired
        expires_at = cookie_data.get('expiresAt')
        if expires_at:
            expiry_date = datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
            if expiry_date < datetime.now(expiry_date.tzinfo):
                log(f"Cookies in GCS expired at {expires_at}")
                return None

        log(f"Loaded fresh cookies from GCS (uploaded: {cookie_data.get('timestamp', 'unknown')})")
        return cookie_data.get('cookies', {})

    except Exception as e:
        log(f"Failed to load cookies from GCS: {e}")
        return None

def parse_cookies(cookie_string):
    """Parse cookie string to dict"""
    cookies = {}
    if not cookie_string:
        return cookies

    for item in cookie_string.split(';'):
        item = item.strip()
        if '=' in item:
            key, value = item.split('=', 1)
            cookies[key.strip()] = value.strip()

    return cookies

def cookies_to_string(cookies_dict):
    """Convert dict to cookie string format for twscrape"""
    if not cookies_dict:
        return ""

    # Format cookies as "key1=value1; key2=value2"
    cookie_pairs = [f"{k}={v}" for k, v in cookies_dict.items()]
    return "; ".join(cookie_pairs)

async def scrape_twitter_bookmarks_async():
    """
    Scrape Twitter bookmarks using twscrape (internal API)
    Supports cookies from GCS, env cookies, or username/password
    """
    if not TWSCRAPE_AVAILABLE:
        return {"success": False, "error": "twscrape not installed"}

    log("=" * 50)
    log("Twitter Bookmark Scraper Started (twscrape)")
    log("=" * 50)

    try:
        pool = AccountsPool()
        use_cookies = False
        cookie_string = None

        # Try GCS cookies first
        gcs_cookies = load_cookies_from_gcs()
        if gcs_cookies and (gcs_cookies.get('auth_token') or gcs_cookies.get('ct0')):
            log("Using cookies from GCS")
            cookie_string = cookies_to_string(gcs_cookies)
            if cookie_string:
                try:
                    await pool.add_account(
                        username=TWITTER_USERNAME,
                        password="",
                        email="",
                        email_password="",
                        cookies=cookie_string
                    )
                    use_cookies = True
                    log("GCS cookies loaded successfully")
                except Exception as e:
                    log(f"Failed to use GCS cookies: {e}")

        # Try env cookies if GCS failed
        if not use_cookies and TWITTER_COOKIES:
            cookies = parse_cookies(TWITTER_COOKIES)
            if "auth_token" in cookies or "ct0" in cookies:
                log(f"Using cookies from env: auth_token={cookies.get('auth_token', '')[:20]}...")
                cookie_string = cookies_to_string(cookies)
                try:
                    await pool.add_account(
                        username=TWITTER_USERNAME,
                        password="",
                        email="",
                        email_password="",
                        cookies=cookie_string
                    )
                    use_cookies = True
                    log("Env cookies loaded successfully")
                except Exception as e:
                    log(f"Failed to use env cookies: {e}")

        # Use password login as fallback
        if not use_cookies and TWITTER_USERNAME and TWITTER_PASSWORD:
            log(f"Logging in with username/password: {TWITTER_USERNAME}")
            try:
                await pool.add_account(
                    username=TWITTER_USERNAME,
                    password=TWITTER_PASSWORD,
                    email=TWITTER_EMAIL or f"{TWITTER_USERNAME}@gmail.com",
                    email_password=TWITTER_PASSWORD
                )
                log("Username/password credentials added")
            except Exception as e:
                log(f"Failed to add account: {e}")
                return {"success": False, "error": str(e)}

        if not use_cookies and not TWITTER_PASSWORD:
            log("ERROR: No valid cookies from GCS/env and no TWITTER_PASSWORD set")
            return {"success": False, "error": "No valid credentials"}

        # Login to all accounts
        log("Logging in...")
        await pool.login_all()

        # Create API instance
        api = API(pool)

        # Fetch bookmarks
        log("Fetching bookmarks...")
        bookmarks_data = []

        # twscrape Bookmark fetcher
        async for tweet in api.bookmarks(limit=500):
            tweet_dict = {
                "id": str(tweet.id),
                "tweet_id": str(tweet.id),
                "text": tweet.text or "",
                "url": f"https://twitter.com/i/status/{tweet.id}",
                "author": tweet.user.username if hasattr(tweet, 'user') and tweet.user else "",
                "created_at": tweet.date.isoformat() if hasattr(tweet, 'date') and tweet.date else None,
                "like_count": tweet.like_count if hasattr(tweet, 'like_count') else 0,
                "retweet_count": tweet.retweet_count if hasattr(tweet, 'retweet_count') else 0,
                "reply_count": tweet.reply_count if hasattr(tweet, 'reply_count') else 0,
                "timestamp": datetime.now().isoformat()
            }

            # Add media info if available
            if hasattr(tweet, 'media') and tweet.media:
                tweet_dict['media'] = [str(m) for m in tweet.media]

            bookmarks_data.append(tweet_dict)

            # Limit to 500 bookmarks
            if len(bookmarks_data) >= 500:
                log(f"Reached limit of 500 bookmarks")
                break

        log(f"Fetched {len(bookmarks_data)} bookmarks")

        # Save to file
        os.makedirs(VAULT_DIR, exist_ok=True)

        with open(TWITTER_OUTPUT, 'w') as f:
            json.dump(bookmarks_data, f, indent=2)

        # Save last run info
        last_run = {
            "timestamp": datetime.now().isoformat(),
            "count": len(bookmarks_data),
            "source": "twitter",
            "status": "success"
        }

        with open(LAST_RUN_FILE, 'w') as f:
            json.dump(last_run, f, indent=2)

        log(f"✅ Saved {len(bookmarks_data)} bookmarks to {TWITTER_OUTPUT}")
        return {
            "success": True,
            "count": len(bookmarks_data),
            "file": TWITTER_OUTPUT,
            "timestamp": datetime.now().isoformat()
        }

    except Exception as e:
        log(f"❌ Error: {e}")
        return {"success": False, "error": str(e)}

def scrape_twitter_bookmarks():
    """Sync wrapper for async function"""
    return asyncio.run(scrape_twitter_bookmarks_async())

if __name__ == "__main__":
    result = scrape_twitter_bookmarks()
    print(json.dumps(result, indent=2))
