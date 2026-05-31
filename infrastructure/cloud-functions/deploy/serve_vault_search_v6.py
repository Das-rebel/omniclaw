#!/usr/bin/env python3
"""
Serve Vault Search v6 - BM25 Full-Text Ranking

Replaces the broken LIKE-based search with BM25Okapi ranking.
Consistent multi-term, phrase, and conceptual queries.

Key improvements over v5:
1. BM25Okapi scoring instead of OR'd LIKE + ad-hoc heuristics
2. Proper tokenization (lowercased, punctuation stripped)
3. Handles "LLM cost", "LLM costs expensive", "model routing gateway" natively
4. Stopwords are used only for pre-filter (not exclusion from search)
5. BM25 rank returned as score — proper ranking by relevance
6. Type filter (twitter_tweet, instagram_post) at loop level (fast)
"""

import os
import re
import json
import sqlite3
import math
import time
from typing import List, Dict, Optional
from flask import Flask, request, jsonify
from google.cloud import storage

app = Flask(__name__)

GCS_BUCKET = 'omniclaw-knowledge-graph'
DB_FILE = '/tmp/vault.db'

# BM25 parameters
BM25_K1 = 1.5
BM25_B = 0.75

# Search limits
MAX_RESULTS = 50

# ------------------------------------------------------------------
# Download & Load
# ------------------------------------------------------------------

def download_db():
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

nodes_cache: List[Dict] = []
_doc_tokens_list: List[List[str]] = []
_doc_freqs: Dict[str, int] = {}
_index_built = False

def load_nodes_to_memory():
    global nodes_cache
    if not os.path.exists(DB_FILE):
        return False
    print(f'[Vault] Loading nodes from DB...')
    start = time.time()
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("""\
        SELECT id, type, name, content, url, timestamp, metadata
        FROM nodes ORDER BY timestamp DESC
    """)
    nodes_cache = []
    for row in cur.fetchall():
        try:
            meta = json.loads(row['metadata']) if row['metadata'] else {}
        except:
            meta = {}
        nodes_cache.append({
            'id': row['id'],
            'type': row['type'],
            'name': row['name'] or '',
            'content': row['content'] or '',
            'url': row['url'] or '',
            'timestamp': row['timestamp'] or '',
            'metadata': meta,
        })
    conn.close()
    print(f'[Vault] Loaded {len(nodes_cache)} nodes in {time.time()-start:.1f}s')
    return True

# ------------------------------------------------------------------
# Tokenization
# ------------------------------------------------------------------

def simple_tokenize(text: str) -> List[str]:
    """Lowercase, strip punctuation, split on whitespace."""
    if not text:
        return []
    tokens = text.lower().split()
    return [re.sub(r'[^a-z0-9]', '', t) for t in tokens if len(re.sub(r'[^a-z0-9]', '', t)) > 1]

# ------------------------------------------------------------------
# BM25 Index Build
# ------------------------------------------------------------------

def build_bm25_index(nodes: List[Dict]) -> tuple:
    doc_tokens_list: List[List[str]] = []
    doc_freqs: Dict[str, int] = {}
    for node in nodes:
        text = f"{node.get('name', '')} {node.get('content', '')}"
        tokens = simple_tokenize(text)
        doc_tokens_list.append(tokens)
        for t in set(tokens):
            doc_freqs[t] = doc_freqs.get(t, 0) + 1
    return doc_tokens_list, doc_freqs

def build_index():
    global _doc_tokens_list, _doc_freqs, _index_built
    if _index_built:
        return
    if not nodes_cache:
        load_nodes_to_memory()
    if nodes_cache:
        _doc_tokens_list, _doc_freqs = build_bm25_index(nodes_cache)
        _index_built = True
        print(f'[Vault] BM25: {len(_doc_tokens_list)} docs, {len(_doc_freqs)} terms')

def ensure_index():
    if not _index_built:
        build_index()

# ------------------------------------------------------------------
# BM25 Core
# ------------------------------------------------------------------

def search_bm25(query: str, limit: int = 10, type_filter: Optional[str] = None) -> List[Dict]:
    if not nodes_cache or not _doc_tokens_list or not query:
        return []
    query_tokens = simple_tokenize(query)
    if not query_tokens:
        return []
    n_docs = len(nodes_cache)
    avg_doc_len = sum(len(t) for t in _doc_tokens_list) / n_docs if n_docs > 0 else 200
    results = []
    for i, doc_tokens in enumerate(_doc_tokens_list):
        if type_filter and nodes_cache[i].get('type') != type_filter:
            continue
        # Score only docs that have at least one query token
        if not any(qt in doc_tokens for qt in query_tokens):
            continue
        score = 0.0
        for qt in query_tokens:
            df = _doc_freqs.get(qt, 0)
            if df == 0:
                continue
            idf = math.log((n_docs - df + 0.5) / (df + 0.5) + 1)
            tf = sum(1 for t in doc_tokens if t == qt)
            doc_len = len(doc_tokens)
            numerator = tf * (BM25_K1 + 1)
            denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * doc_len / avg_doc_len)
            score += idf * numerator / denominator
        if score > 0:
            results.append((i, score))
    results.sort(key=lambda x: x[1], reverse=True)
    output = []
    seen_urls = set()  # deduplicate by URL
    for idx, score in results[:limit*2]:  # fetch extra to compensate for dedup
        node = nodes_cache[idx]
        url = node.get('url', '')
        if url and url in seen_urls:
            continue
        seen_urls.add(url)
        meta = node.get('metadata', {})
        content = node.get('content', '')
        topic = meta.get('topic', '') or extract_topic_from_content(content)
        output.append({
            'id': node['id'],
            'type': node['type'],
            'name': node['name'],
            'content': content[:2000],
            'url': node['url'],
            'timestamp': node['timestamp'],
            'score': round(score, 2),
            'topic': topic,
            'hashtags': ((meta.get('hashtags') or extract_hashtags_from_content(content) or [e.get('name','') for e in (meta.get('entities') or []) if isinstance(e,dict) and e.get('type')=='hashtag'] or meta.get('vlTags')) or [])[:10],
            'entities': ((meta.get('entities') or extract_entities_from_content(content)) or [])[:5],
            'metadata': {
                'topic': topic,
                'tags': ((meta.get('hashtags') or extract_hashtags_from_content(content) or [e.get('name','') for e in (meta.get('entities') or []) if isinstance(e,dict) and e.get('type')=='hashtag'] or meta.get('vlTags')) or [])[:10],
                'vlTags': (meta.get('vlTags') or [])[:10],
                'vlSubject': (meta.get('vlSubject') or '')[:200],
                'mood': meta.get('vlMood', ''),
                'narrative': (meta.get('narrative') or '')[:500],
                'location': meta.get('location', ''),
                'sentiment': meta.get('sentiment', ''),
                'categories': (meta.get('categories') or [])[:5],
                'topics': (meta.get('topics') or [])[:5],
            }
        })
        if len(output) >= limit:
            break
    return output

# ------------------------------------------------------------------
# Topic Fallback
# ------------------------------------------------------------------

def extract_topic_from_content(content: str) -> str:
    content_lower = content.lower()
    topic_map = [
        ('AI & Machine Learning', ['ai', 'llm', 'gpt', 'neural', 'model', 'training', 'deep learning']),
        ('Programming', ['code', 'programming', 'python', 'javascript', 'rust', 'function', 'api', 'bug']),
        ('Web Development', ['react', 'vue', 'html', 'css', 'frontend', 'backend', 'http']),
        ('System Design', ['architecture', 'microservice', 'database', 'cache', 'scaling']),
        ('Startup & Business', ['startup', 'funding', 'revenue', 'saas', 'customer', 'product']),
        ('Design', ['figma', 'ui', 'ux', 'design', 'prototype', 'wireframe']),
        ('Data Science', ['data', 'analytics', 'pandas', 'numpy', 'visualization', 'statistics']),
        ('Cloud & DevOps', ['aws', 'gcp', 'azure', 'kubernetes', 'docker', 'ci/cd']),
        ('Mobile', ['ios', 'android', 'swift', 'kotlin', 'react native', 'flutter']),
        ('Security', ['security', 'vulnerability', 'encryption', 'auth', 'oauth', 'https']),
    ]
    for name, kws in topic_map:
        if sum(1 for kw in kws if kw in content_lower) >= 2:
            return name
    return ''

def extract_hashtags_from_content(content: str) -> list:
    if not content:
        return []
    return re.findall(r'#(\w+)', content)

def extract_entities_from_content(content: str) -> list:
    if not content:
        return []
    entities = []
    for tag in re.findall(r'#(\w+)', content):
        entities.append({'name': tag, 'type': 'hashtag'})
    for mention in re.findall(r'@(\w+)', content):
        entities.append({'name': mention, 'type': 'mention'})
    return entities

# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------

# Build immediately at startup (single worker, no lazy loading)
download_db()
load_nodes_to_memory()
build_index()

@app.route('/')
def index():
    return jsonify({
        'service': 'serve-vault-search-v6', 'version': '6.0.0',
        'nodes': len(nodes_cache), 'index_built': _index_built,
        'db_file_exists': os.path.exists(DB_FILE),
    })

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'nodes': len(nodes_cache), 'index_built': _index_built})

@app.route('/stats')
def stats():
    return jsonify({
        'total': len(nodes_cache),
        'twitter': sum(1 for n in nodes_cache if n.get('type') == 'twitter_tweet'),
        'instagram': sum(1 for n in nodes_cache if n.get('type') == 'instagram_post'),
        'unique_terms': len(_doc_freqs),
        'index_built': _index_built,
    })

@app.route('/search')
def search_endpoint():
    if not _index_built:
        build_index()
    q = request.args.get('q', '').strip()
    limit = min(int(request.args.get('limit', 10)), MAX_RESULTS)
    search_type = request.args.get('type', None)
    if not q:
        return jsonify({'error': 'empty_query', 'results': [], 'count': 0})
    if not nodes_cache:
        return jsonify({'error': 'db_not_found', 'results': [], 'count': 0})
    try:
        results = search_bm25(q, limit, search_type)
        return jsonify({'query': q, 'results': results, 'count': len(results)})
    except Exception as e:
        print(f'[Vault] Search error: {e}')
        return jsonify({'error': str(e), 'results': [], 'count': 0})

@app.route('/reload')
def reload():
    global nodes_cache, _doc_tokens_list, _doc_freqs, _index_built
    nodes_cache = []
    _doc_tokens_list = []
    _doc_freqs = {}
    _index_built = False
    if os.path.exists(DB_FILE):
        os.remove(DB_FILE)
    download_db()
    load_nodes_to_memory()
    build_index()
    return jsonify({'status': 'ok', 'nodes': len(nodes_cache)})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    build_index()
    app.run(host='0.0.0.0', port=port)
