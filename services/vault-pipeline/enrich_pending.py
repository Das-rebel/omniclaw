#!/usr/bin/env python3
"""
Vault Sync v2 — Vision Enrichment (Standalone, Optional)
Only processes Instagram posts that lack vlTags.
Runs as a SEPARATE background process — not blocking the main pipeline.
Each image gets a hard OS-level timeout via subprocess.
"""

import json
import sys
import sqlite3
import subprocess
import tempfile
import base64
import re
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from config import (
    DB_PATH, OLLAMA_URL, OLLAMA_TIMEOUT_SEC,
    ENRICH_BATCH_SIZE, ENRICH_MAX_IMAGE_SIZE_MB,
    EXIT_OK, EXIT_ERROR, EXIT_TIMEOUT,
)

LOG_PREFIX = "[ENRICH]"


def log(msg: str):
    print(f"{LOG_PREFIX} {datetime.now().isoformat()} {msg}", flush=True)


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def get_pending_items(conn: sqlite3.Connection, limit: int) -> list[dict]:
    """
    Find Instagram posts that have an image_url but lack vlTags in metadata.
    """
    rows = conn.execute("""
        SELECT id, url, title, content, metadata
        FROM bookmarks
        WHERE source = 'instagram'
          AND is_active = 1
          AND metadata NOT LIKE '%vlTags%'
        ORDER BY rowid DESC
        LIMIT ?
    """, (limit,)).fetchall()

    items = []
    for row in rows:
        meta = json.loads(row["metadata"] or "{}")
        image_url = meta.get("imageUrl", "")
        if image_url:
            items.append({
                "id": row["id"],
                "url": row["url"],
                "title": row["title"],
                "content": row["content"],
                "image_url": image_url,
                "metadata": meta,
            })
    return items


def download_image(image_url: str, timeout_sec: int = 15) -> bytes | None:
    """
    Download an image with a hard subprocess timeout.
    Uses `curl` via subprocess so OS-level timeout works reliably.
    Returns raw bytes or None on failure.
    """
    try:
        # Use curl with hard timeout (timeout command, not curl's --max-time)
        result = subprocess.run(
            [
                "timeout", "--kill-after=2", str(timeout_sec),
                "curl", "-s", "-L",
                "--max-filesize", str(ENRICH_MAX_IMAGE_SIZE_MB * 1024 * 1024),
                "-A", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
                "-o", "/dev/stdout",
                "--silent", "--show-error",
                image_url,
            ],
            capture_output=True, timeout=timeout_sec + 5,
        )
        if result.returncode == 0 and len(result.stdout) > 1024:
            return result.stdout
    except subprocess.TimeoutExpired:
        log(f"Image download timed out after {timeout_sec}s: {image_url[:60]}")
    except Exception as e:
        log(f"Image download error: {e}")
    return None


def analyze_image(img_bytes: bytes, model: str) -> dict | None:
    """
    Send image to Ollama vision model and parse response.
    Returns vlTags, visual_description, vlMood or None on failure.
    """
    try:
        prompt = (
            "Describe this image for a search index. "
            "Return ONLY a valid JSON object with these exact fields: "
            '{"visual_description":"<80 char caption>","vlTags":["<tag1>","<tag2>","<tag3>"],"vlMood":"<one word mood>"}'
            " RESPOND WITH NOTHING ELSE — pure JSON, no markdown, no explanation."
        )

        b64_img = base64.b64encode(img_bytes).decode("utf-8")
        payload = json.dumps({
            "model": model,
            "prompt": prompt,
            "images": [b64_img],
            "stream": False,
            "options": {"num_predict": 150, "temperature": 0.2},
        })

        result = subprocess.run(
            [
                "timeout", "--kill-after=5", str(OLLAMA_TIMEOUT_SEC),
                "curl", "-s", f"{OLLAMA_URL}/api/generate",
                "-d", payload,
                "-H", "Content-Type: application/json",
            ],
            capture_output=True, text=True, timeout=OLLAMA_TIMEOUT_SEC + 10,
        )

        if result.returncode != 0:
            return None

        resp = json.loads(result.stdout)
        text = resp.get("response", "").strip()

        # Clean markdown code blocks
        if "```" in text:
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
            text = text.strip()

        analysis = json.loads(text)
        return {
            "visual_description": analysis.get("visual_description", "")[:80],
            "vlTags": analysis.get("vlTags", [])[:6],
            "vlMood": analysis.get("vlMood", "Neutral"),
            "vlStyle": analysis.get("vlMood", "Neutral"),
            "vision_provider": f"ollama-{model}",
        }
    except Exception as e:
        log(f"Vision analysis error: {e}")
        return None


def update_bookmark_metadata(conn: sqlite3.Connection, bookmark_id: int,
                             new_meta: dict) -> bool:
    """Merge new vision metadata into the bookmark's metadata JSON."""
    try:
        row = conn.execute(
            "SELECT metadata FROM bookmarks WHERE id = ?", (bookmark_id,)
        ).fetchone()
        if not row:
            return False

        meta = json.loads(row["metadata"] or "{}")
        meta.update(new_meta)
        conn.execute(
            "UPDATE bookmarks SET metadata = ? WHERE id = ?",
            (json.dumps(meta, ensure_ascii=False), bookmark_id),
        )
        conn.commit()
        return True
    except Exception as e:
        log(f"Failed to update metadata: {e}")
        return False


def detect_vision_model() -> tuple[str, bool]:
    """
    Auto-detect best vision model from Ollama.
    Returns (model_name, is_fallback).
    """
    preferred = [
        ("llava:7b", False),
        ("llava:13b", False),
        ("qwen2.5-vl:7b", False),
        ("qwen2.5-vl:3b", False),
        ("moondream:1.8b", False),
        ("llava:latest", True),  # fallback
    ]

    try:
        result = subprocess.run(
            ["curl", "-s", f"{OLLAMA_URL}/api/tags"],
            capture_output=True, text=True, timeout=5,
        )
        installed = {m["name"] for m in json.loads(result.stdout).get("models", [])}

        for model, is_fallback in preferred:
            if model in installed:
                return model, is_fallback
    except Exception:
        pass

    return "", True  # No model found


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Enrich pending Instagram posts with vision tags")
    parser.add_argument("--db", help="Path to vault.db (default: from config)")
    parser.add_argument("--max-items", type=int, default=ENRICH_BATCH_SIZE,
                        help=f"Max items to process (default: {ENRICH_BATCH_SIZE})")
    parser.add_argument("--force", action="store_true",
                        help="Re-process items even if they already have vlTags")
    args = parser.parse_args()

    db_path = Path(args.db) if args.db else DB_PATH
    max_items = args.max_items

    model, is_fallback = detect_vision_model()
    if not model:
        log("No Ollama vision model detected — skipping enrichment")
        log("Install with: ollama pull llava:7b")
        sys.exit(EXIT_OK)  # Not an error — enrichment is optional

    if is_fallback:
        log(f"WARNING: Using fallback model '{model}' (preferred models not installed)")

    conn = get_db()
    items = get_pending_items(conn, max_items)
    conn.close()

    if not items:
        log(f"No items need enrichment (checked {max_items} items)")
        sys.exit(EXIT_OK)

    log(f"Processing {len(items)} items with model={model}")

    processed = 0
    errors = 0
    skipped = 0

    for item in items:
        img_bytes = download_image(item["image_url"], timeout_sec=15)
        if not img_bytes:
            skipped += 1
            continue

        analysis = analyze_image(img_bytes, model)
        if not analysis:
            skipped += 1
            continue

        conn2 = get_db()
        ok = update_bookmark_metadata(conn2, item["id"], analysis)
        conn2.close()

        if ok:
            processed += 1
            log(f"  [{processed}] Enriched: {item['url'][:60]}")
            log(f"       vlTags={analysis.get('vlTags', [])}, mood={analysis.get('vlMood')}")
        else:
            errors += 1

    log(f"=== Enrich complete: processed={processed}, skipped={skipped}, errors={errors} ===")

    if processed == 0 and errors > 0:
        sys.exit(EXIT_ERROR)
    sys.exit(EXIT_OK)


if __name__ == "__main__":
    main()
