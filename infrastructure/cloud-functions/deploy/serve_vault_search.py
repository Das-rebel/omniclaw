#!/usr/bin/env python3
"""
Serve Vault Search v4 - Text-First with Improved Topic Extraction

Key improvements over v3:
1. Searches content field with high weight (not just metadata)
2. Uses topic field from text extraction
3. Ranks results by relevance (not just timestamp)
4. Supports multi-field search with weighted scoring
5. Extracts keywords properly from natural language queries
"""

import os
import re
import json
import sqlite3
from typing import List, Dict, Tuple
from flask import Flask, request, jsonify
from google.cloud import storage

app = Flask(__name__)

GCS_BUCKET = 'omniclaw-knowledge-graph'
DB_FILE = '/tmp/vault.db'

# Search field weights (text >> topic >> visual)
WEIGHTS = {
    'content': 1.0,           # Post text - HIGHEST
    'hashtags': 0.9,          # Extracted hashtags - very high (explicit signal)
    'topic': 0.8,             # Extracted topic from text
    'entities': 0.7,          # Named entities from text
    'name': 0.5,             # Username/title
    'visual_description': 0.1,  # What image shows - LOWEST
    'vlTags': 0.05,          # Visual tags - almost ignored
}

# Stopwords for keyword extraction
STOPWORDS = {
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'or', 'and', 'but', 'find', 'me', 'my', 'i',
    'want', 'need', 'look', 'up', 'search', 'get', 'give', 'some', 'ideas',
    'about', 'what', 'how', 'who', 'when', 'where', 'why', 'which', 'that',
    'this', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we',
    'us', 'our', 'you', 'your', 'please', 'help', 'thanks', 'thank'
}

def download_db():
    """Download vault.db from GCS to /tmp"""
    try:
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob('learning_base/vault.db')
        blob.download_to_filename(DB_FILE)
        print(f'[Vault] Downloaded vault.db')
        return True
    except Exception as e:
        print(f'[Vault] Download failed: {e}')
        return False

@app.before_request
def ensure_db():
    if not os.path.exists(DB_FILE):
        download_db()

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

@app.route('/stats')
def stats():
    if not os.path.exists(DB_FILE):
        return jsonify({'total': 0})
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM nodes")
    total = cur.fetchone()[0]
    conn.close()
    return jsonify({'total': total})

def extract_keywords(query: str) -> Tuple[List[str], List[str]]:
    """Extract keywords and bigrams from natural language query"""
    words = query.lower().split()
    keywords = [w for w in words if w not in STOPWORDS and len(w) > 2]
    
    # Extract bigrams
    bigrams = []
    for i in range(len(words) - 1):
        if words[i] not in STOPWORDS and words[i+1] not in STOPWORDS:
            bigrams.append(f'{words[i]} {words[i+1]}')
    
    return keywords[:5], bigrams[:3]

def search(query: str, limit: int = 10, search_type: str = None) -> List[Dict]:
    """Search with text-first priority and relevance scoring"""
    
    keywords, bigrams = extract_keywords(query)
    all_terms = keywords + bigrams
    
    if not all_terms:
        # No meaningful keywords - return recent
        all_terms = [query.lower()]
    
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # Build search across multiple fields
    conditions = []
    params = []
    
    for term in all_terms:
        # Search in content (highest weight), name, and metadata
        conditions.append("""
            (LOWER(n.content) LIKE ? OR 
             LOWER(n.name) LIKE ? OR 
             LOWER(n.metadata) LIKE ?)
        """)
        params.extend([f'%{term}%', f'%{term}%', f'%{term}%'])
    
    where_sql = ' OR '.join(conditions)
    
    if search_type:
        where_sql = f'({where_sql}) AND n.type = ?'
        params.append(search_type)
    
    cur.execute(f"""
        SELECT n.id, n.type, n.name, n.content, n.url, n.timestamp, n.metadata
        FROM nodes n
        WHERE {where_sql}
        ORDER BY n.timestamp DESC
        LIMIT ?
    """, params + [limit * 2])  # Fetch more for re-ranking
    
    rows = cur.fetchall()
    conn.close()
    
    results = []
    for row in rows:
        try:
            metadata = json.loads(row['metadata']) if row['metadata'] else {}
        except:
            metadata = {}
        
        # Calculate relevance score
        score = calculate_score(query, row, metadata, all_terms)
        
        # Extract topic info
        topic = metadata.get('topic', '')
        hashtags = metadata.get('hashtags', [])
        entities = metadata.get('entities', [])
        visual_desc = metadata.get('visual_description', '')
        
        results.append({
            'id': row['id'],
            'type': row['type'],
            'name': row['name'] or '',
            'content': (row['content'] or '')[:1000],  # FIXED: was 200, now 1000
            'url': row['url'] or '',
            'timestamp': row['timestamp'] or '',
            'score': round(score, 3),
            'topic': topic,
            'hashtags': hashtags[:5] if isinstance(hashtags, list) else [],
            'entities': entities[:3] if isinstance(entities, list) else [],
            'visual_description': visual_desc[:200] if visual_desc else '',  # FIXED: was 50, now 200
            'metadata': {  # Simplified metadata for response
                'topic': topic,
                'topic_source': metadata.get('topic_source', 'unknown'),
                'visual_description': visual_desc[:200] if visual_desc else ''  # FIXED: was 30, now 200
            }
        })
    
    # Sort by score (relevance) not timestamp
    results.sort(key=lambda x: x['score'], reverse=True)
    
    return results[:limit]

def calculate_score(query: str, row: sqlite3.Row, metadata: Dict, terms: List[str]) -> float:
    """Calculate relevance score based on multiple signals"""
    score = 0.0
    content_text = ((row['content'] or '') + ' ' + (row['name'] or '')).lower()
    query_lower = query.lower()
    
    # 1. Exact query match in content (highest weight)
    if query_lower in content_text:
        score += WEIGHTS['content']
    
    # 2. Individual term matches
    for term in terms:
        # Content match
        if term in content_text:
            score += WEIGHTS['content'] * 0.5
        
        # Topic match (if topic field exists)
        topic = metadata.get('topic', '').lower()
        if topic and term in topic:
            score += WEIGHTS['topic']
        
        # Hashtags match (very high - explicit signal)
        hashtags = metadata.get('hashtags', [])
        if isinstance(hashtags, list):
            for ht in hashtags:
                if term in ht.lower():
                    score += WEIGHTS['hashtags'] * 0.5
        
        # Name match
        name = (row['name'] or '').lower()
        if term in name:
            score += WEIGHTS['name']
    
    # 3. Boost for multiple term matches
    matched_terms = sum(1 for t in terms if t in content_text)
    if matched_terms > 1:
        score += matched_terms * 0.1
    
    # 4. Small timestamp boost (prefer recent within similar relevance)
    # This prevents old posts from dominating
    try:
        from datetime import datetime
        timestamp = row['timestamp'] or ''
        if timestamp:
            dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            age_days = (datetime.now() - dt.replace(tzinfo=None)).days
            if age_days < 7:
                score += 0.05
            elif age_days < 30:
                score += 0.02
    except:
        pass
    
    return min(score, 10.0)  # Cap at 10

@app.route('/search')
def search_endpoint():
    q = request.args.get('q', '').strip()
    limit = min(int(request.args.get('limit', 10)), 50)
    search_type = request.args.get('type', None)
    
    if not os.path.exists(DB_FILE):
        return jsonify({'error': 'db_not_found', 'results': []})
    
    if not q:
        return jsonify({'error': 'empty_query', 'results': []})
    
    try:
        results = search(q, limit, search_type)
        return jsonify({
            'query': q,
            'results': results,
            'count': len(results)
        })
    except Exception as e:
        return jsonify({'error': str(e), 'results': []})

@app.route('/search-simple')
def search_simple():
    """Simple keyword search - just content matching"""
    q = request.args.get('q', '').strip()
    limit = min(int(request.args.get('limit', 10)), 50)
    
    if not q:
        return jsonify({'error': 'empty_query'})
    
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    cur.execute("""
        SELECT id, type, name, substr(content, 1, 150) as content, url, timestamp
        FROM nodes 
        WHERE LOWER(content) LIKE ? OR LOWER(name) LIKE ?
        ORDER BY timestamp DESC
        LIMIT ?
    """, (f'%{q.lower()}%', f'%{q.lower()}%', limit))
    
    rows = cur.fetchall()
    conn.close()
    
    return jsonify({
        'query': q,
        'results': [{'id': r['id'], 'type': r['type'], 'name': r['name'], 
                    'content': r['content'], 'url': r['url'], 'timestamp': r['timestamp']} 
                   for r in rows],
        'count': len(rows)
    })

@app.route('/reload')
def reload():
    if os.path.exists(DB_FILE):
        os.remove(DB_FILE)
    download_db()
    return jsonify({'status': 'ok'})

def search_app(request):
    """Entry point for Cloud Functions"""
    return app(request.environ, lambda status, headers=None: [b''])

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)