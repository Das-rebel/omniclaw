# OmniClaw Deployment Status — May 12, 2026

## Executive Summary
- **Vault Search**: Fully operational with Twitter + Instagram results
- **FAISS Index**: 7,899 CLIP vectors (was 2,037 Instagram-only)
- **Twitter Sync**: 800 fresh bookmarks fetched with new cookies
- **Cloud Run**: `serve-vault-search-00004-bjh` deployed and serving

## What Changed Since May 4

### 1. Vault Search Now Includes Twitter (May 12)
**Problem:** `keyword_search()` in `serve_vault_search.py` filtered `WHERE type='instagram_post'` — Twitter tweets were completely excluded from keyword search results.

**Fix:** Changed to `WHERE type IN ('instagram_post', 'twitter_tweet')`

**File changed:** `infrastructure/cloud-functions/deploy/serve_vault_search.py` line 175

### 2. vlTags Crash Fixed (May 12)
**Problem:** Non-string vlTags (dicts, bools, None) crashed keyword search with `TypeError: sequence item 0: expected str instance`

**Fix:** `tags = ' '.join(str(t) for t in meta.get('vlTags', [])).lower()`

### 3. source Field Added to API Responses (May 12)
**Problem:** API responses had no `source` field — Telegram bot couldn't show 🐦/📷 icons.

**Fix:** Both `semantic_search()` and `keyword_search()` now return `'source': 'twitter'` or `'source': 'instagram'` per result.

### 4. Twitter Cookies Refreshed (May 12)
**Problem:** auth_token `27711f88095d8b15958e744f15aaa19f4e097928` expired (HTTP 401)

**Fix:** New cookies uploaded to `gs://omniclaw-knowledge-graph/vault/cookies/twitter_cookies.json`
- auth_token: `867b402e2ab7138e6c328625d633b3c118593bae`
- ct0: `493a931c1897f84e045b5d1a8eac3d8e3f21c8556bff3886faf85c891d68ad1db86fd314dfcaead216b1912ae681a3ac0a7aa26e9a7a0703aa0e13a0db9ab0f400aede5a5900662a8dae08813a23e69b`
- twid: `335549747`
- Query ID confirmed working: `-LGfdImKeQz0xS_jjUwzlA`

**Result:** 800 fresh bookmarks fetched and uploaded to GCS

### 5. FAISS Index Expanded to Include Twitter (May 12)
**Problem:** FAISS index had only 2,037 Instagram image embeddings, no Twitter vectors

**Fix:** Built CLIP **text** embeddings for all 5,862 Twitter tweets (CLIP supports text encoding)
- Used text from `name` + `vlTags` + `categories` fields
- Encoded in batches of 64 at ~45/sec
- Total: 7,899 vectors (2,037 Instagram + 5,862 Twitter)
- FAISS file: 23MB (was 6MB)

**Files updated:**
- `learning_base/clip.faiss` (23MB)
- `learning_base/clip_ids.json` (180KB)
- `learning_base/vault.db` (40MB)

**GCS:** All three uploaded to `gs://omniclaw-knowledge-graph/deploy/learning_base/`

**Container build:** Dockerfile downloads these from GCS during build (`curl -sL https://storage.googleapis.com/...`)

### 6. serve-vault-search Deployed (May 12)
**Revision:** `serve-vault-search-00004-bjh`
**URL:** https://serve-vault-search-338789220059.asia-south1.run.app
**Changes:**
- vlTags crash fixed
- Twitter tweets included in keyword search
- `source` field added to all results
- Learning base updated from GCS (7,899 FAISS vectors)

---

## Architecture Overview (Updated May 12)

```
┌──────────────────────────────────────────────────────────────┐
│                    OmniClaw Vault Pipeline                   │
│                                                               │
│  Sources                 GCS                    Cloud Run      │
│  ───────                 ───                    ─────────      │
│                                                               │
│  Twitter ──── GQL ──► vault/twitter_bookmarks_automated.json │
│  (800 bm)               (auth_token + -LGfdImKeQz0xS_jjUwzlA) │
│                             │                                 │
│  Instagram ─── instagrapi ─► vault/instagram_saved.json (500)│
│  (500 posts)                    │                             │
│                                ▼                             │
│                    learning_base/                           │
│                    ├─ vault.db (40MB)                       │
│                    │   6,187 twitter + 2,037 instagram      │
│                    ├─ clip.faiss (23MB)                     │
│                    │   7,899 CLIP vectors                   │
│                    │   (2,037 ig images + 5,862 tw text)   │
│                    └─ clip_ids.json (180KB)                  │
│                              │                               │
│                              ▼                               │
│                  serve_vault_search.py                       │
│                  ├─ semantic_search() → FAISS + CLIP        │
│                  └─ keyword_search() → SQLite full-text     │
│                              │                               │
│                              ▼                               │
│  Telegram ──── /vault ──► 🐦 Twitter + 📷 Instagram results  │
│  Auto-search ─────────► 🔍 Same unified results              │
└──────────────────────────────────────────────────────────────┘
```

---

## Cloud Run Services

| Service | Revision | URL | Status |
|---------|----------|-----|--------|
| **serve-vault-search** | 00004-bjh | https://serve-vault-search-338789220059.asia-south1.run.app | ✅ ACTIVE |
| **dasomni-bot** | (prev) | https://dasomni-bot-338789220059.asia-south1.run.app | ✅ ACTIVE |
| **vault-control** | (prev) | https://omniclaw-vault-control-338789220059.us-central1.run.app | ✅ ACTIVE |

---

## Vault Data Status (May 12)

| Source | Bookmarks | FAISS Vector | Notes |
|--------|-----------|--------------|-------|
| Twitter | 6,187 | 5,862 text embeddings | +800 fresh from today's sync |
| Instagram | 2,037 | 2,037 image embeddings | Unchanged |
| **Total** | **8,224** | **7,899** | |

### FAISS Index
- **Total vectors:** 7,899
- **Instagram:** 2,037 (CLIP image embeddings from thumbnails)
- **Twitter:** 5,862 (CLIP text embeddings from name + vlTags)
- **Dimensions:** 768 (clip-vit-large-patch14)

### Semantic Search Quality
Twitter tweets use **text embeddings** (CLIP encodes the tweet text directly), not image thumbnails. This means:
- Text queries like "drone", "AI agent", "protein recipes" return Twitter results
- Image queries (future) would only match Instagram posts
- Both sources are searchable via semantic similarity

---

## serve_vault_search.py API

### Endpoints

| Endpoint | Mode | Sources | Returns |
|----------|------|---------|---------|
| `GET /search?q=...&mode=keyword` | keyword | Twitter + Instagram | 10 results, scored by term frequency |
| `GET /search?q=...&mode=semantic` | semantic | Twitter + Instagram | 10 results, CLIP cosine similarity |
| `GET /search?q=...` (default) | auto | Twitter + Instagram | semantic → keyword fallback |
| `GET /health` | - | - | FAISS count, CLIP loaded status |
| `GET /stats` | - | - | Total nodes, has_clip, has_location |

### Response Format
```json
{
  "query": "machine learning",
  "total": 10,
  "results": [
    {
      "rank": 1,
      "id": "1990229238449102951",
      "name": "Introducing Karpathy: An Agentic Machine Learning Engineer",
      "caption": "...",
      "url": "https://x.com/...",
      "source": "twitter",
      "score": 12.0,
      "vlTags": ["robotics", "machines", "code"],
      "location": "",
      "colabSummary": ""
    }
  ]
}
```

### Telegram Formatting
```
🔍 Vault: "machine learning" (10 results)

🐦 Introducing Karpathy: An Agentic Machine Learning 
  "Introducing Karpathy: An Agentic Machine Learning Engineer..."
  🏷 robotics, machines, code, screens

📷 Review and overview of the Sekoza dryer machine
  🏷 food dehydrator, dryer machine, drying performance
```

---

## Twitter Sync Pipeline

### How It Works
1. Load cookies from `gs://omniclaw-knowledge-graph/vault/cookies/twitter_cookies.json`
2. Create httpx AsyncClient with auth_token + ct0 cookies
3. Call `https://x.com/i/api/graphql/-LGfdImKeQz0xS_jjUwzlA/Bookmarks`
4. Paginate with cursor until 800 bookmarks or end
5. Upload to `gs://omniclaw-knowledge-graph/vault/twitter_bookmarks_automated.json`
6. `ingest_twitter.py` loads into vault.db

### Current Status
- ✅ Auth works: `auth_token=867b402e2ab7138e6c328625d633b3c118593bae`
- ✅ Query ID works: `-LGfdImKeQz0xS_jjUwzlA` (Twitter hasn't rotated it)
- ✅ 800 bookmarks fetched
- ✅ Ingested into vault.db (6,187 total twitter bookmarks)

### Cloud Function
- **Function:** `twitter-sync` (Cloud Run, NOT Cloud Functions)
- **URL:** https://twitter-sync-o36e7noe5a-el.a.run.app
- **Timeout:** 300s (50s was too short, got truncated at ~300 bookmarks)

---

## Instagram Sync Pipeline

### How It Works
1. instagrapi loads session from `vault/cookies/instagram_cookies.json`
2. Calls `collection_medias()` for saved posts
3. Results uploaded to `gs://omniclaw-knowledge-graph/vault/instagram_saved_automated.json`
4. `ingest_instagram.py` loads into vault.db

### Current Status
- ✅ instagrapi session works (challenge_required avoided)
- ✅ 500 posts synced (May 12)
- ⚠️ Cookie session expires periodically — may need refresh

---

## Key Files

| File | Purpose |
|------|---------|
| `serve_vault_search.py` | Flask server + semantic/keyword search |
| `learning_base/vault.db` | SQLite with 8,224 bookmarks |
| `learning_base/clip.faiss` | FAISS index with 7,899 vectors |
| `learning_base/clip_ids.json` | Vector ID mapping |
| `ingest_twitter.py` | Twitter → vault.db pipeline |
| `ingest_instagram.py` | Instagram → vault.db pipeline |

---

## Useful Commands

```bash
# Test vault search
curl "https://serve-vault-search-338789220059.asia-south1.run.app/search?q=machine%20learning&limit=5"

# Test semantic search
curl "https://serve-vault-search-338789220059.asia-south1.run.app/search?q=drone&mode=semantic&limit=5"

# Check FAISS health
curl "https://serve-vault-search-338789220059.asia-south1.run.app/health"

# Test Twitter sync
curl -X POST "https://twitter-sync-o36e7noe5a-el.a.run.app/" -H "Content-Type: application/json" -d '{"send_summary": true}'

# Check GCS vault files
gsutil ls gs://omniclaw-knowledge-graph/vault/

# Ingest Twitter bookmarks locally
cd ~/omniclaw/services/vault-pipeline && python ingest_twitter.py

# Rebuild FAISS locally
python3 -c "
import json, sqlite3, torch, faiss, numpy as np
from transformers import CLIPProcessor, CLIPModel

# ... (see extract_clip_local.py for full code)
"
```

---

## Previous Issues (May 4) — Status

| Issue | Status | Notes |
|-------|--------|-------|
| alexaHandler orphaned | ✅ Fixed May 4 | - |
| Claude missing | ✅ Fixed May 4 | - |
| Cloud Run CPU conflict | ✅ Fixed May 4 | - |
| Twitter GQL query ID stale | ✅ Fixed May 12 | - |
| Twitter cookies stale | ✅ Fixed May 12 | Refreshed with new auth_token |
| Instagram double-encoding | ✅ Fixed May 4 | - |
| Instagram session validation | ✅ Stable | - |
| instagram-vault-scheduler UNKNOWN | ✅ Fixed May 4 | - |
| Bookmarks data stale | ✅ Fixed May 12 | 800 fresh twitter, 500 instagram |
| Knowledge Graph stale | ✅ Partially | vault.db updated, unified_knowledge_graph.json older |
| daily-summary.sh date parsing | ✅ Fixed May 4 | - |
| Instagram cookie expiry | ⚠️ Ongoing | Need monitoring |
| Bookmark processor GCS | ⚠️ Pending | - |
| KG build not scheduled | ⚠️ Pending | - |

---

## New Issues (May 12)

### 1. unified_knowledge_graph.json Not Updated
**Status:** ⚠️ P2
**Problem:** Last built May 10, has 8,214 items from migration. Not rebuilt with new Twitter data.
**Fix needed:** Run knowledge graph builder to incorporate latest vault.db data

### 2. vault_url_lookup.json Not Updated  
**Status:** ⚠️ P2
**Problem:** URL lookup table (16,426 entries) still points to old GCS paths
**Fix needed:** Rebuild with current vault.db URLs

### 3. CLIP Index Uses Mixed Encoding
**Status:** ℹ️ Info
**Note:** Instagram uses image embeddings (thumbnail photos), Twitter uses text embeddings (tweet text). This is intentional — CLIP supports both modes. Results may be heterogeneous in semantic search.

---

Generated: 2026-05-12
Author: PI CLI Agent