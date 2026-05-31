#!/usr/bin/env python3
"""
Sync bookmarks to nodes - URL-based dedup safe
"""
import os, sys, json, sqlite3
from datetime import datetime

DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'learning_base', 'vault.db')

def log(msg):
    print(f'[SYNC] {datetime.now().isoformat()} {msg}')

def sync():
    log('=== Syncing bookmarks to nodes ===')
    
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    
    # Load existing node URLs for dedup
    cur.execute("SELECT url FROM nodes WHERE url IS NOT NULL AND url != ''")
    existing_urls = {row[0] for row in cur.fetchall()}
    log(f'Loaded {len(existing_urls)} existing URLs for dedup')
    
    # Find bookmarks not yet in nodes (URL-based)
    cur.execute("""
        SELECT b.id, b.source, b.url, b.title, b.content, b.metadata, b.bookmarked_at
        FROM bookmarks b
        WHERE b.is_active=1
        AND b.url IS NOT NULL 
        AND b.url != ''
    """)
    
    bookmarks = cur.fetchall()
    synced = 0
    skipped = 0
    
    for bm in bookmarks:
        bm_id, source, url, title, content, metadata, bookmarked_at = bm
        
        # Skip if URL already in nodes
        if url in existing_urls:
            skipped += 1
            continue
        
        node_type = 'instagram_post' if source == 'instagram' else 'twitter_tweet'
        
        # Extract hashtags and entities from content for Instagram
        if source == 'instagram' and content:
            import re
            tags = re.findall(r'#(\w+)', content or '')
            meta = json.loads(metadata or '{}')
            meta['hashtags'] = tags
            metadata = json.dumps(meta)
        
        cur.execute("""
            INSERT OR IGNORE INTO nodes (id, type, name, content, url, timestamp, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (f'bm_{bm_id}', node_type, title or '', content or '', url, bookmarked_at or '', metadata or '{}'))
        
        if cur.rowcount > 0:
            synced += 1
            existing_urls.add(url)
    
    conn.commit()
    conn.close()
    
    log(f'Synced: {synced} new, Skipped: {skipped} duplicates')
    log(f'=== Sync complete: {{"inserted": {synced}}} ===')
    return {"inserted": synced, "skipped": skipped}

if __name__ == '__main__':
    result = sync()
    print(json.dumps(result))
