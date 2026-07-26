#!/usr/bin/env python3
"""
Vault Sync v2 — Instagram Scraper (Standalone Subprocess)

Sources (in priority order):
1. Direct HTTP: Instagram saved posts API via curl subprocess (hard OS timeout)
   Falls back to:
2. instagrapi library (live scrape)
3. GCS fallback file
4. Local file fallback

Why direct HTTP:
  instagrapi has no saved_posts() method — only collection_medias().
  The "Saved" collection uses /feed/saved/posts/ which needs specific cookies
  and can be slow on page 2+ pagination. We use curl subprocess with
  OS-level timeout to prevent hangs.

Exit codes:
  0  = success (some items scraped or fallback worked)
  1  = general error
  2  = auth expired (sessionid invalid)
  124 = timeout (OS-level, should retry later)
"""

import json
import os
import sys
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from config import (
    GCS_PROJECT, GCS_BUCKET, GCS_INSTAGRAM_COOKIES_PATH,
    INSTAGRAM_USERNAME, DB_PATH,
    EXIT_OK, EXIT_ERROR, EXIT_AUTH_EXPIRED, EXIT_TIMEOUT,
)

LOG_PREFIX = "[IG-SCRAPE]"


def log(msg: str):
    print(f"{LOG_PREFIX} {datetime.now().isoformat()} {msg}", flush=True)


# ─── Cookie Loading ──────────────────────────────────────────────────────────

def load_cookies() -> dict:
    """Load Instagram cookies from GCS (GCS format: {cookies: {...}, timestamp: ...})."""
    try:
        from google.cloud import storage
        client = storage.Client(project=GCS_PROJECT)
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob(GCS_INSTAGRAM_COOKIES_PATH)
        data = json.loads(blob.download_as_text())
        if isinstance(data, dict) and "cookies" in data:
            log(f"Cookies from GCS, timestamp: {data.get('timestamp', 'unknown')}")
            return data["cookies"]
        return data
    except Exception as e:
        log(f"GCS cookie read failed: {e}")
        return {}


def parse_cookie_string(cookies_str: str) -> dict:
    """Parse semicolon-separated cookie string into dict."""
    cookies = {}
    for part in cookies_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies


# ─── GCS Fallback Readers ────────────────────────────────────────────────────

def read_gcs_fallback() -> list[dict]:
    """Read Instagram from GCS fallback."""
    try:
        from google.cloud import storage
        client = storage.Client(project=GCS_PROJECT)
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob("vault/instagram_saved_automated.json")
        data = json.loads(blob.download_as_text())
        if isinstance(data, list):
            log(f"GCS fallback: {len(data)} items")
            return data
        if isinstance(data, dict) and "posts" in data:
            log(f"GCS fallback: {len(data['posts'])} items (dict format)")
            return data["posts"]
    except Exception as e:
        log(f"GCS fallback read failed: {e}")
    return []


def read_local_fallback() -> list[dict]:
    """Read from local file as last resort."""
    for path in [
        DB_PATH.parent / "instagram_saved_automated.json",
        DB_PATH.parent / "instagram_scrape.json",
    ]:
        if path.exists():
            try:
                data = json.loads(path.read_text())
                if isinstance(data, list):
                    log(f"Local fallback ({path.name}): {len(data)} items")
                    return data
            except Exception as e:
                log(f"Local fallback ({path}) failed: {e}")
    return []


# ─── Direct HTTP Scrape via curl (primary method) ───────────────────────────

def scrape_via_http(cookies: dict) -> tuple[list[dict], bool]:
    """
    Scrape Instagram saved posts via direct HTTP API using curl subprocess.
    Uses OS-level timeout to prevent hangs on slow pagination.
    Returns (posts, auth_ok). auth_ok=False means sessionid expired.
    """
    import urllib.parse

    sessionid = cookies.get("sessionid", "")
    if not sessionid:
        log("No sessionid in cookies")
        return [], False

    # URL-decode sessionid if URL-encoded
    if "%" in sessionid:
        sessionid = urllib.parse.unquote(sessionid)

    csrftoken = cookies.get("csrftoken", cookies.get("csrf_token", ""))

    # Build full cookie string
    cookie_parts = [f"{k}={v}" for k, v in cookies.items() if v]
    cookie_str = "; ".join(cookie_parts)

    all_posts = []
    next_max_id = None
    auth_ok = True

    for page in range(50):  # max 50 pages = 2500 posts
        url = f"https://i.instagram.com/api/v1/feed/saved/posts/?count=50"
        if next_max_id:
            url += f"&max_id={urllib.parse.quote(next_max_id)}"

        # Build curl command with hard OS-level timeout
        curl_cmd = [
            "timeout", "--kill-after=5", "60",
            "curl", "-s", "-L",
            "--max-time", "55",
            "-H", f"User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
            "-H", "X-IG-App-ID: 936619743392459",
            "-H", "X-IG-WWW-Claim: 0",
            "-H", "X-Requested-With: XMLHttpRequest",
            "-H", "Referer: https://www.instagram.com/",
            "-H", f"Cookie: {cookie_str}",
            "-H", f"X-CSRFToken: {csrftoken}",
            "-H", "Accept: */*",
            "-H", "Accept-Language: en-US,en;q=0.9",
            url,
        ]

        try:
            result = subprocess.run(
                curl_cmd,
                capture_output=True, text=True, timeout=35,
            )

            if result.returncode == 124:
                log(f"curl timed out on page {page + 1} (30s) — stopping pagination")
                break
            elif result.returncode != 0:
                stderr = result.stderr.strip()
                # Detect auth failures
                if any(kw in stderr.lower() for kw in ["login", "unauthorized", "auth", "401", "403"]):
                    log(f"Auth error on page {page + 1}: {stderr[:100]}")
                    auth_ok = False
                    break
                log(f"curl error page {page + 1}: {stderr[:100]}")
                break

            text = result.stdout.strip()
            if not text or text.startswith("<!DOCTYPE") or text.startswith("<html"):
                log(f"HTML response (not JSON) on page {page + 1} — stopping")
                break

            data = json.loads(text)
            items = data.get("items", [])
            more_available = data.get("more_available", False)
            next_max_id = data.get("next_max_id")

            if not items:
                log(f"Page {page + 1}: 0 items — end of feed")
                break

            for item in items:
                media = item.get("media", {})
                user = media.get("user", {})
                code = media.get("code", "")
                caption = media.get("caption_text", "")
                media_type = media.get("media_type", 1)  # 1=photo, 2=video, 8=carousel
                username = user.get("username", "")

                taken_at_raw = media.get("taken_at") or media.get("date") or ""
                taken_at_str = ""
                if taken_at_raw:
                    try:
                        ts = int(taken_at_raw)
                        taken_at_str = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
                    except (ValueError, OSError):
                        taken_at_str = str(taken_at_raw)

                if not code:
                    continue

                # Handle carousel posts: extract all children images
                carousel_media = media.get("carousel_media", []) or []
                
                if carousel_media:
                    # Carousel post: create one entry per carousel image
                    for idx, child in enumerate(carousel_media):
                        child_image_url = ""
                        if child.get("thumbnail_url"):
                            child_image_url = child["thumbnail_url"]
                        elif child.get("image_versions2"):
                            candidates = child["image_versions2"].get("candidates", [])
                            if candidates:
                                child_image_url = candidates[0].get("url", "")
                        
                        if child_image_url:
                            all_posts.append({
                                "code": code,
                                "url": f"https://www.instagram.com/p/{code}/?img_index={idx}",
                                "caption": caption or "",
                                "image_url": child_image_url,
                                "taken_at": taken_at_str,
                                "username": username or "",
                                "source": "instagram",
                                "media_type": "carousel",
                                "carousel_index": idx,
                            })
                else:
                    # Regular photo/video post
                    image_url = ""
                    if media.get("thumbnail_url"):
                        image_url = media["thumbnail_url"]
                    elif media.get("image_versions2"):
                        candidates = media["image_versions2"].get("candidates", [])
                        if candidates:
                            image_url = candidates[0].get("url", "")

                    all_posts.append({
                        "code": code,
                        "url": f"https://www.instagram.com/p/{code}/",
                        "caption": caption or "",
                        "image_url": image_url or "",
                        "taken_at": taken_at_str,
                        "username": username or "",
                        "source": "instagram",
                        "media_type": {1: "photo", 2: "video"}.get(media_type, "photo"),
                    })

            log(f"Page {page + 1}: {len(items)} posts (total: {len(all_posts)}, more={more_available})")

            if not more_available or not next_max_id:
                break

        except subprocess.TimeoutExpired:
            log(f"Page {page + 1}: OS timeout — stopping")
            break
        except json.JSONDecodeError as e:
            log(f"Page {page + 1}: JSON parse error: {e} — {result.stdout[:100] if result.stdout else 'empty'}")
            break
        except Exception as e:
            log(f"Page {page + 1}: Error: {e}")
            break

    log(f"HTTP scrape: {len(all_posts)} posts from {page + 1} pages")
    return all_posts, auth_ok


# ─── instagrapi fallback (secondary) ─────────────────────────────────────────

def scrape_via_instagrapi(cookies: dict) -> tuple[list[dict], bool]:
    """
    instagrapi fallback — only used if direct HTTP fails.
    This is synchronous blocking code, so it's wrapped in a subprocess timeout.
    """
    sessionid = cookies.get("sessionid", "")
    if not sessionid:
        return [], False

    try:
        from instagrapi import Client
        cl = Client()

        result = cl.login_by_sessionid(sessionid)
        log(f"instagrapi login: {result}, username: {cl.username}")

        if not cl.username:
            return [], False

        # Try collections first
        collections = cl.collections()
        target = None
        for c in collections:
            for name in ["saved", "Saved", "SAVED"]:
                if c.name == name:
                    target = c
                    break
            if target:
                break

        posts = []
        if target:
            log(f"Fetching collection '{target.name}' (id={target.id})")
            medias = cl.collection_medias(target.id, amount=50)
            for media in medias:
                code = getattr(media, "code", "") or ""
                posts.append({
                    "code": code,
                    "url": f"https://www.instagram.com/p/{code}/" if code else "",
                    "caption": getattr(media, "caption_text", "") or "",
                    "image_url": (str(media.thumbnail_url)
                                 if hasattr(media, "thumbnail_url") and media.thumbnail_url else ""),
                    "taken_at": (media.taken_at.isoformat()
                                 if hasattr(media, "taken_at") and media.taken_at else ""),
                    "username": (getattr(media.user, "username", "")
                                 if hasattr(media, "user") else ""),
                    "source": "instagram",
                })
        else:
            # No saved collection — try user media
            log("No Saved collection, fetching user media")
            medias = cl.user_medias(cl.user_id, amount=50)
            for media in medias:
                code = getattr(media, "code", "") or ""
                posts.append({
                    "code": code,
                    "url": f"https://www.instagram.com/p/{code}/" if code else "",
                    "caption": getattr(media, "caption_text", "") or "",
                    "image_url": (str(media.thumbnail_url)
                                 if hasattr(media, "thumbnail_url") and media.thumbnail_url else ""),
                    "taken_at": (media.taken_at.isoformat()
                                 if hasattr(media, "taken_at") and media.taken_at else ""),
                    "username": (getattr(media.user, "username", "")
                                 if hasattr(media, "user") else ""),
                    "source": "instagram",
                })

        log(f"instagrapi: {len(posts)} posts")
        return posts, True

    except Exception as e:
        err_str = str(e).lower()
        log(f"instagrapi error: {e}")

        if any(kw in err_str for kw in ["auth", "401", "403", "login", "unauthorized", "expired", "session"]):
            return [], False

        return [], True  # Network/temporary error


# ─── Normalize ─────────────────────────────────────────────────────────────

def normalize_post(raw: dict) -> dict:
    """Normalize to unified bookmark format."""
    code = str(raw.get("code", raw.get("shortcode", "")))
    url = raw.get("url", raw.get("permalink",
                              f"https://www.instagram.com/p/{code}/" if code else ""))
    caption = raw.get("caption", raw.get("content", ""))
    image_url = raw.get("image_url", raw.get("imageUrl", ""))
    media_type = raw.get("media_type", "photo")
    taken_at = raw.get("taken_at", raw.get("postDate", ""))
    username = raw.get("username", "")

    meta_keys = {"code", "shortcode", "url", "permalink", "caption", "content",
                 "text", "image_url", "imageUrl", "media_type", "taken_at",
                 "postDate", "timestamp", "username", "user", "id", "type"}
    metadata = {k: v for k, v in raw.items() if k not in meta_keys}
    if image_url:
        metadata["imageUrl"] = image_url
    if media_type:
        metadata["mediaType"] = media_type

    source_id = raw.get("id", code or url)
    return {
        "source": "instagram",
        "source_id": str(source_id),
        "url": url,
        "title": f"@{username}" if username else "",
        "content": caption,
        "bookmarked_at": taken_at,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "metadata": metadata,
    }


# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Instagram scraper for Vault Sync v2")
    parser.add_argument("--out", required=True, help="Output JSON file path")
    parser.add_argument("--cookies-env", default="INSTAGRAM_COOKIES",
                       help="Environment variable name for cookies")
    args = parser.parse_args()

    output_path = Path(args.out)
    cookies_raw = os.environ.get(args.cookies_env, "")

    all_posts = []
    source = "none"
    auth_working = True

    # ── Source 1: Direct HTTP (primary) ──
    if cookies_raw:
        # Parse cookies
        try:
            cookies_data = json.loads(cookies_raw)
            if isinstance(cookies_data, dict) and "cookies" in cookies_data:
                cookies = cookies_data["cookies"]
            else:
                cookies = parse_cookie_string(cookies_raw)
        except json.JSONDecodeError:
            cookies = parse_cookie_string(cookies_raw)

        log("Attempting HTTP scrape of saved posts...")
        posts, auth_ok = scrape_via_http(cookies)
        all_posts.extend(posts)
        source = "http_saved_api"
        auth_working = auth_ok

        if not auth_working:
            log("HTTP auth failed — trying instagrapi fallback")
        elif not all_posts:
            log("HTTP returned 0 posts — trying instagrapi fallback")
            http_posts = list(all_posts)
            all_posts = []
            source = "http_empty"

    # ── Source 2: instagrapi fallback ──
    if not all_posts and cookies_raw:
        log("Attempting instagrapi scrape...")
        try:
            posts2, auth_ok2 = scrape_via_instagrapi(cookies)
            if posts2:
                all_posts.extend(posts2)
                source = "instagrapi"
                auth_working = auth_ok2
            elif not auth_ok2:
                auth_working = False
        except Exception as e:
            log(f"instagrapi fallback error: {e}")

    # ── Source 3: GCS fallback ──
    if not all_posts:
        log("Trying GCS fallback...")
        gcs_data = read_gcs_fallback()
        all_posts.extend(gcs_data)
        if gcs_data:
            source = "gcs_fallback"

    # ── Source 4: Local fallback ──
    if not all_posts:
        log("Trying local fallback...")
        local_data = read_local_fallback()
        all_posts.extend(local_data)
        if local_data:
            source = "local_fallback"

    if not all_posts:
        log("No Instagram posts found from any source")
        source = "none"

    # Deduplicate by URL
    seen_urls = set()
    deduped = []
    for p in all_posts:
        url = p.get("url", "")
        if url and url not in seen_urls:
            seen_urls.add(url)
            deduped.append(p)

    normalized = [normalize_post(p) for p in deduped]

    # Write output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps({
        "source": source,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "auth_working": auth_working,
        "count": len(normalized),
        "items": normalized,
    }, ensure_ascii=False, indent=2))

    log(f"Wrote {len(normalized)} posts to {output_path}")

    # Write metadata
    meta_path = output_path.with_suffix(".meta.json")
    meta_path.write_text(json.dumps({
        "source": source,
        "auth_working": auth_working,
        "count": len(normalized),
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "instagram_username": INSTAGRAM_USERNAME,
    }))

    if not auth_working:
        sys.exit(EXIT_AUTH_EXPIRED)

    sys.exit(EXIT_OK)


if __name__ == "__main__":
    main()
