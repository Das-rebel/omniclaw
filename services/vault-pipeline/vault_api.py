#!/usr/bin/env python3
"""
Vault API - Direct GCS-based bookmark API.

Loads bookmarks from GCS JSON files on startup and caches them in memory.
No local SQLite needed - always reads from the massive scraped database.

Endpoints:
    GET  /                        - service info
    GET  /health                  - health check
    GET  /api/stats               - counts per source
    GET  /api/bookmarks           - list bookmarks
    GET  /api/bookmarks/<id>      - single bookmark
    GET  /api/search              - search bookmarks
    GET  /api/sync/twitter        - sync Twitter from GCS
    GET  /api/sync/instagram      - sync Instagram from GCS
    GET  /api/sync/status         - sync status
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

from flask import Flask, request, jsonify

# google-cloud-storage for GCS access
from google.cloud import storage

app = Flask(__name__)

GCS_BUCKET = "omniclaw-knowledge-graph"
GCS_TWITTER_PATH = "vault/twitter_bookmarks_automated.json"
GCS_INSTAGRAM_PATH = "vault/instagram_saved_automated.json"

# In-memory cache
bookmarks_cache = []
last_sync = {"twitter": None, "instagram": None}
cache_loaded_at = None
executor = ThreadPoolExecutor(max_workers=2)


def load_gcs_json(bucket, path):
    """Load JSON from GCS. Returns a list or dict."""
    try:
        client = storage.Client()
        blob = bucket.blob(path)
        data_str = blob.download_as_text()
        # Handle double-encoded JSON
        data = json.loads(data_str)
        if isinstance(data, str):
            data = json.loads(data)
        return data
    except Exception as e:
        print(f"GCS load error for {path}: {e}")
        return []


def load_all_bookmarks():
    """Load all bookmarks from GCS into memory cache."""
    global bookmarks_cache, last_sync, cache_loaded_at
    
    print("Loading bookmarks from GCS...")
    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    
    all_items = []
    
    # Load Twitter
    twitter_data = load_gcs_json(bucket, GCS_TWITTER_PATH)
    print(f"Twitter: {len(twitter_data)} items")
    for item in twitter_data:
        item["source"] = "twitter"
        item["url"] = item.get("url", f"https://x.com/{item.get('author','unknown')}/status/{item.get('id','')}")
        item["content"] = item.get("text", item.get("content", ""))
        item["title"] = f"@{item.get('author', '')}"
        item["bookmarked_at"] = item.get("created_at", "")
        all_items.append(item)
    
    # Load Instagram  
    instagram_raw = load_gcs_json(bucket, GCS_INSTAGRAM_PATH)
    instagram_data = instagram_raw.get("posts", []) if isinstance(instagram_raw, dict) else instagram_raw
    print(f"Instagram: {len(instagram_data)} items")
    for item in instagram_data:
        item["source"] = "instagram"
        item["url"] = item.get("url", item.get("permalink", ""))
        item["content"] = item.get("caption", item.get("content", ""))
        item["title"] = item.get("title", f"IG: {item.get('shortcode', '')}")
        item["bookmarked_at"] = item.get("timestamp", item.get("created_at", ""))
        all_items.append(item)
    
    bookmarks_cache = all_items
    cache_loaded_at = datetime.utcnow().isoformat()
    last_sync = {
        "twitter": cache_loaded_at,
        "instagram": cache_loaded_at
    }
    print(f"Total cached: {len(bookmarks_cache)} bookmarks")


def get_stats():
    """Calculate stats from cache."""
    twitter_count = sum(1 for b in bookmarks_cache if b.get("source") == "twitter")
    instagram_count = sum(1 for b in bookmarks_cache if b.get("source") == "instagram")
    
    twitter_dates = [b.get("bookmarked_at", "") for b in bookmarks_cache if b.get("source") == "twitter" and b.get("bookmarked_at")]
    instagram_dates = [b.get("bookmarked_at", "") for b in bookmarks_cache if b.get("source") == "instagram" and b.get("bookmarked_at")]
    
    return {
        "total": len(bookmarks_cache),
        "sources": {
            "twitter": {"count": twitter_count, "earliest": min(twitter_dates) if twitter_dates else None, "latest": max(twitter_dates) if twitter_dates else None},
            "instagram": {"count": instagram_count, "earliest": min(instagram_dates) if instagram_dates else None, "latest": max(instagram_dates) if instagram_dates else None}
        },
        "unique_tags": 0,
        "last_sync": last_sync,
        "cache_loaded_at": cache_loaded_at
    }


def search_bookmarks(q, source=None, limit=50):
    """Search in-memory cache."""
    q_lower = q.lower()
    results = []
    
    for b in bookmarks_cache:
        if source and b.get("source") != source:
            continue
        
        # Search in content, title, url
        content = b.get("content", "").lower()
        title = b.get("title", "").lower()
        url = b.get("url", "").lower()
        
        if q_lower in content or q_lower in title or q_lower in url:
            results.append({
                "id": b.get("id", b.get("tweet_id", b.get("code", ""))),
                "source": b.get("source"),
                "url": b.get("url"),
                "title": b.get("title"),
                "content": b.get("content", "")[:200],
                "bookmarked_at": b.get("bookmarked_at"),
                "metadata": {k: v for k, v in b.items() if k not in ["content", "title", "url", "source", "bookmarked_at", "id"]}
            })
        
        if len(results) >= limit:
            break
    
    return results


# Load bookmarks on startup
print("Initializing vault-pipeline with GCS backend...")
load_all_bookmarks()


@app.route("/")
def index():
    stats = get_stats()
    return jsonify({
        "service": "vault-pipeline",
        "status": "ok",
        "backend": "GCS",
        "total_bookmarks": stats["total"],
        "cache_loaded_at": cache_loaded_at
    })


@app.route("/health")
def health():
    return jsonify({
        "status": "healthy",
        "service": "vault-pipeline",
        "total_bookmarks": len(bookmarks_cache)
    })


@app.route("/api/stats")
def stats():
    return jsonify(get_stats())


@app.route("/api/bookmarks")
def bookmarks_list():
    source = request.args.get("source")
    limit = min(int(request.args.get("limit", 50)), 500)
    offset = int(request.args.get("offset", 0))
    
    items = []
    count = 0
    for b in bookmarks_cache:
        if source and b.get("source") != source:
            continue
        count += 1
        if offset <= 0:
            items.append({
                "id": b.get("id", b.get("tweet_id", b.get("code", ""))),
                "source": b.get("source"),
                "url": b.get("url"),
                "title": b.get("title"),
                "content": b.get("content", ""),
                "bookmarked_at": b.get("bookmarked_at"),
                "metadata": {k: v for k, v in b.items() if k not in ["content", "title", "url", "source", "bookmarked_at", "id"]}
            })
            if len(items) >= limit:
                break
    
    return jsonify({
        "items": items,
        "limit": limit,
        "offset": offset,
        "count": len(items),
        "total_matching": count
    })


@app.route("/api/bookmarks/<bookmark_id>")
def bookmark_detail(bookmark_id):
    for b in bookmarks_cache:
        bid = str(b.get("id", b.get("tweet_id", b.get("code", ""))))
        if bid == str(bookmark_id):
            return jsonify({
                "id": b.get("id", b.get("tweet_id", b.get("code", ""))),
                "source": b.get("source"),
                "url": b.get("url"),
                "title": b.get("title"),
                "content": b.get("content"),
                "bookmarked_at": b.get("bookmarked_at"),
                "metadata": {k: v for k, v in b.items() if k not in ["content", "title", "url", "source", "bookmarked_at", "id"]}
            })
    return jsonify({"error": "not found"}), 404


@app.route("/api/search")
def search():
    q = request.args.get("q", "").strip()
    source = request.args.get("source")
    limit = min(int(request.args.get("limit", 50)), 200)
    
    if not q:
        return jsonify({"error": "q parameter required"}), 400
    
    results = search_bookmarks(q, source, limit)
    return jsonify({
        "query": q,
        "results": results,
        "count": len(results)
    })


@app.route("/api/sync/<source>", methods=["POST"])
def trigger_sync(source):
    if source not in ("twitter", "instagram"):
        return jsonify({"error": f"unknown source: {source}"}), 400
    
    # Reload from GCS in background
    def background_sync():
        load_all_bookmarks()
    
    executor.submit(background_sync)
    
    return jsonify({
        "source": source,
        "result": {"status": "syncing", "message": f"Reloading {source} from GCS..."}
    })


@app.route("/api/sync/status")
def sync_status():
    return jsonify({
        "twitter_last_scrape": last_sync.get("twitter"),
        "instagram_last_scrape": last_sync.get("instagram"),
        "cache_loaded_at": cache_loaded_at,
        "recent_log": []
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)