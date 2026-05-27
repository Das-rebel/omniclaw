#!/usr/bin/env python3
"""
Enrich vault.db with visual descriptions using Gemini Vision API.
Much faster than BLIP (seconds vs minutes per image).

Usage:
    python3 enrich_vault_vision.py              # process all Instagram posts
    python3 enrich_vault_vision.py --limit 50   # process only 50
    python3 enrich_vault_vision.py --dry-run    # preview without saving
"""

import os
import sys
import json
import sqlite3
import time
import base64
import urllib.request
import tempfile
from pathlib import Path
import argparse

GCS_BUCKET = 'omniclaw-knowledge-graph'
DB_PATH = '/tmp/vault.db'
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def download_db():
    """Download vault.db from GCS"""
    from google.cloud import storage
    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    blob = bucket.blob('learning_base/vault.db')
    blob.download_to_filename(DB_PATH)
    log(f"✓ vault.db downloaded ({os.path.getsize(DB_PATH)//1024}KB)")

def upload_db():
    """Upload vault.db back to GCS"""
    from google.cloud import storage
    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    blob = bucket.blob('learning_base/vault.db')
    blob.upload_from_filename(DB_PATH)
    log(f"✓ vault.db uploaded ({os.path.getsize(DB_PATH)//1024}KB)")

def download_image(url, timeout=30):
    """Download image from URL"""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (compatible; VaultEnricher/1.0)'
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
            content_type = resp.headers.get('Content-Type', 'image/jpeg')
            return data, content_type
    except Exception as e:
        log(f"  ⚠ Download failed: {e}")
        return None, None

def analyze_image_gemini(image_data, mime_type, caption=""):
    """Analyze image using Gemini 2.0 Flash Vision"""
    if not GEMINI_API_KEY:
        log("  ⚠ No GEMINI_API_KEY set")
        return None
    
    # Encode image as base64
    img_b64 = base64.b64encode(image_data).decode('utf-8')
    
    prompt = f"""Describe what this image shows for a search engine.
Return a JSON object with these fields:
- "subject": short description (1 sentence, max 100 chars)
- "visual_tags": array of 3-6 tags describing visual content
- "mood": single word mood (Vibrant, Minimalist, Cinematic, Warm, etc.)
- "narrative_summary": description as it relates to the caption below (max 200 chars)

Caption for context: {caption[:200]}

Respond ONLY with valid JSON."""
    
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}"
    
    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": mime_type, "data": img_b64}}
            ]
        }],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 300
        }
    }
    
    try:
        req = urllib.request.Request(url, 
            data=json.dumps(payload).encode(),
            headers={'Content-Type': 'application/json'},
            method='POST')
        
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
        
        # Extract text from Gemini response
        text = result['candidates'][0]['content']['parts'][0]['text']
        
        # Clean markdown code block if present
        text = text.strip()
        if text.startswith('```json'):
            text = text[7:]
        if text.endswith('```'):
            text = text[:-3]
        text = text.strip()
        
        return json.loads(text)
        
    except Exception as e:
        log(f"  ⚠ Gemini error: {e}")
        return None

def process_images(limit=None, dry_run=False):
    """Process Instagram images without visual descriptions"""
    
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # Get Instagram posts that need visual descriptions
    cur.execute("""
        SELECT id, content, metadata, url 
        FROM nodes 
        WHERE type = 'instagram_post'
        ORDER BY timestamp DESC
    """)
    
    rows = cur.fetchall()
    log(f"Found {len(rows)} Instagram posts")
    
    total_enriched = 0
    total_skipped = 0
    total_failed = 0
    
    for idx, row in enumerate(rows):
        if limit and total_enriched >= limit:
            break
        
        try:
            metadata = json.loads(row['metadata']) if row['metadata'] else {}
        except:
            metadata = {}
        
        # Skip if already has visual data
        if metadata.get('visual_description') and metadata.get('vlTags'):
            total_skipped += 1
            continue
        
        # Get image URL
        image_url = metadata.get('imageUrl', metadata.get('thumbnail_url', ''))
        if not image_url:
            total_skipped += 1
            continue
        
        log(f"[{idx+1}/{len(rows)}] {row['id']}: downloading...")
        
        # Download image
        img_data, mime_type = download_image(image_url)
        if not img_data:
            total_skipped += 1
            continue
        
        # Skip if too large (>10MB)
        if len(img_data) > 10 * 1024 * 1024:
            log(f"  ⚠ Image too large ({len(img_data)//1024}KB), skipping")
            total_skipped += 1
            continue
        
        # Analyze with Gemini
        log(f"  Analyzing with Gemini...")
        result = analyze_image_gemini(img_data, mime_type, row['content'] or '')
        
        if result:
            # Enrich metadata
            metadata['visual_description'] = result.get('subject', '')
            metadata['vlTags'] = result.get('visual_tags', [])
            metadata['vlMood'] = result.get('mood', 'Neutral')
            metadata['vlStyle'] = result.get('mood', 'Neutral')
            metadata['narrative'] = result.get('narrative_summary', '')
            metadata['vision_provider'] = 'gemini-2.0-flash'
            
            if not dry_run:
                cur.execute("""
                    UPDATE nodes SET metadata = ? WHERE id = ?
                """, (json.dumps(metadata), row['id']))
            
            total_enriched += 1
            log(f"  ✓ {result.get('subject', '')[:60]}")
        else:
            total_failed += 1
            log(f"  ✗ Failed to analyze")
        
        # Commit progress
        if total_enriched % 10 == 0 and total_enriched > 0 and not dry_run:
            conn.commit()
            log(f"  [commit] {total_enriched} enriched")
    
    conn.commit()
    conn.close()
    
    log(f"\n{'='*50}")
    log(f"Results:")
    log(f"  Processed: {total_enriched + total_skipped + total_failed}")
    log(f"  Enriched:  {total_enriched}")
    log(f"  Skipped:   {total_skipped}")
    log(f"  Failed:    {total_failed}")
    if dry_run:
        log(f"  DRY RUN - no changes saved")
    log(f"{'='*50}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, help='Max images to process')
    parser.add_argument('--dry-run', action='store_true', help='Preview without saving')
    parser.add_argument('--no-download', action='store_true', help='Skip GCS download')
    parser.add_argument('--no-upload', action='store_true', help='Skip GCS upload')
    args = parser.parse_args()
    
    if not GEMINI_API_KEY:
        log("ERROR: GEMINI_API_KEY not set")
        sys.exit(1)
    
    if not args.no_download:
        download_db()
    
    process_images(limit=args.limit, dry_run=args.dry_run)
    
    if not args.no_upload and not args.dry_run:
        upload_db()
