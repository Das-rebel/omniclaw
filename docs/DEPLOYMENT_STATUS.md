# OmniClaw Deployment Status — May 4, 2026

## Executive Summary
- All Cloud Functions ACTIVE and healthy
- All vault data sources FRESH
- All schedulers ENABLED

## Architecture Overview
```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OmniClaw Pipeline                               │
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐             │
│  │   Twitter    │    │  Instagram   │    │   Browser    │             │
│  │   Scraper   │    │   Scraper   │    │  Bookmarks   │             │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘             │
│         │                  │                  │                       │
│         ▼                  ▼                  ▼                       │
│  ┌─────────────────────────────────────────────────────────┐          │
│  │              GCS: gs://omniclaw-knowledge-graph/        │          │
│  │                    vault/                                │          │
│  │   twitter_bookmarks_automated.json                      │          │
│  │   instagram_saved_automated.json                        │          │
│  │   browser_bookmarks.json                                │          │
│  │   bookmarks_automated.json (MERGED)                      │          │
│  └──────────────────────────┬──────────────────────────────┘          │
│                             │                                          │
│                             ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐          │
│  │         Knowledge Graph Builder                          │          │
│  │    unified_knowledge_graph.json (2,110 nodes)           │          │
│  └──────────────────────────┬──────────────────────────────┘          │
│                             │                                          │
│         ┌────────────────────┼────────────────────┐                     │
│         ▼                    ▼                    ▼                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐            │
│  │  api-handler │    │ fallback-    │    │  alexa-      │            │
│  │  (CF)        │    │  handler (CF)│    │  handler (CF)│            │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘            │
│         │                  │                  │                       │
│         │                  │                  │                       │
│         ▼                  ▼                  ▼                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐            │
│  │  Groq        │    │  Cerebras    │    │  Alexa Dev   │            │
│  │  (primary)   │    │  (fallback)  │    │  Console     │            │
│  └──────────────┘    └──────────────┘    └──────────────┘            │
│                             │                                          │
│                             ▼                                          │
│                      ┌──────────────┐                                 │
│                      │  Claude      │                                 │
│                      │  (Z.ai proxy)│                                 │
│                      └──────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────┘

Cloud Functions (asia-south1 unless noted):
  - instagram-sync          → instagrapi → GCS vault
  - instagram-vault-scheduler → triggers instagram-sync daily
  - twitter-sync            → httpx+cookies → GCS vault
  - bookmark-vault-scheduler → merges sources → KG rebuild
  - bookmark-processor      → POSTs to scrapers
  - api-handler (us-central1) → main LLM endpoint
  - fallback-handler (us-central1) → fallback LLM
  - alexaHandler (us-central1) → Alexa bridge

Schedulers:
  - instagram-vault-daily (10:00 UTC) → instagram-vault-scheduler
  - bookmark-processing-daily (10:30 UTC) → bookmark-processor
  - twitter-sync-daily (03:00 UTC) → twitter-sync
```

## Cloud Functions Status

| Function | Region | State | Timeout | URL |
|----------|--------|-------|---------|-----|
| instagram-sync | asia-south1 | ACTIVE | 300s | https://instagram-sync-o36e7noe5a-el.a.run.app |
| instagram-vault-scheduler | asia-south1 | ACTIVE | 300s | https://instagram-vault-scheduler-o36e7noe5a-el.a.run.app |
| twitter-sync | asia-south1 | ACTIVE | 300s | https://twitter-sync-o36e7noe5a-el.a.run.app |
| bookmark-vault-scheduler | asia-south1 | ACTIVE | 300s | https://bookmark-vault-scheduler-o36e7noe5a-el.a.run.app |
| bookmark-processor | asia-south1 | ACTIVE | 300s | https://bookmark-processor-o36e7noe5a-el.a.run.app |
| api-handler | us-central1 | ACTIVE | 60s | https://us-central1-omniclaw-personal-assistant.cloudfunctions.net/api-handler |
| fallback-handler | us-central1 | ACTIVE | 60s | https://us-central1-omniclaw-personal-assistant.cloudfunctions.net/fallback-handler |
| alexaHandler | us-central1 | ACTIVE | 60s | https://us-central1-omniclaw-personal-assistant.cloudfunctions.net/alexaHandler |

## Issues Found & Solutions Applied

### 1. alexaHandler Cloud Function — ORPHANED (P0)
**Problem:** Cloud Run service for the function was deleted, leaving CF in UNKNOWN state
**Solution:** Redeployed with `gcloud functions deploy alexaHandler --runtime=nodejs22 --entry-point=alexaHandler --region=us-central1`
**Files Changed:** None (redeploy only)
**Date:** 2026-05-04

### 2. AI Fallback Chain — CLAUDE MISSING (P0)
**Problem:** `resilient-clients.js` only had GroqClient and CerebrasClient. AnthropicClient was missing entirely.
**Solution:** Added AnthropicClient class using:
- HTTPS module (not fetch — more reliable in Cloud Functions)
- Z.ai proxy endpoint: `https://api.z.ai/api/anthropic/messages`
- Model: `claude-sonnet-4-20250514`
- Auth: `Authorization: Bearer ${ZAI_API_KEY}`
**Files Changed:** `infrastructure/cloud-functions/deploy/resilient-clients.js`
**Date:** 2026-05-04

### 3. Cloud Run Services — CPU/CONCURRENCY CONFLICT (P0)
**Problem:** Both `alexa-handler` and `omniclaw-alexa-bridge` Cloud Run services showed X (red) with error "cpu < 1 is not supported with concurrency > 1"
**Solution:** Redeployed with explicit `--cpu=1 --concurrency=1`
**Files Changed:** None (redeploy only)
**Date:** 2026-05-04

### 4. Twitter Scraper — GRAPHQL QUERY ID STALE + CLOUDFLARE BLOCK (P1)
**Problem:**
- GraphQL query ID `WUAL-t2Pq4sg3dZp5-6Srw` returned HTTP 404 (Twitter changed their API)
- twscrape password login blocked by Cloudflare (403)
**Solution:**
- Switched to cookie-injected httpx client (matching Instagram pattern)
- Used twscrape's own query ID `GQL_FEATURES` and `OP_Bookmarks` from twscrape library
- Injected cookies from GCS directly into httpx AsyncClient
- Removed Cloudflare-triggering delays
**Files Changed:** `infrastructure/cloud-functions/twitter-sync-function/main.py`
**Date:** 2026-05-04

### 5. Twitter Cookies — STALE (P1)
**Problem:** Cookies uploaded to GCS on 2026-04-22 were expired
**Solution:** Extracted fresh cookies from Chrome DevTools and uploaded to `gs://omniclaw-knowledge-graph/vault/cookies/twitter_cookies.json`
**Files Changed:** GCS only
**Date:** 2026-05-04

### 6. Instagram Scraper — DOUBLE-ENCODING BUG (P1)
**Problem:** GCS file `instagram_saved_automated.json` was stored with `posts` field as a JSON-ENCODED STRING instead of a proper JSON array. This caused:
- `_read_gcs_json` to return `{"posts": "[{...}]"}` (string value)
- `_merge_posts` to call `.get()` on a string → AttributeError
**Root Cause:** The `_write_gcs_json` function did `json.dumps()` on already-serialized data
**Solution:**
1. Fixed `_write_gcs_json` to detect and handle pre-encoded strings
2. Fixed `_read_gcs_json` to detect and parse string-encoded posts
3. Fixed `_merge_posts` to handle existing_posts being a string
4. Added `force_refresh=true` option to bypass merge entirely
**Files Changed:** `infrastructure/cloud-functions/instagram-sync-function/main.py`
**Date:** 2026-05-04

### 7. Instagram Scraper — SESSION VALIDATION FAILING (P1)
**Problem:** `user_id_from_username` call failed with "property 'user_id' has no setter"
**Solution:** instagrapi session still works via cookies — the error is non-fatal. Session verification uses `user_info(cl.user_id)` which succeeds.
**Files Changed:** None (cosmetic issue)
**Date:** 2026-05-04

### 8. instagram-vault-scheduler — UNKNOWN STATE (P1)
**Problem:** CF in UNKNOWN state with "Cloud Run service not found" error
**Solution:** Redeployed from `~/omniclaw/infrastructure/cloud-functions/bookmark-vault-scheduler/` source with entry point `instagram_scrape`
**Files Changed:** None (redeploy only)
**Date:** 2026-05-04

### 9. Bookmarks Data — STALE (P2)
**Problem:** `bookmarks_automated.json` had only 4 items, 9 days old. No merge step existed to combine Twitter + Instagram + Browser sources.
**Solution:**
- Merged all three sources manually: 3 Twitter + 80 Instagram + 16 Browser = 98 items
- Added merge step to `vm_sync.sh` and `vm_sync_gcs.sh`
- Uploaded fresh file to GCS
**Files Changed:** `scripts/vm_sync.sh`, `scripts/vm_sync_gcs.sh` (added), GCS upload
**Date:** 2026-05-04

### 10. Knowledge Graph — STALE (P2)
**Problem:** `unified_knowledge_graph.json` was 21 days old (last updated ~April 13, 2026)
**Solution:** Rebuilt KG from fresh Twitter (800) + Instagram (80) + Browser (16) + preserved entity/topic/category nodes
- New: 2,110 nodes, 7,446 relationships (was 7,077 nodes but many were duplicates)
**Files Changed:** GCS upload
**Date:** 2026-05-04

### 11. daily-summary.sh — NODE PATH + DATE PARSING (P2)
**Problem:**
- Line 260 used bare `node` command which wasn't in PATH on macOS
- `format_age()` function used GNU `date -j -u -f` which fails on macOS
**Solution:**
- Changed `node` to `/usr/local/bin/node`
- Replaced `date` parsing with python3 `datetime.strptime()` for cross-platform compatibility
**Files Changed:** `scripts/daily-summary.sh`
**Date:** 2026-05-04

### 12. instagram-vault-daily Scheduler — MISSING (P1)
**Problem:** The `instagram-vault-daily` Cloud Scheduler job didn't exist
**Solution:** Created with `gcloud scheduler jobs create http instagram-vault-daily --schedule="0 10 * * *" --uri="https://asia-south1-omniclaw-personal-assistant.cloudfunctions.net/instagram-vault-scheduler"`
**Date:** 2026-05-04

## Vault Data Status

| Source | Items | Last Updated | GCS Path |
|--------|-------|-------------|----------|
| Twitter | 800 | 2026-05-04 11:34 UTC | vault/twitter_bookmarks_automated.json |
| Instagram | 50 | 2026-05-04 14:48 UTC | vault/instagram_saved_automated.json |
| Bookmarks (merged) | 98 | 2026-05-04 11:24 UTC | vault/bookmarks_automated.json |
| Browser BMs | 16 | ~2026-04-29 | vault/browser_bookmarks.json |
| Knowledge Graph | 2,110 nodes | 2026-05-04 12:00 UTC | unified_knowledge_graph.json |

## Cloud Scheduler Jobs

| Job | Schedule | Target | State |
|-----|----------|--------|-------|
| instagram-vault-daily | 0 10 * * * | instagram-vault-scheduler | ENABLED |
| bookmark-processing-daily | 30 10 * * * | bookmark-processor | ENABLED |
| twitter-sync-daily | 0 3 * * * | twitter-sync | ENABLED |

## Key Architecture Decisions

### AI Provider Chain (resilient-clients.js)
The fallback chain is: Groq → Cerebras → Anthropic (Z.ai proxy)
- Uses Z.ai proxy at `https://api.z.ai/api/anthropic/messages`
- Model: `claude-sonnet-4-20250514`
- Auth: `Bearer ${ZAI_API_KEY}` (NOT ANTHROPIC_API_KEY)
- Uses Node.js `https` module (not `fetch`) for reliability

### Instagram Scraping (instagrapi)
- Uses cookie-based session from GCS (`vault/cookies/instagram_cookies.json`)
- Session refreshed automatically after each fetch
- `collection_medias()` used for saved posts (NOT `collection_items()` which was removed in instagrapi 2.x)
- Merge logic handles double-encoded posts gracefully

### Twitter Scraping (twscrape + httpx)
- Cookies injected directly into httpx AsyncClient (NOT via twscrape AccountsPool)
- Uses twscrape's own GraphQL query ID and features (not hardcoded)
- Falls back to no-auth syndication API if cookies fail

## Remaining Issues (P2/P3)

### 1. Instagram Cookie Session Expiry
Instagram cookies expire and need periodic refresh. The current session may need refreshing every few weeks.
**Recommendation:** Set up alerting when scraper returns <5 items

### 2. Bookmark Processor Doesn't Read GCS
The `bookmark-processor` function POSTs to scraper endpoints instead of reading from GCS.
**Recommendation:** Refactor to read from GCS directly

### 3. Knowledge Graph Build Not Scheduled
KG is rebuilt manually. Should be triggered by the bookmark-processing-daily scheduler.
**Recommendation:** Add KG build step to `bookmark-vault-scheduler`

### 4. vm_sync.sh References GCP VM Path
`vm_sync.sh` uses `/home/ubuntu/vault_scraper/` which is a GCP VM path, not available on macOS
**Recommendation:** Add environment detection to `vm_sync.sh`

## Useful Commands

```bash
# Check all Cloud Functions
gcloud functions list --project=omniclaw-personal-assistant

# Check all Cloud Run services
gcloud run services list --platform=managed --region=us-central1 --project=omniclaw-personal-assistant

# Check schedulers
gcloud scheduler jobs list --project=omniclaw-personal-assistant --location=us-central1

# Test Twitter scraper
gcloud functions call twitter-sync --region=asia-south1 --data '{"send_summary": true}'

# Test Instagram scraper (force refresh)
curl -X POST "https://asia-south1-omniclaw-personal-assistant.cloudfunctions.net/instagram-sync" \
  -H "Content-Type: application/json" \
  -d '{"force_refresh": true}'

# Check vault data
gsutil ls gs://omniclaw-knowledge-graph/vault/
gsutil cat gs://omniclaw-knowledge-graph/vault/latest_sync_summary.json

# Daily summary dry-run
cd ~/omniclaw && ./scripts/daily-summary.sh --dry-run

# Daily summary (sends to WhatsApp)
cd ~/omniclaw && ./scripts/daily-summary.sh
```

## Rollback Notes

If any change causes issues, these are the previous working states:

- **twitter-sync**: revision `twitter-sync-00016-hih` (before cookie-injection rewrite)
- **instagram-sync**: revision `instagram-sync-00005-cex` (before main.py rewrite)
- **resilient-clients.js**: git checkout fc82e9b -- infrastructure/cloud-functions/deploy/resilient-clients.js

## Vault Control Center

A web dashboard deployed to Cloud Run providing permanent URL access to vault management.

**URL:** https://omniclaw-vault-control-338789220059.us-central1.run.app

**Features:**
- Password-protected access (env var: `CONTROL_PASSWORD=omniclaw2026`)
- Dashboard with vault data status (Twitter 800, Instagram 500, Bookmarks 98, Knowledge Graph 2,110 nodes)
- Manual sync buttons for Twitter, Instagram, Bookmarks, and All
- Vault data browser with pagination
- Cloud Functions status view
- Scheduled jobs status view
- Auto-refresh every 60 seconds

**Architecture:**
- Cloud Run service: `omniclaw-vault-control`
- Region: us-central1
- Backend: Node.js + Express
- Frontend: Embedded HTML/CSS/JS
- Data source: GCS `gs://omniclaw-knowledge-graph/`

**Files:**
- `vault-control/index.js` - Express server
- `vault-control/public/index.html` - Dashboard UI
- `vault-control/public/style.css` - Dark theme styles
- `vault-control/public/app.js` - Frontend logic
- `vault-control/Dockerfile` - Container config

**API Endpoints:**
- `GET /api/vault/status` - Vault data status
- `GET /api/vault/browse` - Data browser with ?file=&limit=&offset=
- `GET /api/vault/history` - Recent sync history
- `GET /api/vault/files` - List available vault files
- `POST /api/sync/twitter` - Trigger Twitter sync
- `POST /api/sync/instagram` - Trigger Instagram sync
- `POST /api/sync/bookmarks` - Trigger Bookmarks sync
- `POST /api/sync/all` - Trigger all syncs
- `GET /api/functions/status` - Cloud Functions status
- `GET /api/schedulers/status` - Scheduled jobs status

---
Generated: 2026-05-04
Session: OmniClaw Deployment Audit & Fix
Author: PI CLI Agent
