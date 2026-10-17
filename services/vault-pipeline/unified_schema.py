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
import json as _json
from pathlib import Path
from datetime import datetime, timezone


DEFAULT_DB_PATH = Path.home() / "omniclaw" / "infrastructure" / "cloud-functions" / "deploy" / "learning_base" / "vault.db"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS bookmarks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL CHECK(source IN ('twitter','instagram','browser','manual')),
    source_id       TEXT NOT NULL,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT,
    content         TEXT,
    content_source  TEXT DEFAULT 'unknown',
    bookmarked_at   TEXT,
    scraped_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    metadata        TEXT DEFAULT '{}',
    is_active       INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookmarks_tags (
    bookmark_id     INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    tag             TEXT NOT NULL,
    source          TEXT,
    PRIMARY KEY (bookmark_id, tag)
);

CREATE TABLE IF NOT EXISTS bookmarks_meta (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT DEFAULT (datetime('now')),
    source          TEXT NOT NULL,
    action          TEXT NOT NULL,
    count           INTEGER DEFAULT 0,
    status          TEXT NOT NULL,
    notes           TEXT
);

CREATE TABLE IF NOT EXISTS relationships (
    from_id         TEXT,
    to_id           TEXT,
    type            TEXT,
    strength        REAL,
    PRIMARY KEY (from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_source ON bookmarks(source);
CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);
CREATE INDEX IF NOT EXISTS idx_bookmarks_bookmarked_at ON bookmarks(bookmarked_at);
CREATE INDEX IF NOT EXISTS idx_bookmarks_source_id ON bookmarks(source, source_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_content_source ON bookmarks(content_source);
CREATE INDEX IF NOT EXISTS idx_bookmarks_tags_tag ON bookmarks_tags(tag);
CREATE INDEX IF NOT EXISTS idx_sync_log_source ON sync_log(source);
CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_id);
"""

SCHEMA_VERSION = "1.0.1"


def get_db(db_path=None):
    path = Path(db_path) if db_path else DEFAULT_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_schema(db_path=None):
    conn = get_db(db_path)
    conn.executescript(SCHEMA_SQL)
    conn.execute(
        "INSERT OR REPLACE INTO bookmarks_meta (key, value, updated_at) VALUES (?, ?, ?)",
        ("schema_version", SCHEMA_VERSION, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    return conn


def log_sync(conn, source, action, count, status, notes=""):
    conn.execute(
        "INSERT INTO sync_log (source, action, count, status, notes) VALUES (?, ?, ?, ?, ?)",
        (source, action, count, status, notes),
    )
    conn.commit()


def get_meta(conn, key):
    row = conn.execute("SELECT value FROM bookmarks_meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(conn, key, value):
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
