#!/usr/bin/env python3
"""
Main sync orchestrator: scrape → ingest → sync bookmarks to nodes → export to GCS.
Uses Google Cloud Storage Python library instead of gsutil.
"""

import json
import os
import re
import sys
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from google.cloud import storage

# Add current directory to path
sys.path.insert(0, os.path.dirname(__file__))

from unified_schema import get_db, init_schema, log_sync, DEFAULT_DB_PATH
from ingest_twitter import run as twitter_run
from ingest_instagram import run as instagram_run

GCS_BUCKET = "omniclaw-knowledge-graph"
GCS_EXPORT_PATH = "vault/unified_bookmarks.json"


def log(msg: str):
    print(f"[SYNC-PIPELINE] {datetime.now(timezone.utc).isoformat()} {msg}", flush=True)


def export_to_gcs(db_path=None) -> dict:
    """Export full bookmarks DB to GCS as JSON using GCS Python library."""
    conn = get_db(db_path)
    rows = conn.execute("""
        SELECT id, source, source_id, url, title, content,
               bookmarked_at, scraped_at, metadata
        FROM bookmarks WHERE is_active = 1
        ORDER BY bookmarked_at DESC
    """).fetchall()

    bookmarks = []
    for r in rows:
        bm = {
            "id": r[0], "source": r[1], "source_id": r[2],
            "url": r[3], "title": r[4], "content": r[5],
            "bookmarked_at": r[6], "scraped_at": r[7],
            **json.loads(r[8] or "{}"),
        }
        bookmarks.append(bm)

    conn.close()

    tmp = Path("/tmp/vault_export.json")
    tmp.write_text(json.dumps(bookmarks, ensure_ascii=False, indent=2))
    log(f"Exported {len(bookmarks)} bookmarks to {tmp}")

    try:
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET)

        blob = bucket.blob(GCS_EXPORT_PATH)
        blob.upload_from_filename(str(tmp))
        log(f"Uploaded to gs://{GCS_BUCKET}/{GCS_EXPORT_PATH}")

        conn = get_db(db_path)
        log_sync(conn, "export", "export_to_gcs", len(bookmarks), "success")
        conn.close()

        return {"exported": len(bookmarks), "status": "success"}
    except Exception as e:
        log(f"GCS upload failed: {e}")
        return {"exported": 0, "status": "error", "error": str(e)}


def sync_bookmarks_to_nodes(db_path=None) -> dict:
    """
    Sync new bookmarks → nodes table (URL-based dedup).
    Extracts hashtags from Instagram content.
    """
    conn = get_db(db_path)
    cur = conn.cursor()

    # Load existing node URLs for dedup
    cur.execute("SELECT url FROM nodes WHERE url IS NOT NULL AND url != ''")
    existing_urls = {row[0] for row in cur.fetchall()}
    log(f"Loaded {len(existing_urls)} existing node URLs for dedup")

    # Find all active bookmarks
    cur.execute("""
        SELECT b.id, b.source, b.url, b.title, b.content, b.metadata, b.bookmarked_at
        FROM bookmarks b
        WHERE b.is_active = 1
        AND b.url IS NOT NULL AND b.url != ''
    """)

    bookmarks = cur.fetchall()
    synced = 0
    skipped = 0

    for bm in bookmarks:
        bm_id, source, url, title, content, metadata, bookmarked_at = bm

        if url in existing_urls:
            skipped += 1
            continue

        node_type = "instagram_post" if source == "instagram" else "twitter_tweet"

        # Extract hashtags from Instagram content
        if source == "instagram" and content:
            tags = re.findall(r"#(\w+)", content or "")
            try:
                meta = json.loads(metadata or "{}")
            except Exception:
                meta = {}
            meta["hashtags"] = tags
            metadata = json.dumps(meta)

        cur.execute("""
            INSERT OR IGNORE INTO nodes
            (id, type, name, content, url, timestamp, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            f"bm_{bm_id}",
            node_type,
            title or "",
            content or "",
            url,
            bookmarked_at or "",
            metadata or "{}",
        ))

        if cur.rowcount > 0:
            synced += 1
            existing_urls.add(url)

    conn.commit()
    conn.close()
    log(f"Nodes sync: {synced} new, {skipped} skipped (already in nodes)")
    return {"inserted": synced, "skipped": skipped}


async def run_sync(sources=None, db_path=None, export=True, dry_run=False):
    """Run the full sync pipeline."""
    log("=" * 60)
    log("Vault Sync Pipeline Starting")
    log(f"Sources: {sources or 'all'} | Export: {export} | Dry-run: {dry_run}")
    log("=" * 60)

    # Ensure schema exists
    conn = init_schema(db_path)
    conn.close()

    results = {}

    if not sources or "twitter" in sources:
        if dry_run:
            log("[DRY-RUN] Would scrape + ingest Twitter")
        else:
            log("--- Twitter ---")
            try:
                results["twitter"] = await twitter_run(db_path)
            except Exception as e:
                log(f"Twitter pipeline failed: {e}")
                results["twitter"] = {"error": str(e)}

    if not sources or "instagram" in sources:
        if dry_run:
            log("[DRY-RUN] Would scrape + ingest Instagram")
        else:
            log("--- Instagram ---")
            try:
                results["instagram"] = await instagram_run(db_path)
            except Exception as e:
                log(f"Instagram pipeline failed: {e}")
                results["instagram"] = {"error": str(e)}

    # Sync bookmarks to nodes table
    if not dry_run:
        log("--- Sync bookmarks → nodes ---")
        try:
            results["nodes_sync"] = sync_bookmarks_to_nodes(db_path)
        except Exception as e:
            log(f"Nodes sync failed: {e}")
            results["nodes_sync"] = {"error": str(e)}

    if export and not dry_run:
        log("--- Export to GCS ---")
        results["export"] = export_to_gcs(db_path)

    log("=" * 60)
    log(f"Pipeline complete: {json.dumps(results, default=str)}")
    return results


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Vault Sync Pipeline")
    parser.add_argument("--source", choices=["twitter", "instagram"], action="append", default=None)
    parser.add_argument("--db", default=None, help="Path to vault.db")
    parser.add_argument("--export-only", action="store_true")
    parser.add_argument("--no-export", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.export_only:
        print(json.dumps(export_to_gcs(args.db), indent=2))
    else:
        result = asyncio.run(run_sync(
            sources=args.source,
            db_path=args.db,
            export=not args.no_export,
            dry_run=args.dry_run,
        ))
        print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
