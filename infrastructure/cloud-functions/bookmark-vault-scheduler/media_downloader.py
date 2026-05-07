#!/usr/bin/env python3
"""
Instagram Media Downloader
Uses instagrapi to download media bytes to avoid CDN 403s
"""

import os
import sys
import json
import asyncio
from instagrapi import Client

async def download_media(identifier, username, cookies_str):
    try:
        cl = Client()
        
        # Debug output
        print(f"[DOWNLOADER_DEBUG] Received identifier: {identifier}", file=sys.stderr)
        print(f"[DOWNLOADER_DEBUG] Username: {username}", file=sys.stderr)
        print(f"[DOWNLOADER_DEBUG] Cookies: {cookies_str[:30] if cookies_str else 'None'}...", file=sys.stderr)
        
        # Parse cookies
        if cookies_str:
            cookies = {}
            for part in cookies_str.split(";"):
                p = part.strip().split("=", 1)
                if len(p) == 2:
                    cookies[p[0].strip()] = p[1].strip()
            cl.set_settings({"cookies": cookies})
        
        cl.set_user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        
        # Extract shortcode
        if "instagram.com" in identifier:
            shortcode = identifier.split('/p/')[1].split('/')[0] if '/p/' in identifier else identifier.split('/reels/')[1].split('/')[0] if '/reels/' in identifier else None
            if not shortcode:
                print(json.dumps({"success": False, "error": "Invalid URL"}))
                return
            print(f"[DOWNLOADER_DEBUG] Resolving from URL, shortcode: {shortcode}", file=sys.stderr)
        elif identifier.startswith("ig_"):
            shortcode = identifier.replace("ig_", "")
            print(f"[DOWNLOADER_DEBUG] Resolving from ID prefix, shortcode: {shortcode}", file=sys.stderr)
        else:
            shortcode = identifier
        
        # Get integer pk from shortcode/URL
        try:
            pk = cl.media_pk_from_url(identifier)
            print(f"[DOWNLOADER_DEBUG] Resolved pk: {pk}", file=sys.stderr)
            media = cl.media_info(pk)
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Could not find media: {str(e)}"}))
            return

        # Download logic
        output_path = f"temp_{media.pk}.bin"
        mime_type = ""

        if media.media_type == 1: # Photo
            path = cl.photo_download(media.pk)
            mime_type = "image/jpeg"
            with open(path, "rb") as f:
                content = f.read()
            import os
            os.remove(path)
        elif media.media_type == 2: # Video
            path = cl.video_download(media.pk)
            mime_type = "video/mp4"
            with open(path, "rb") as f:
                content = f.read()
            import os
            os.remove(path)
        else:
            print(json.dumps({"success": False, "error": "Unsupported media type"}))
            return

        # We output as a JSON with base64 to avoid shell pipe binary issues
        import base64
        print(json.dumps({
            "success": True,
            "mimeType": mime_type,
            "data": base64.b64encode(content).decode('utf-8')
        }))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(json.dumps({"success": False, "error": "Missing arguments"}))
        sys.exit(1)
        
    identifier = sys.argv[1]
    user = sys.argv[2]
    cookies = sys.argv[3]
    
    asyncio.run(download_media(identifier, user, cookies))