#!/usr/bin/env python3
"""
Instagram Saved Posts Sync via instagrapi (NO Apify, NO paid APIs)

Uses the proprietary instagrapi library to:
1. Load session cookies from GCS
2. Fallback to username/password login
3. Fetch saved post collections
4. Upload merged results to GCS
"""

import os
import json
import traceback
from datetime import datetime, timezone
import functions_framework

try:
    from google.cloud import storage
    GCS_AVAILABLE = True
except ImportError:
    GCS_AVAILABLE = False
    print("[INSTAGRAM] google-cloud-storage not available")

try:
    from instagrapi import Client
    INSTAGRAPH_AVAILABLE = True
except ImportError:
    INSTAGRAPH_AVAILABLE = False
    print("[INSTAGRAM] instagrapi not installed")

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BUCKET_NAME = "omniclaw-knowledge-graph"
GCS_COOKIE_PATH = "vault/cookies/instagram_cookies.json"
GCS_INSTAGRAM_PATH = "vault/instagram_saved_automated.json"
GCS_SYNC_SUMMARY_PATH = "vault/latest_sync_summary.json"

INSTAGRAM_USERNAME = os.getenv("INSTAGRAM_USERNAME", "sdas22")
INSTAGRAM_PASSWORD = os.getenv("INSTAGRAM_PASSWORD", "")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(msg):
    print(f"[INSTAGRAM] {datetime.now(timezone.utc).isoformat()} {msg}", flush=True)

# ---------------------------------------------------------------------------
# GCS helpers
# ---------------------------------------------------------------------------

def _gcs_client():
    if not GCS_AVAILABLE:
        return None, None
    try:
        client = storage.Client()
        bucket = client.bucket(BUCKET_NAME)
        return client, bucket
    except Exception as e:
        log(f"GCS client error: {e}")
        return None, None


def _read_gcs_json(path):
    _, bucket = _gcs_client()
    if bucket is None:
        return None
    try:
        blob = bucket.blob(path)
        if not blob.exists():
            return None
        raw = blob.download_as_text()
        data = json.loads(raw)
        # Handle double-encoding: file contains JSON where posts field is a string
        if isinstance(data, dict):
            posts = data.get("posts", [])
            if isinstance(posts, str):
                data["posts"] = json.loads(posts)
        return data
    except Exception as e:
        log(f"Error reading {path}: {e}")
        return None


def _write_gcs_json(path, data):
    _, bucket = _gcs_client()
    if bucket is None:
        return False
    try:
        blob = bucket.blob(path)
        # Fix: Don't double-encode posts. The GCS file should be proper JSON
        # with posts as a JSON array, not a string-encoded JSON string.
        write_data = data
        if isinstance(data, dict) and isinstance(data.get("posts"), str):
            # Already double-encoded from a previous buggy write - fix it
            write_data = dict(data)
            write_data["posts"] = json.loads(data["posts"])
        blob.upload_from_string(
            json.dumps(write_data, indent=2),
            content_type="application/json",
        )
        log(f"Uploaded to GCS: {path}")
        return True
    except Exception as e:
        log(f"GCS upload failed for {path}: {e}")
        return False

# ---------------------------------------------------------------------------
# instagrapi session management
# ---------------------------------------------------------------------------

def _create_client():
    """Create an instagrapi Client."""
    if not INSTAGRAPH_AVAILABLE:
        raise RuntimeError("instagrapi not installed")
    cl = Client()
    # Set a realistic user-agent to reduce challenge risk
    cl.set_user_agent(
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.6099.230 Mobile Safari/537.36"
    )
    return cl


def _verify_session(cl):
    """Return True if the current session is valid.
    Tests a PRIVATE endpoint, not a public one.
    user_id_from_username works without auth — useless for verification.
    """
    try:
        # This is a private endpoint that requires valid session cookies
        # If cookies are expired, this will raise LoginRequired or 403
        cl.user_info(cl.user_id)
        log(f"Session valid (user_id={cl.user_id})")
        return True
    except Exception as e:
        err = str(e)
        if "login" in err.lower() or "403" in err or "401" in err:
            log(f"Session EXPIRED (private endpoint check failed): {err}")
            return False
        # If user_id is not set, try setting it first
        try:
            cl.user_id = cl.user_id_from_username(INSTAGRAM_USERNAME)
            cl.user_info(cl.user_id)
            log(f"Session valid after user_id resolution (user_id={cl.user_id})")
            return True
        except Exception as e2:
            log(f"Session verification failed: {e2}")
            return False


def _init_session_with_cookies(cl, cookies):
    """Load cookies into the client and verify against a private endpoint."""
    log("Loading cookies into instagrapi client")
    cl.set_settings({"cookies": cookies})
    # Inject username
    try:
        cl._username = INSTAGRAM_USERNAME
        cl.user_id = cl.user_id_from_username(INSTAGRAM_USERNAME)
    except Exception as e:
        log(f"Could not resolve user_id from username: {e}")
    return _verify_session(cl)


def _init_session_with_password(cl):
    """Login with username/password. Raises on failure."""
    if not INSTAGRAM_PASSWORD:
        raise RuntimeError("INSTAGRAM_PASSWORD not set; cannot fallback to password login")
    log(f"Attempting password login as {INSTAGRAM_USERNAME}")
    try:
        cl.login(INSTAGRAM_USERNAME, INSTAGRAM_PASSWORD)
        log("Password login succeeded")
        return True
    except Exception as e:
        err = str(e)
        if "challenge" in err.lower() or "two_factor" in err.lower() or "2fa" in err.lower():
            log(f"PASSWORD LOGIN BLOCKED: 2FA/challenge required from cloud IP: {err}")
            raise RuntimeError(
                "Instagram requires 2FA or challenge from this cloud IP. "
                "Upload fresh cookies to GCS instead."
            ) from e
        if "login" in err.lower() or "password" in err.lower():
            log(f"PASSWORD LOGIN FAILED: {err}")
            raise
        raise

# ---------------------------------------------------------------------------
# Cookie loading
# ---------------------------------------------------------------------------

def _load_cookies_gcs():
    """Load cookies from GCS. Returns dict or None."""
    data = _read_gcs_json(GCS_COOKIE_PATH)
    if data is None:
        log(f"No cookie file at gs://{BUCKET_NAME}/{GCS_COOKIE_PATH}")
        return None

    cookies = data.get("cookies", data) if isinstance(data, dict) else None
    if not cookies or not isinstance(cookies, dict):
        log("Cookie file has unexpected format")
        return None

    if not cookies.get("sessionid"):
        log("Cookie file missing sessionid")
        return None

    # Check freshness
    ts = data.get("timestamp", "")
    log(f"Loaded cookies from GCS (uploaded: {ts or 'unknown'})")
    return cookies

# ---------------------------------------------------------------------------
# Core scraping
# ---------------------------------------------------------------------------

def _fetch_collection_with_retry(cl, coll_id, coll_name, initial_amount=10000):
    """
    Fetch medias from a collection with retry logic.
    On 572 server error, retry with smaller chunks to avoid rate limits.
    Returns list of Media objects.
    """
    import time
    
    # Chunk sizes to try, descending
    chunk_sizes = [500, 200, 100, 50, 25, 10]
    last_media_pk = 0
    all_medias = []
    errors_572 = 0
    
    for chunk_size in chunk_sizes:
        try:
            remaining = initial_amount - len(all_medias)
            if remaining <= 0:
                break
            
            amount = min(chunk_size, remaining)
            if last_media_pk:
                medias = cl.collection_medias(str(coll_id), amount=amount, last_media_pk=last_media_pk)
            else:
                medias = cl.collection_medias(str(coll_id), amount=amount)
            
            if not medias:
                break
            
            all_medias.extend(medias)
            last_media_pk = int(medias[-1].pk)
            errors_572 = 0
            
            # If we got a full chunk, try for more (unless this is the last chunk_size tier)
            if len(medias) >= chunk_size and chunk_size < 500:
                # Keep fetching with this chunk_size
                continue
            elif len(medias) >= chunk_size and chunk_size == 500:
                # Got full 500, continue with same strategy
                continue
            else:
                # Got less than chunk_size → end of collection
                break
                
        except Exception as e:
            err_str = str(e)
            if "572" in err_str or "Server Error" in err_str:
                errors_572 += 1
                log(f"  572 error for collection '{coll_name}' (attempt {errors_572}, chunk={chunk_size}): {err_str[:80]}")
                if errors_572 >= 3:
                    log(f"  Too many 572 errors for '{coll_name}', stopping fetch")
                    break
                time.sleep(errors_572 * 2)  # backoff
                # Try smaller chunks on next iteration
                continue
            else:
                # Non-572 error → re-raise
                raise
    
    log(f"  → Fetched {len(all_medias)} posts from collection '{coll_name}' (chunk_size loop done)")
    return all_medias


def _scrape_saved_posts(cl):
    """
    Fetch all saved-post collections via instagrapi.
    Returns list of post dicts.
    """
    log("Fetching saved post collections...")
    try:
        collections = cl.collections()
    except Exception as e:
        err = str(e)
        log(f"collections() threw: {err}")
        if "login" in err.lower() or "403" in err or "401" in err:
            raise RuntimeError(f"LoginRequired during collections fetch: {err}") from e
        raise

    if not collections:
        # Could be genuinely empty or session expired mid-call
        # Verify session is still alive
        try:
            cl.user_info(cl.user_id)
            log("No collections found (session valid, account has no saved posts)")
        except Exception:
            log("No collections found AND session dead — cookies expired")
            raise RuntimeError("LoginRequired: session expired during collections fetch")
        return []

    log(f"Found {len(collections)} collection(s)")

    all_posts = []
    seen_pks = set()

    for coll in collections:
        coll_name = getattr(coll, "name", str(coll))
        coll_id = getattr(coll, "id", None)
        log(f"Fetching collection: {coll_name} (id={coll_id})")
        try:
            # instagrapi 2.x uses collection_medias (not collection_items)
            # It returns a list of Media objects (not a paginated iterator)
            # Use retry logic to handle 572 server errors on large collections
            medias = _fetch_collection_with_retry(cl, coll_id, coll_name, initial_amount=10000)
            for media in medias:
                pk = str(getattr(media, "pk", ""))
                if pk in seen_pks:
                    continue
                seen_pks.add(pk)

                code = getattr(media, "code", "")
                caption = ""
                if hasattr(media, "caption_text"):
                    caption = media.caption_text or ""

                thumbnail = ""
                if hasattr(media, "thumbnail_url"):
                    thumbnail = str(media.thumbnail_url) if media.thumbnail_url else ""
                elif hasattr(media, "resources") and media.resources:
                    first = media.resources[0]
                    if hasattr(first, "thumbnail_url"):
                        thumbnail = str(first.thumbnail_url) if first.thumbnail_url else ""

                post = {
                    "id": f"ig_{pk}",
                    "type": "instagram_saved",
                    "pk": pk,
                    "shortcode": code,
                    "url": f"https://www.instagram.com/p/{code}/" if code else "",
                    "caption": caption[:500] if caption else "",
                    "image_url": thumbnail,
                    "media_type": getattr(media, "media_type", 0),
                    "like_count": getattr(media, "like_count", 0),
                    "comment_count": getattr(media, "comment_count", 0),
                    "collection": coll_name,
                    "source": "instagrapi_saved",
                    "synced_at": datetime.now(timezone.utc).isoformat(),
                }

                if hasattr(media, "usertags") and hasattr(media.usertags, "users"):
                    post["usertags"] = [str(u.user.pk) for u in media.usertags.users]


                all_posts.append(post)

        except Exception as e:
            log(f"Error fetching collection {coll_name}: {e}")
            traceback.print_exc()
            continue

    return all_posts

# ---------------------------------------------------------------------------
# Merge + upload
# ---------------------------------------------------------------------------

def _merge_posts(new_posts, existing_data):
    """Merge new posts into existing data, dedup by pk."""
    if not existing_data:
        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "count": len(new_posts),
            "posts": new_posts,
        }

    existing_posts = existing_data.get("posts", [])
    # Handle double-encoded posts (stored as JSON string)
    if isinstance(existing_posts, str):
        try:
            existing_posts = json.loads(existing_posts)
        except Exception:
            existing_posts = []
    if not isinstance(existing_posts, list):
        existing_posts = []


    existing_pks = {p.get("pk") or p.get("id", "") for p in existing_posts}

    added = 0
    for post in new_posts:
        pk = post.get("pk", "")
        if pk and pk not in existing_pks:
            existing_posts.append(post)
            existing_pks.add(pk)
            added += 1

    existing_data["synced_at"] = datetime.now(timezone.utc).isoformat()
    existing_data["count"] = len(existing_posts)
    return existing_data, added


def _write_sync_summary(result, send_summary=True):
    if not send_summary:
        return
    existing = _read_gcs_json(GCS_SYNC_SUMMARY_PATH) or {}
    existing["instagram"] = {
        "synced_at": datetime.now(timezone.utc).isoformat(),
        "success": result.get("success", False),
        "count": result.get("count", 0),
        "source": result.get("source", "none"),
        "new_added": result.get("new_added", 0),
    }
    existing["last_updated"] = datetime.now(timezone.utc).isoformat()
    _write_gcs_json(GCS_SYNC_SUMMARY_PATH, existing)

# ---------------------------------------------------------------------------
# Main sync logic
# ---------------------------------------------------------------------------

def _do_sync(force_refresh=False, send_summary=True):
    """
    Full sync pipeline:
    1. Try GCS cookies → instagrapi session
    2. Fallback to password login
    3. Fetch saved collections
    4. Merge with existing GCS data (or skip merge if force_refresh or corrupt)
    5. Upload results
    """
    if not INSTAGRAPH_AVAILABLE:
        return {
            "success": False,
            "error": "instagrapi not installed — check requirements.txt",
            "source": "none",
            "count": 0,
        }


    cl = _create_client()
    auth_method = None

    # --- Step 1: Try GCS cookies ---
    cookies = _load_cookies_gcs()
    if cookies:
        try:
            if _init_session_with_cookies(cl, cookies):
                auth_method = "gcs_cookies"
                log("Authenticated via GCS cookies")
            else:
                log("GCS cookies expired or invalid")
        except Exception as e:
            log(f"GCS cookie auth failed: {e}")

    # --- Step 2: Fallback to password login ---
    if auth_method is None and INSTAGRAM_PASSWORD:
        try:
            _init_session_with_password(cl)
            auth_method = "password_login"
        except RuntimeError as e:
            return {
                "success": False,
                "error": str(e),
                "source": "password_login_blocked",
                "count": 0,
            }
        except Exception as e:
            log(f"Password login failed: {e}")
            # Don't give up yet — we may have existing data

    if auth_method is None:
        # No auth method worked; serve existing data
        existing = _read_gcs_json(GCS_INSTAGRAM_PATH)
        count = 0
        if existing and isinstance(existing, dict):
            count = existing.get("count", 0)
        msg = (
            "No valid auth method available. "
            "Upload fresh cookies to GCS or set INSTAGRAM_PASSWORD. "
            f"Existing data has {count} posts."
        )
        log(msg)
        result = {
            "success": count > 0,
            "error": msg if count == 0 else None,
            "source": "existing_stale" if count > 0 else "none",
            "count": count,
        }
        _write_sync_summary(result, send_summary)
        return result

    # --- Step 3: Fetch saved posts ---
    log(f"Authenticated via {auth_method}, fetching saved posts...")
    try:
        posts = _scrape_saved_posts(cl)
    except Exception as e:
        err = str(e)
        log(f"Scraping failed: {err}")
        traceback.print_exc()
        # Check if it's a LoginRequired / session expired error
        err_lower = err.lower()
        if "loginrequired" in err_lower or "login_required" in err_lower or "session expired" in err_lower:
            # Try password fallback if we were using cookies
            if auth_method == "gcs_cookies" and INSTAGRAM_PASSWORD:
                log("Session expired with cookies, trying password fallback...")
                try:
                    cl2 = _create_client()
                    _init_session_with_password(cl2)
                    auth_method = "password_fallback"
                    posts = _scrape_saved_posts(cl2)
                    cl = cl2  # Use the new client for cookie saving
                except Exception as pw_err:
                    log(f"Password fallback also failed: {pw_err}")
                    return {
                        "success": False,
                        "error": f"Cookies expired and password login failed: {pw_err}",
                        "source": "cookies_then_password_both_failed",
                        "count": 0,
                    }
            else:
                return {
                    "success": False,
                    "error": "Instagram session expired mid-request (LoginRequired). Upload fresh cookies.",
                    "source": auth_method,
                    "count": 0,
                }

    log(f"Fetched {len(posts)} saved posts via instagrapi")


    # --- Step 4: Merge and upload ---
    # Force refresh = skip merge entirely, just write fresh data
    if force_refresh:
        log("force_refresh=True — skipping merge, writing fresh data")
        merged = {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "count": len(posts),
            "posts": posts,
        }
        added = len(posts)
    else:
        # Normal merge with robust error handling for corrupt GCS data
        existing = _read_gcs_json(GCS_INSTAGRAM_PATH)
        if existing and isinstance(existing, dict):
            existing_posts = existing.get("posts", [])
            # Handle double-encoded posts (stored as JSON string instead of list)
            if isinstance(existing_posts, str):
                try:
                    existing_posts = json.loads(existing_posts)
                    log("Fixed double-encoded posts field in existing data")
                except Exception:
                    existing_posts = []
                    log("Could not parse double-encoded posts — starting fresh")

            if isinstance(existing_posts, list):
                # Do merge
                merged, added = _merge_posts(posts, existing)
            else:
                # existing is corrupt (posts is neither list nor parseable string) — start fresh
                log("Existing data corrupt (posts not a list) — starting fresh")
                merged = {
                    "synced_at": datetime.now(timezone.utc).isoformat(),
                    "count": len(posts),
                    "posts": posts,
                }
                added = len(posts)
        else:
            # No existing data — start fresh
            merged = {
                "synced_at": datetime.now(timezone.utc).isoformat(),
                "count": len(posts),
                "posts": posts,
            }
            added = len(posts)

    _write_gcs_json(GCS_INSTAGRAM_PATH, merged)

    result = {
        "success": True,
        "source": f"instagrapi_{auth_method}",
        "count": merged["count"],
        "new_added": added,
        "fetched_now": len(posts),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    # --- Step 5: Try to save refreshed cookies back to GCS ---
    try:
        settings = cl.get_settings()
        fresh_cookies = settings.get("cookies", {})
        if fresh_cookies and fresh_cookies.get("sessionid"):
            _write_gcs_json(GCS_COOKIE_PATH, {
                "cookies": fresh_cookies,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            log("Saved refreshed cookies back to GCS")
    except Exception as e:
        log(f"Could not save refreshed cookies: {e}")

    _write_sync_summary(result, send_summary)
    return result

# ---------------------------------------------------------------------------
# CORS helpers
# ---------------------------------------------------------------------------

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
}

CORS_PREFLIGHT = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

# ---------------------------------------------------------------------------
# Cloud Function entry point
# ---------------------------------------------------------------------------

@functions_framework.http
def fetch_instagram_saved(request):
    """
    HTTP Cloud Function for Instagram saved posts sync.
    Uses instagrapi (NOT Apify). Zero paid APIs.

    GET  → health check + existing data status
    POST → trigger sync
      Body: {
        "force_refresh": false,
        "send_summary": true
      }
    """
    # CORS preflight
    if request.method == "OPTIONS":
        return ("", 204, CORS_PREFLIGHT)

    # Health check
    if request.method == "GET":
        existing = _read_gcs_json(GCS_INSTAGRAM_PATH)
        cookie_data = _read_gcs_json(GCS_COOKIE_PATH)

        cookie_status = "none"
        if cookie_data:
            ts = cookie_data.get("timestamp", "unknown")
            cookie_status = f"present (uploaded: {ts})"

        count = 0
        last_sync = "never"
        if existing and isinstance(existing, dict):
            count = existing.get("count", 0)
            last_sync = existing.get("synced_at", "never")

        return (json.dumps({
            "service": "instagram-sync",
            "engine": "instagrapi",
            "status": "healthy",
            "apify_required": False,
            "cost": "$0/month",
            "instagrapi_available": INSTAGRAPH_AVAILABLE,
            "cookies_in_gcs": cookie_status,
            "password_configured": bool(INSTAGRAM_PASSWORD),
            "existing_data": {
                "count": count,
                "last_synced": last_sync,
            },
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }, indent=2), 200, CORS_HEADERS)

    # --- POST: trigger sync ---
    try:
        req_json = request.get_json(silent=True) or {}
    except Exception:
        req_json = {}

    force_refresh = req_json.get("force_refresh", False)
    send_summary = req_json.get("send_summary", True)

    log(f"Sync triggered (force_refresh={force_refresh})")

    try:
        result = _do_sync(force_refresh=force_refresh, send_summary=send_summary)
    except Exception as e:
        log(f"Unhandled error: {e}")
        traceback.print_exc()
        result = {
            "success": False,
            "error": str(e),
            "source": "error",
            "count": 0,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    code = 200 if result.get("success") else 502
    return (json.dumps(result, indent=2), code, CORS_HEADERS)


# Backward-compatible alias
def fetch_instagram_bookmarks(request):
    return fetch_instagram_saved(request)
