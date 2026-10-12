# Graphiti v3-Memory — Phase 1 (Foundation) — Vertical Slice

Backbone: Graphiti (3 vault saves validated, including @_avichawla MCP stack tweet)
Source doc: docs/planning/omniclaw-memory-v3-roadmap.md
Status: Phase 1.4 in progress (of 4)

## Schema Design (merge existing vault + L0-L3)

L0 — Raw Log (new table `l0_raw_logs`):
- id, timestamp (UTC, date('now')), source (whatsapp/twitter/ig), raw_json, session_ref, ttl_days
- Writer: append-only, no updates, 30-day TTL, PRAGMA checkpoint after insert

L1 — Fact Extractor (table `l1_facts` — extends existing `nodes` / `relationships`):
- id, entity_name, fact_text (≤200 chars), source_ids (array of bookmark ids), confidence (0-1), extracted_at
- Source: vault.db nodes (17874 nodes existing) + bookmark content
- Links to L0 by session_ref

L2 — Summary (table `l2_summaries`):
- id, time_window_start/end, theme_chain (theme + angles from build_brief v3), key_facts (L1 refs), summary_text (≤500 chars)
- Source: build_brief.py v3 theme output + top picks by engagement_score

L3 — Persona / Scene (table `l3_persona`):
- id, scene_type (work/life/learning/health), persona_snapshot, temporal_edges (L1→L2→L3)
- Source: recurring author patterns (author_history) + session context

## Migration (preserve vault.db)
- Add tables (NOT ALTER existing): l0_raw_logs, l1_facts, l2_summaries, l3_persona
- Copy nodes (17874) + relationships (26538) + bookmarks_tags (121693) unchanged
- Preserve sync_log (59 entries) — all state references stay

## Phase 1.1 Deliverable (this slice) ✅
- [x] Design unified schema (this file)
- [x] Identify Graphiti as backbone (3 saves validated vs LightRAG 0)
- [x] Create SQL schema (CREATE TABLE — safe, doesn't drop vault)
- [x] L0 writer: insert from latest brief / DM / bookmark events
- [x] L1 extractor: first pass from 2,018 filled IG + 7,523 other bookmarks
- [x] Test: graph query via sqlite-vec (or plain SQL join L1-L2)

## Phase 1.2 Deliverable ✅
- [x] L1 fact extractor v2 (cleaner extraction, min_conf=0.70)
- [x] Run on 1000 bookmarks, validated: 2,327 facts, avg_conf=0.73

## Phase 1.3 Deliverable ✅
- [x] L2 summary generator (reads build_brief v3 theme + L1 facts)
- [x] First summary inserted (1 row, theme=omniclaw vault sync)

## Phase 1.4 Deliverable (in progress)
- [ ] L3 persona generator (scene_type: work/life/learning/health)
- [ ] MCP server stub (port 8091, exposes l0/l1/l2/l3)

## Phase 2 (Temporal Graph) (next — NOT started)
- [ ] Temporal edges in relationships (L1→L2→L3)
- [ ] Time-aware query engine
- [ ] Integration with existing bot

## Phase 3 — Scene & Persona (NOT started)
- [ ] Scene detector
- [ ] L2 summary generator (done — see Phase 1.3)
- [ ] L3 persona synthesizer
- [ ] Periodic background updates

## Phase 4 — MCP Server (NOT started)
- [ ] Implement MCP protocol server
- [ ] Expose all tools/resources
- [ ] Test with Claude Code / Cursor
- [ ] Documentation for external usage