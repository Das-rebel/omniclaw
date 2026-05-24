#!/usr/bin/env python3
"""
Serve Vault Search v5 - Improved Content & Visual Discovery

Key improvements over v4:
1. Content NOT truncated - full text returned (up to 2000 chars)
2. Visual description given more weight (0.4 instead of 0.1)
3. Better score differentiation - multiple bonus factors
4. Full metadata returned including vlTags and narrative
5. Topic fallback - if no topic, extract from content
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

# IMPROVED weights - visual is no longer ignored
WEIGHTS = {
    'content': 1.0,           
    'hashtags': 0.9,          
    'topic': 0.8,             
    'entities': 0.7,          
    'name': 0.5,             
    'visual_description': 0.4,  # INCREASED from 0.1 - now meaningful
    'vlTags': 0.3,           # INCREASED from 0.05
    'narrative': 0.6,        # NEW - AI summary of content
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
    'us', 'our', 'you', 'your', 'please', 'help', 'thanks', 'thank',
    'just', 'like', 'really', 'actually', 'maybe', 'probably', 'definitely'
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
    
    # Extract bigrams (two-word phrases)
    bigrams = []
    for i in range(len(words) - 1):
        if words[i] not in STOPWORDS and words[i+1] not in STOPWORDS:
            bigrams.append(f'{words[i]} {words[i+1]}')
    
    return keywords[:8], bigrams[:5]

def extract_topic_from_content(content: str) -> str:
    """Fallback: extract topic from content if metadata.topic is empty"""
    content_lower = content.lower()
    
    # Topic keywords
    topic_map = {
        'AI & Machine Learning': ['ai', 'machine learning', 'llm', 'gpt', 'neural', 'model', 'training', 'deep learning'],
        'Programming': ['code', 'programming', 'python', 'javascript', 'rust', 'function', 'api', 'bug', 'debug'],
        'Web Development': ['react', 'vue', 'angular', 'html', 'css', 'frontend', 'backend', 'http'],
        'System Design': ['architecture', 'microservice', 'database', 'cache', 'scaling', 'load balancer'],
        'Startup & Business': ['startup', 'funding', 'revenue', 'saas', 'customer', 'product', 'launch'],
        'Design': ['figma', 'ui', 'ux', 'design', 'prototype', 'wireframe', 'typography'],
        'Data Science': ['data', 'analytics', 'pandas', 'numpy', 'visualization', 'statistics'],
        'Cloud & DevOps': ['aws', 'gcp', 'azure', 'kubernetes', 'docker', 'ci/cd', 'deployment'],
        'Mobile': ['ios', 'android', 'swift', 'kotlin', 'react native', 'flutter', 'app'],
        'Security': ['security', 'vulnerability', 'encryption', 'auth', 'oauth', 'jwt', 'https'],
    }
    
    for topic, keywords in topic_map.items():
        if sum(1 for kw in keywords if kw in content_lower) >= 2:
            return topic
    
    return ''

def search(query: str, limit: int = 10, search_type: str = None) -> List[Dict]:
    """Search with improved content and visual discovery"""
    
    keywords, bigrams = extract_keywords(query)
    all_terms = keywords + bigrams
    
    if not all_terms:
        all_terms = [query.lower()]
    
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # Build search across multiple fields
    conditions = []
    params = []
    
    for term in all_terms:
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
    
    # Fetch more for better re-ranking
    cur.execute(f"""
        SELECT n.id, n.type, n.name, n.content, n.url, n.timestamp, n.metadata
        FROM nodes n
        WHERE {where_sql}
        ORDER BY n.timestamp DESC
        LIMIT ?
    """, params + [limit * 3])
    
    rows = cur.fetchall()
    conn.close()
    
    results = []
    for row in rows:
        try:
            metadata = json.loads(row['metadata']) if row['metadata'] else {}
        except:
            metadata = {}
        
        # Calculate improved relevance score
        score = calculate_score(query, row, metadata, all_terms)
        
        # Extract info
        content = row['content'] or ''
        topic = metadata.get('topic', '')
        hashtags = metadata.get('hashtags', [])
        entities = metadata.get('entities', [])
        visual_desc = metadata.get('visual_description', '')
        vl_tags = metadata.get('vlTags', [])
        narrative = metadata.get('narrative', '')
        
        # Fallback: extract topic from content if missing
        if not topic and content:
            topic = extract_topic_from_content(content)
        
        # Build result - NO TRUNCATION on content (up to 2000 chars)
        result = {
            'id': row['id'],
            'type': row['type'],
            'name': row['name'] or '',
            'content': content[:2000] if content else '',  # INCREASED from 200
            'url': row['url'] or '',
            'timestamp': row['timestamp'] or '',
            'score': round(score, 3),
            'topic': topic,
            'hashtags': hashtags[:10] if isinstance(hashtags, list) else [],  # INCREASED from 5
            'entities': entities[:5] if isinstance(entities, list) else [],  # INCREASED from 3
            'visual_description': visual_desc[:300] if visual_desc else '',  # INCREASED from 50
            # FULL metadata now returned
            'metadata': {
                'topic': topic,
                'topic_source': metadata.get('topic_source', 'unknown'),
                'visual_description': visual_desc[:300] if visual_desc else '',
                'vlTags': vl_tags[:10] if isinstance(vl_tags, list) else [],  # NEW
                'narrative': narrative[:500] if narrative else '',  # NEW
                'sentiment': metadata.get('sentiment', ''),
                'mood': metadata.get('vlMood', ''),
                'style': metadata.get('vlStyle', ''),
            }
        }
        
        results.append(result)
    
    # Sort by score (relevance) not timestamp
    results.sort(key=lambda x: x['score'], reverse=True)
    
    return results[:limit]

def calculate_score(query: str, row: sqlite3.Row, metadata: Dict, terms: List[str]) -> float:
    """Calculate improved relevance score with better differentiation"""
    score = 0.0
    content_text = ((row['content'] or '') + ' ' + (row['name'] or '')).lower()
    query_lower = query.lower()
    
    # 1. Exact query match in content (highest weight)
    if query_lower in content_text:
        score += WEIGHTS['content']
    
    # 2. Individual term matches with multiple weight checks
    for term in terms:
        term_matches = 0
        
        # Content match (with bonus for multiple occurrences)
        if term in content_text:
            term_matches += 1
            count = content_text.count(term)
            score += WEIGHTS['content'] * min(count * 0.2, 0.5)  # Bonus for repetition
        
        # Visual description match - NOW MEANINGFUL
        visual_desc = (metadata.get('visual_description', '') or '').lower()
        if term in visual_desc:
            term_matches += 1
            score += WEIGHTS['visual_description'] * 0.5
        
        # vlTags match - NOW MEANINGFUL
        vl_tags = metadata.get('vlTags', [])
        if isinstance(vl_tags, list):
            for tag in vl_tags:
                if term in tag.lower():
                    term_matches += 1
                    score += WEIGHTS['vlTags']
                    break
        
        # Topic match
        topic = metadata.get('topic', '').lower()
        if topic and term in topic:
            term_matches += 1
            score += WEIGHTS['topic']
        
        # Hashtags match (very high - explicit signal)
        hashtags = metadata.get('hashtags', [])
        if isinstance(hashtags, list):
            for ht in hashtags:
                if term in ht.lower():
                    term_matches += 1
                    score += WEIGHTS['hashtags'] * 0.3
                    break
        
        # Narrative match (NEW)
        narrative = (metadata.get('narrative', '') or '').lower()
        if term in narrative:
            term_matches += 1
            score += WEIGHTS['narrative'] * 0.3
        
        # Name match
        name = (row['name'] or '').lower()
        if term in name:
            term_matches += 1
            score += WEIGHTS['name']
        
        # Bonus for matching multiple aspects
        if term_matches >= 3:
            score += 0.2  # Strong match bonus
    
    # 3. Boost for ALL terms matching (not just some)
    matched_terms = sum(1 for t in terms if t in content_text)
    if matched_terms == len(terms):
        score += 0.5  # Perfect match bonus
    elif matched_terms > 1:
        score += matched_terms * 0.1
    
    # 4. Recency boost (smaller than before to not overpower relevance)
    try:
        from datetime import datetime
        timestamp = row['timestamp'] or ''
        if timestamp:
            dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            age_days = (datetime.now() - dt.replace(tzinfo=None)).days
            if age_days < 7:
                score += 0.1
            elif age_days < 30:
                score += 0.05
            elif age_days < 90:
                score += 0.02
    except:
        pass
    
    # 5. Type bonus (tweets might need more recency, posts can be timeless)
    row_type = row['type'] or ''
    if 'post' in row_type.lower() or 'article' in row_type.lower():
        score += 0.05  # Slight boost for substantive content
    
    return min(score, 15.0)  # Cap at 15 (increased from 10)

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
    
    # Return more content in simple search too
    cur.execute("""
        SELECT id, type, name, substr(content, 1, 500) as content, url, timestamp
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