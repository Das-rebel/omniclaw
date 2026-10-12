import json
import sqlite3
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

PORT = 8091
VAULT_DB = "/opt/vault-sync/vault.db"
MEMORY_DB = "/opt/vault-sync/memory.db"

def search_vault(query, limit=10):
    conn = sqlite3.connect(VAULT_DB)
    c = conn.cursor()
    q = f'%{query}%'
    c.execute('''
        SELECT id, source, title, content, url, bookmarked_at
        FROM bookmarks WHERE is_active = 1 AND (title LIKE ? OR content LIKE ?)
        ORDER BY bookmarked_at DESC LIMIT ?
    ''', (q, q, limit))
    rows = c.fetchall()
    conn.close()
    return [{'id': r[0], 'source': r[1], 'title': r[2], 'content': r[3][:200] if r[3] else '', 
             'url': r[4], 'bookmarked': r[5]} for r in rows]

def get_vault_stats():
    conn = sqlite3.connect(VAULT_DB)
    c = conn.cursor()
    c.execute('SELECT source, COUNT(*) FROM bookmarks WHERE is_active = 1 GROUP BY source')
    sources = dict(c.fetchall())
    c.execute('SELECT COUNT(*) FROM bookmarks WHERE is_active = 1')
    total = c.fetchone()[0]
    conn.close()
    return {'total': total, 'by_source': sources}

def get_memory_context(topic=None):
    conn = sqlite3.connect(MEMORY_DB)
    c = conn.cursor()
    c.execute('SELECT dimension, value FROM persona')
    persona = dict(c.fetchall())
    c.execute('SELECT subject, predicate, object FROM facts WHERE is_active = 1 ORDER BY created_at DESC LIMIT 20')
    facts = [{'subject': r[0], 'predicate': r[1], 'object': r[2]} for r in c.fetchall()]
    c.execute('SELECT title, summary, start_time FROM scenes ORDER BY start_time DESC LIMIT 5')
    scenes = [{'title': r[0], 'summary': r[1][:100], 'time': r[2]} for r in c.fetchall()]
    conn.close()
    return {'persona': persona, 'facts': facts, 'scenes': scenes}

def add_memory_log(source, direction, content, metadata=None):
    try:
        conn = sqlite3.connect(MEMORY_DB)
        c = conn.cursor()
        c.execute('INSERT INTO raw_logs (source, direction, raw_content, metadata) VALUES (?, ?, ?, ?)',
                  (source, direction, content, json.dumps(metadata) if metadata else None))
        log_id = c.lastrowid
        conn.commit()
        conn.close()
        return {'success': True, 'id': log_id}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def add_memory_fact(fact_type, subject, predicate, obj=None):
    try:
        conn = sqlite3.connect(MEMORY_DB)
        c = conn.cursor()
        c.execute('INSERT INTO facts (fact_type, subject, predicate, object, confidence) VALUES (?, ?, ?, ?, 0.8)',
                  (fact_type, subject, predicate, obj))
        fact_id = c.lastrowid
        conn.commit()
        conn.close()
        return {'success': True, 'id': fact_id}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def update_persona(dimension, value):
    try:
        conn = sqlite3.connect(MEMORY_DB)
        c = conn.cursor()
        c.execute('''INSERT INTO persona (dimension, value, confidence, updated_at)
            VALUES (?, ?, 0.6, CURRENT_TIMESTAMP)
            ON CONFLICT(dimension) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP''',
                  (dimension, value))
        conn.commit()
        conn.close()
        return {'success': True}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def get_memory_stats():
    conn = sqlite3.connect(MEMORY_DB)
    c = conn.cursor()
    c.execute('SELECT COUNT(*) FROM raw_logs'); l0 = c.fetchone()[0]
    c.execute('SELECT COUNT(*) FROM facts WHERE is_active = 1'); l1 = c.fetchone()[0]
    c.execute('SELECT COUNT(*) FROM scenes'); l2 = c.fetchone()[0]
    c.execute('SELECT COUNT(*) FROM persona'); l3 = c.fetchone()[0]
    conn.close()
    return {'L0_raw': l0, 'L1_facts': l1, 'L2_scenes': l2, 'L3_persona': l3}

class MCPHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == '/health':
            self.send_json({'status': 'ok', 'service': 'omniclaw-mcp'})
        elif path == '/vault/search':
            q = query.get('q', [''])[0]
            limit = int(query.get('limit', [10])[0])
            self.send_json({'query': q, 'results': search_vault(q, limit)})
        elif path == '/vault/stats':
            self.send_json(get_vault_stats())
        elif path == '/memory/context':
            topic = query.get('topic', [None])[0]
            self.send_json(get_memory_context(topic))
        elif path == '/memory/stats':
            self.send_json(get_memory_stats())
        else:
            self.send_error(404)
    
    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        cl = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(cl).decode() if cl > 0 else '{}'
        data = json.loads(body) if body else {}
        if path == '/memory/log':
            self.send_json(add_memory_log(data.get('source'), data.get('direction'),
                         data.get('content'), data.get('metadata')))
        elif path == '/memory/fact':
            self.send_json(add_memory_fact(data.get('type'), data.get('subject'),
                         data.get('predicate'), data.get('object')))
        elif path == '/memory/persona':
            self.send_json(update_persona(data.get('dimension'), data.get('value')))
        else:
            self.send_error(404)
    
    def send_json(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    def log_message(self, format, *args):
        pass

def start_server(port=PORT):
    server = HTTPServer(('0.0.0.0', port), MCPHandler)
    print(f'MCP Server running on port {port}')
    server.serve_forever()

if __name__ == '__main__':
    start_server()
