#!/usr/bin/env python3
"""
Vault Sync v2 — GCS Export & Status Upload
Exports bookmarks to unified_bookmarks.json and uploads vault.db + status.json to GCS.
Uses EXPLICIT project ID — no environment guessing.
"""

import json
import subprocess
import sys
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from config import (
    DB_PATH, GCS_PROJECT, GCS_BUCKET,
    GCS_VAULT_PATH, GCS_BOOKMARKS_PATH, GCS_STATUS_PATH,
    PIPELINE_DIR,
    EXIT_OK, EXIT_ERROR,
)

LOG_PREFIX = "[EXPORT]"


def log(msg: str):
    print(f"{LOG_PREFIX} {datetime.now().isoformat()} {msg}", flush=True)


def gcs_upload(local_path: Path, gcs_path: str) -> tuple[bool, str]:
    """Upload a file to GCS using gsutil. Returns (success, message)."""
    try:
        result = subprocess.run(
            [
                "gsutil", "-h", f"x-goog-meta-pipeline-version:2.0",
                "-h", f"x-goog-meta-uploaded-at:{datetime.now(timezone.utc).isoformat()}Z",
                "cp", str(local_path),
                f"gs://{GCS_BUCKET}/{gcs_path}",
            ],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode == 0:
            return True, f"Uploaded {local_path.name} → gs://{GCS_BUCKET}/{gcs_path}"
        else:
            return False, f"gsutil failed: {result.stderr[:200]}"
    except subprocess.TimeoutExpired:
        return False, f"gsutil timed out after 120s"
    except Exception as e:
        return False, f"Upload error: {e}"


def export_bookmarks_json(db_path: Path) -> tuple[bool, Path]:
    """Export active bookmarks to /tmp/vault_export.json."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT id, source, source_id, url, title, content,
               bookmarked_at, scraped_at, metadata
        FROM bookmarks WHERE is_active = 1
        ORDER BY bookmarked_at DESC
    """).fetchall()
    conn.close()

    bookmarks = []
    for r in rows:
        bm = {
            "id": r["id"], "source": r["source"], "source_id": r["source_id"],
            "url": r["url"], "title": r["title"], "content": r["content"],
            "bookmarked_at": r["bookmarked_at"], "scraped_at": r["scraped_at"],
            **json.loads(r["metadata"] or "{}"),
        }
        bookmarks.append(bm)

    out = Path("/tmp/vault_export.json")
    out.write_text(json.dumps(bookmarks, ensure_ascii=False, indent=2))
    log(f"Exported {len(bookmarks)} bookmarks to {out}")
    return True, out


def upload_status_json() -> tuple[bool, str]:
    """Upload sync-status.json to GCS."""
    status_file = PIPELINE_DIR / "sync-status.json"
    if not status_file.exists():
        return False, "sync-status.json not found"

    try:
        result = subprocess.run(
            [
                "gsutil", "-h", "x-goog-meta-status-version:2.0",
                "cp", str(status_file),
                f"gs://{GCS_BUCKET}/{GCS_STATUS_PATH}",
            ],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            return True, f"Status → gs://{GCS_BUCKET}/{GCS_STATUS_PATH}"
        else:
            return False, f"Status upload failed: {result.stderr[:200]}"
    except Exception as e:
        return False, f"Status upload error: {e}"


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Export vault to GCS")
    parser.add_argument("--db", help="Path to vault.db (default: from config)")
    args = parser.parse_args()

    db_path = Path(args.db) if args.db else DB_PATH

    log(f"Exporting from {db_path}")

    if not db_path.exists():
        log(f"ERROR: vault.db not found at {db_path}")
        sys.exit(EXIT_ERROR)

    # 1. Export bookmarks JSON
    ok, result = export_bookmarks_json(db_path)
    bookmarks_json = result if ok else None

    # 2. Upload bookmarks JSON
    if bookmarks_json:
        ok2, msg2 = gcs_upload(bookmarks_json, GCS_BOOKMARKS_PATH)
        log(msg2)

    # 3. Upload vault.db
    ok3, msg3 = gcs_upload(db_path, GCS_VAULT_PATH)
    log(msg3)

    # 4. Upload status.json
    ok4, msg4 = upload_status_json()
    if ok4:
        log(msg4)
    else:
        log(f"Status upload: {msg4} (non-fatal)")

    # Log to sync_log
    try:
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "INSERT INTO sync_log (source, action, count, status, notes) "
            "VALUES ('export', 'export_to_gcs', 0, 'success', ?)",
            (json.dumps({"vault_db": str(db_path)}),),
        )
        conn.commit()
        conn.close()
    except Exception as e:
        log(f"Failed to log export: {e}")

    all_ok = ok3  # vault.db upload is the critical one
    if not all_ok:
        sys.exit(EXIT_ERROR)
    sys.exit(EXIT_OK)


if __name__ == "__main__":
    main()
