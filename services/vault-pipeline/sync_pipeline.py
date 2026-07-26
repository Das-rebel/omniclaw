#!/usr/bin/env python3
"""
Main sync orchestrator: scrape → ingest → export to GCS.

Usage:
    python sync_pipeline.py                  # full sync
    python sync_pipeline.py --source twitter # twitter only
    python sync_pipeline.py --export-only    # just export to GCS
    python sync_pipeline.py --dry-run        # show what would happen
"""

import json
import subprocess
import sys
import asyncio
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from unified_schema import get_db, init_schema, log_sync, get_meta, set_meta, DEFAULT_DB_PATH
from ingest_twitter import run as twitter_run
from ingest_instagram import run as instagram_run

GCS_BUCKET = "omniclaw-knowledge-graph"
GCS_EXPORT_PATH = "vault/unified_bookmarks.json"


def log(msg: str):
    print(f"[SYNC-PIPELINE] {datetime.now().isoformat()} {msg}", flush=True)


def export_to_gcs(db_path: str | Path | None = None) -> dict:
    """Export full bookmarks DB to GCS as JSON."""
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

    # Write temp file
    tmp = Path("/tmp/vault_export.json")
    tmp.write_text(json.dumps(bookmarks, ensure_ascii=False, indent=2))
    log(f"Exported {len(bookmarks)} bookmarks to {tmp}")

    # Upload to GCS
    try:
        result = subprocess.run(
            ["gsutil", "cp", str(tmp), f"gs://{GCS_BUCKET}/{GCS_EXPORT_PATH}"],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0:
            log(f"Uploaded to gs://{GCS_BUCKET}/{GCS_EXPORT_PATH}")
            conn = get_db(db_path)
            log_sync(conn, "export", "export_to_gcs", len(bookmarks), "success")
            conn.close()
            return {"exported": len(bookmarks), "status": "success"}
        else:
            log(f"GCS upload failed: {result.stderr}")
            conn = get_db(db_path)
            log_sync(conn, "export", "export_to_gcs", len(bookmarks), "error", result.stderr[:500])
            conn.close()
            return {"exported": 0, "status": "error", "error": result.stderr[:200]}
    except Exception as e:
        log(f"Export error: {e}")
        return {"exported": 0, "status": "error", "error": str(e)}


async def run_sync(sources: list[str] | None = None, db_path: str | Path | None = None,
                   export: bool = True, dry_run: bool = False):
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
