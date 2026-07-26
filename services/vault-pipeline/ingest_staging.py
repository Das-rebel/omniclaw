#!/usr/bin/env python3
"""
Vault Sync v2 — Staging Ingest
Reads all JSON files from a staging directory and ingests them
into the vault.db bookmarks table.
Idempotent: ON CONFLICT(url) DO UPDATE.
"""

import json
import sys
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from config import DB_PATH, EXIT_OK, EXIT_ERROR

LOG_PREFIX = "[INGEST]"


def log(msg: str):
    print(f"{LOG_PREFIX} {datetime.now().isoformat()} {msg}", flush=True)


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def ensure_schema(conn: sqlite3.Connection):
    """Ensure bookmarks table exists. Idempotent."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS bookmarks (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            source          TEXT NOT NULL CHECK(source IN ('twitter','instagram','browser','manual')),
            source_id       TEXT NOT NULL,
            url             TEXT NOT NULL UNIQUE,
            title           TEXT,
            content         TEXT,
            bookmarked_at   TEXT,
            scraped_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL,
            metadata        TEXT DEFAULT '{}',
            is_active       INTEGER DEFAULT 1,
            created_at      TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_bookmarks_source ON bookmarks(source);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);

        CREATE TABLE IF NOT EXISTS bookmarks_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT DEFAULT (datetime('now')),
            source TEXT NOT NULL,
            action TEXT NOT NULL,
            count INTEGER DEFAULT 0,
            status TEXT NOT NULL,
            notes TEXT
        );
    """)


def log_sync(conn: sqlite3.Connection, source: str, action: str, count: int,
             status: str, notes: str = ""):
    conn.execute(
        "INSERT INTO sync_log (source, action, count, status, notes) VALUES (?, ?, ?, ?, ?)",
        (source, action, count, status, notes),
    )
    conn.commit()


def set_meta(conn: sqlite3.Connection, key: str, value: str):
    conn.execute(
        "INSERT OR REPLACE INTO bookmarks_meta (key, value, updated_at) VALUES (?, ?, ?)",
        (key, value, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()


def ingest_file(conn: sqlite3.Connection, filepath: Path) -> dict:
    """Ingest a single staging JSON file. Returns stats dict."""
    stats = {"inserted": 0, "updated": 0, "skipped": 0, "errors": 0}
    now = datetime.now(timezone.utc).isoformat()

    try:
        data = json.loads(filepath.read_text())
    except Exception as e:
        log(f"Failed to read {filepath}: {e}")
        return stats

    items = data.get("items", [])
    if not items:
        log(f"No items in {filepath.name}")
        return stats

    source = items[0].get("source", "unknown") if items else "unknown"

    for item in items:
        if not item.get("url"):
            stats["skipped"] += 1
            continue

        try:
            metadata_json = json.dumps(item.get("metadata", {}), ensure_ascii=False)
            cursor = conn.execute(
                """INSERT INTO bookmarks
                   (source, source_id, url, title, content, bookmarked_at, scraped_at, updated_at, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(url) DO UPDATE SET
                       content = COALESCE(NULLIF(excluded.content, ''), bookmarks.content),
                       metadata = excluded.metadata,
                       updated_at = excluded.updated_at,
                       title = COALESCE(NULLIF(excluded.title, ''), bookmarks.title),
                       bookmarked_at = COALESCE(NULLIF(excluded.bookmarked_at, ''), bookmarks.bookmarked_at)
                """,
                (
                    item["source"], item["source_id"], item["url"],
                    item.get("title", ""), item.get("content", ""),
                    item.get("bookmarked_at"), item.get("scraped_at", now),
                    now, metadata_json,
                ),
            )
            if cursor.rowcount == 1:
                stats["inserted"] += 1
            else:
                stats["updated"] += 1

        except Exception as e:
            log(f"Error ingesting {item.get('url', '?')}: {e}")
            stats["errors"] += 1

    conn.commit()
    log(f"{filepath.name}: inserted={stats['inserted']}, updated={stats['updated']}, "
        f"skipped={stats['skipped']}, errors={stats['errors']}")
    log_sync(conn, source, "ingest",
             stats["inserted"] + stats["updated"],
             "success" if stats["errors"] == 0 else "partial",
             json.dumps(stats))
    return stats


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Ingest staging JSON into vault.db")
    parser.add_argument("--staging-dir", required=True,
                        help="Directory containing staging JSON files")
    parser.add_argument("--db", help="Path to vault.db (default: from config)")
    args = parser.parse_args()

    staging_dir = Path(args.staging_dir)
    db_path = Path(args.db) if args.db else DB_PATH

    log(f"Starting ingest from {staging_dir}")
    log(f"DB: {db_path}")

    conn = get_db()
    ensure_schema(conn)

    total = {"inserted": 0, "updated": 0, "skipped": 0, "errors": 0}
    sources = []

    # Find all staging JSON files
    for f in sorted(staging_dir.glob("*.json")):
        # Skip meta files
        if f.name.endswith(".meta.json"):
            continue

        # Skip the top-level status meta
        if f.name in ["meta.json", "status.json"]:
            continue

        log(f"Processing {f.name}...")
        stats = ingest_file(conn, f)
        total["inserted"] += stats["inserted"]
        total["updated"] += stats["updated"]
        total["skipped"] += stats["skipped"]
        total["errors"] += stats["errors"]

        # Get source from first item
        try:
            data = json.loads(f.read_text())
            items = data.get("items", [])
            if items:
                sources.append(items[0].get("source", "?"))
        except Exception:
            pass

    # Update metadata
    now_str = datetime.now(timezone.utc).isoformat()
    for src in set(sources):
        set_meta(conn, f"{src}_last_scrape", now_str)

    conn.close()

    log(f"=== Ingest complete: {total} ===")

    if total["errors"] > 0 and total["inserted"] == 0 and total["updated"] == 0:
        sys.exit(EXIT_ERROR)
    sys.exit(EXIT_OK)


if __name__ == "__main__":
    main()
