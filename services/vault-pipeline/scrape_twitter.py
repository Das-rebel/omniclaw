#!/usr/bin/env python3
"""
Vault Sync v2 — Twitter Scraper (Standalone Subprocess)
Reads TWITTER_COOKIES from environment, tries twscrape live, falls back to GCS.

Exit codes:
  0  = success (some items scraped or fallback worked)
  1  = general error
  2  = auth expired (cookies invalid, need manual refresh)
  124 = timeout (OS-level, should retry later)
"""

import json
import os
import sys
import asyncio
from datetime import datetime, timezone
from pathlib import Path

# Add pipeline dir to path for config
sys.path.insert(0, str(Path(__file__).parent))
from config import (
    GCS_PROJECT, GCS_BUCKET, GCS_TWITTER_COOKIES_PATH,
    TWITTER_USERNAME, DB_PATH,
    EXIT_OK, EXIT_ERROR, EXIT_AUTH_EXPIRED, EXIT_TIMEOUT,
)

LOG_PREFIX = "[TWITTER-SCRAPE]"


def log(msg: str):
    print(f"{LOG_PREFIX} {datetime.now().isoformat()} {msg}", flush=True)


# ─── GCS Reader ──────────────────────────────────────────────────────────────

def read_gcs_cookies() -> str:
    """Read Twitter cookies from GCS."""
    try:
        from google.cloud import storage
        client = storage.Client(project=GCS_PROJECT)
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob(GCS_TWITTER_COOKIES_PATH)
        data = json.loads(blob.download_as_text())
        if isinstance(data, dict) and "cookies" in data:
            log(f"Cookies from GCS, timestamp: {data.get('timestamp', 'unknown')}")
            return json.dumps(data["cookies"])
        return json.dumps(data)
    except Exception as e:
        log(f"GCS cookie read failed: {e}")
        return ""


def read_gcs_fallback() -> list[dict]:
    """Read twitter bookmarks from GCS fallback file."""
    try:
        from google.cloud import storage
        client = storage.Client(project=GCS_PROJECT)
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob("vault/twitter_bookmarks_automated.json")
        data = json.loads(blob.download_as_text())
        if isinstance(data, list):
            log(f"GCS fallback: {len(data)} items")
            return data
    except Exception as e:
        log(f"GCS fallback read failed: {e}")
    return []


def read_local_fallback() -> list[dict]:
    """Read from local file as last resort."""
    path = DB_PATH.parent / "twitter_bookmarks_automated.json"
    if path.exists():
        try:
            data = json.loads(path.read_text())
            if isinstance(data, list):
                log(f"Local fallback: {len(data)} items")
                return data
        except Exception as e:
            log(f"Local fallback failed: {e}")
    return []


# ─── Live Scrape via twscrape ────────────────────────────────────────────────

def normalize_tweet(raw: dict) -> dict:
    """Normalize a raw tweet dict to unified bookmark format."""
    tweet_id = str(raw.get("id", ""))
    author = raw.get("author", raw.get("username", ""))
    text = raw.get("text", raw.get("content", raw.get("rawContent", "")))
    url = raw.get("url") or (f"https://x.com/{author}/status/{tweet_id}" if tweet_id else "")
    created_at = raw.get("created_at", raw.get("date", ""))
    scraped_at = raw.get("scraped_at", datetime.now(timezone.utc).isoformat())

    meta_keys = {"id", "text", "content", "rawContent", "author", "username",
                 "url", "created_at", "date", "scraped_at", "extracted_at", "type"}
    metadata = {k: v for k, v in raw.items() if k not in meta_keys}

    return {
        "source": "twitter",
        "source_id": tweet_id,
        "url": url,
        "title": f"@{author}" if author else "",
        "content": text,
        "bookmarked_at": created_at,
        "scraped_at": scraped_at,
        "metadata": metadata,
    }


async def scrape_live(cookies_str: str, username: str) -> tuple[list[dict], bool]:
    """
    Scrape bookmarks via twscrape.
    Returns (tweets, auth_ok). auth_ok=False means cookies are invalid/expired.
    """
    # Parse cookies (handle GCS format vs raw format)
    try:
        cookies_data = json.loads(cookies_str)
        if isinstance(cookies_data, dict) and "cookies" in cookies_data:
            cookies_str = json.dumps(cookies_data["cookies"])
    except json.JSONDecodeError:
        pass  # Already a raw cookie string

    try:
        import asyncio
        from twscrape import API
        from twscrape.accounts_pool import AccountsPool

        pool = AccountsPool()
        await pool.add_account(
            username=username,
            password="",
            email="",
            email_password="",
            cookies=cookies_str,
        )
        await pool.login_all()
        api = API(pool)

        tweets = []
        async for tweet in api.bookmarks(limit=200):
            tweets.append({
                "id": str(tweet.id),
                "rawContent": tweet.rawContent if hasattr(tweet, 'rawContent') else '',
                "author": tweet.user.username if tweet.user else "",
                "url": f"https://x.com/{tweet.user.username if tweet.user else 'unknown'}/status/{tweet.id}",
                "created_at": str(tweet.date) if hasattr(tweet, 'date') else "",
                "scraped_at": datetime.now(timezone.utc).isoformat(),
            })

        log(f"twscrape fetched {len(tweets)} tweets")
        return tweets, True

    except Exception as e:
        err_str = str(e).lower()
        log(f"twscrape error: {e}")

        # Detect auth failures
        if any(kw in err_str for kw in ["auth", "401", "403", "invalid", "expired", "could not authenticate"]):
            log("Auth failure detected — cookies expired or invalid")
            return [], False

        return [], True  # Network error, not auth — let caller retry


# ─── Main ─────────────────────────────────────────────────────────────────────

async def main():
    import argparse
    parser = argparse.ArgumentParser(description="Twitter scraper for Vault Sync v2")
    parser.add_argument("--out", required=True, help="Output JSON file path")
    parser.add_argument("--cookies-env", default="TWITTER_COOKIES",
                        help="Environment variable name for cookies")
    args = parser.parse_args()

    output_path = Path(args.out)
    cookies_str = os.environ.get(args.cookies_env, "")

    all_tweets = []
    source = "none"
    auth_working = True

    # Source 1: Live scrape
    if cookies_str:
        log("Attempting live scrape...")
        tweets, auth_ok = await scrape_live(cookies_str, TWITTER_USERNAME)
        all_tweets.extend(tweets)
        source = "twscrape"
        auth_working = auth_ok

        if not auth_working:
            log("Auth expired — falling back to GCS/local")
            # Don't exit — try fallbacks below
    else:
        log("No TWITTER_COOKIES env var — using fallbacks")

    # Source 2: GCS fallback
    if not all_tweets:
        log("Trying GCS fallback...")
        gcs_data = read_gcs_fallback()
        all_tweets.extend(gcs_data)
        if gcs_data:
            source = "gcs_fallback"

    # Source 3: Local fallback
    if not all_tweets:
        log("Trying local fallback...")
        local_data = read_local_fallback()
        all_tweets.extend(local_data)
        if local_data:
            source = "local_fallback"

    # Deduplicate by URL
    seen_urls = set()
    deduped = []
    for t in all_tweets:
        url = t.get("url", "")
        if url and url not in seen_urls:
            seen_urls.add(url)
            deduped.append(t)

    normalized = [normalize_tweet(t) for t in deduped]

    # Write output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps({
        "source": source,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "auth_working": auth_working,
        "count": len(normalized),
        "items": normalized,
    }, ensure_ascii=False, indent=2))

    log(f"Wrote {len(normalized)} tweets to {output_path}")

    # Write metadata alongside
    meta_path = output_path.with_suffix(".meta.json")
    meta_path.write_text(json.dumps({
        "source": source,
        "auth_working": auth_working,
        "count": len(normalized),
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "twitter_username": TWITTER_USERNAME,
    }))

    if not auth_working:
        sys.exit(EXIT_AUTH_EXPIRED)

    sys.exit(EXIT_OK)


if __name__ == "__main__":
    asyncio.run(main())
