#!/usr/bin/env python3
"""
Instagram Bookmark Scraper with GCS Cookie Support
Fetches saved posts using cookies from GCS or environment
"""

import os
import json
import asyncio
from datetime import datetime
from pathlib import Path

# Try to import instagrapi
try:
    from instagrapi import Client
    INSTAGRAPH_AVAILABLE = True
except ImportError:
    INSTAGRAPH_AVAILABLE = False
    print("[INSTAGRAM] instagrapi not installed, install with: pip3 install --break-system-packages instagrapi")

# Google Cloud Storage
try:
    from google.cloud import storage
    GCS_AVAILABLE = True
except ImportError:
    GCS_AVAILABLE = False
    print("[INSTAGRAM] google-cloud-storage not installed")

# Configuration
BUCKET_NAME = "omniclaw-knowledge-graph"
COOKIE_FILE = "vault/cookies/instagram_cookies.json"

# Environment variables
INSTAGRAM_COOKIES = os.getenv("INSTAGRAM_COOKIES", "")
INSTAGRAM_USERNAME = os.getenv("INSTAGRAM_USERNAME", "")
INSTAGRAM_PASSWORD = os.getenv("INSTAGRAM_PASSWORD", "")
VAULT_DIR = os.getenv("VAULT_DIR", "/home/ubuntu/vault_data")
INSTAGRAM_OUTPUT = os.path.join(VAULT_DIR, "instagram_scrape.json")
LAST_RUN_FILE = os.path.join(VAULT_DIR, "instagram_last_run.json")

def log(message):
    """Log with timestamp"""
    print(f"[INSTAGRAM] {datetime.now().isoformat()} {message}")

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

async def scrape_instagram_bookmarks_async():
    """
    Scrape Instagram bookmarks using instagrapi
    Supports cookies from GCS, env cookies, or password login
    """
    if not INSTAGRAPH_AVAILABLE:
        return {"success": False, "error": "instagrapi not installed"}

    log("=" * 50)
    log("Instagram Bookmark Scraper Started (instagrapi)")
    log("=" * 50)

    cl = Client()
    use_cookies = False

    # Try GCS cookies first
    gcs_cookies = load_cookies_from_gcs()
    if gcs_cookies and gcs_cookies.get('sessionid'):
        log("Using cookies from GCS")
        try:
            cl.set_settings({
                "cookies": gcs_cookies,
                "username": INSTAGRAM_USERNAME
            })
            # Verify by trying to fetch collections (works without full user context)
            test = cl.collections()
            log(f"GCS cookies are valid (found {len(test)} collections)")
            use_cookies = True
        except Exception as e:
            log(f"GCS cookies invalid ({e}), trying alternatives...")

    # Try env cookies if GCS failed
    if not use_cookies and INSTAGRAM_COOKIES:
        cookies = parse_cookies(INSTAGRAM_COOKIES)
        if "sessionid" in cookies:
            log(f"Using sessionid from env: {cookies.get('sessionid', '')[:20]}...")
            try:
                cl.set_settings({
                    "cookies": cookies,
                    "username": INSTAGRAM_USERNAME
                })
                # Verify by trying to fetch collections
                test = cl.collections()
                log(f"Env cookies are valid (found {len(test)} collections)")
                use_cookies = True
            except Exception as e:
                log(f"Env cookies expired ({e}), trying password login...")

    # Password login as fallback
    if not use_cookies and INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD:
        log(f"Logging in as {INSTAGRAM_USERNAME}...")
        try:
            cl.login(INSTAGRAM_USERNAME, INSTAGRAM_PASSWORD)
            log("Password login successful")
        except Exception as e:
            log(f"Password login failed: {e}")
            return {"success": False, "error": str(e)}

    if not use_cookies and not INSTAGRAM_PASSWORD:
        log("ERROR: No valid cookies from GCS/env and no INSTAGRAM_PASSWORD set")
        return {"success": False, "error": "No valid credentials"}

    try:
        # Get all collections (saved posts)
        log("Fetching collections (saved posts)...")
        collections = cl.collections()

        if not collections:
            log("No collections found")
            return {"success": False, "error": "No collections"}

        log(f"Found {len(collections)} collection(s)")

        # Fetch all saved posts from all collections
        all_posts = []
        for collection in collections:
            log(f"Fetching collection: {collection.name}")
            try:
                collection_items = cl.collection_medias(collection.id, amount=200)
                for item in collection_items:
                    post_data = {
                        "pk": str(item.pk),
                        "id": str(item.pk),
                        "caption": item.caption_text if hasattr(item, 'caption_text') and item.caption_text else "",
                        "media_type": item.media_type if hasattr(item, 'media_type') else 0,
                        "thumbnail_url": item.thumbnail_url if hasattr(item, 'thumbnail_url') else "",
                        "url": f"https://www.instagram.com/p/{item.code}/" if hasattr(item, 'code') and item.code else "",
                        "timestamp": datetime.now().isoformat(),
                        "like_count": item.like_count if hasattr(item, 'like_count') else 0,
                        "comment_count": item.comment_count if hasattr(item, 'comment_count') else 0
                    }
                    all_posts.append(post_data)

            except Exception as e:
                log(f"Error fetching collection {collection.name}: {e}")
                continue

        log(f"Total posts fetched: {len(all_posts)}")

        # Save to file
        os.makedirs(VAULT_DIR, exist_ok=True)

        with open(INSTAGRAM_OUTPUT, 'w') as f:
            json.dump(all_posts, f, indent=2)

        # Save last run info
        last_run = {
            "timestamp": datetime.now().isoformat(),
            "count": len(all_posts),
            "source": "instagram",
            "status": "success"
        }

        with open(LAST_RUN_FILE, 'w') as f:
            json.dump(last_run, f, indent=2)

        log(f"✅ Saved {len(all_posts)} posts to {INSTAGRAM_OUTPUT}")
        return {
            "success": True,
            "count": len(all_posts),
            "file": INSTAGRAM_OUTPUT,
            "timestamp": datetime.now().isoformat()
        }

    except Exception as e:
        log(f"❌ Error: {e}")
        return {"success": False, "error": str(e)}

def scrape_instagram_bookmarks():
    """Sync wrapper for async function"""
    return asyncio.run(scrape_instagram_bookmarks_async())

# Alias for compatibility with main.py import
scrape_instagram_saved = scrape_instagram_bookmarks

if __name__ == "__main__":
    result = scrape_instagram_bookmarks()
    print(json.dumps(result, indent=2))
