#!/usr/bin/env python3
"""
One-time migration: legacy vault.db nodes → unified bookmarks table.

Reads existing nodes (twitter_tweet, instagram_post) and relationships from
the old `nodes` + `relationships` tables and inserts them into the new
`bookmarks` + `bookmarks_tags` + `relationships` tables.

Preserves ALL metadata (VL tags, sentiment, entities, clip embeddings, etc.).

Idempotent: safe to run multiple times (deduplicates by url).
"""

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# Add parent for imports
sys.path.insert(0, str(Path(__file__).parent))

from unified_schema import init_schema, log_sync, get_db

LEGACY_DB = Path.home() / "omniclaw" / "infrastructure" / "cloud-functions" / "deploy" / "learning_base" / "vault.db"

SOURCE_MAP = {
    "twitter_tweet": "twitter",
    "instagram_post": "instagram",
}


def extract_tags_from_metadata(metadata: dict) -> list[tuple[str, str]]:
    """Extract tags from legacy metadata. Returns [(tag, source), ...]."""
    tags = []
    for tag in metadata.get("vlTags", []):
        tags.append((tag, "vl"))
    for tag in metadata.get("vlStyle", []):
        tags.append((tag, "vl"))
    for tag in metadata.get("vlMood", []):
        tags.append((tag, "vl"))
    return tags


def migrate_node(row: sqlite3.Row, conn: sqlite3.Connection) -> bool:
    """Migrate a single legacy node to bookmarks. Returns True if inserted."""
    node_type = row["type"]
    source = SOURCE_MAP.get(node_type)
    if not source:
        return False

    node_id = row["id"]
    url = row["url"]
    content = row["content"] or ""
    name = row["name"] or ""
    timestamp = row["timestamp"]
    metadata_raw = row["metadata"] or "{}"
    metadata = json.loads(metadata_raw) if isinstance(metadata_raw, str) else metadata_raw

    # Derive source_id
    if source == "twitter":
        # node id is the tweet ID (e.g., "2042633356123193733")
        source_id = node_id
        title = name
        bookmarked_at = timestamp
    elif source == "instagram":
        # node id is like "ig_0_1776118302058"
        source_id = node_id
        title = name
        bookmarked_at = metadata.get("postDate", timestamp)
    else:
        source_id = node_id
        title = name
        bookmarked_at = timestamp

    scraped_at = metadata.get("extracted_at", metadata.get("scraped_at", timestamp or datetime.now(timezone.utc).isoformat()))
    now = datetime.now(timezone.utc).isoformat()

    try:
        cursor = conn.execute(
            """INSERT INTO bookmarks
               (source, source_id, url, title, content, bookmarked_at, scraped_at, updated_at, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(url) DO UPDATE SET
                   metadata = excluded.metadata,
                   content = COALESCE(NULLIF(excluded.content, ''), bookmarks.content),
                   updated_at = excluded.updated_at
            """,
            (source, source_id, url, title, content, bookmarked_at, scraped_at, now, json.dumps(metadata, ensure_ascii=False)),
        )
        bookmark_id = cursor.lastrowid

        # If ON CONFLICT updated existing, lastrowid is wrong — get actual id
        if not bookmark_id:
            existing = conn.execute("SELECT id FROM bookmarks WHERE url = ?", (url,)).fetchone()
            if existing:
                bookmark_id = existing[0]
            else:
                return False

        # Insert tags
        tags = extract_tags_from_metadata(metadata)
        for tag, tag_source in tags:
            conn.execute(
                "INSERT OR IGNORE INTO bookmarks_tags (bookmark_id, tag, source) VALUES (?, ?, ?)",
                (bookmark_id, tag, tag_source),
            )

        return True
    except Exception as e:
        print(f"  ERROR inserting {url}: {e}")
        return False


def migrate_relationships(conn: sqlite3.Connection) -> int:
    """Copy all rows from legacy relationships table to new one."""
    count = 0
    rows = conn.execute("SELECT from_id, to_id, type, strength FROM relationships").fetchall()
    for row in rows:
        try:
            conn.execute(
                "INSERT OR IGNORE INTO relationships (from_id, to_id, type, strength) VALUES (?, ?, ?, ?)",
                (row[0], row[1], row[2], row[3]),
            )
            count += 1
        except Exception as e:
            print(f"  ERROR inserting relationship {row[0]}→{row[1]}: {e}")
    return count


def migrate_legacy_nodes(conn: sqlite3.Connection) -> dict:
    """Migrate all twitter_tweet and instagram_post nodes."""
    stats = {"twitter": 0, "instagram": 0, "errors": 0, "tags": 0}

    for node_type, source in SOURCE_MAP.items():
        rows = conn.execute(
            "SELECT id, type, name, content, url, timestamp, metadata FROM nodes WHERE type = ?",
            (node_type,),
        ).fetchall()
        print(f"\n[{source}] Found {len(rows)} legacy nodes")

        for i, row in enumerate(rows):
            ok = migrate_node(row, conn)
            if ok:
                stats[source] += 1
            else:
                stats["errors"] += 1
            if (i + 1) % 500 == 0:
                print(f"  ... {i + 1}/{len(rows)} processed")
                conn.commit()

        conn.commit()
        print(f"[{source}] Migrated {stats[source]} nodes ({stats['errors']} errors)")

    # Count tags
    tag_count = conn.execute("SELECT COUNT(*) FROM bookmarks_tags").fetchone()[0]
    stats["tags"] = tag_count

    return stats


def run_migration(db_path: str | Path | None = None):
    """Run the full one-time migration."""
    db_path = db_path or LEGACY_DB
    print(f"Migrating from: {db_path}")
    print(f"Started at: {datetime.now().isoformat()}")

    conn = init_schema(db_path)

    # Check if already migrated
    already = conn.execute("SELECT COUNT(*) FROM bookmarks").fetchone()[0]
    if already > 0:
        print(f"\nWARNING: bookmarks table already has {already} rows.")
        print("Migrating anyway (upsert logic will handle duplicates).")

    # Migrate nodes
    stats = migrate_legacy_nodes(conn)

    # Migrate relationships (into same table, idempotent via PRIMARY KEY)
    rel_count = migrate_relationships(conn)
    conn.commit()
    stats["relationships"] = rel_count

    # Summary
    total = stats["twitter"] + stats["instagram"]
    print(f"\n{'=' * 60}")
    print(f"MIGRATION COMPLETE")
    print(f"  Twitter bookmarks:  {stats['twitter']}")
    print(f"  Instagram bookmarks: {stats['instagram']}")
    print(f"  Tags indexed:        {stats['tags']}")
    print(f"  Relationships:       {stats['relationships']}")
    print(f"  Errors:              {stats['errors']}")
    print(f"  Total migrated:      {total}")

    log_sync(conn, "migration", "migrate_legacy", total, "success",
             json.dumps(stats))

    # Verify
    verify = conn.execute("SELECT source, COUNT(*) FROM bookmarks GROUP BY source").fetchall()
    print(f"\nVerification:")
    for row in verify:
        print(f"  {row[0]}: {row[1]} bookmarks")

    conn.close()
    return stats


if __name__ == "__main__":
    run_migration()
