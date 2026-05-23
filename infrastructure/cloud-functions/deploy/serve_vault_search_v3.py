#!/usr/bin/env python3
"""
Serve Vault Search Cloud Function v3
Updated search with TEXT-first priority over visual metadata

KEY CHANGE: Search weights prioritize text content over visual metadata:
- content (post text): 1.0 (highest)
- topic (from text): 0.8
- name (username/title): 0.6
- visual_description (from image): 0.2 (lowest)
- vlTags (from image): 0.1
"""

import os
import json
import sqlite3
import re
from datetime import datetime
from flask import Flask, request, jsonify
from google.cloud import storage

app = Flask(__name__)

GCS_BUCKET = 'omniclaw-knowledge-graph'
DB_FILE = '/tmp/vault.db'

# Search weights: text content >> visual metadata
SEARCH_WEIGHTS = {
    'content': 1.0,           # Post text, captions - highest priority
    'topic': 0.8,            # Topic extracted from text
    'name': 0.6,             # Username/title
    'hashtags': 0.5,         # From post text
    'visual_description': 0.2,  # What image shows - low priority
    'vlTags': 0.1,           # Visual tags from BLIP - lowest
}

def download_db():
    """Download vault.db from GCS to /tmp"""
    try:
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob('learning_base/vault.db')
        blob.download_to_filename(DB_FILE)
        print(f'[Vault] Downloaded vault.db from GCS')
        return True
    except Exception as e:
        print(f'[Vault] Download failed: {e}')
        return False

@app.before_request
def ensure_db():
    """Lazy download on first request"""
    if not os.path.exists(DB_FILE):
        download_db()

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'time': datetime.now().isoformat()})

@app.route('/stats')
def stats():
    if not os.path.exists(DB_FILE):
        return jsonify({'total': 0, 'error': 'db_not_found'})
    try:
        conn = sqlite3.connect(DB_FILE)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM nodes")
        total = cur.fetchone()[0]
        cur.execute("SELECT type, COUNT(*) FROM nodes GROUP BY type")
        types = dict(cur.fetchall())
        conn.close()
        return jsonify({'total': total, 'types': types})
    except Exception as e:
        return jsonify({'error': str(e)})

def extract_keywords(query):
    """Extract meaningful keywords from natural language query"""
    # Remove common stopwords
    stopwords = {'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
                 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
                 'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
                 'at', 'by', 'from', 'as', 'or', 'and', 'but', 'find', 'me', 'my', 'i',
                 'want', 'need', 'look', 'up', 'search', 'get', 'give', 'some', 'ideas'}
    
    words = query.lower().split()
    keywords = [w for w in words if w not in stopwords and len(w) > 2]
    
    # Extract bigrams (2-word phrases)
    bigrams = []
    for i in range(len(words) - 1):
        if words[i] not in stopwords and words[i+1] not in stopwords:
            bigrams.append(f'{words[i]} {words[i+1]}')
    
    return keywords[:5], bigrams[:3]

def search_bookmarks(query, limit=10, search_type=None):
    """Search with text-first priority"""
    keywords, bigrams = extract_keywords(query)
    all_terms = keywords + bigrams
    query_lower = query.lower()
    
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # Build search query that checks multiple fields
    where_clauses = []
    params = []
    
    for term in all_terms:
        where_clauses.append("(LOWER(name) LIKE ? OR LOWER(content) LIKE ? OR LOWER(metadata) LIKE ?)")
        params.extend([f'%{term}%', f'%{term}%', f'%{term}%'])
    
    # Fallback to original query if no keywords
    if not all_terms:
        where_clauses.append("(LOWER(name) LIKE ? OR LOWER(content) LIKE ? OR LOWER(metadata) LIKE ?)")
        params.extend([f'%{query_lower}%', f'%{query_lower}%', f'%{query_lower}%'])
    
    where_sql = ' OR '.join(where_clauses)
    
    if search_type:
        where_sql = f'({where_sql}) AND type = ?'
        params.append(search_type)
    
    cur.execute(f"""
        SELECT id, type, name, content, url, timestamp, metadata
        FROM nodes 
        WHERE {where_sql}
        ORDER BY timestamp DESC
        LIMIT ?
    """, params + [limit])
    
    rows = cur.fetchall()
    conn.close()
    
    results = []
    for row in rows:
        try:
            metadata = json.loads(row['metadata']) if row['metadata'] else {}
        except:
            metadata = {}
        
        # Calculate relevance score based on text match
        score = 1.0
        
        # Boost if query matches content (post text) - highest weight
        content_text = ((row['content'] or '') + ' ' + (row['name'] or '')).lower()
        for term in all_terms:
            if term in content_text:
                score += SEARCH_WEIGHTS['content']
            if metadata.get('topic') and term in metadata['topic'].lower():
                score += SEARCH_WEIGHTS['topic']
            if term in (row['name'] or '').lower():
                score += SEARCH_WEIGHTS['name']
        
        # Extract text topic (from migrated metadata)
        text_topic = metadata.get('topic', '')
        visual_desc = metadata.get('visual_description', '')
        
        results.append({
            'id': row['id'],
            'type': row['type'],
            'name': row['name'],
            'content': (row['content'] or '')[:300],
            'url': row['url'] or '',
            'timestamp': row['timestamp'] or '',
            'score': round(score, 2),
            'metadata': {
                'topic': text_topic,  # What post is about (from TEXT)
                'topic_source': metadata.get('topic_source', 'unknown'),
                'visual_description': visual_desc,  # What image shows (from BLIP)
                'visual_source': metadata.get('visual_source', 'unknown'),
            }
        })
    
    # Sort by score descending
    results.sort(key=lambda x: x['score'], reverse=True)
    
    return results

@app.route('/search')
def search():
    q = request.args.get('q', '').lower()
    limit = min(int(request.args.get('limit', 10)), 50)
    search_type = request.args.get('type', None)  # instagram_post, twitter_tweet, etc.
    
    if not os.path.exists(DB_FILE):
        return jsonify({'query': q, 'results': [], 'error': 'db_not_found'})
    
    if not q:
        return jsonify({'query': q, 'results': [], 'error': 'empty_query'})
    
    try:
        results = search_bookmarks(q, limit, search_type)
        return jsonify({
            'query': q,
            'results': results,
            'count': len(results)
        })
    except Exception as e:
        return jsonify({'query': q, 'results': [], 'error': str(e)})

@app.route('/reload')
def reload():
    """Force reload from GCS"""
    if os.path.exists(DB_FILE):
        os.remove(DB_FILE)
    download_db()
    return jsonify({'status': 'ok', 'message': 'Reloaded from GCS'})

# Entry point for GCF
def search_app(request):
    """WSGI wrapper for Cloud Functions"""
    from flask import Flask
    app = Flask(__name__)
    
    @app.route('/')
    def index():
        return jsonify({'service': 'serve-vault-search', 'version': 'v3-text-first'})
    
    return app(request.environ, lambda status, headers=None: [b''])

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)