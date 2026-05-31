#!/usr/bin/env python3
"""Backfill hashtags for all existing Instagram nodes in vault."""
import sqlite3, json, re, time
from pathlib import Path

DB_FILE = Path(__file__).parent / 'learning_base' / 'vault.db'

def main():
    conn = sqlite3.connect(str(DB_FILE))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Find all Instagram nodes without hashtags
    cur.execute("""
        SELECT id, content, metadata FROM nodes 
        WHERE type='instagram_post' 
        AND (json_extract(metadata, '$.hashtags') IS NULL 
             OR json_array_length(json_extract(metadata, '$.hashtags')) = 0)
    """)
    rows = cur.fetchall()
    total = len(rows)
    print(f'Found {total} Instagram nodes without hashtags')

    updated = 0
    for row in rows:
        content = row['content'] or ''
        tags = re.findall(r'#(\w+)', content)
        if not tags:
            continue

        meta = json.loads(row['metadata'] or '{}')
        meta['hashtags'] = tags
        cur.execute("UPDATE nodes SET metadata=? WHERE id=?",
                    (json.dumps(meta), row['id']))
        updated += 1

    conn.commit()
    conn.close()
    print(f'Backfilled {updated}/{total} nodes with hashtags')
    return updated


if __name__ == '__main__':
    t0 = time.time()
    n = main()
    print(f'Done in {time.time()-t0:.1f}s — updated {n} nodes')
