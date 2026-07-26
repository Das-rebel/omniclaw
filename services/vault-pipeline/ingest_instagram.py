#!/usr/bin/env python3
"""
Instagram Bookmark Ingestion.

Sources (in priority order):
1. instagrapi (live scrape) - if cookies available
2. GCS file: gs://omniclaw-knowledge-graph/vault/instagram_scrape.json
3. Local JSON file fallback

Deduplicates by URL. Preserves all metadata (imageUrl, vlTags, vlStyle, etc.).
"""

import json
import os
import sys
import asyncio
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from unified_schema import get_db, log_sync, get_meta, set_meta

GCS_BUCKET = "gs://omniclaw-knowledge-graph"
GCS_INSTAGRAM_PATH = "vault/instagram_scrape.json"
LOCAL_FALLBACK = Path.home() / "omniclaw" / "infrastructure" / "cloud-functions" / "deploy" / "learning_base" / "instagram_scrape.json"


def log(msg: str):
    print(f"[INSTAGRAM-INGEST] {datetime.now().isoformat()} {msg}", flush=True)


def _parse_gcs_uri(uri: str) -> tuple[str, str]:
    parts = uri.replace("gs://", "").split("/", 1)
    return parts[0], parts[1]


def read_from_gcs() -> list[dict]:
    """Read instagram JSON from GCS via google-cloud-storage library."""
    try:
        from google.cloud import storage
        bucket_name = GCS_BUCKET.replace("gs://", "")
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(GCS_INSTAGRAM_PATH)
        data = json.loads(blob.download_as_text())
        if isinstance(data, list):
            log(f"Read {len(data)} items from GCS")
            return data
    except Exception as e:
        log(f"GCS read failed: {e}")
    return []


def read_from_local() -> list[dict]:
    """Read instagram JSON from local file."""
    if LOCAL_FALLBACK.exists():
        try:
            data = json.loads(LOCAL_FALLBACK.read_text())
            if isinstance(data, list):
                log(f"Read {len(data)} items from local file")
                return data
        except Exception as e:
            log(f"Local read failed: {e}")
    return []


async def scrape_via_instagrapi() -> list[dict]:
    """Scrape saved posts live via instagrapi."""
    cookies_str = os.getenv("INSTAGRAM_COOKIES", "")
    username = os.getenv("INSTAGRAM_USERNAME", "")

    if not cookies_str:
        log("No INSTAGRAM_COOKIES set, skipping live scrape")
        return []

    # Handle GCS cookie format: {"cookies": {...}, "timestamp": "..."}
    try:
        cookies_data = json.loads(cookies_str)
        if isinstance(cookies_data, dict) and "cookies" in cookies_data:
            cookies = cookies_data["cookies"]
            log(f"Extracted Instagram cookies from GCS format")
        else:
            cookies = cookies_data
    except json.JSONDecodeError:
        # Not JSON - parse semicolon-separated format
        cookies = {}
        for part in cookies_str.split(";"):
            part = part.strip()
            if "=" in part:
                k, v = part.split("=", 1)
                cookies[k.strip()] = v.strip()

    sessionid = cookies.get("sessionid", "")
    if not sessionid:
        log("No sessionid in cookies, skipping")
        return []

    try:
        import asyncio
        from instagrapi import Client

        def _extract_posts_from_medias(medias: list) -> list[dict]:
            """Extract posts from instagrapi Media objects, expanding carousels into multiple entries."""
            result = []
            for media in medias:
                code = getattr(media, "code", "") or ""
                caption = getattr(media, "caption_text", "") or ""
                taken_at = media.taken_at.isoformat() if hasattr(media, "taken_at") and media.taken_at else ""
                media_type = {1: "photo", 2: "video", 8: "carousel"}.get(getattr(media, "media_type", 1), "photo")
                username = getattr(media.user, "username", "") if hasattr(media, "user") else ""
                scraped_at = datetime.now(timezone.utc).isoformat()
                
                if not code:
                    continue
                
                # Handle carousel posts: expand into one entry per carousel image
                resources = getattr(media, "resources", []) or []
                if resources and media_type == "carousel":
                    for idx, resource in enumerate(resources):
                        resource_image_url = str(getattr(resource, "thumbnail_url", "") or "")
                        if resource_image_url:
                            result.append({
                                "code": code,
                                "caption": caption,
                                "url": f"https://www.instagram.com/p/{code}/?img_index={idx}",
                                "image_url": resource_image_url,
                                "media_type": "carousel",
                                "carousel_index": idx,
                                "taken_at": taken_at,
                                "username": username,
                                "scraped_at": scraped_at,
                            })
                else:
                    # Regular photo/video post
                    image_url = str(getattr(media, "thumbnail_url", "") or "")
                    result.append({
                        "code": code,
                        "caption": caption,
                        "url": f"https://www.instagram.com/p/{code}/" if code else "",
                        "image_url": image_url,
                        "media_type": media_type,
                        "taken_at": taken_at,
                        "username": username,
                        "scraped_at": scraped_at,
                    })
            return result

        async def scrape_with_timeout():
            cl = Client()
            
            # Login via sessionid (proper auth method)
            result = cl.login_by_sessionid(sessionid)
            log(f"Instagram login: {result}, username: {cl.username}")
            
            if not cl.username:
                log("Instagram login failed")
                return []

            posts = []
            log("Fetching saved media via instagrapi...")

            # Get all collections and find the main one
            collections = cl.collections()
            log(f"Found {len(collections)} collections")
            
            # Try "Saved" collection first, then fall back to all collections
            target_collection = None
            for c in collections:
                if c.name and c.name.lower() == "saved":
                    target_collection = c
                    break
            
            if not target_collection:
                # No "Saved" collection - get user's own media instead
                log("No 'Saved' collection found, fetching user media")
                medias = cl.user_medias(cl.user_id, amount=50)
                posts.extend(_extract_posts_from_medias(medias))
                log(f"Got {len(posts)} user media items")
                return posts
            
            # Fetch from Saved collection
            log(f"Found Saved collection (id={target_collection.id})")
            saved_medias = cl.collection_medias(target_collection.id, amount=0)
            posts.extend(_extract_posts_from_medias(saved_medias))
            log(f"Got {len(posts)} saved posts")
            return posts

        # Run with 30 second timeout
        try:
            return await asyncio.wait_for(scrape_with_timeout(), timeout=30)
        except asyncio.TimeoutError:
            log("instagrapi timed out after 30s, falling back to GCS")
            return []
    except ImportError:
        log("instagrapi not installed, skipping live scrape")
        return []
    except Exception as e:
        log(f"instagrapi error: {e}")
        return []


def normalize_instagram(raw: dict) -> dict:
    """Normalize a raw Instagram post dict to unified bookmark format.
    Downloads the image and runs Ollama llava to generate visual descriptions.
    """
    code = raw.get("code", raw.get("shortcode", ""))
    url = raw.get("url", raw.get("permalink", f"https://www.instagram.com/p/{code}/" if code else ""))
    caption = raw.get("caption", raw.get("content", raw.get("text", "")))
    image_url = raw.get("image_url", raw.get("imageUrl", ""))
    media_type = raw.get("media_type", raw.get("mediaType", "photo"))
    taken_at = raw.get("taken_at", raw.get("postDate", raw.get("timestamp", "")))
    scraped_at = raw.get("scraped_at", raw.get("extracted_at", datetime.now(timezone.utc).isoformat()))
    username = raw.get("username", raw.get("user", ""))

    # Build metadata from extra fields
    meta_keys = {"code", "shortcode", "url", "permalink", "caption", "content",
                 "text", "image_url", "imageUrl", "media_type", "mediaType",
                 "taken_at", "postDate", "timestamp", "scraped_at", "extracted_at",
                 "username", "user", "id", "type"}
    metadata = {k: v for k, v in raw.items() if k not in meta_keys}
    if image_url and "imageUrl" not in metadata:
        metadata["imageUrl"] = image_url
    if media_type and "mediaType" not in metadata:
        metadata["mediaType"] = media_type

    source_id = raw.get("id", code or url)
    result = {
        "source": "instagram",
        "source_id": str(source_id),
        "url": url,
        "title": f"@{username}" if username else (raw.get("name", "")),
        "content": caption,
        "bookmarked_at": taken_at,
        "scraped_at": scraped_at,
        "metadata": metadata,
    }

    # Enrich with vision analysis (Ollama llava)
    vision_result = _analyze_instagram_image(image_url, caption)
    if vision_result:
        result["metadata"].update(vision_result)

    return result


def _analyze_instagram_image(image_url: str, caption: str) -> dict | None:
    """Download Instagram image and analyze with Ollama llava vision model.
    Returns enriched metadata dict or None on failure.
    """
    if not image_url:
        return None

    import urllib.request
    import base64
    import json
    import subprocess
    import tempfile

    img_data = None
    # Try multiple methods to get the image
    for attempt in range(2):
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
                'Accept': 'image/webp,image/png,*/*',
                'Referer': 'https://www.instagram.com/',
            }
            req = urllib.request.Request(image_url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                img_data = resp.read()
                break
        except Exception:
            if attempt == 0 and ('cdninstagram.com' in image_url or 'fbcdn' in image_url):
                # Try to get fresh URL via public Instagram page
                try:
                    import re
                    # Extract shortcode from existing URL
                    shortcode_match = re.search(r'/p/([^/]+)/', image_url)
                    if not shortcode_match:
                        # Try to get from generic patterns
                        shortcode_match = re.search(r'instagram\.com/p/([^/]+)', image_url)
                    if shortcode_match:
                        fresh_url = f"https://www.instagram.com/p/{shortcode_match.group(1)}/"
                        page_req = urllib.request.Request(fresh_url, headers={
                            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
                            'Accept-Language': 'en-US,en;q=0.9',
                        })
                        with urllib.request.urlopen(page_req, timeout=10) as page_resp:
                            html = page_resp.read().decode('utf-8', errors='replace')
                        # Extract og:image from meta tags
                        og_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', html) or \
                                   re.search(r'"og:image"\s+content="([^"]+)"', html)
                        if og_match:
                            image_url = og_match.group(1).replace('&amp;', '&')
                except Exception:
                    pass
            else:
                return None

    if not img_data or len(img_data) < 1024:
        return None

    # Skip processing large videos/images (over 15MB)
    if len(img_data) > 15 * 1024 * 1024:
        return None

    try:
        # Call Ollama llava vision model
        prompt = (
            "Describe this image for a search index. "
            "Return a JSON object with 3 fields: "
            "'visual_description' (short caption, max 80 chars), "
            "'vlTags' (array of 3-6 visual tag words like 'food,landscape,tech,art,people,nature,urban,minimalist'), "
            "'vlMood' (one word mood: Vibrant|Minimalist|Cinematic|Warm|Nostalgic|Cool). "
            "RESPOND ONLY WITH THE JSON OBJECT, no other text."
        )
        payload = json.dumps({
            "model": "llava:7b",
            "prompt": prompt,
            "images": [base64.b64encode(img_data).decode('utf-8')],
            "stream": False,
            "options": {"num_predict": 150, "temperature": 0.2}
        })
        result = subprocess.run(
            ["curl", "-s", "http://localhost:11434/api/generate", "-d", payload],
            capture_output=True, text=True, timeout=60
        )

        resp = json.loads(result.stdout)
        text = resp.get('response', '').strip()

        # Clean markdown code blocks
        if '```' in text:
            text = text.split('```')[1] if text.count('```') >= 2 else text
            if text.startswith('json'):
                text = text[4:]
        text = text.strip()

        analysis = json.loads(text)

        return {
            "visual_description": analysis.get("visual_description", ""),
            "vlTags": analysis.get("vlTags", []),
            "vlMood": analysis.get("vlMood", "Neutral"),
            "vlStyle": analysis.get("vlMood", "Neutral"),
            "vision_provider": "ollama-llava",
        }

    except Exception as e:
        log(f"Vision analysis error: {e}")
        return None


def ingest_bookmarks(bookmarks: list[dict], db_path: str | Path | None = None) -> dict:
    """Ingest a list of normalized Instagram bookmarks into the DB."""
    conn = get_db(db_path)
    stats = {"inserted": 0, "updated": 0, "skipped": 0, "errors": 0}
    now = datetime.now(timezone.utc).isoformat()

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

            # Index tags
            bookmark_id = conn.execute("SELECT id FROM bookmarks WHERE url = ?", (bm["url"],)).fetchone()[0]
            for tag_key in ("vlTags", "vlStyle", "vlMood"):
                for tag in bm.get("metadata", {}).get(tag_key, []):
                    conn.execute(
                        "INSERT OR IGNORE INTO bookmarks_tags (bookmark_id, tag, source) VALUES (?, ?, 'vl')",
                        (bookmark_id, tag),
                    )

        except Exception as e:
            log(f"Error ingesting {bm.get('url', '?')}: {e}")
            stats["errors"] += 1

    conn.commit()

    set_meta(conn, "instagram_last_scrape", now)
    log_sync(conn, "instagram", "ingest", stats["inserted"] + stats["updated"],
             "success", json.dumps(stats))

    conn.close()
    log(f"Ingest complete: {stats}")
    return stats


async def run(db_path: str | Path | None = None) -> dict:
    """Main entry point: try all sources and ingest."""
    log("Starting Instagram ingestion pipeline")
    all_bookmarks = []

    # Source 1: live instagrapi
    live = await scrape_via_instagrapi()
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
        log("No Instagram data found from any source")
        return {"source": "instagram", "inserted": 0, "updated": 0, "skipped": 0, "errors": 0}

    normalized = [normalize_instagram(p) for p in all_bookmarks if p.get("url") or p.get("code")]
    stats = ingest_bookmarks(normalized, db_path)
    return stats


def run_sync(db_path: str | Path | None = None) -> dict:
    """Synchronous wrapper."""
    return asyncio.run(run(db_path))


if __name__ == "__main__":
    result = run_sync()
    print(f"\nResult: {json.dumps(result, indent=2)}")
