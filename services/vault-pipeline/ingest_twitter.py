#!/usr/bin/env python3
"""
Twitter Bookmark Ingestion.

Sources (in priority order):
1. twscrape API (live scrape) - if cookies available
2. GCS file: gs://omniclaw-knowledge-graph/vault/twitter_bookmarks_automated.json
3. Local JSON file fallback

Deduplicates by URL. Preserves all metadata.
"""

import json
import os
import sys
import asyncio
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from unified_schema import get_db, log_sync, get_meta, set_meta, DEFAULT_DB_PATH

GCS_BUCKET = "gs://omniclaw-knowledge-graph"
GCS_TWITTER_PATH = "vault/twitter_bookmarks_automated.json"
LOCAL_FALLBACK = Path.home() / "omniclaw" / "infrastructure" / "cloud-functions" / "deploy" / "learning_base" / "twitter_bookmarks_automated.json"


def log(msg: str):
    print(f"[TWITTER-INGEST] {datetime.now().isoformat()} {msg}", flush=True)


def _parse_gcs_uri(uri: str) -> tuple[str, str]:
    """Parse gs://bucket/path into (bucket, path)."""
    parts = uri.replace("gs://", "").split("/", 1)
    return parts[0], parts[1]


def read_from_gcs() -> list[dict]:
    """Read twitter JSON from GCS via google-cloud-storage library."""
    try:
        from google.cloud import storage
        bucket_name = GCS_BUCKET.replace("gs://", "")
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(GCS_TWITTER_PATH)
        data = json.loads(blob.download_as_text())
        if isinstance(data, list):
            log(f"Read {len(data)} items from GCS")
            return data
    except Exception as e:
        log(f"GCS read failed: {e}")
    return []


def read_from_local() -> list[dict]:
    """Read twitter JSON from local file."""
    if LOCAL_FALLBACK.exists():
        try:
            data = json.loads(LOCAL_FALLBACK.read_text())
            if isinstance(data, list):
                log(f"Read {len(data)} items from local file")
                return data
        except Exception as e:
            log(f"Local read failed: {e}")
    return []


async def scrape_via_twscrape() -> list[dict]:
    """Scrape bookmarks live via twscrape API."""
    cookies = os.getenv("TWITTER_COOKIES", "")
    username = os.getenv("TWITTER_USERNAME", "")

    if not cookies:
        log("No TWITTER_COOKIES set, skipping live scrape")
        return []

    try:
        from twscrape import API
        from twscrape.accounts_pool import AccountsPool

        pool = AccountsPool()
        await pool.add_account(
            username=username, password="", email="",
            email_password="", cookies=cookies,
        )
        await pool.login_all()
        api = API(pool)

        tweets = []
        async for tweet in api.bookmarks(limit=200):
            tweets.append({
                "id": str(tweet.id),
                "text": tweet.rawText,
                "author": tweet.user.screenName if tweet.user else "",
                "url": f"https://x.com/{tweet.user.screenName if tweet.user else 'unknown'}/status/{tweet.id}",
                "created_at": tweet.dateStr if hasattr(tweet, "dateStr") else datetime.utcnow().isoformat(),
                "scraped_at": datetime.utcnow().isoformat(),
            })

        log(f"twscrape fetched {len(tweets)} tweets")
        return tweets
    except ImportError:
        log("twscrape not installed, skipping live scrape")
        return []
    except Exception as e:
        log(f"twscrape error: {e}")
        return []


def normalize_tweet(raw: dict) -> dict:
    """Normalize a raw tweet dict to unified bookmark format."""
    tweet_id = str(raw.get("id", ""))
    text = raw.get("text", raw.get("content", raw.get("full_text", "")))
    author = raw.get("author", raw.get("username", ""))
    url = raw.get("url", f"https://x.com/{author}/status/{tweet_id}" if tweet_id else "")
    created_at = raw.get("created_at", raw.get("timestamp", ""))
    scraped_at = raw.get("scraped_at", raw.get("extracted_at", datetime.utcnow().isoformat()))

    # Build metadata from any extra fields
    meta_keys = {"id", "text", "content", "full_text", "author", "username",
                 "url", "created_at", "timestamp", "scraped_at", "extracted_at", "type"}
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


def ingest_bookmarks(bookmarks: list[dict], db_path: str | Path | None = None) -> dict:
    """Ingest a list of normalized twitter bookmarks into the DB."""
    conn = get_db(db_path)
    stats = {"inserted": 0, "updated": 0, "skipped": 0, "errors": 0}
    now = datetime.utcnow().isoformat()

    for bm in bookmarks:
        if not bm.get("url"):
            stats["skipped"] += 1
            continue

        try:
            metadata_json = json.dumps(bm.get("metadata", {}), ensure_ascii=False)
            cursor = conn.execute(
                """INSERT INTO bookmarks
                   (source, source_id, url, title, content, bookmarked_at, scraped_at, updated_at, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(url) DO UPDATE SET
                       content = COALESCE(NULLIF(excluded.content, ''), bookmarks.content),
                       metadata = excluded.metadata,
                       updated_at = excluded.updated_at,
                       title = COALESCE(NULLIF(excluded.title, ''), bookmarks.title)
                """,
                (bm["source"], bm["source_id"], bm["url"], bm.get("title", ""),
                 bm.get("content", ""), bm.get("bookmarked_at"), bm.get("scraped_at", now),
                 now, metadata_json),
            )

            if cursor.rowcount == 1:
                stats["inserted"] += 1
            else:
                stats["updated"] += 1

            # Index tags from metadata
            bookmark_id = conn.execute("SELECT id FROM bookmarks WHERE url = ?", (bm["url"],)).fetchone()[0]
            tags = bm.get("metadata", {}).get("vlTags", [])
            for tag in tags:
                conn.execute(
                    "INSERT OR IGNORE INTO bookmarks_tags (bookmark_id, tag, source) VALUES (?, ?, 'vl')",
                    (bookmark_id, tag),
                )

        except Exception as e:
            log(f"Error ingesting {bm.get('url', '?')}: {e}")
            stats["errors"] += 1

    conn.commit()

    # Update sync state
    set_meta(conn, "twitter_last_scrape", now)
    log_sync(conn, "twitter", "ingest", stats["inserted"] + stats["updated"],
             "success", json.dumps(stats))

    conn.close()
    log(f"Ingest complete: {stats}")
    return stats


async def run(db_path: str | Path | None = None) -> dict:
    """Main entry point: try all sources and ingest."""
    log("Starting Twitter ingestion pipeline")
    all_bookmarks = []

    # Source 1: live twscrape
    live = await scrape_via_twscrape()
    all_bookmarks.extend(live)

    # Source 2: GCS
    if not live:
        gcs_data = read_from_gcs()
        all_bookmarks.extend(gcs_data)

    # Source 3: local fallback
    if not all_bookmarks:
        local_data = read_from_local()
        all_bookmarks.extend(local_data)

    if not all_bookmarks:
        log("No Twitter data found from any source")
        return {"source": "twitter", "inserted": 0, "updated": 0, "skipped": 0, "errors": 0}

    # Normalize and ingest
    normalized = [normalize_tweet(t) for t in all_bookmarks]
    stats = ingest_bookmarks(normalized, db_path)
    return stats


def run_sync(db_path: str | Path | None = None) -> dict:
    """Synchronous wrapper."""
    return asyncio.run(run(db_path))


if __name__ == "__main__":
    result = run_sync()
    print(f"\nResult: {json.dumps(result, indent=2)}")
