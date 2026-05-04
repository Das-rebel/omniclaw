# OmniClaw Architecture Decisions

## AI Provider Strategy

### Decision: Use Z.ai Proxy for Claude
**Date:** 2026-05-04
**Status:** Active

The Claude integration uses the Z.ai proxy at `https://api.z.ai/api/anthropic/messages` rather than direct Anthropic API.

**Rationale:**
- Z.ai provides unified API access with better reliability
- ANTHROPIC_API_KEY is not needed when using Z.ai proxy
- ZAI_API_KEY is already configured in the environment

**Implementation:**
- `infrastructure/cloud-functions/deploy/resilient-clients.js` — AnthropicClient
- `clients/glm_client.js` — Direct Z.ai usage
- `clients/unified_glm_client_v2.js` — Z.ai with retry logic

### Decision: Fallback Chain Order
**Date:** 2026-05-04
**Status:** Active

Fallback order: Groq → Cerebras → Anthropic (Z.ai)

**Rationale:**
- Groq is fastest and cheapest for simple queries
- Cerebras provides backup if Groq fails
- Claude via Z.ai is best quality but slowest

## Scraper Architecture

### Decision: Cookie-Based Auth for Both Twitter and Instagram
**Date:** 2026-05-04
**Status:** Active

Both Twitter and Instagram scrapers use cookie-based authentication stored in GCS.

**Pattern:**
1. Cookies extracted from browser via DevTools
2. Uploaded to `gs://omniclaw-knowledge-graph/vault/cookies/`
3. Scraper loads cookies from GCS at runtime
4. Fresh cookies refresh the session automatically

**Why not password login:**
- Twitter: twscrape password login blocked by Cloudflare on GCP IPs
- Instagram: instagrapi password login triggers challenges

### Decision: Twitter — httpx + twscrape GQL (Not AccountsPool)
**Date:** 2026-05-04
**Status:** Active

Instead of using twscrape's `AccountsPool` with password login, we inject cookies directly into an httpx AsyncClient using twscrape's GraphQL query IDs.

**Rationale:**
- AccountsPool triggers Cloudflare on GCP IPs
- Direct cookie injection works with existing authenticated session
- twscrape's query IDs and features are kept up-to-date by the library

### Decision: Instagram — instagrapi with Cookie Injection
**Date:** 2026-05-04
**Status:** Active

Uses `set_settings({"cookies": cookies})` on instagrapi Client to load cookies from GCS.

**Note:** `collection_items()` was removed in instagrapi 2.x. Use `collection_medias(collection_pk, amount=N)`.

## Vault Data Architecture

### Decision: Separate Source Files + Merged Aggregates
**Date:** 2026-05-04
**Status:** Active

Source files are kept separate and merged into aggregate files:

| Source | File |
|--------|------|
| Twitter raw | vault/twitter_bookmarks_automated.json |
| Instagram raw | vault/instagram_saved_automated.json |
| Browser raw | vault/browser_bookmarks.json |
| Merged all | vault/bookmarks_automated.json |
| KG | unified_knowledge_graph.json |

### Decision: GCS as Single Source of Truth
**Date:** 2026-05-04
**Status:** Active

All vault data lives in GCS bucket `gs://omniclaw-knowledge-graph/`. Local VM is just a sync target.

## Known Fragilities

### Twitter Query ID Drift
Twitter changes their GraphQL query IDs periodically. When `GraphQL returned HTTP 404`, the query ID has changed.

**Current query approach:** Cookie-injected httpx using twscrape's internal query ID and features (which auto-updates with the library).

### Instagram Challenge Risk
instagrapi may trigger challenges if requests look suspicious. Mitigation:
- Realistic user-agent
- Cookie-based session (not password)
- Reasonable request delays

### Double-Encoding Bug (HISTORICAL)
**Date:** 2026-05-04 (introduced ~May 1, fixed May 4)
**Issue:** `json.dumps(posts)` where posts was already a JSON string → double-encoded storage

This was caused by inconsistent handling where `posts` was serialized separately then the whole object was serialized again.
