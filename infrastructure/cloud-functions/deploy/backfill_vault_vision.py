#!/usr/bin/env python3
"""
Backfill visual descriptions for existing vault posts using Ollama llava.
Processes Instagram posts that lack visual_description.

Usage:
    python3 backfill_vault_vision.py              # process all
    python3 backfill_vault_vision.py --limit 20   # process only 20
    python3 backfill_vault_vision.py --dry-run    # preview only
"""

import os
import sys
import json
import sqlite3
import time
import base64
import urllib.request
import subprocess
import re
import tempfile
from pathlib import Path
from datetime import datetime

GCS_BUCKET = 'omniclaw-knowledge-graph'
DB_PATH = '/tmp/vault.db'
OLLAMA_URL = 'http://localhost:11434/api/generate'

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", end='\n', flush=True)

def download_db():
    from google.cloud import storage
    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    blob = bucket.blob('learning_base/vault.db')
    blob.download_to_filename(DB_PATH)
    log(f"✓ Downloaded vault.db ({Path(DB_PATH).stat().st_size // 1024}KB)")

def upload_db():
    from google.cloud import storage
    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    blob = bucket.blob('learning_base/vault.db')
    blob.upload_from_filename(DB_PATH)
    log(f"✓ Uploaded vault.db ({Path(DB_PATH).stat().st_size // 1024}KB)")

def download_image(image_url, shortcode=None, max_retries=2):
    """Download image by trying Instagram /media/ endpoint first, then CDN fallback."""
    # Try Instagram's /media/ endpoint first (works without auth!)
    if shortcode:
        for endpoint in [f"https://www.instagram.com/p/{shortcode}/media/?size=l",
                         f"https://www.instagram.com/p/{shortcode}/media/"]:
            try:
                headers = {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
                }
                req = urllib.request.Request(endpoint, headers=headers)
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = resp.read()
                    content_type = resp.headers.get('Content-Type', '')
                    if 'image' in content_type and len(data) > 1024:
                        return data, endpoint
            except Exception:
                pass
    
    # Fallback: try CDN URL
    for attempt in range(max_retries):
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
                'Accept': 'image/webp,image/png,*/*',
                'Referer': 'https://www.instagram.com/',
            }
            req = urllib.request.Request(image_url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                if len(data) > 1024:
                    return data, image_url
        except Exception:
            pass
    
    return None, None

def analyze_with_ollama(img_data, caption=""):
    """Analyze image using BLIP (faster CPU vision). Returns enriched metadata dict."""
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bookmark-vault-scheduler"))
        from blip_vision import load_models, analyze_image
        import tempfile
        
        # BLIP model loads once globally via load_models()
        load_models()
        
        # Resize to 384px for speed (matching blip_vision.py default)
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(img_data))
        if img.mode != 'RGB':
            img = img.convert('RGB')
        ratio = min(384 / img.width, 384 / img.height)
        if ratio < 1:
            new_size = (int(img.width * ratio), int(img.height * ratio))
            img = img.resize(new_size, Image.LANCZOS)
        
        # Save to temp for BLIP
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
            f.write(buf.getvalue())
            tmp = f.name
        
        result = analyze_image(tmp, caption[:200], timeout=120)
        os.unlink(tmp)
        
        if result.get('success'):
            return {
                "visual_description": result.get("subject", ""),
                "vlTags": result.get("visual_tags", []),
                "vlMood": result.get("mood", "Neutral"),
                "vlStyle": result.get("mood", "Neutral"),
                "narrative": result.get("narrative_summary", ""),
                "vision_provider": "blip-cpu",
            }
    except Exception as e:
        log(f"  ⚠ BLIP error: {e}")
        return None

def extract_shortcode(url):
    """Extract Instagram shortcode from URL"""
    m = re.search(r'/p/([^/?]+)', url)
    return m.group(1) if m else None

def process_backfill(limit=None, dry_run=False):
    """Backfill visual descriptions for Instagram posts."""
    
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # Find Instagram posts without visual descriptions
    cur.execute("""
        SELECT id, content, metadata, url 
        FROM nodes 
        WHERE type = 'instagram_post'
        AND (json_extract(metadata, '$.visual_description') IS NULL 
             OR json_extract(metadata, '$.visual_description') = '')
        ORDER BY timestamp DESC
    """)
    
    rows = cur.fetchall()
    total = len(rows)
    log(f"Found {total} Instagram posts without visual descriptions")
    
    enriched = 0
    failed = 0
    skipped = 0
    
    for idx, row in enumerate(rows):
        if limit and enriched >= limit:
            break
        
        try:
            metadata = json.loads(row['metadata']) if row['metadata'] else {}
        except:
            metadata = {}
        
        # Get image URL
        image_url = metadata.get('imageUrl', '')
        if not image_url:
            skipped += 1
            continue
        
        shortcode = extract_shortcode(row['url'])
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{idx+1}/{total}] {row['id']}: downloading...", end=' ', flush=True)
        
        # Try to download the image
        img_data, used_url = download_image(image_url, shortcode)
        if not img_data:
            log("✗ no image")
            failed += 1
            continue
        
        print(f"OK ({len(img_data)//1024}KB)")
        
        # Analyze with Ollama
        print(f"  [{datetime.now().strftime('%H:%M:%S')}] Analyzing...", end=' ', flush=True)
        vision = analyze_with_ollama(img_data, row['content'] or '')
        
        if not vision:
            log("✗")
            failed += 1
            continue
        
        # Update metadata
        metadata["visual_description"] = vision["visual_description"]
        metadata["vlTags"] = vision["vlTags"]
        metadata["vlMood"] = vision["vlMood"]
        metadata["vlStyle"] = vision["vlStyle"]
        metadata["vision_provider"] = "ollama-llava"
        
        print(f"✓ {vision['visual_description'][:50]}")
        
        if not dry_run:
            cur.execute(
                "UPDATE nodes SET metadata = ? WHERE id = ?",
                (json.dumps(metadata), row['id'])
            )
        
        enriched += 1
        
        # Commit every 5
        if enriched % 5 == 0 and not dry_run:
            conn.commit()
    
    conn.commit()
    conn.close()
    
    log(f"\n{'='*50}")
    log(f"Results:")
    log(f"  Total: {total}")
    log(f"  Enriched: {enriched}")
    log(f"  Failed:  {failed}")
    log(f"  Skipped: {skipped}")
    if dry_run:
        log(f"  DRY RUN - no changes saved")
    log(f"{'='*50}")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, help='Max images to process')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--no-download', action='store_true')
    parser.add_argument('--no-upload', action='store_true')
    args = parser.parse_args()
    
    if not args.no_download:
        download_db()
    
    process_backfill(limit=args.limit, dry_run=args.dry_run)
    
    if not args.no_upload and not args.dry_run:
        upload_db()
