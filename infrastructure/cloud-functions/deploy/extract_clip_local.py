#!/usr/bin/env python3
"""
Local CLIP embedding extraction - runs on MacBook CPU.
No GPU needed, processes 1896 posts that had images.
"""
import json, sqlite3, time, io, os, sys
from PIL import Image
import requests
import numpy as np
import torch
from transformers import CLIPProcessor, CLIPModel
import faiss

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VAULT_DB = os.path.join(BASE_DIR, 'learning_base', 'vault.db')
CLIP_IDS_FILE = os.path.expanduser('~/Documents/clip_ids (1).json')
OUTPUT_FULL = os.path.expanduser('~/Documents/clip_full_local.json')
OUTPUT_FAISS = os.path.join(BASE_DIR, 'learning_base', 'clip.faiss')
OUTPUT_IDS = os.path.join(BASE_DIR, 'learning_base', 'clip_ids.json')

print("=== Local CLIP Extraction (CPU) ===", flush=True)
print(f"Vault: {VAULT_DB}", flush=True)
print(f"CLIP IDs: {CLIP_IDS_FILE}", flush=True)
sys.stdout.flush()

with open(CLIP_IDS_FILE) as f:
    clip_ids = json.load(f)
print(f"Posts to process: {len(clip_ids)}", flush=True)

db = sqlite3.connect(VAULT_DB)
cur = db.cursor()
cur.execute("SELECT id, url, metadata FROM nodes WHERE type='instagram_post'")
post_map = {}
for row in cur.fetchall():
    post_id, url, meta_json = row
    if post_id in clip_ids:
        post_map[post_id] = {'url': url}
db.close()
print(f"Posts in vault: {len(post_map)}", flush=True)

print("\nLoading CLIP (CPU, ~1GB)...", flush=True)
sys.stdout.flush()
start_load = time.time()
processor = CLIPProcessor.from_pretrained('openai/clip-vit-large-patch14', use_fast=False)
model = CLIPModel.from_pretrained('openai/clip-vit-large-patch14')
model.eval()
print(f"CLIP loaded in {time.time()-start_load:.1f}s", flush=True)

def get_thumbnail(url):
    try:
        r = requests.get('https://www.instagram.com/api/v1/oembed/', params={'url': url}, timeout=10)
        if r.status_code == 200:
            thumb = r.json().get('thumbnail_url')
            if thumb:
                r2 = requests.get(thumb, timeout=10)
                if r2.status_code == 200 and len(r2.content) > 500:
                    return Image.open(io.BytesIO(r2.content)).convert('RGB')
    except:
        pass
    return None

def get_clip_embedding(img):
    try:
        inputs = processor(images=img, return_tensors='pt')
        with torch.no_grad():
            features = model.get_image_features(**inputs)
            features = features / features.norm(p=2, dim=-1, keepdim=True)
        return features.squeeze().cpu().float().numpy().tolist()
    except:
        return [0.0] * 768

t0 = time.time()
results = []
nok = 0
nfail = 0

for i, post_id in enumerate(clip_ids):
    if i % 50 == 0:
        el = time.time() - t0
        rate = (i+1)/el if el > 0 else 0
        eta = (len(clip_ids)-i-1)/rate/60 if rate > 0 else 0
        pct = (i+1)/len(clip_ids)*100
        bar = chr(9608)*int(pct/5) + chr(9617)*(20-int(pct/5))
        sys.stdout.write(f'\r[{bar}] {pct:.0f}% {i+1}/{len(clip_ids)} {rate:.1f}/s eta {eta:.0f}m ok={nok} fail={nfail}')
        sys.stdout.flush()

    url = post_map.get(post_id, {}).get('url', '')
    img = get_thumbnail(url)
    if img:
        nok += 1
        emb = get_clip_embedding(img)
    else:
        nfail += 1
        emb = [0.0] * 768

    results.append({'id': post_id, 'clip': emb, 'img_ok': img is not None})

elapsed = time.time() - t0
sys.stdout.write(f'\nDone! {len(results)} in {elapsed/60:.1f}m ok={nok} fail={nfail}\n')
sys.stdout.flush()

non_zero = sum(1 for r in results if any(v != 0 for v in r['clip']))
print(f"CLIP non-zero: {non_zero}/{len(results)}", flush=True)

print("Saving...", flush=True)
with open(OUTPUT_FULL, 'w') as f:
    json.dump(results, f)

embs = np.array([r['clip'] for r in results], dtype=np.float32)
norms = np.linalg.norm(embs, axis=1)
print(f"Embedding norms: min={norms.min():.4f} max={norms.max():.4f} mean={norms.mean():.4f}", flush=True)

faiss.normalize_L2(embs)
index = faiss.IndexFlatIP(768)
index.add(embs)
faiss.write_index(index, OUTPUT_FAISS)
with open(OUTPUT_IDS, 'w') as f:
    json.dump([r['id'] for r in results], f)

# Verify
vec = np.zeros(768, dtype=np.float32)
index.reconstruct(0, vec)
norm = np.linalg.norm(vec)
print(f"\nFAISS vector 0 norm: {norm:.4f}, non-zero: {np.count_nonzero(vec)}")
print("Done!", flush=True)