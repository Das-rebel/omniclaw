"""
Layered Memory Architecture for Omniclaw
L0: Raw Logs (immutable JSONL)
L1: Facts (structured extractions)
L2: Scenes (conversation summaries)
L3: Persona (synthesized user model)
"""

import sqlite3
import json
import os
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

class LayeredMemory:
    """Four-tier memory hierarchy"""
    
    DB_PATH = "/opt/vault-sync/memory.db"
    
    def __init__(self, db_path: str = None):
        self.db_path = db_path or self.DB_PATH
        self._init_schema()
    
    def _init_schema(self):
        """Initialize layered memory schema"""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        
        # L0: Raw Logs
        c.execute('''
            CREATE TABLE IF NOT EXISTS raw_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                source TEXT NOT NULL,
                direction TEXT NOT NULL,
                raw_content TEXT NOT NULL,
                metadata TEXT,
                user_id TEXT DEFAULT 'default'
            )
        ''')
        
        # L1: Facts
        c.execute('''
            CREATE TABLE IF NOT EXISTS facts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fact_type TEXT NOT NULL,
                subject TEXT NOT NULL,
                predicate TEXT NOT NULL,
                object TEXT,
                confidence REAL DEFAULT 1.0,
                source_log_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME,
                is_active INTEGER DEFAULT 1,
                FOREIGN KEY (source_log_id) REFERENCES raw_logs(id)
            )
        ''')
        
        # L2: Scenes
        c.execute('''
            CREATE TABLE IF NOT EXISTS scenes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                summary TEXT NOT NULL,
                start_time DATETIME NOT NULL,
                end_time DATETIME,
                participants TEXT,
                key_topics TEXT,
                key_outcomes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # L3: Persona
        c.execute('''
            CREATE TABLE IF NOT EXISTS persona (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dimension TEXT NOT NULL,
                value TEXT NOT NULL,
                evidence TEXT,
                confidence REAL DEFAULT 0.5,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(dimension)
            )
        ''')
        
        # Temporal Graph
        c.execute('''
            CREATE TABLE IF NOT EXISTS conversation_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT DEFAULT 'default',
                content TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                embedding BLOB,
                node_type TEXT DEFAULT 'message'
            )
        ''')
        
        c.execute('''
            CREATE TABLE IF NOT EXISTS conversation_edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_node INTEGER NOT NULL,
                to_node INTEGER,
                edge_type TEXT DEFAULT 'related_to',
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (from_node) REFERENCES conversation_nodes(id)
            )
        ''')
        
        # Indexes
        c.execute('CREATE INDEX IF NOT EXISTS idx_raw_timestamp ON raw_logs(timestamp)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(fact_type)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_nodes_timestamp ON conversation_nodes(timestamp)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_edges_from ON conversation_edges(from_node)')
        
        conn.commit()
        conn.close()
    
    def add_raw_log(self, source: str, direction: str, content: str, 
                    metadata: Dict = None, user_id: str = 'default') -> int:
        """Add a raw message to L0"""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute('''
            INSERT INTO raw_logs (source, direction, raw_content, metadata, user_id)
            VALUES (?, ?, ?, ?, ?)
        ''', (source, direction, content, json.dumps(metadata) if metadata else None, user_id))
        log_id = c.lastrowid
        conn.commit()
        conn.close()
        return log_id
    
    def get_recent_logs(self, hours: int = 24, limit: int = 100) -> List[Dict]:
        """Get recent logs from L0"""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        since = datetime.now() - timedelta(hours=hours)
        c.execute('''
            SELECT id, timestamp, source, direction, raw_content, metadata
            FROM raw_logs
            WHERE timestamp > ? AND user_id = 'default'
            ORDER BY timestamp DESC
            LIMIT ?
        ''', (since.isoformat(), limit))
        rows = c.fetchall()
        conn.close()
        return [
            {
                'id': r[0],
                'timestamp': r[1],
                'source': r[2],
                'direction': r[3],
                'content': r[4],
                'metadata': json.loads(r[5]) if r[5] else {}
            }
            for r in rows
        ]
    
    def add_fact(self, fact_type: str, subject: str, predicate: str, 
                 object: str = None, confidence: float = 1.0,
                 source_log_id: int = None) -> int:
        """Add a fact to L1"""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute('''
            INSERT INTO facts (fact_type, subject, predicate, object, confidence, source_log_id)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (fact_type, subject, predicate, object, confidence, source_log_id))
        fact_id = c.lastrowid
        conn.commit()
        conn.close()
        return fact_id
    
    def get_facts(self, fact_type: str = None, limit: int = 50) -> List[Dict]:
        """Get facts from L1"""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        if fact_type:
            c.execute('''
                SELECT id, fact_type, subject, predicate, object, confidence, created_at
                FROM facts WHERE is_active = 1 AND fact_type = ?
                ORDER BY confidence DESC, created_at DESC LIMIT ?
            ''', (fact_type, limit))
        else:
            c.execute('''
                SELECT id, fact_type, subject, predicate, object, confidence, created_at
                FROM facts WHERE is_active = 1
                ORDER BY confidence DESC, created_at DESC LIMIT ?
            ''', (limit,))
        rows = c.fetchall()
        conn.close()
        return [
            {'id': r[0], 'type': r[1], 'subject': r[2], 'predicate': r[3], 'object': r[4], 'confidence': r[5], 'created_at': r[6]}
            for r in rows
        ]
    
    def search_facts(self, query: str) -> List[Dict]:
        """Search facts by content"""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        q = f'%{query}%'
        c.execute('''
            SELECT id, fact_type, subject, predicate, object, confidence
            FROM facts WHERE is_active = 1 AND (subject LIKE ? OR predicate LIKE ? OR object LIKE ?)
            LIMIT 20
        ''', (q, q, q))
        rows = c.fetchall()
        conn.close()
        return [{'id': r[0], 'type': r[1], 'subject': r[2], 'predicate': r[3], 'object': r[4], 'confidence': r[5]} for r in rows]
    
    def update_persona(self, dimension: str, value: str, evidence: str = None, confidence: float = 0.5) -> bool:
        """Update a persona dimension"""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute('''
            INSERT INTO persona (dimension, value, evidence, confidence, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(dimension) DO UPDATE SET
                value = excluded.value, evidence = excluded.evidence,
                confidence = excluded.confidence, updated_at = CURRENT_TIMESTAMP
        ''', (dimension, value, evidence, confidence))
        conn.commit()
        conn.close()
        return True
    
    def get_persona(self) -> List[Dict]:
        """Get full persona"""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute('SELECT dimension, value, evidence, confidence, updated_at FROM persona')
        rows = c.fetchall()
        conn.close()
        return [{'dimension': r[0], 'value': r[1], 'evidence': r[2], 'confidence': r[3], 'updated': r[4]} for r in rows]
    
    def add_node(self, content: str, node_type: str = 'message', user_id: str = 'default') -> int:
        """Add a node to conversation graph"""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute('INSERT INTO conversation_nodes (user_id, content, node_type, timestamp) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
                  (user_id, content, node_type))
        node_id = c.lastrowid
        conn.commit()
        conn.close()
        return node_id
    
    def get_context_for_query(self, query: str, hours: int = 72) -> str:
        """Get relevant context for a query from all layers"""
        logs = self.get_recent_logs(hours=hours)
        logs_text = '\n'.join([f"[{l['timestamp']}] {l['direction']}: {l['content'][:100]}" for l in logs[:10]])
        
        facts = self.search_facts(query)
        facts_text = '\n'.join([f"• {f['subject']} {f['predicate']} {f['object']}" for f in facts[:5]])
        
        persona = self.get_persona()
        persona_text = '\n'.join([f"• {p['dimension']}: {p['value']}" for p in persona])
        
        return f"""## Recent Context (last {hours}h)
{logs_text or 'No recent messages'}

## Relevant Facts
{facts_text or 'No relevant facts'}

## User Profile
{persona_text or 'No profile yet'}"""
    
    def get_stats(self) -> Dict:
        """Get memory statistics"""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute('SELECT COUNT(*) FROM raw_logs'); l0 = c.fetchone()[0]
        c.execute('SELECT COUNT(*) FROM facts WHERE is_active = 1'); l1 = c.fetchone()[0]
        c.execute('SELECT COUNT(*) FROM scenes'); l2 = c.fetchone()[0]
        c.execute('SELECT COUNT(*) FROM persona'); l3 = c.fetchone()[0]
        c.execute('SELECT COUNT(*) FROM conversation_nodes'); nodes = c.fetchone()[0]
        conn.close()
        return {'L0_raw': l0, 'L1_facts': l1, 'L2_scenes': l2, 'L3_persona': l3, 'graph_nodes': nodes}


if __name__ == '__main__':
    mem = LayeredMemory()
    print("Memory DB initialized")
    print(f"Stats: {mem.get_stats()}")
