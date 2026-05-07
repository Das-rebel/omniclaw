#!/usr/bin/env python3
"""
Instagram media downloader using instagrapi session.
Usage: python3 instagrapi_downloader.py <post_url> [output_path]
Outputs JSON: {"success": true, "data": "<base64>", "mimeType": "<type>", "mediaType": "<type>"}
"""

import sys
import os
import json
import tempfile
import base64
import logging
from instagrapi import Client
from instagrapi.exceptions import MediaUnavailable, InvalidMediaId

logging.basicConfig(level=logging.WARNING)

SESSION_ID = '1321310950%3Ahb1jB0072L17B6%3A1%3AAYhL69uBNFOQ2VZ4y1whwJ0JHAbDmDUeK9nSHwXs8A'

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: <post_url> [output_dir]"}))
        sys.exit(1)

    post_url = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else '/tmp/instagram_media'

    os.makedirs(output_dir, exist_ok=True)

    try:
        cl = Client()
        cl.login_by_sessionid(SESSION_ID)

        # Extract shortcode from URL - handle both post URLs and CDN URLs
        # If it's a post URL like https://www.instagram.com/p/XXXXX/, extract shortcode
        # If it's a CDN URL, media_pk_from_url will extract the shortcode from the path
        shortcode = None
        if '/p/' in post_url:
            parts = post_url.split('/p/')
            if len(parts) > 1:
                shortcode = parts[1].split('/')[0].split('?')[0]
        elif '/reels/' in post_url:
            parts = post_url.split('/reels/')
            if len(parts) > 1:
                shortcode = parts[1].split('/')[0].split('?')[0]
        
        if not shortcode or len(shortcode) < 5:
            print(json.dumps({"success": False, "error": f"Invalid URL format: {post_url}"}))
            sys.exit(1)

        pk = cl.media_pk_from_url(post_url)
        media = cl.media_info(pk)

        mime_type_map = {1: 'image/jpeg', 2: 'video/mp4', 8: 'application/json'}

        if media.media_type == 1:
            # Photo
            path = cl.photo_download(pk, folder=output_dir)
            with open(path, 'rb') as f:
                data = base64.b64encode(f.read()).decode('utf-8')
            mime_type = 'image/jpeg'
            media_type = 'image'
            print(json.dumps({"success": True, "data": data, "mimeType": mime_type, "mediaType": media_type, "path": str(path), "thumbPath": str(path)}))

        elif media.media_type == 2:
            # Video - download thumbnail
            thumb_url = str(media.thumbnail_url)
            import requests
            resp = requests.get(thumb_url, timeout=15)
            if resp.status_code == 200:
                data = base64.b64encode(resp.content).decode('utf-8')
                mime_type = 'image/jpeg'
                media_type = 'video'
                thumb_path = os.path.join(output_dir, f'{shortcode}_thumb.jpg')
                with open(thumb_path, 'wb') as f:
                    f.write(resp.content)
                print(json.dumps({"success": True, "data": data, "mimeType": mime_type, "mediaType": media_type, "path": str(thumb_path), "thumbPath": str(thumb_path)}))
            else:
                print(json.dumps({"success": False, "error": f"Thumbnail download failed: {resp.status_code}"}))

        elif media.media_type == 8:
            # Album - download first image as representative
            if media.resources and len(media.resources) > 0:
                first_res = media.resources[0]
                if hasattr(first_res, 'thumbnail_url') and first_res.thumbnail_url:
                    import requests
                    resp = requests.get(str(first_res.thumbnail_url), timeout=15)
                    if resp.status_code == 200:
                        data = base64.b64encode(resp.content).decode('utf-8')
                        mime_type = 'image/jpeg'
                        media_type = 'album'
                        print(json.dumps({"success": True, "data": data, "mimeType": mime_type, "mediaType": media_type}))
                    else:
                        print(json.dumps({"success": False, "error": f"Album thumbnail download failed: {resp.status_code}"}))
                else:
                    print(json.dumps({"success": False, "error": "Album resource has no thumbnail_url"}))
            else:
                print(json.dumps({"success": False, "error": "Album has no resources"}))

        else:
            print(json.dumps({"success": False, "error": f"Unknown media type: {media.media_type}"}))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()