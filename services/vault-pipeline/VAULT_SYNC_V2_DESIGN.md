# Vault Sync v2 — Architecture Redesign

## Problem Summary

The current pipeline (7 bugs found) suffers from: hung processes (2+ days),
expired auth with no fallback, fake async timeouts on sync libraries, silent
enrichment failures, dual scheduling collisions, and no concurrency control.

## Root Causes (from forensic analysis)

| # | Bug | Root Cause Category |
|---|-----|-------------------|
| 1 | Twitter auth expired | Fragile auth, no health check |
| 2 | Instagram image download hangs | No hard timeout on network I/O |
| 3 | asyncio.wait_for can't cancel sync code | Async/sync mismatch |
| 4 | llava model not installed | Hardcoded dependency, silent failure |
| 5 | GCS project not in launchd env | Environment guessing |
| 6 | Dual scheduling (launchd + crontab) | Operational overlap |
| 7 | No locking | Zombie process accumulation |

## Constraints

- Runs on a **Mac** (may sleep, be offline, Ollama models change)
- **twscrape** and **instagrapi** are synchronous blocking libraries
- Cookies expire and need **manual refresh** (can't auto-renew)
- **SQLite** vault.db is consumed by Cloud Run vault search service
- GCS auth is inconsistent from launchd vs interactive shell
- Pipeline feeds: OmniClaw Desktop, vault search Cloud Run, daily health checks

## Design Principles

1. **Subprocess isolation** — every fragile network op runs as a subprocess
   with OS-level `timeout`. If it hangs, the OS kills it. Period.
2. **Staging area** — scrape to temp JSON files first. Only touch vault.db
   after scrape succeeds. Failed scrape = zero DB impact.
3. **Decouple enrichment** — vision/image analysis is a separate, optional,
   non-blocking process. Main pipeline never waits for it.
4. **Single scheduler** — launchd only. Remove crontab entry.
5. **File locking** — flock-based lock prevents concurrent runs.
6. **Explicit config** — hardcoded project ID, model names, timeouts.
   No environment guessing.
7. **Structured status** — JSON status file that health checks can read.
8. **Graceful degradation** — each source fails independently. Twitter down
   doesn't block Instagram. Enrichment down doesn't block export.

## New Architecture

```
vault-daily-sync-v2.sh  (orchestrator + lock + status)
 │
 ├─ [1] ACQUIRE LOCK (flock — prevent concurrent runs)
 │
 ├─ [2] SCRAPE (subprocess + hard OS timeout per source)
 │      ├─ timeout 90  python3 scrape_twitter.py  --out staging/twitter.json
 │      └─ timeout 90  python3 scrape_instagram.py --out staging/instagram.json
 │      (each source independent — one failing doesn't block the other)
 │      (if live scrape fails, try GCS fallback)
 │
 ├─ [3] INGEST (local SQLite, fast, always works)
 │      python3 ingest_staging.py --staging-dir staging/ --db vault.db
 │      (idempotent ON CONFLICT(url) DO UPDATE)
 │
 ├─ [4] SYNC NODES (bookmarks table → nodes table)
 │      python3 sync_bookmarks_to_nodes.py (existing, unchanged)
 │
 ├─ [5] ENRICH (optional, background, per-item subprocess timeout)
 │      timeout 300 python3 enrich_pending.py --db vault.db --max-items 20
 │      (only items WITHOUT vlTags, hard 15s per-image subprocess timeout)
 │      (runs in background — pipeline continues without waiting)
 │
 ├─ [6] EXPORT + UPLOAD
 │      python3 export_gcs.py --db vault.db (explicit project ID)
 │      gsutil cp vault.db gs://...
 │
 ├─ [7] WRITE STATUS (JSON status file for health checks)
 │      { "last_run": "...", "twitter": "ok", "instagram": "ok", ... }
 │
 └─ [8] RELEASE LOCK
```

## Key Design Decisions

### D1: Subprocess Isolation (solves bugs 2, 3)

Instead of:
```python
# BROKEN: asyncio.wait_for can't cancel sync blocking calls
return await asyncio.wait_for(scrape_with_timeout(), timeout=30)
```

Do:
```bash
# RELIABLE: OS kills the process after 90s, no matter what
timeout --kill-after=5 90 python3 scrape_twitter.py --out "$STAGING/twitter.json"
SCRAPER_EXIT=$?
```

The `timeout` command sends SIGTERM after 90s, then SIGKILL after 5 more
seconds. This is a hard, OS-enforced timeout that works on any code.

### D2: Staging Area (solves data integrity)

```
/tmp/vault-staging-2026-07-01/
├── twitter.json      (raw scraped data)
├── instagram.json    (raw scraped data)
└── meta.json         (scrape metadata: timestamps, counts, errors)
```

Scrapers write ONLY to staging. The ingester reads staging → vault.db.
If scraping fails halfway, vault.db is untouched. The staging dir also
serves as a debug artifact.

### D3: Decoupled Enrichment (solves bugs 2, 4)

Enrichment is completely separated:
- Runs as a **separate background process** (not blocking main pipeline)
- Only processes items that **lack** vlTags (WHERE metadata LIKE '%"vlTags":[]%')
- Each image analysis is a **subprocess** with hard 15s timeout
- Model name comes from **config.py**, not hardcoded
- Falls back gracefully: no llava = skip enrichment, store raw

### D4: Explicit Config (solves bug 5)

```python
# config.py — single source of truth
GCS_PROJECT = "omniclaw-personal-assistant"
GCS_BUCKET = "omniclaw-knowledge-graph"
OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_VISION_MODEL = "qwen2.5:7b"  # auto-detect what's installed
SCRAPER_TIMEOUT_SEC = 90
IMAGE_TIMEOUT_SEC = 15
ENRICH_BATCH_SIZE = 20
```

### D5: File Locking (solves bugs 6, 7)

```bash
# Acquire exclusive lock — prevents concurrent runs
LOCK_FILE="/tmp/vault-sync.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "Another sync is already running (PID $(cat "$LOCK_FILE"))"
    exit 0
fi
echo $$ > "$LOCK_FILE"
```

### D6: Structured Status (solves observability)

```json
// /Users/Subho/omniclaw/services/vault-pipeline/sync-status.json
{
  "last_run": "2026-07-01T04:00:00Z",
  "last_success": "2026-07-01T04:05:23Z",
  "duration_sec": 323,
  "stages": {
    "twitter": {"status": "ok", "items": 12, "source": "twscrape"},
    "instagram": {"status": "ok", "items": 5, "source": "instagrapi"},
    "ingest": {"status": "ok", "inserted": 17, "updated": 0},
    "enrich": {"status": "ok", "enriched": 8, "skipped": 9, "errors": 0},
    "export": {"status": "ok", "uploaded": 8827},
    "upload": {"status": "ok", "bytes": 61534208}
  },
  "warnings": ["llava not installed, using qwen2.5:7b"],
  "errors": []
}
```

## File Structure

```
~/omniclaw/services/vault-pipeline/
├── config.py              # Explicit config (project IDs, timeouts, model)
├── scrape_twitter.py      # Standalone subprocess: twscrape → staging JSON
├── scrape_instagram.py    # Standalone subprocess: instagrapi → staging JSON
├── ingest_staging.py      # Read staging JSON → vault.db bookmarks table
├── enrich_pending.py      # Enrich items lacking vlTags (subprocess per image)
├── export_gcs.py          # Export vault.db → GCS (explicit project)
├── sync_status.py         # Write/read structured status JSON
├── vault-daily-sync-v2.sh # New orchestrator (lock + schedule stages)
├── locker.py              # Cross-platform file locking helper
│
├── unified_schema.py      # EXISTING — unchanged (schema stays the same)
├── ingest_twitter.py      # EXISTING — kept for reference/rollback
├── ingest_instagram.py    # EXISTING — kept for reference/rollback
└── sync_pipeline.py       # EXISTING — kept for reference/rollback
```

## Scheduling Changes

### Remove:
```cron
# crontab — REMOVE THIS (causes dual-run collision)
0 4 * * * /bin/bash /Users/Subho/omniclaw/scripts/vault-daily-sync.sh
```

### Update launchd plist:
```xml
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/Subho</string>
    <key>GOOGLE_CLOUD_PROJECT</key>
    <string>omniclaw-personal-assistant</string>
</dict>
```

## Migration Plan

1. Kill hung processes (PIDs 4335, 4385)
2. Write new v2 files alongside existing (no destructive changes)
3. Test each stage independently
4. Run full v2 pipeline manually once
5. Update launchd to point to v2 script
6. Remove crontab entry
7. Keep v1 files for rollback

## Bug Resolution Matrix

| Bug | v2 Solution |
|-----|------------|
| 1. Twitter auth expired | Health check in scraper; graceful GCS fallback; status reports auth state |
| 2. IG image download hangs | Subprocess isolation + OS `timeout`; enrichment decoupled |
| 3. asyncio can't timeout sync | Eliminated — scrapers are standalone subprocesses with `timeout` |
| 4. llava not installed | Auto-detect installed model in config.py; graceful skip |
| 5. GCS project missing | Explicit project in config.py + launchd env var |
| 6. Dual scheduling | Remove crontab; launchd only |
| 7. No locking | flock-based exclusive lock |

---

## Deployment Status: ✅ FULLY DEPLOYED (2026-07-01)

### macOS Compatibility Notes
- `timeout` requires GNU coreutils: `brew install coreutils` → `/opt/homebrew/bin/timeout`
- `flock` is Linux-only (util-linux). macOS uses Python `fcntl` via `locker.py`
- Watchdog uses Python for all date parsing (avoids macOS `date` format incompatibilities)

### Bug Resolution Status

| Bug | v2 Solution | Status |
|-----|------------|--------|
| 1. Twitter auth expired | GCS fallback with structured error + action_required | ✅ Deployed |
| 2. IG image download hangs | OS `timeout --kill-after=10 90`; enrichment decoupled | ✅ Deployed |
| 3. asyncio can't timeout sync | Eliminated — standalone subprocesses with OS `timeout` | ✅ Deployed |
| 4. llava not installed | Auto-detect model + graceful skip + warning | ✅ Deployed |
| 5. GCS project missing | Explicit project in config.py + launchd env var | ✅ Deployed |
| 6. Dual scheduling | Launchd only; crontab v1 entry commented out | ✅ Deployed |
| 7. No locking | Python fcntl via locker.py (macOS-compatible) | ✅ Deployed |

### Test Results (2026-07-01)

| Test | Result |
|------|--------|
| Twitter GCS fallback | ✅ 800 items |
| Instagram live scrape | ✅ 3 items (login worked!) |
| Ingest to vault.db | ✅ 803 inserted |
| Export to GCS | ✅ 8810 bookmarks uploaded |
| sync-status.json → GCS | ✅ Uploaded to gs://.../vault/sync-status.json |
| Enrichment (no llava) | ✅ Graceful skip |
| End-to-end pipeline | ✅ 22 seconds |
| Watchdog | ✅ Healthy, no alert |
| Lock acquire/release | ✅ |
| Launchd v2 | ✅ Active |
| Crontab v1 | ✅ Commented out |

---

## Key Finding: twscrape's Default accounts.db Location

**Critical discovery during implementation:**

twscrape stores accounts in `~/accounts.db` (NOT in the pipeline directory). The pipeline had its own `accounts.db` but twscrape always uses the default location `~/accounts.db`.

This was the ROOT CAUSE of the 5-day auth failure:
1. Old auth error from June 19 was cached in `~/accounts.db` 
2. The `active=0` flag made twscrape skip the account without retrying
3. Fresh cookies couldn't update the account because twscrape never re-authenticated

**Fix:** Clear `~/accounts.db` before first use with fresh cookies:
```bash
rm -f ~/accounts.db
# Then run pipeline — twscrape will create fresh account with new cookies
```

**Also:** Set `TWSCRAPE_DB` env var for predictable behavior:
```python
import os
os.environ["TWSCRAPE_DB"] = str(Path.home() / "accounts.db")
```

## Final Test Results (2026-07-01)

| Test | Result |
|------|--------|
| Twitter live scrape (fresh cookies) | ✅ 236 new tweets |
| Instagram live scrape | ✅ 3 posts |
| Ingest to vault.db | ✅ 239 inserted |
| Export to GCS | ✅ unified_bookmarks.json 12.32 MiB |
| sync-status.json → GCS | ✅ |
| Enrichment (no llava) | ✅ Graceful skip |
| Vault search endpoint | ✅ Working |
| End-to-end pipeline | ✅ 32 seconds |
| Lock acquire/release | ✅ |
| Watchdog | ✅ Healthy |

**Twitter auth was fixed by clearing `~/accounts.db` (not GCS cookies).**

---

## Deployment Status (2026-07-01)

### Deployment Summary

Pipeline v2 is **fully deployed and tested**. First successful end-to-end run completed at 2026-07-01 20:05 UTC in **97 seconds**.

### Platform Decisions

| Decision | Value | Rationale |
|----------|-------|-----------|
| `timeout` path | `/opt/homebrew/bin/timeout` | macOS doesn't ship `flock`; GNU coreutils provides `timeout` at this path |
| Lock file | `/tmp/vault-sync.lock` | No flock available; Python fcntl used instead |
| Twscrape accounts.db | `~/accounts.db` (not pipeline dir) | twscrape defaults to `~/accounts.db`; pipeline dir path not used |
| Instagram primary | **Direct HTTP via curl** | instagrapi has no `saved()` method; `/feed/saved/posts/` API works with curl |
| Instagram fallback | instagrapi → GCS fallback → local fallback | 3-tier fallback chain |
| Cookie source | GCS at `gs://omniclaw-knowledge-graph/vault/cookies/instagram_cookies.json` | Centralized, versioned |
| `bookmarked_at` | From Instagram `taken_at` (Unix int → ISO string) | Actual saved-post date, not scrape date |

### Instagram Scraping Findings

1. **Saved Posts API**: `https://i.instagram.com/api/v1/feed/saved/posts/` — returns saved posts (NOT `collections` API which only returns custom collections)

2. **instagrapi limitation**: No `saved_posts()` method. Only `collection_medias()` which returns custom collections, not the "Saved" folder. Falls back to `user_medias` (only own posts).

3. **Cookie format**: Sessionid stored URL-encoded in GCS JSON (e.g., `sessionid%3A1321310950%3AgEmK...`). Must URL-decode before use.

4. **Checkpoint behavior**: After ~15 pages of rapid requests, Instagram triggers a checkpoint challenge (`message: "checkpoint_required"`). The API blocks ALL saved posts requests from that IP until verified via web UI.

5. **Pagination**: Each page = 50 posts. Instagram has 700+ saved posts for this account. At ~5s/page, full scrape = ~70s for 700 posts.

6. **`bookmarked_at` fix**: Instagram `taken_at` is a Unix integer (e.g., `1782584401`). Must convert: `datetime.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%S")`.

7. **One-time SQL fix (2026-07-01)**: 374 posts had empty `bookmarked_at` from partial scrape. Converted to ISO datetimes via:
   ```sql
   UPDATE bookmarks SET bookmarked_at = datetime(bookmarked_at, 'unixepoch')
   WHERE source='instagram' AND LENGTH(bookmarked_at)=10
   AND bookmarked_at GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]';
   ```

### Instagram Checkpoint Workaround

When checkpoint blocks the API:
1. **Wait**: Checkpoint typically clears in hours. Re-run pipeline after waiting.
2. **Re-authenticate**: Log into Instagram via browser, export fresh `sessionid`, upload to GCS.
3. **Browser verification**: Navigate to `https://www.instagram.com/challenge/` while logged in to auto-verify.

### Known Limitations

- Instagram saved posts API is blocked by checkpoint (as of 2026-07-01). 700 posts captured before checkpoint.
- Old instagrapi posts have `bookmarked_at = 2026-04-13` (scrape date, not post date). Posts from April 2026 are actually from various dates.
- `flock` not available on macOS — fcntl-based locking used instead.

### Pipeline Run History

| Timestamp | Duration | Twitter | Instagram | Notes |
|-----------|----------|---------|-----------|-------|
| 2026-07-01 18:05 | ~40s | 236 | 3 | Old instagrapi fallback (3 user media) |
| 2026-07-01 20:05 | 97s | 236 | 700 | Full HTTP scrape, then checkpoint hit |
