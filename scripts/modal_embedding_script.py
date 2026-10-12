# Modal GPU app to build sqlite-vec embeddings for vault bookmarks
# Usage: python3 build_embeddings_modal.py
# Requires: modal token (already configured) + bookmark_ids.txt (2MB)

import modal, os, sqlite3, time

DB_PATH = "/opt/vault-sync/vault.db"

stub = modal.App("vault-embeddings")
image = modal.Image.debian_slim().pip_install("sentence-transformers", "sqlite-vec")

@stub.function(gpu="A10G", image=image, timeout=3600)
def build_embeddings():
    import sqlite3, sqlite_vec, numpy as np, gc, json
    from sentence_transformers import SentenceTransformer
    import time

    # Load model
    print("Loading model...")
    model = SentenceTransformer("all-MiniLM-L6-v2")  # 384-dim
    print("Model loaded.")

    # Connect to DB
    print(f"Reading from {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        SELECT id, title, content FROM bookmarks
        WHERE is_active=1 AND source_id NOT LIKE 'dm:%'
          AND length(coalesce(content,'')) > 20
    """)
    rows = cur.fetchall()
    conn.close()
    print(f"Bookmark count: {len(rows)}")

    # Build sqlite-vec DB
    import sqlite3 as sq
    db_path = "/tmp/vault_vec.db"
    # Clean up old
    import os
    if os.path.exists(db_path):
        os.remove(db_path)

    v = sq.connect(db_path)
    v.execute("CREATE VIRTUAL TABLE vec_items_vector USING vec0(embedding float[384], metric=cosine)")

    # Process in batches
    BATCH = 256  # larger batch on GPU
    texts, ids_batch = [], []

    for bid, title, content in rows:
        text = f"{title or ''} {content or ''}".strip()[:2000]
        ids_batch.append(str(bid))
        texts.append(text)
        if len(texts) >= BATCH:
            embeddings = model.encode(texts, show_progress_bar=False, convert_to_numpy=True)
            for b, emb in zip(ids_batch, embeddings):
                v.execute("INSERT INTO vec_items_vector (embedding) VALUES (?)", (emb.astype(np.float32).tobytes(),))
            texts, ids_batch = [], []
            gc.collect()

    if texts:
        embeddings = model.encode(texts, show_progress_bar=False, convert_to_numpy=True)
        for b, emb in zip(ids_batch, embeddings):
            v.execute("INSERT INTO vec_items_vector (embedding) VALUES (?)", (emb.astype(np.float32).tobytes(),))

    v.commit()
    # Save meta
    meta = {"total_embedded": len(rows), "dim": 384, "model": "all-MiniLM-L6-v2"}
    with open(db_path + ".meta.json", "w") as f:
        import json
        json.dump(meta, f)
    print(f"Done. {len(rows)} embeddings saved to {db_path}")
    return db_path

if __name__ == "__main__":
    with stub.run():
        result = build_embeddings.local()
        print("Result path:", result)
