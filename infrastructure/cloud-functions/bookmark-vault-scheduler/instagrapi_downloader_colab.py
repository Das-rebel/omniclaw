# Instagram Image Downloader for Google Colab
# ============================================
# Solves: 403 errors on instagram.fblr2-*.fna.fbcdn.net CDN URLs
#
# APPROACH:
#   Option 1 (PRIMARY): Use instagrapi to get fresh signed URLs
#   Option 2 (FALLBACK): Use oEmbed API for public posts (no auth, 640px max)
#
# WHY THIS WORKS:
#   instagrapi's photo_download() calls media_info() which fetches NEW signed URLs
#   from Instagram's API. These URLs are valid for ANY IP, unlike the stale
#   pre-computed URLs stored in the KG.
#
#   The oEmbed API (public, no auth) redirects to fresh CDN URLs that work.
#   It returns max 640px wide thumbnails - sufficient for vision processing.
#
# COLAB USAGE:
#   !pip install instagrapi requests
#   import instagrapi_downloader_colab as ig
#
#   # Option 1: instagrapi (needs sessionid for full access)
#   downloader = ig.InstagrapiDownloader(session_id='YOUR_SESSIONID')
#   img_bytes = downloader.download_image_from_url('https://www.instagram.com/p/XXXXX/')
#
#   # Option 2: oEmbed fallback (public posts only, no auth)
#   img_bytes = ig.oembed_download('https://www.instagram.com/p/XXXXX/')
#
#   # Batch from KG
#   results = ig.batch_download_from_knowledge_graph('/path/to/kg.json', session_id='XXX')
#
# LIMITATIONS:
#   - oEmbed returns max 640px wide thumbnails (fine for Gemini Pro Vision)
#   - instagrapi needs valid sessionid for all posts (private posts require it)
#   - Rate limit: ~200 requests/minute to avoid triggering Instagram's block

import requests
import re
import json
import base64
import time
import os
from typing import Optional, Tuple, List, Dict
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from instagrapi import Client
    from instagrapi.exceptions import MediaUnavailable, InvalidMediaId, ClientLoginRequired
    INSTAGRAPI_AVAILABLE = True
except ImportError:
    INSTAGRAPI_AVAILABLE = False


# =============================================================================
# OPTION 1: instagrapi (fresh signed URLs via Instagram API)
# =============================================================================

class InstagrapiDownloader:
    """
    Downloads Instagram images using instagrapi's private API.
    
    instagrapi works in Colab - it makes HTTPS requests to Instagram's API
    endpoints (i.instagram.com and www.instagram.com) which are NOT blocked.
    Only the CDN (fna.fbcdn.net) is blocked.
    
    The photo_download() workflow:
      1. media_pk_from_url() → resolves shortcode to PK via API
      2. media_info() → fetches media metadata + FRESH thumbnail_url
      3. photo_download_by_url_origin() → downloads from the fresh URL
    """

    def __init__(self, session_id: str = "", request_timeout: int = 30):
        """
        Args:
            session_id: Instagram sessionid cookie. Without it, public posts work.
                      With it, private posts and reels work too.
            request_timeout: Timeout for API requests in seconds.
        """
        self.session_id = session_id
        self.request_timeout = request_timeout
        self._cl = None
        self._logged_in = False

    def _get_client(self) -> Client:
        if self._cl is None:
            self._cl = Client(timeout=self.request_timeout)
            if self.session_id:
                try:
                    self._cl.login_by_sessionid(self.session_id)
                    self._logged_in = True
                    print("[InstagrapiDownloader] Logged in with sessionid")
                except Exception as e:
                    print(f"[InstagrapiDownloader] Login failed (public posts only): {e}")
                    self._logged_in = False
            else:
                print("[InstagrapiDownloader] No sessionid - public posts only")
        return self._cl

    @staticmethod
    def extract_shortcode(url: str) -> Optional[str]:
        """Extract shortcode from Instagram post URL."""
        patterns = [
            r'instagram\.com/p/([A-Za-z0-9_-]+)',
            r'instagram\.com/reels/([A-Za-z0-9_-]+)',
            r'instagram\.com/tv/([A-Za-z0-9_-]+)',
        ]
        for pattern in patterns:
            m = re.search(pattern, url)
            if m:
                return m.group(1)
        return None

    def download_image_from_url(self, post_url: str) -> Tuple[bytes, str]:
        """
        Download image from Instagram post URL using instagrapi.
        
        Returns: (image_bytes, mime_type)
        Raises: RuntimeError on failure
        """
        if not INSTAGRAPI_AVAILABLE:
            raise RuntimeError("instagrapi not installed. Run: !pip install instagrapi")

        cl = self._get_client()
        shortcode = self.extract_shortcode(post_url)
        if not shortcode:
            raise ValueError(f"Invalid Instagram URL: {post_url}")

        try:
            pk = cl.media_pk_from_url(post_url)
            media = cl.media_info(pk)

            if media.media_type == 1:
                # Photo
                url = str(media.thumbnail_url)
                data = cl.photo_download_by_url_origin(url)
                return data, "image/jpeg"

            elif media.media_type == 2:
                # Video - download thumbnail
                if media.thumbnail_url:
                    url = str(media.thumbnail_url)
                    data = cl.photo_download_by_url_origin(url)
                    return data, "image/jpeg"
                raise MediaUnavailable(f"No thumbnail for video {shortcode}")

            elif media.media_type == 8:
                # Album - first image
                if media.resources and len(media.resources) > 0:
                    first = media.resources[0]
                    if hasattr(first, 'thumbnail_url') and first.thumbnail_url:
                        url = str(first.thumbnail_url)
                        data = cl.photo_download_by_url_origin(url)
                        return data, "image/jpeg"
                raise MediaUnavailable(f"No resources in album {shortcode}")

            else:
                raise MediaUnavailable(f"Unknown media type: {media.media_type}")

        except (MediaUnavailable, InvalidMediaId) as e:
            raise RuntimeError(f"Media unavailable: {e}")
        except ClientLoginRequired:
            raise RuntimeError(f"This post requires login: {shortcode}")
        except Exception as e:
            raise RuntimeError(f"Download failed: {e}")

    def get_media_info(self, post_url: str) -> Dict:
        """Get full media info (useful for getting captions etc)."""
        if not INSTAGRAPI_AVAILABLE:
            raise RuntimeError("instagrapi not installed")
        cl = self._get_client()
        pk = cl.media_pk_from_url(post_url)
        media = cl.media_info(pk)
        return {
            'pk': media.pk,
            'code': media.code,
            'media_type': media.media_type,
            'thumbnail_url': str(media.thumbnail_url) if media.thumbnail_url else None,
            'caption': media.caption_text,
            'like_count': media.like_count,
            'username': media.user.username,
            'resources': [{'thumbnail_url': str(r.thumbnail_url)} for r in (media.resources or [])],
        }


# =============================================================================
# OPTION 2: oEmbed API (public posts only, no auth, 640px max)
# =============================================================================

class OEmbedDownloader:
    """
    Downloads Instagram images via the public oEmbed API.
    
    ENDPOINT: https://www.instagram.com/api/v1/oembed/?url={post_url}
    
    ADVANTAGES:
    - No auth required for public posts
    - Works from any IP (including Colab)
    - Returns thumbnail_url pointing to fresh signed CDN URL
    
    DISADVANTAGES:
    - Only returns 640px wide thumbnails (not full resolution)
    - Does NOT work for private posts
    - Rate limited by Instagram
    
    NOTE: The oEmbed endpoint at /api/v1/oembed/ (v1 API) works.
          The legacy /oembed/ endpoint may fail DNS resolution in some envs.
    """

    OEMBED_API_V1 = "https://www.instagram.com/api/v1/oembed/"

    def __init__(self, session: requests.Session = None):
        self.session = session or requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (compatible; InstagramDownloader/1.0)',
            'Accept': 'application/json',
        })
        self._call_count = 0

    def download(self, post_url: str) -> Tuple[bytes, str, Dict]:
        """
        Download image via oEmbed API.
        
        Returns: (image_bytes, mime_type, oembed_data)
        oembed_data contains additional metadata like title, author_name, etc.
        """
        self._call_count += 1
        if self._call_count % 10 == 0:
            time.sleep(0.5)  # Rate limit protection

        try:
            # Get oEmbed data
            r = self.session.get(
                self.OEMBED_API_V1,
                params={'url': post_url},
                timeout=15
            )
            if r.status_code != 200:
                raise RuntimeError(f"oEmbed API returned {r.status_code}: {r.text[:200]}")

            data = r.json()
            thumb_url = data.get('thumbnail_url')
            if not thumb_url:
                raise RuntimeError("No thumbnail_url in oEmbed response")

            # Download the thumbnail image
            img_resp = self.session.get(thumb_url, timeout=15, stream=True)
            if img_resp.status_code != 200:
                raise RuntimeError(f"Thumbnail download returned {img_resp.status_code}")

            img_bytes = img_resp.content
            mime = img_resp.headers.get('Content-Type', 'image/jpeg')

            return img_bytes, mime, data

        except requests.RequestException as e:
            raise RuntimeError(f"oEmbed download failed: {e}")


def oembed_download(post_url: str, session: requests.Session = None) -> Tuple[bytes, str]:
    """
    Convenience function: download Instagram image via oEmbed API.
    No auth required for public posts. Returns 640px thumbnail.
    
    Args:
        post_url: Instagram post URL
        session: Optional requests.Session with cookies (e.g., sessionid)
    
    Returns:
        (image_bytes, mime_type)
    """
    downloader = OEmbedDownloader(session)
    img_bytes, mime, _ = downloader.download(post_url)
    return img_bytes, mime


# =============================================================================
# BATCH PROCESSING
# =============================================================================

def batch_download_from_knowledge_graph(
    kg_path: str,
    output_dir: str = "/tmp/instagram_images",
    session_id: str = "",
    use_oembed_fallback: bool = True,
    max_workers: int = 4,
    delay: float = 0.3,
    limit: int = None,
    progress: bool = True
) -> Dict:
    """
    Download all Instagram images from a knowledge graph JSON file.
    
    Args:
        kg_path: Path to unified_knowledge_graph.json
        output_dir: Where to save downloaded images
        session_id: Instagram sessionid (for private posts / full resolution)
        use_oembed_fallback: If instagrapi fails, try oEmbed (public posts only)
        max_workers: Number of parallel download threads
        delay: Delay between batches (rate limit protection)  
        limit: Max posts to process (None = all 2037)
        progress: Print progress updates
    
    Returns:
        dict with keys: success, failed, results, errors
    """
    os.makedirs(output_dir, exist_ok=True)

    with open(kg_path) as f:
        kg = json.load(f)

    # Try instagrapi first, fall back to oEmbed
    if INSTAGRAPI_AVAILABLE and session_id:
        primary_downloader = InstagrapiDownloader(session_id)
        primary_name = "instagrapi"
    elif INSTAGRAPI_AVAILABLE:
        primary_downloader = InstagrapiDownloader("")
        primary_name = "instagrapi (public)"
    else:
        primary_downloader = None
        primary_name = None

    oembed = OEmbedDownloader() if use_oembed_fallback else None

    posts = [n for n in kg['nodes'] if n.get('type') == 'instagram_post']
    if limit:
        posts = posts[:limit]

    results = {'success': 0, 'failed': 0, 'results': [], 'errors': []}
    total = len(posts)

    def download_one(post: Dict) -> Dict:
        post_url = post.get('url', '')
        post_id = post.get('id', 'unknown')
        shortcode = InstagrapiDownloader.extract_shortcode(post_url) or post_id

        # Try primary downloader (instagrapi)
        if primary_downloader:
            try:
                img_bytes, mime = primary_downloader.download_image_from_url(post_url)
                out_path = os.path.join(output_dir, f"{shortcode}.jpg")
                with open(out_path, 'wb') as f:
                    f.write(img_bytes)
                return {'id': post_id, 'shortcode': shortcode, 'path': out_path,
                        'size': len(img_bytes), 'source': primary_name, 'status': 'ok'}
            except Exception as e:
                primary_err = str(e)

        # Try oEmbed fallback
        if oembed:
            try:
                img_bytes, mime, oembed_data = oembed.download(post_url)
                out_path = os.path.join(output_dir, f"{shortcode}.jpg")
                with open(out_path, 'wb') as f:
                    f.write(img_bytes)
                return {
                    'id': post_id, 'shortcode': shortcode, 'path': out_path,
                    'size': len(img_bytes), 'source': 'oembed',
                    'title': oembed_data.get('title', '')[:100],
                    'status': 'ok'
                }
            except Exception as e:
                oembed_err = str(e)
        else:
            primary_err = "No sessionid and use_oembed_fallback=False"
            oembed_err = primary_err

        return {
            'id': post_id, 'shortcode': shortcode,
            'status': 'failed',
            'error': primary_err if primary_downloader else oembed_err
        }

    # Process in batches with threading
    for batch_start in range(0, total, 50):
        batch_end = min(batch_start + 50, total)
        batch = posts[batch_start:batch_end]

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(download_one, p): p for p in batch}
            for future in as_completed(futures):
                result = future.result()
                if result['status'] == 'ok':
                    results['success'] += 1
                    results['results'].append(result)
                else:
                    results['failed'] += 1
                    results['errors'].append(result)

        if progress:
            print(f"  Batch {batch_start+1}-{batch_end}/{total} | "
                  f"OK: {results['success']} | Fail: {results['failed']}")

        if delay > 0 and batch_end < total:
            time.sleep(delay)

    if progress:
        print(f"\n[batch_download] Complete: {results['success']} ok, "
              f"{results['failed']} failed out of {total}")

    return results


# =============================================================================
# GEMINI PRO VISION PIPELINE
# =============================================================================

def gemini_vision_process_kg(
    kg_path: str,
    output_json: str = "/tmp/vl_results.json",
    session_id: str = "",
    api_key: str = None,
    batch_size: int = 30,
    max_workers: int = 4,
    delay: float = 0.3,
    limit: int = None,
    progress: bool = True
) -> List[Dict]:
    """
    Full pipeline: download Instagram images and process with Gemini Pro Vision.
    
    Designed for Colab T4 GPU runtime.
    
    Args:
        kg_path: Path to unified_knowledge_graph.json
        output_json: Where to saveVL results
        session_id: Instagram sessionid
        api_key: Gemini API key (or set GEMINI_API_KEY env var)
        batch_size: Images per Gemini call (stays within token limits)
        max_workers: Parallel download threads
        delay: Delay between batches
        limit: Max posts to process
        progress: Print progress
    
    Returns:
        List of VL result dicts
    """
    api_key = api_key or os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        print("[WARNING] No GEMINI_API_KEY - will download images only")

    os.makedirs(os.path.dirname(output_json) or "/tmp", exist_ok=True)

    if INSTAGRAPI_AVAILABLE and session_id:
        downloader = InstagrapiDownloader(session_id)
        dl_name = "instagrapi"
    elif INSTAGRAPI_AVAILABLE:
        downloader = InstagrapiDownloader("")
        dl_name = "instagrapi_public"
    else:
        downloader = OEmbedDownloader()
        dl_name = "oembed"

    with open(kg_path) as f:
        kg = json.load(f)

    posts = [n for n in kg['nodes'] if n.get('type') == 'instagram_post']
    if limit:
        posts = posts[:limit]

    print(f"[pipeline] Processing {len(posts)} posts with {dl_name}")

    results = []
    for i in range(0, len(posts), batch_size):
        batch = posts[i:i+batch_size]
        batch_results = []

        # Download batch in parallel
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(downloader.download_image_from_url, p.get('url')): p
                      for p in batch}
            for future in as_completed(futures):
                post = futures[future]
                post_id = post.get('id', f'post_{i}')
                shortcode = InstagrapiDownloader.extract_shortcode(post.get('url', '')) or post_id

                try:
                    img_bytes, mime = future.result()
                    b64_img = base64.b64encode(img_bytes).decode()
                    result = {
                        'id': post_id,
                        'shortcode': shortcode,
                        'url': post.get('url'),
                        'content': post.get('content', ''),
                        'image_size': len(img_bytes),
                        'status': 'downloaded'
                    }

                    # Process with Gemini Vision if API key available
                    if api_key:
                        try:
                            import urllib.request
                            payload = {
                                'contents': [{
                                    'parts': [
                                        {'text': f"Analyze this Instagram post. Caption: {post.get('content', 'no caption')}"),
                                        {'inline_data': {
                                            'mime_type': mime,
                                            'data': b64_img
                                        }}
                                    ]
                                }]
                            }
                            req = urllib.request.Request(
                                f'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}',
                                data=json.dumps(payload).encode(),
                                headers={'Content-Type': 'application/json'},
                                method='POST'
                            )
                            with urllib.request.urlopen(req, timeout=60) as resp:
                                gemini_result = json.loads(resp.read())
                                result['vision_result'] = gemini_result.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '')
                                result['status'] = 'vision_processed'
                        except Exception as e:
                            result['vision_error'] = str(e)
                            result['status'] = 'vision_failed'

                    batch_results.append(result)

                except Exception as e:
                    batch_results.append({
                        'id': post_id,
                        'shortcode': shortcode,
                        'url': post.get('url'),
                        'status': 'failed',
                        'error': str(e)
                    })

        results.extend(batch_results)

        if progress:
            ok = sum(1 for r in batch_results if r.get('status') not in ('failed', 'vision_failed'))
            print(f"  Batch {i+1}-{i+len(batch_results)}/{len(posts)} | OK: {ok}/{len(batch_results)}")

        # Incremental save
        with open(output_json, 'w') as f:
            json.dump(results, f, indent=2, default=str)

        time.sleep(delay)

    print(f"[pipeline] Done. {len(results)} posts processed. Results: {output_json}")
    return results


# =============================================================================
# CLI / DIRECT TESTING
# =============================================================================

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage:")
        print("  python instagrapi_downloader_colab.py <post_url> [session_id]")
        print("  python instagrapi_downloader_colab.py --oembed <post_url>")
        print("  python instagrapi_downloader_colab.py --batch <kg.json> [output_dir]")
        sys.exit(1)

    if sys.argv[1] == '--oembed':
        # Test oEmbed approach
        post_url = sys.argv[2] if len(sys.argv) > 2 else "https://www.instagram.com/p/DXDz9AuDGDS/"
        try:
            img_bytes, mime = oembed_download(post_url)
            print(f"Downloaded {len(img_bytes)} bytes, mime={mime}")
        except Exception as e:
            print(f"Error: {e}")

    elif sys.argv[1] == '--batch':
        # Batch download
        kg_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/kg.json"
        output_dir = sys.argv[3] if len(sys.argv) > 3 else "/tmp/instagram_images"
        session_id = sys.argv[4] if len(sys.argv) > 4 else ""
        results = batch_download_from_knowledge_graph(kg_path, output_dir, session_id)
        print(f"Success: {results['success']}, Failed: {results['failed']}")

    else:
        # Single post download
        post_url = sys.argv[1]
        session_id = sys.argv[2] if len(sys.argv) > 2 else ""

        if INSTAGRAPI_AVAILABLE:
            downloader = InstagrapiDownloader(session_id)
            try:
                img_bytes, mime = downloader.download_image_from_url(post_url)
                print(f"Downloaded {len(img_bytes)} bytes, mime={mime}")
            except Exception as e:
                print(f"instagrapi failed: {e}")
                print("Trying oEmbed fallback...")
                try:
                    img_bytes, mime = oembed_download(post_url)
                    print(f"oEmbed fallback: {len(img_bytes)} bytes, mime={mime}")
                except Exception as e2:
                    print(f"oEmbed also failed: {e2}")
        else:
            # instagrapi not available, use oEmbed
            try:
                img_bytes, mime = oembed_download(post_url)
                print(f"oEmbed: {len(img_bytes)} bytes, mime={mime}")
            except Exception as e:
                print(f"Error: {e}")
