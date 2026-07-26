#!/usr/bin/env python3
"""
Unified Vault Schema - Single source of truth for all bookmark data.

Tables:
    bookmarks       - Core bookmark records from any source
    bookmarks_tags  - Normalized tag storage (one row per tag per bookmark)
    bookmarks_meta  - Key-value sync state per source
    sync_log        - Audit log of all scrape/ingest operations
    relationships   - Preserved from legacy vault.db
"""

import sqlite3
import json
from pathlib import Path
from datetime import datetime, timezone


DEFAULT_DB_PATH = Path.home() / "omniclaw" / "infrastructure" / "cloud-functions" / "deploy" / "learning_base" / "vault.db"

SCHEMA_SQL = """
-- Core bookmarks table: one row per unique bookmark, deduplicated by url
CREATE TABLE IF NOT EXISTS bookmarks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL CHECK(source IN ('twitter','instagram','browser','manual')),
    source_id       TEXT NOT NULL,          -- original ID from source (tweet ID, IG code, etc.)
    url             TEXT NOT NULL UNIQUE,   -- canonical URL, dedup key
    title           TEXT,                   -- display title / author handle
    content         TEXT,                   -- full text / caption
    bookmarked_at   TEXT,                   -- when user bookmarked it (ISO 8601)
    scraped_at      TEXT NOT NULL,          -- when we scraped it
    updated_at      TEXT NOT NULL,          -- last modification time
    metadata        TEXT DEFAULT '{}',      -- full JSON blob (VL tags, sentiment, etc.)
    is_active       INTEGER DEFAULT 1,      -- soft delete
    created_at      TEXT DEFAULT (datetime('now'))
);

-- Tag index for fast tag-based queries
CREATE TABLE IF NOT EXISTS bookmarks_tags (
    bookmark_id     INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    tag             TEXT NOT NULL,
    source          TEXT,                   -- where tag came from: 'vl', 'user', 'auto'
    PRIMARY KEY (bookmark_id, tag)
);

-- Sync state: last successful scrape/ingest per source
CREATE TABLE IF NOT EXISTS bookmarks_meta (
    key             TEXT PRIMARY KEY,       -- e.g. 'twitter_last_scrape', 'schema_version'
    value           TEXT NOT NULL,
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- Audit log for all pipeline operations
CREATE TABLE IF NOT EXISTS sync_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT DEFAULT (datetime('now')),
    source          TEXT NOT NULL,           -- twitter / instagram / browser / migration
    action          TEXT NOT NULL,           -- scrape / ingest / export / migrate / cleanup
    count           INTEGER DEFAULT 0,      -- items affected
    status          TEXT NOT NULL,           -- success / error / partial
    notes           TEXT                     -- error details, stats, etc.
);

-- Preserve legacy relationships from vault.db
CREATE TABLE IF NOT EXISTS relationships (
    from_id         TEXT,
    to_id           TEXT,
    type            TEXT,
    strength        REAL,
    PRIMARY KEY (from_id, to_id, type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bookmarks_source ON bookmarks(source);
CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);
CREATE INDEX IF NOT EXISTS idx_bookmarks_bookmarked_at ON bookmarks(bookmarked_at);
CREATE INDEX IF NOT EXISTS idx_bookmarks_source_id ON bookmarks(source, source_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_tags_tag ON bookmarks_tags(tag);
CREATE INDEX IF NOT EXISTS idx_sync_log_source ON sync_log(source);
CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_id);
"""

SCHEMA_VERSION = "1.0.0"


def get_db(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Open vault.db with WAL mode and foreign keys enabled."""
    path = Path(db_path) if db_path else DEFAULT_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_schema(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Create all tables and indexes if they don't exist. Idempotent."""
    conn = get_db(db_path)
    conn.executescript(SCHEMA_SQL)
    # Record schema version
    conn.execute(
        "INSERT OR REPLACE INTO bookmarks_meta (key, value, updated_at) VALUES (?, ?, ?)",
        ("schema_version", SCHEMA_VERSION, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    return conn


def log_sync(conn: sqlite3.Connection, source: str, action: str, count: int,
             status: str, notes: str = ""):
    """Insert a sync_log entry."""
    conn.execute(
        "INSERT INTO sync_log (source, action, count, status, notes) VALUES (?, ?, ?, ?, ?)",
        (source, action, count, status, notes),
    )
    conn.commit()


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    """Read a bookmarks_meta value."""
    row = conn.execute("SELECT value FROM bookmarks_meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str):
    """Write a bookmarks_meta value."""
    conn.execute(
        "INSERT OR REPLACE INTO bookmarks_meta (key, value, updated_at) VALUES (?, ?, ?)",
        (key, value, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()


if __name__ == "__main__":
    conn = init_schema()
    ver = get_meta(conn, "schema_version")
    print(f"Schema initialized. version={ver}")
    conn.close()
