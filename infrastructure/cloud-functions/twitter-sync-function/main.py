"""
Twitter Bookmark Sync — Cloud Function

Strategy:
  1. Load auth cookies from GCS (vault/cookies/twitter_cookies.json)
  2. Try twscrape API with cookies injected directly into httpx client
  3. If that fails, try direct GraphQL API with httpx + cookies
  4. Upload results to GCS
"""

import os
import json
import asyncio
import traceback
import random
from datetime import datetime, timezone

import functions_framework

try:
    from google.cloud import storage
    GCS_AVAILABLE = True
except ImportError:
    GCS_AVAILABLE = False

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

try:
    from twscrape import API
    from twscrape.models import Tweet
    TWSCRAPE_AVAILABLE = True
except ImportError:
    TWSCRAPE_AVAILABLE = False

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BUCKET_NAME = os.getenv("GCS_BUCKET", "omniclaw-knowledge-graph")
COOKIE_PATH = "vault/cookies/twitter_cookies.json"
BOOKMARKS_PATH = "vault/twitter_bookmarks_automated.json"
SUMMARY_PATH = "vault/latest_sync_summary.json"

MAX_BOOKMARKS = int(os.getenv("MAX_BOOKMARKS", "800"))
ATTEMPT_TIMEOUT = int(os.getenv("ATTEMPT_TIMEOUT", "180"))

# Twitter GQL endpoint
GQL_URL = "https://x.com/i/api/graphql"
OP_BOOKMARKS = "-LGfdImKeQz0xS_jjUwzlA/Bookmarks"

# Twitter static headers + authorization
TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"

TWITTER_HEADERS = {
    "authorization": f"Bearer {TOKEN}",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
}

# Feature flags for bookmarks (from twscrape source)
GQL_FEATURES = {
    "graphql_timeline_v2_bookmark_timeline": True,
    "articles_preview_enabled": False,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "communities_web_enable_tweet_community_results_fetch": True,
    "creator_subscriptions_quote_tweet_preview_enabled": False,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "longform_notetweets_inline_media_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "responsive_web_enhance_cards_enabled": False,
    "responsive_web_graphql_exclude_directive_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_media_download_video_enabled": False,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "rweb_tipjar_consumption_enabled": True,
    "rweb_video_timestamps_enabled": True,
    "standardized_nudges_misinfo": True,
    "tweet_awards_web_tipping_enabled": False,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "tweet_with_visibility_results_prefer_gql_media_interstitial_enabled": False,
    "tweetypie_unmention_optimization_enabled": True,
    "verified_phone_label_enabled": False,
    "view_counts_everywhere_api_enabled": True,
    "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
    "premium_content_api_read_enabled": False,
    "profile_label_improvements_pcf_label_in_post_enabled": False,
    "responsive_web_grok_share_attachment_enabled": False,
    "responsive_web_grok_analyze_post_followups_enabled": False,
    "responsive_web_grok_image_annotation_enabled": False,
    "responsive_web_grok_analysis_button_from_backend": False,
    "responsive_web_grok_share_attachment_enabled": False,
    "rweb_video_screen_enabled": True,
    "responsive_web_grok_show_grok_translated_post": True,
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(msg: str):
    ts = datetime.now(timezone.utc).isoformat()
    print(f"[twitter-sync] {ts} {msg}", flush=True)


# ---------------------------------------------------------------------------
# GCS helpers
# ---------------------------------------------------------------------------

def _gcs_client():
    if not GCS_AVAILABLE:
        return None
    return storage.Client()


def gcs_download_json(path: str) -> dict | None:
    try:
        client = _gcs_client()
        if client is None:
            return None
        bucket = client.bucket(BUCKET_NAME)
        blob = bucket.blob(path)
        if not blob.exists():
            log(f"GCS blob not found: {path}")
            return None
        return json.loads(blob.download_as_text())
    except Exception as exc:
        log(f"GCS download failed for {path}: {exc}")
        return None


def gcs_upload_json(path: str, data):
    try:
        client = _gcs_client()
        if client is None:
            log("GCS unavailable, skipping upload")
            return False
        bucket = client.bucket(BUCKET_NAME)
        blob = bucket.blob(path)
        blob.upload_from_string(
            json.dumps(data, indent=2, ensure_ascii=False),
            content_type="application/json",
        )
        log(f"Uploaded {path} to GCS")
        return True
    except Exception as exc:
        log(f"GCS upload failed for {path}: {exc}")
        return False


# ---------------------------------------------------------------------------
# Cookie loading
# ---------------------------------------------------------------------------

def load_cookies_from_gcs() -> dict | None:
    data = gcs_download_json(COOKIE_PATH)
    if data is None:
        return None
    cookies = data.get("cookies", {})
    if not cookies.get("auth_token") and not cookies.get("ct0"):
        log("Cookie file present but missing auth_token/ct0")
        return None
    ts = data.get("timestamp", "unknown")
    log(f"Loaded cookies from GCS (uploaded: {ts})")
    return cookies


# ---------------------------------------------------------------------------
# Helper: build httpx client with Twitter cookies
# ---------------------------------------------------------------------------

def _build_twitter_client(cookies: dict) -> httpx.AsyncClient:
    """
    Create an httpx AsyncClient with Twitter auth cookies and headers injected.
    This mimics what Account.make_client() does in twscrape.
    """
    auth_token = cookies.get("auth_token", "")
    ct0 = cookies.get("ct0", "")

    cookie_jar = httpx.Cookies()
    cookie_jar.set("auth_token", auth_token, domain=".x.com")
    cookie_jar.set("ct0", ct0, domain=".x.com")
    if cookies.get("twid"):
        cookie_jar.set("twid", cookies["twid"], domain=".x.com")
    if cookies.get("gt"):
        cookie_jar.set("gt", cookies["gt"], domain=".x.com")
    if cookies.get("guest_id"):
        cookie_jar.set("guest_id", cookies["guest_id"], domain=".x.com")

    headers = {
        **TWITTER_HEADERS,
        "user-agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "content-type": "application/json",
        "x-csrf-token": ct0,
    }

    client = httpx.AsyncClient(
        cookies=cookie_jar,
        headers=headers,
        follow_redirects=True,
        timeout=30,
    )
    return client


# ---------------------------------------------------------------------------
# Helper: parse bookmarks from twscrape-style GQL JSON
# ---------------------------------------------------------------------------

def _parse_bookmarks_from_gql(obj: dict, limit: int) -> tuple[list[dict], str | None]:
    """
    Parse GraphQL JSON into bookmark dicts.
    Twitter returns: data.bookmark_timeline_v2.timeline.instructions[].entries[]
    where entryId is a UUID like "tweet-c0a80c4f-..." not "tweet-{numeric_id}".
    """
    bookmarks = []
    cursor = None

    entries = (
        obj.get("data", {})
        .get("bookmark_timeline_v2", {})
        .get("timeline", {})
        .get("instructions", [])
    )
    # Collect all entries from all instructions
    all_entries = []
    for inst in entries:
        all_entries.extend(inst.get("entries", []))

    for entry in all_entries:
        entry_id = entry.get("entryId", "")

        # Pagination cursor entries
        if "cursor-bottom" in entry_id or "cursor" in entry_id.lower():
            content = entry.get("content", {})
            cursor = (
                content.get("value")
                or content.get("itemContent", {}).get("value")
            )
            continue

        # Tweet entries have __typename in itemContent.tweet_results.result
        item_content = entry.get("content", {}).get("itemContent", {})
        tweet_results = item_content.get("tweet_results", {}).get("result", {})

        # Skip non-tweet entries (like cursor-type, messageprompt)
        if not tweet_results or tweet_results.get("__typename") not in ("Tweet", "TweetWithVisibilityResults"):
            continue

        # Unwrap TweetWithVisibilityResults
        if tweet_results.get("__typename") == "TweetWithVisibilityResults":
            tweet_results = tweet_results.get("tweet", {})

        rest_id = tweet_results.get("rest_id", "")
        legacy = tweet_results.get("legacy", {})
        core = (
            tweet_results.get("core", {})
            .get("user_results", {})
            .get("result", {})
            .get("legacy", {})
        )

        text = legacy.get("full_text", "") or legacy.get("text", "")
        screen_name = core.get("screen_name", "")

        bm = {
            "id": str(rest_id),
            "url": f"https://x.com/{screen_name}/status/{rest_id}",
            "text": text,
            "author": screen_name,
            "author_name": core.get("name", ""),
            "created_at": legacy.get("created_at", ""),
            "like_count": legacy.get("favorite_count", 0),
            "retweet_count": legacy.get("retweet_count", 0),
            "reply_count": legacy.get("reply_count", 0),
            "view_count": (
                tweet_results.get("views", {}).get("count", 0) or 0
            ),
            "scraped_at": datetime.now(timezone.utc).isoformat(),
        }

        # Media
        media = legacy.get("extended_entities", {}).get("media", [])
        if media:
            bm["media"] = [
                {"type": m.get("type", "photo"), "url": m.get("media_url_https", m.get("mediaUrl", ""))}
                for m in media
            ]

        bookmarks.append(bm)
        if len(bookmarks) >= limit:
            break

    return bookmarks, cursor


# ---------------------------------------------------------------------------
# Method 1: twscrape API with injected cookies (via httpx client)
#
# twscrape's API uses QueueClient which manages account pool internally.
# We replicate that here by creating an httpx client with cookies injected
# the same way Account.make_client() does, then calling the GQL endpoint
# directly using twscrape's own OP_Bookmarks query ID and features.
# ---------------------------------------------------------------------------

async def _fetch_bookmarks_via_twscrape_client(cookies: dict) -> list[dict]:
    """
    Use twscrape's OP_Bookmarks query ID + features, but drive the HTTP client
    ourselves with cookies injected from GCS. This bypasses AccountsPool
    password login which gets blocked by Cloudflare.
    """
    if not HTTPX_AVAILABLE:
        raise RuntimeError("httpx not installed")

    auth_token = cookies.get("auth_token", "")
    ct0 = cookies.get("ct0", "")

    if not auth_token or not ct0:
        raise ValueError("Missing auth_token or ct0 in cookies")

    client = _build_twitter_client(cookies)
    all_bookmarks = []
    cursor = None
    page = 0

    try:
        while len(all_bookmarks) < MAX_BOOKMARKS:
            page += 1
            log(f"[twscrape-client] Page {page}, have {len(all_bookmarks)} bookmarks")

            kv = {
                "count": min(20, MAX_BOOKMARKS - len(all_bookmarks)),
                "includePromotedContent": False,
                "withClientEventToken": False,
                "withBirdwatchNotes": False,
                "withVoice": True,
                "withV2Timeline": True,
            }
            if cursor:
                kv["cursor"] = cursor

            params = {
                "variables": json.dumps(kv),
                "features": json.dumps(GQL_FEATURES),
            }

            gql_url = f"{GQL_URL}/{OP_BOOKMARKS}"
            log(f"[twscrape-client] Request: {gql_url} params={params}")
            resp = await client.get(gql_url, params=params)
            log(f"[twscrape-client] Response status: {resp.status_code}")

            if resp.status_code == 429:
                log("[twscrape-client] Rate limited (429), waiting 60s")
                await asyncio.sleep(60)
                continue

            if resp.status_code == 403:
                log(f"[twscrape-client] HTTP 403 (Cloudflare blocked)")
                raise ValueError(f"HTTP 403 from GQL (Cloudflare): cookies may be stale")

            if resp.status_code != 200:
                body = resp.text[:300]
                log(f"[twscrape-client] HTTP {resp.status_code}: {body}")
                break

            log(f"[twscrape-client] HTTP {resp.status_code}, body (first 300): {resp.text[:300]}")
            obj = resp.json()
            log(f"[twscrape-client] Raw response keys: {list(obj.keys())}")
            data_obj = obj.get("data", {})
            log(f"[twscrape-client] data keys: {list(data_obj.keys())}")
            timeline_data = data_obj.get("bookmark_timeline_v2", {})
            log(f"[twscrape-client] timeline keys: {list(timeline_data.keys())}")
            instructions = timeline_data.get("timeline", {}).get("instructions", [])
            log(f"[twscrape-client] instructions count: {len(instructions)}")
            for idx, inst in enumerate(instructions):
                log(f"[twscrape-client] instruction[{idx}] type={inst.get('type')}, entries={len(inst.get('entries', []))}")

            page_bookmarks, cursor = _parse_bookmarks_from_gql(obj, MAX_BOOKMARKS)

            if not page_bookmarks:
                log(f"[twscrape-client] Page {page}: 0 bookmarks, stopping")
                break

            all_bookmarks.extend(page_bookmarks)
            log(f"[twscrape-client] Page {page}: +{len(page_bookmarks)} = {len(all_bookmarks)} total")

            if not cursor:
                log("[twscrape-client] No cursor, pagination done")
                break

            # Minimal delay between pages to avoid rate limiting
            await asyncio.sleep(0.5)

    finally:
        await client.aclose()

    return all_bookmarks[:MAX_BOOKMARKS]


# ---------------------------------------------------------------------------
# Method 2: Syndication API fallback (no auth, for timeline tweets)
# ---------------------------------------------------------------------------

async def _fetch_via_syndication(cookies: dict) -> list[dict]:
    """
    syndication.twitter.com provides a minimal tweet timeline without auth.
    Used as fallback when cookie-based methods fail.
    Note: This returns home timeline, NOT bookmarks — but is useful as fallback.
    """
    if not HTTPX_AVAILABLE:
        return []

    log("[syndication] Trying syndication.twitter.com")
    auth_token = cookies.get("auth_token", "")
    ct0 = cookies.get("ct0", "")

    client = httpx.AsyncClient(follow_redirects=True, timeout=30)

    try:
        # Syndication endpoint (no auth required)
        resp = await client.get(
            "https://syndication.twitter.com/srv/timeline-profile/screen-name/i",
            headers={
                **TWITTER_HEADERS,
                "x-csrf-token": ct0 or "",
                "Authorization": f"Bearer {TOKEN}",
            },
            cookies={"auth_token": auth_token, "ct0": ct0} if auth_token else {},
        )

        if resp.status_code != 200:
            log(f"[syndication] HTTP {resp.status_code}")
            return []

        # Syndication returns HTML/JSON hybrid — parse tweets from it
        text = resp.text
        tweets = []

        # Try to find JSON data in the response
        import re
        match = re.search(r'"tweet":\s*\{[^}]+\}', text)
        if match:
            log("[syndication] Found tweet data in syndication response")
            # Parse available tweet data
            try:
                # Syndication format differs; extract what we can
                tweets_data = re.findall(r'"tweet"\s*:\s*\{[^}]+\}', text)
                for t in tweets_data[:MAX_BOOKMARKS]:
                    # Basic extraction
                    id_m = re.search(r'"id_str"\s*:\s*"(\d+)"', t)
                    text_m = re.search(r'"text"\s*:\s*"([^"]+)"', t)
                    if id_m:
                        tweets.append({
                            "id": id_m.group(1),
                            "url": f"https://x.com/i/status/{id_m.group(1)}",
                            "text": text_m.group(1) if text_m else "",
                            "author": "",
                            "created_at": "",
                            "scraped_at": datetime.now(timezone.utc).isoformat(),
                        })
            except Exception as e:
                log(f"[syndication] Parse error: {e}")

        log(f"[syndication] Got {len(tweets)} tweets")
        return tweets

    except Exception as exc:
        log(f"[syndication] Error: {exc}")
        return []
    finally:
        await client.aclose()


# ---------------------------------------------------------------------------
# Core orchestrator
# ---------------------------------------------------------------------------

async def _fetch_bookmarks() -> dict:
    """
    Primary: twscrape-style GQL with GCS cookies (injected httpx client).
    Fallback: direct GraphQL with cookies (same client approach, slightly
    different parse — kept for backwards compat).
    """
    errors = []

    # Load cookies
    gcs_cookies = load_cookies_from_gcs()
    if not gcs_cookies:
        return {"success": False, "error": "No cookies in GCS"}

    if not HTTPX_AVAILABLE:
        return {"success": False, "error": "httpx not available"}

    # --- Attempt 1: twscrape-style GQL with cookie-injected httpx client ---
    log("=== Attempt 1: twscrape-style GQL with GCS cookies ===")
    try:
        log(f"[orchestrator] invoking _fetch_bookmarks_via_twscrape_client, timeout={ATTEMPT_TIMEOUT}s")
        bookmarks = await asyncio.wait_for(
            _fetch_bookmarks_via_twscrape_client(gcs_cookies),
            timeout=ATTEMPT_TIMEOUT,
        )
        log(f"[orchestrator] _fetch_bookmarks_via_twscrape_client returned {len(bookmarks)} items")
        if bookmarks:
            return {
                "success": True,
                "bookmarks": bookmarks,
                "count": len(bookmarks),
                "auth_method": "twscrape_cookies",
            }
        errors.append("twscrape_cookies: returned 0 bookmarks")
    except asyncio.TimeoutError:
        errors.append(f"twscrape_cookies: timed out after {ATTEMPT_TIMEOUT}s")
        log(f"Attempt 1 timed out after {ATTEMPT_TIMEOUT}s")
    except Exception as exc:
        err_str = str(exc)
        log(f"Attempt 1 failed: {err_str}")
        errors.append(f"twscrape_cookies: {err_str}")

    # --- Attempt 2: Syndication fallback ---
    log("=== Attempt 2: Syndication API fallback ===")
    try:
        tweets = await asyncio.wait_for(
            _fetch_via_syndication(gcs_cookies),
            timeout=30,
        )
        if tweets:
            return {
                "success": True,
                "bookmarks": tweets,
                "count": len(tweets),
                "auth_method": "syndication",
                "note": "syndication returns timeline, not bookmarks",
            }
    except asyncio.TimeoutError:
        errors.append("syndication: timed out")
    except Exception as exc:
        errors.append(f"syndication: {exc}")

    return {
        "success": False,
        "bookmarks": [],
        "error": "All methods failed: " + " | ".join(errors),
    }


# ---------------------------------------------------------------------------
# Cloud Function entry point
# ---------------------------------------------------------------------------

@functions_framework.http
def fetch_twitter_bookmarks(request):
    """
    HTTP Cloud Function — fetches Twitter bookmarks.

    Methods:
      1. twscrape-style GQL (OP_Bookmarks) with cookies from GCS
         (httpx client with cookies injected, bypassing AccountsPool password login)
      2. Syndication API fallback

    Query / JSON params:
      send_summary (bool) – if true, also writes vault/latest_sync_summary.json
    """
    cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }
    if request.method == "OPTIONS":
        return ("", 204, cors)

    resp_headers = {**cors, "Content-Type": "application/json"}

    # Health check
    if request.method == "GET":
        return (
            json.dumps({
                "service": "twitter-sync",
                "engine": "twscrape_cookies",
                "status": "healthy",
                "twscrape_available": TWSCRAPE_AVAILABLE,
                "gcs_available": GCS_AVAILABLE,
                "httpx_available": HTTPX_AVAILABLE,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }),
            200,
            resp_headers,
        )

    # Parse params
    try:
        payload = request.get_json(silent=True) or {}
    except Exception:
        payload = {}
    send_summary = payload.get("send_summary", False)

    log("=" * 60)
    log(f"Twitter bookmark sync started (timeout={ATTEMPT_TIMEOUT}s)")
    log(f"send_summary={send_summary}")

    # Run async scraper
    try:
        result = asyncio.run(_fetch_bookmarks())
    except Exception as exc:
        log(f"Unhandled async error: {exc}")
        traceback.print_exc()
        return (
            json.dumps({
                "success": False,
                "error": str(exc),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }),
            500,
            resp_headers,
        )

    # Process result
    bookmarks = result.pop("bookmarks", [])
    success = result.get("success", False)
    count = result.get("count", 0)
    auth_method = result.get("auth_method", "none")
    error = result.get("error")
    note = result.get("note", "")

    # Upload to GCS
    gcs_ok = False
    if success and bookmarks:
        gcs_ok = gcs_upload_json(BOOKMARKS_PATH, bookmarks)
        if not gcs_ok:
            log("WARNING: Bookmarks fetched but GCS upload failed")

    # Optional summary
    if send_summary:
        summary = {
            "twitter": {
                "status": "success" if success else "failed",
                "count": count,
                "auth_method": auth_method,
                "gcs_uploaded": gcs_ok,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                **({"error": error} if error else {}),
                **({"note": note} if note else {}),
            },
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        gcs_upload_json(SUMMARY_PATH, summary)

    response = {
        "success": success,
        "count": count,
        "auth_method": auth_method,
        "gcs_uploaded": gcs_ok,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if error:
        response["error"] = error
    if note:
        response["note"] = note

    code = 200 if success else (500 if error else 200)
    log(f"Done: success={success}, count={count}, auth={auth_method}")
    return json.dumps(response), code, resp_headers