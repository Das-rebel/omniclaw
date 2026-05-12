"""
Vault Search Server - Combined Flask + Static Dashboard
Loads CLIP lazily only when semantic_search is called.
"""
import os, json, faiss, numpy as np, sqlite3
from flask import Flask, request, jsonify, send_file
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

app = Flask(__name__, static_folder='.', static_url_path='')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(BASE_DIR, 'learning_base', 'vault.db')
INDEX_FILE = os.path.join(BASE_DIR, 'learning_base', 'clip.faiss')
IDS_FILE = os.path.join(BASE_DIR, 'learning_base', 'clip_ids.json')

INDEX = None
IDS = []
DB_PATH = None

# CLIP lazy-loaded
CLIP_MODEL = None
CLIP_PROC = None
CLIP_LOADED = False

def load_index():
    global INDEX, IDS, DB_PATH
    DB_PATH = DB_FILE
    INDEX = faiss.read_index(INDEX_FILE)
    with open(IDS_FILE) as f:
        IDS = json.load(f)
    print(f'[Vault] FAISS: {INDEX.ntotal} vectors, {len(IDS)} IDs')

def get_clip():
    """Lazily load CLIP model. Thread-safe singleton."""
    global CLIP_MODEL, CLIP_PROC, CLIP_LOADED
    if CLIP_LOADED:
        return CLIP_MODEL, CLIP_PROC
    
    import torch
    from transformers import CLIPProcessor, CLIPModel
    
    print('[Vault] Loading CLIP model...')
    try:
        CLIP_PROC = CLIPProcessor.from_pretrained('openai/clip-vit-large-patch14', use_fast=False)
        CLIP_MODEL = CLIPModel.from_pretrained('openai/clip-vit-large-patch14')
        # Keep on CPU, eval mode
        CLIP_MODEL = CLIP_MODEL.cpu().eval()
        CLIP_LOADED = True
        print('[Vault] CLIP loaded (CPU)')
        return CLIP_MODEL, CLIP_PROC
    except Exception as e:
        print(f'[Vault] CLIP load failed: {e}')
        CLIP_LOADED = False
        return None, None

@app.route('/')
def index():
    return send_file(os.path.join(BASE_DIR, 'semantic_dashboard.html'))

@app.route('/health')
def health():
    return jsonify({
        'status': 'ok',
        'clip': CLIP_LOADED,
        'faiss': INDEX.ntotal if INDEX else 0
    })

@app.route('/stats')
def stats():
    db = sqlite3.connect(DB_PATH)
    cur = db.execute("SELECT COUNT(*) FROM nodes WHERE type='instagram_post'")
    total = cur.fetchone()[0]
    cur = db.execute("SELECT metadata FROM nodes WHERE type='instagram_post'")
    has_loc = has_clip = 0
    for (m,) in cur:
        if m:
            try:
                meta = json.loads(m)
                if meta.get('location'): has_loc += 1
                if meta.get('hasClipEmbedding'): has_clip += 1
            except: pass
    db.close()
    return jsonify({
        'total': total,
        'has_location': has_loc,
        'has_clip': has_clip,
        'clip_vectors': INDEX.ntotal if INDEX else 0,
        'has_transformers': CLIP_LOADED
    })

@app.route('/search')
def search():
    q = request.args.get('q', '').strip()
    top_k = min(int(request.args.get('k', 10)), 50)
    mode = request.args.get('mode', 'auto')

    if not q:
        return jsonify({'error': 'no query'})

    # Try semantic (auto or explicit semantic mode)
    if mode in ('auto', 'semantic'):
        result = semantic_search(q, top_k)
        if 'error' not in result:
            return jsonify(result)
        # Semantic failed (CRASH or unavailable) — fall back to keyword
        if mode == 'semantic':
            # explicit semantic but failed — return error (no silent fallback)
            return jsonify(result)
        # auto mode — silently fall back to keyword
    
    # mode == 'keyword' or auto fallback
    return jsonify(keyword_search(q, top_k))

def semantic_search(query, top_k):
    """
    Semantic search using CLIP text embeddings.
    CLIP encoding runs in ThreadPoolExecutor to avoid signal issues in Flask threads.
    Falls back to keyword search on any failure.
    """
    global CLIP_MODEL, CLIP_PROC

    def _clip_encode():
        """Run CLIP encoding in thread."""
        model, processor = get_clip()
        if model is None:
            raise RuntimeError('CLIP not available')

        inputs = processor(text=[query], return_tensors='pt', padding=True, truncation=True, max_length=77)
        with torch.no_grad():
            emb = model.get_text_features(**inputs)
            emb = emb / emb.norm(p=2, dim=-1, keepdim=True)
        return emb.cpu().float().numpy().astype('float32')


    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(_clip_encode)
            qv = future.result(timeout=90)
    except Exception:
        return keyword_search(query, top_k)


    scores, idxs = INDEX.search(qv, top_k)

    results = []
    db = sqlite3.connect(DB_PATH)
    for rank, (idx, score) in enumerate(zip(idxs[0], scores[0])):
        if idx < 0 or idx >= len(IDS):
            continue
        pid = IDS[idx]
        row = db.execute("SELECT name, content, url, metadata, type FROM nodes WHERE id=?", (pid,)).fetchone()
        if not row:
            continue
        try:
            meta = json.loads(row[3]) if row[3] else {}
        except:
            meta = {}
        node_type = row[4] if len(row) > 4 else ''
        results.append({
            'rank': rank + 1,
            'id': pid,
            'name': row[0] or '',
            'caption': row[1] or '',
            'url': row[2] or '',
            'score': float(score),
            'vlTags': meta.get('vlTags', []),
            'location': meta.get('location', ''),
            'colabSummary': meta.get('colabSummary', ''),
            'source': 'twitter' if node_type == 'twitter_tweet' else 'instagram',
        })
    db.close()
    return {'query': query, 'total': len(results), 'results': results}

def keyword_search(query, top_k):
    db = sqlite3.connect(DB_PATH)
    cur = db.execute(
        "SELECT id, name, content, url, metadata, type FROM nodes WHERE type IN ('instagram_post', 'twitter_tweet')"
    )
    q = query.lower()
    scored = []

    for row in cur:
        name = (row[1] or '').lower()
        content = (row[2] or '').lower()
        meta = {}
        if row[4]:
            try:
                meta = json.loads(row[4])
            except:
                pass
        tags = ' '.join(str(t) for t in meta.get('vlTags', [])).lower()
        summary = (meta.get('colabSummary', '') or '').lower()

        score = 0
        for tok in q.split():
            score += (tok in name) * 3
            score += (tok in content)
            score += (tok in tags) * 2
            score += (tok in summary) * 1.5

        if score > 0:
            scored.append((score, row[0], row[1], row[2], meta, row[5]))

    scored.sort(key=lambda x: x[0], reverse=True)
    results = []
    for score, pid, name, content, meta, node_type in scored[:top_k]:
        results.append({
            'rank': len(results) + 1,
            'id': pid,
            'name': name or '',
            'caption': content or '',
            'url': meta.get('url', ''),
            'score': score,
            'vlTags': meta.get('vlTags', []),
            'location': meta.get('location', ''),
            'colabSummary': meta.get('colabSummary', ''),
            'source': 'twitter' if node_type == 'twitter_tweet' else 'instagram',
        })
    db.close()
    return {'query': query, 'total': len(results), 'results': results}

# Load on startup (not just when run directly)
load_index()
print('[Vault] FAISS: loaded at startup, ready for requests')

if __name__ == '__main__':
    print('[Vault] Server starting on port 8766...')
    app.run(host='0.0.0.0', port=8766, debug=False, threaded=True)
