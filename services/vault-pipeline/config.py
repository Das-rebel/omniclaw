#!/usr/bin/env python3
"""
Vault Sync v2 — Explicit Configuration
Single source of truth for all pipeline settings.
No environment guessing. All values hardcoded here.
"""

from pathlib import Path
import subprocess
import json

# ─── Paths ───────────────────────────────────────────────────────────────────

PIPELINE_DIR = Path(__file__).parent
DEPLOY_DIR = Path.home() / "omniclaw" / "infrastructure" / "cloud-functions" / "deploy"
DB_PATH = DEPLOY_DIR / "learning_base" / "vault.db"
STAGING_DIR = Path("/tmp/vault-staging")

# twscrape uses ~/accounts.db as default — we set this env so all
# twscrape instances in the pipeline use the same DB
import os as _os
_os.environ.setdefault("TWSCRAPE_DB", str(Path.home() / "accounts.db"))

# GCS cookie files (loaded by shell script before calling Python)
COOKIES_DIR = Path.home() / "omniclaw" / "infrastructure" / "cloud-functions" / "deploy"

# ─── GCS / Cloud ─────────────────────────────────────────────────────────────

GCS_PROJECT = "omniclaw-personal-assistant"
GCS_BUCKET = "omniclaw-knowledge-graph"
GCS_VAULT_PATH = "learning_base/vault.db"
GCS_BOOKMARKS_PATH = "vault/unified_bookmarks.json"
GCS_STATUS_PATH = "vault/sync-status.json"
GCS_TWITTER_COOKIES_PATH = "vault/cookies/twitter_cookies.json"
GCS_INSTAGRAM_COOKIES_PATH = "vault/cookies/instagram_cookies.json"

# ─── Scraping Accounts ───────────────────────────────────────────────────────

TWITTER_USERNAME = "Subhojit_Sarkar"
INSTAGRAM_USERNAME = "subhojit.sarkar"

# ─── Timeouts (seconds) ──────────────────────────────────────────────────────

SCRAPER_TIMEOUT_SEC = 90       # OS-level timeout for scraper subprocesses
IMAGE_TIMEOUT_SEC = 15         # Per-image download timeout
OLLAMA_TIMEOUT_SEC = 60        # Ollama API call timeout

# ─── Enrichment ──────────────────────────────────────────────────────────────

OLLAMA_URL = "http://localhost:11434"
ENRICH_BATCH_SIZE = 20         # Max items per enrichment run
ENRICH_MAX_IMAGE_SIZE_MB = 15  # Skip images larger than this

# ─── Instagram ────────────────────────────────────────────────────────────────

# The Instagram scraper tries these collection names in order
INSTAGRAM_COLLECTION_NAMES = ["saved", "Saved", "SAVED"]

# ─── Exit Codes ──────────────────────────────────────────────────────────────
# Standardized across all v2 Python scripts

EXIT_OK = 0           # Success
EXIT_ERROR = 1        # General error
EXIT_AUTH_EXPIRED = 2 # Auth/token expired, manual refresh needed
EXIT_TIMEOUT = 124   # OS-level timeout (from `timeout` command)


def detect_ollama_vision_model() -> str:
    """
    Auto-detect the best available vision model from Ollama.
    Tries in order of preference. Returns the model name or '' if none found.
    """
    preferred = ["llava:7b", "llava:13b", "llava:latest",
                 "qwen2.5-vl:7b", "qwen2.5-vl:3b",
                 "moondream:1.8b"]
    try:
        result = subprocess.run(
            ["curl", "-s", f"{OLLAMA_URL}/api/tags"],
            capture_output=True, text=True, timeout=5
        )
        data = json.loads(result.stdout)
        installed = {m["name"] for m in data.get("models", [])}

        for model in preferred:
            if model in installed:
                return model

        # No vision model found
        return ""
    except Exception:
        return ""


def get_ollama_vision_model() -> str:
    """Cached model detection — runs once per process."""
    if not hasattr(get_ollama_vision_model, "_model"):
        get_ollama_vision_model._model = detect_ollama_vision_model()
    return get_ollama_vision_model._model


if __name__ == "__main__":
    print(f"GCS_PROJECT={GCS_PROJECT}")
    print(f"GCS_BUCKET={GCS_BUCKET}")
    print(f"DB_PATH={DB_PATH}")
    print(f"STAGING_DIR={STAGING_DIR}")
    print(f"OLLAMA_VISION_MODEL={get_ollama_vision_model()}")
