-- Memory V3 Schema: L0-L3 tables with temporal graph structure

-- L0: Raw Logs (append-only event store)
CREATE TABLE IF NOT EXISTS l0_raw_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    timestamp DATETIME NOT NULL,
    raw_input TEXT NOT NULL,
    raw_output TEXT,
    provider_used TEXT,
    cost DECIMAL(10,2)
);

-- L1: Facts (structured entity extraction from L0 logs)
CREATE TABLE IF NOT EXISTS l1_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_type TEXT NOT NULL,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT,
    confidence REAL NOT NULL DEFAULT 0.8,
    source_node TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
);

-- L2: Scenes (cross-session narrative reconstruction)
CREATE TABLE IF NOT EXISTS l2_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT,
    retrieved_facts TEXT, -- JSON array of fact IDs
    reconstructed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    session_ids TEXT[]
);

-- L3: Persona (temporal knowledge graph / persona state)
CREATE TABLE IF NOT EXISTS l3_persona (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dimension TEXT NOT NULL,
    value TEXT,
    confidence REAL DEFAULT 0.6,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON l0_raw_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_l0_session ON l0_raw_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_l1_fact_type ON l1_facts(fact_type);
CREATE INDEX IF NOT EXISTS idx_l2_query ON l2_scenes(query);
CREATE INDEX IF NOT EXISTS idx_l3_dimension ON l3_persona(dimension);
