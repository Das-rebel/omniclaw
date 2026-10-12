# Omniclaw Memory Architecture V3: Implementation Roadmap

**Date:** 2026-07-30
**Status:** Ready for Implementation
**Unanimous Vote:** 5/5 agent council members

---

## Executive Summary

Three memory architecture improvements that transform Omniclaw from a conversational bot into a **persistent AI companion** that learns, remembers, and reasons about your life over time.

---

## Feature 1: Graphiti-Style Temporal Memory

### What It Is
A time-aware knowledge graph where conversation events are nodes with temporal edges. Enables queries like:
- "What did we discuss about project X last week?"
- "What have we never talked about?"
- "When was the last time we discussed Y?"

### Architecture
```
User Message → Time Encoder → Graph Node
                              ↓
                    Temporal Edge (when)
                              ↓
                    Knowledge Graph (SQLite)
```

### Implementation Steps

**Phase 1.1: Graph Schema**
```sql
CREATE TABLE conversation_nodes (
  id INTEGER PRIMARY KEY,
  user_id TEXT,
  content TEXT,
  timestamp DATETIME,
  embedding BLOB,  -- for semantic search
  node_type TEXT DEFAULT 'message'  -- message, fact, topic
);

CREATE TABLE conversation_edges (
  id INTEGER PRIMARY KEY,
  from_node INTEGER,
  to_node INTEGER,
  edge_type TEXT,  -- 'mentions', 'related_to', 'follows'
  timestamp DATETIME,
  FOREIGN KEY (from_node) REFERENCES conversation_nodes(id),
  FOREIGN KEY (to_node) REFERENCES conversation_nodes(id)
);

CREATE INDEX idx_nodes_timestamp ON conversation_nodes(timestamp);
CREATE INDEX idx_edges_from ON conversation_edges(from_node);
CREATE INDEX idx_edges_to ON conversation_edges(to_node);
```

**Phase 1.2: Time-Aware Query Engine**
- `get_recent_context(hours=24)` - Last N hours of conversation
- `get_topic_history(topic, limit=5)` - Past discussions about topic
- `get_never_discussed()` - Topics in user profile but never discussed
- `get_temporal_graph(user_query)` - Graph traversal from query

**Phase 1.3: Integration with现有 Bot**
- After each conversation, extract facts and add to graph
- On new query, retrieve relevant context from graph
- Update edges when topics are mentioned together

---

## Feature 2: TencentDB-Style Layered Memory

### What It Is
Four-tier memory hierarchy, each level serving different purpose:

| Layer | Name | What it stores | Retention | Query |
|-------|------|----------------|-----------|-------|
| L0 | Raw Logs | Immutable JSONL of every message | Forever | Rarely |
| L1 | Facts | Structured extractions (name, pref, commitment) | Forever | Often |
| L2 | Scenes | Markdown summaries of conversations | 90 days | Sometimes |
| L3 | Persona | Synthesized user model | Until updated | Every query |

### Schema

**L0: Raw Logs**
```sql
CREATE TABLE raw_logs (
  id INTEGER PRIMARY KEY,
  timestamp DATETIME,
  source TEXT,  -- 'whatsapp', 'telegram', etc
  direction TEXT,  -- 'incoming', 'outgoing'
  raw_content TEXT,
  metadata TEXT  -- JSON
);
```

**L1: Facts**
```sql
CREATE TABLE facts (
  id INTEGER PRIMARY KEY,
  fact_type TEXT,  -- 'name', 'preference', 'commitment', 'schedule'
  subject TEXT,
  predicate TEXT,
  object TEXT,
  confidence REAL DEFAULT 1.0,
  source_node INTEGER,  -- L0 reference
  created_at DATETIME,
  expires_at DATETIME
);
```

**L2: Scenes**
```sql
CREATE TABLE scenes (
  id INTEGER PRIMARY KEY,
  title TEXT,  -- "Discussion about project timeline"
  summary TEXT,  -- Markdown
  start_time DATETIME,
  end_time DATETIME,
  participants TEXT,  -- JSON array
  key_topics TEXT,  -- JSON array
  key_outcomes TEXT  -- JSON array
);
```

**L3: Persona**
```sql
CREATE TABLE persona (
  id INTEGER PRIMARY KEY,
  dimension TEXT,  -- 'communication_style', 'topics_of_interest', 'goals'
  value TEXT,  -- The synthesized value
  evidence TEXT,  -- Supporting facts/scnes
  confidence REAL,
  updated_at DATETIME
);
```

### Extraction Pipeline
```
New Message → L0 Writer → Fact Extractor → L1 Updater
                            ↓
                      Scene Detector (every 10 messages or hour)
                            ↓
                      L2 Writer → Periodic Persona Synthesizer → L3 Updater
```

---

## Feature 3: MCP Server (Model Context Protocol)

### What It Is
Expose Omniclaw tools via MCP protocol so any LLM can use them:
- Claude Code, Cursor, Windsurf
- Any MCP-compatible AI assistant

### MCP Resources

| Resource | URI | Description |
|----------|-----|-------------|
| Vault Search | `vault://search?q={query}` | Search bookmarks |
| User Context | `vault://context` | Current user profile |
| Recent History | `vault://history?limit=10` | Recent conversations |
| Memories | `vault://memories/{topic}` | Facts about topic |

### MCP Tools

| Tool | Input | Output |
|------|-------|--------|
| `vault_search` | query: string, limit: int | Bookmarks |
| `vault_add` | url, title, content, tags | Created ID |
| `context_get` | topic?: string | User facts/scene |
| `memory_add` | fact_type, subject, predicate, object | Created ID |
| `reminder_schedule` | when, message | Scheduled ID |

### Server Implementation
```python
# mcp_server.py
from mcp.server import Server
import asyncio

server = Server("omniclaw-memory")

@server.list_resources()
async def list_resources():
    return [
        Resource(uri="vault://search", name="Vault Search"),
        Resource(uri="vault://context", name="User Context"),
        ...
    ]

@server.call_tool()
async def call_tool(name, arguments):
    if name == "vault_search":
        return await search_vault(arguments["query"])
    ...
```

### Deployment
- Run on port 8091 alongside WhatsApp bot
- GreenAPI webhooks continue to work normally
- New endpoint: `http://159.65.10.49:8091/mcp`

---

## Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Design unified schema (merge existing vault with L0-L3)
- [ ] Implement L0 raw log writer
- [ ] Implement L1 fact extractor (prompt-based)
- [ ] Test fact extraction accuracy

### Phase 2: Temporal Graph (Week 2)
- [ ] Implement graph schema
- [ ] Build time-aware query engine
- [ ] Integrate with existing bot
- [ ] Add temporal edges automatically

### Phase 3: Scene & Persona (Week 3)
- [ ] Implement scene detector
- [ ] Build L2 summary generator
- [ ] Implement L3 persona synthesizer
- [ ] Periodic background updates

### Phase 4: MCP Server (Week 4)
- [ ] Implement MCP protocol server
- [ ] Expose all tools/resources
- [ ] Test with Claude Code / Cursor
- [ ] Documentation for external usage

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Fact extraction accuracy | >85% |
| Graph query latency | <100ms |
| MCP tool call success | >99% |
| Memory retrieval relevance (user rating) | >4/5 |

---

## Dependencies

- Existing vault.db (preserve during migration)
- LLM API (for fact extraction, scene detection)
- WhatsApp bot running on port 8090

## Risks

1. **Schema migration** - Existing vault data needs migration
2. **LLM cost** - Fact extraction adds per-message latency/cost
3. **Storage growth** - L0 logs grow indefinitely → implement archival

---

## Next Steps

1. ✅ Approve this plan
2. Create vertical slices (issues)
3. Implement Phase 1.1 (schema design)
4. Test on scraper droplet before production
