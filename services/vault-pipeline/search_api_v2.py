#!/usr/bin/env python3
"""
Enhanced Vault Search API v2
Uses ALL vault metadata: topics, entities, categories, dates
"""

import sqlite3
import json
from flask import Flask, request, jsonify
from datetime import datetime

app = Flask(__name__)
DB = '/opt/vault-search/vault.db'

# ─── Query Builders ─────────────────────────────────────

def search_basic(q, limit=10):
    """Original basic search"""
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute(f"SELECT id, name, content, url FROM nodes WHERE content LIKE '%{q}%' OR name LIKE '%{q}%' LIMIT {limit}")
    rows = cur.fetchall()
    conn.close()
    return [{'id': r[0], 'name': r[1], 'content': (r[2] or '')[:200], 'url': r[3]} for r in rows]

def search_with_filters(q, limit=10, topic=None, entity=None, category=None, after=None, before=None):
    """
    Enhanced search with full metadata filtering
    """
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    
    # Build query dynamically
    conditions = []
    params = []
    
    # Text search
    if q:
        conditions.append("(n.content LIKE ? OR n.name LIKE ?)")
        params.extend([f'%{q}%', f'%{q}%'])
    
    # Topic filter
    if topic:
        conditions.append("""
            n.id IN (
                SELECT r.from_id FROM relationships r 
                JOIN nodes tn ON tn.id = r.to_id 
                WHERE r.type='about_topic' AND tn.name=?
            )
        """)
        params.append(topic)
    
    # Entity filter  
    if entity:
        conditions.append("""
            n.id IN (
                SELECT r.from_id FROM relationships r 
                JOIN nodes en ON en.id = r.to_id 
                WHERE r.type='mentions_entity' AND en.name=?
            )
        """)
        params.append(entity)
    
    # Category filter
    if category:
        conditions.append("""
            id IN (
                SELECT r.from_id FROM relationships r 
                JOIN nodes n ON n.id = r.to_id 
                WHERE r.type='has_category' AND n.name=?
            )
        """)
        params.append(category)
    
    # Date range
    if after:
        conditions.append("timestamp >= ?")
        params.append(after)
    if before:
        conditions.append("timestamp <= ?")
        params.append(before)
    
    # Build SQL
    where_clause = " AND ".join(conditions) if conditions else "1=1"
    query = f"""
        SELECT DISTINCT n.id, n.name, n.content, n.url, n.timestamp, n.type,
               GROUP_CONCAT(DISTINCT t.name) as topics,
               GROUP_CONCAT(DISTINCT e.name) as entities
        FROM nodes n
        LEFT JOIN relationships r_topic ON r_topic.from_id = n.id AND r_topic.type='about_topic'
        LEFT JOIN nodes t ON t.id = r_topic.to_id AND t.type='topic'
        LEFT JOIN relationships r_entity ON r_entity.from_id = n.id AND r_entity.type='mentions_entity'  
        LEFT JOIN nodes e ON e.id = r_entity.to_id AND e.type='entity'
        WHERE {where_clause}
        GROUP BY n.id
        ORDER BY n.timestamp DESC
        LIMIT ?
    """
    params.append(limit)
    
    cur.execute(query, params)
    rows = cur.fetchall()
    conn.close()
    
    results = []
    for r in rows:
        results.append({
            'id': r[0],
            'name': r[1],
            'content': (r[2] or '')[:200],
            'url': r[3],
            'timestamp': r[4],
            'type': r[5],
            'topics': r[6].split(',') if r[6] else [],
            'entities': r[7].split(',') if r[7] else []
        })
    
    return results

def get_topics():
    """Get all topics with counts"""
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute("""
        SELECT n.name, COUNT(*) as cnt 
        FROM nodes n
        JOIN relationships r ON r.to_id = n.id
        WHERE r.type='about_topic' AND n.type='topic'
        GROUP BY n.name
        ORDER BY cnt DESC
    """)
    rows = cur.fetchall()
    conn.close()
    return [{'topic': r[0], 'count': r[1]} for r in rows]

def get_entities(limit=20):
    """Get top entities"""
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute("""
        SELECT n.name, COUNT(*) as cnt 
        FROM nodes n
        JOIN relationships r ON r.to_id = n.id
        WHERE r.type='mentions_entity' AND n.type='entity'
        GROUP BY n.name
        ORDER BY cnt DESC
        LIMIT ?
    """, [limit])
    rows = cur.fetchall()
    conn.close()
    return [{'entity': r[0], 'count': r[1]} for r in rows]

def get_timeline(months=6):
    """Get bookmark counts by month"""
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute(f"""
        SELECT strftime('%Y-%m', timestamp) as month, COUNT(*) as cnt
        FROM nodes
        GROUP BY month
        ORDER BY month DESC
        LIMIT {months}
    """)
    rows = cur.fetchall()
    conn.close()
    return [{'month': r[0], 'count': r[1]} for r in rows]

def get_related(id, limit=5):
    """Get related bookmarks via shared topics/entities"""
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    
    # Find topics and entities of this bookmark
    cur.execute("""
        SELECT n.name, r.type FROM nodes n
        JOIN relationships r ON r.to_id = n.id
        WHERE r.from_id = ? AND r.type IN ('about_topic', 'mentions_entity')
    """, [id])
    features = cur.fetchall()
    
    if not features:
        conn.close()
        return []
    
    # Find other bookmarks with same features
    conditions = []
    params = []
    for name, rtype in features:
        conditions.append(f"EXISTS (SELECT 1 FROM relationships r2 JOIN nodes n2 ON n2.id=r2.to_id WHERE r2.from_id=n.id AND r2.type='{rtype}' AND n2.name=?)")
        params.append(name)
    
    query = f"""
        SELECT DISTINCT n.id, n.name, n.content, n.url
        FROM nodes n
        WHERE n.id != ? AND ({' OR '.join(conditions)})
        LIMIT ?
    """
    params = [id] + params + [limit]
    
    cur.execute(query, params)
    rows = cur.fetchall()
    conn.close()
    
    return [{'id': r[0], 'name': r[1], 'content': (r[2] or '')[:150], 'url': r[3]} for r in rows]

def get_bookmarks_by_interest(user_topic, limit=10):
    """Get bookmarks related to a topic of interest"""
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute("""
        SELECT n.id, n.name, n.content, n.url, n.timestamp
        FROM nodes n
        JOIN relationships r ON r.from_id = n.id
        JOIN nodes t ON t.id = r.to_id
        WHERE r.type='about_topic' AND t.name = ?
        ORDER BY n.timestamp DESC
        LIMIT ?
    """, [user_topic, limit])
    rows = cur.fetchall()
    conn.close()
    return [{'id': r[0], 'name': r[1], 'content': (r[2] or '')[:200], 'url': r[3], 'timestamp': r[4]} for r in rows]

# ─── Routes ────────────────────────────────────────────

@app.route('/health')
def health(): 
    return jsonify({'status': 'ok', 'service': 'vault-search-v2'})

@app.route('/stats')
def stats():
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute('SELECT COUNT(*) FROM nodes')
    total = cur.fetchone()[0]
    
    cur.execute("SELECT COUNT(*) FROM nodes WHERE type='twitter_tweet'")
    tweets = cur.fetchone()[0]
    
    cur.execute("SELECT COUNT(*) FROM nodes WHERE type='instagram_post'")
    instagram = cur.fetchone()[0]
    
    cur.execute("SELECT COUNT(*) FROM nodes WHERE type='entity'")
    entities = cur.fetchone()[0]
    
    cur.execute("SELECT COUNT(*) FROM relationships")
    relationships = cur.fetchone()[0]
    
    conn.close()
    
    return jsonify({
        'total': total,
        'tweets': tweets,
        'instagram': instagram,
        'entities': entities,
        'relationships': relationships
    })

@app.route('/search')
def route_search():
    """Enhanced search with filters"""
    q = request.args.get('q', '')
    limit = int(request.args.get('limit', 10))
    topic = request.args.get('topic', None)
    entity = request.args.get('entity', None)
    category = request.args.get('category', None)
    after = request.args.get('after', None)
    before = request.args.get('before', None)
    
    results = search_with_filters(
        q, limit, topic, entity, category, after, before
    )
    
    return jsonify({
        'query': q,
        'filters': {'topic': topic, 'entity': entity, 'category': category, 'after': after, 'before': before},
        'count': len(results),
        'results': results
    })

@app.route('/topics')
def route_topics():
    """Get all topics with counts"""
    return jsonify({'topics': get_topics()})

@app.route('/entities')
def route_entities():
    """Get top entities"""
    limit = int(request.args.get('limit', 20))
    return jsonify({'entities': get_entities(limit)})

@app.route('/timeline')
def route_timeline():
    """Get bookmark timeline"""
    months = int(request.args.get('months', 6))
    return jsonify({'timeline': get_timeline(months)})

@app.route('/related/<id>')
def route_related(id):
    """Get related bookmarks"""
    limit = int(request.args.get('limit', 5))
    return jsonify({'related': get_related(id, limit)})

@app.route('/topic/<topic>')
def route_topic(topic):
    """Get bookmarks by topic"""
    limit = int(request.args.get('limit', 10))
    return jsonify({
        'topic': topic,
        'count': limit,
        'bookmarks': get_bookmarks_by_interest(topic, limit)
    })

@app.route('/suggest')
def route_suggest():
    """
    Smart suggestion based on user interests
    Returns: trending topics, recent bookmarks, personalized picks
    """
    # Get top topics
    topics = get_topics()[:5]
    
    # Get recent bookmarks
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute("""
        SELECT n.id, n.name, n.content, n.url, n.timestamp,
               GROUP_CONCAT(t.name) as topics
        FROM nodes n
        LEFT JOIN relationships r ON r.from_id = n.id AND r.type='about_topic'
        LEFT JOIN nodes t ON t.id = r.to_id
        WHERE n.content IS NOT NULL
        GROUP BY n.id
        ORDER BY n.timestamp DESC
        LIMIT 5
    """)
    recent = []
    for r in cur.fetchall():
        recent.append({
            'id': r[0], 'name': r[1], 
            'content': (r[2] or '')[:150], 
            'url': r[3], 
            'timestamp': r[4],
            'topics': r[5].split(',') if r[5] else []
        })
    conn.close()
    
    return jsonify({
        'suggestions': {
            'top_topics': topics,
            'recent': recent
        }
    })

@app.route('/api/search', methods=['POST'])
def api_search():
    """REST API search"""
    d = request.get_json() or {}
    q = d.get('query', d.get('q', ''))
    limit = d.get('limit', 10)
    topic = d.get('topic')
    entity = d.get('entity')
    category = d.get('category')
    
    results = search_with_filters(q, limit, topic, entity, category)
    return jsonify({'results': results, 'count': len(results)})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=False)
