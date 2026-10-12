#!/usr/bin/env python3
"""
Script to push Kaggle kernel for vault bookmark embeddings.
GPU kernel will:
1. Load sentence-transformers all-MiniLM-L6-v2 (384-dim)
2. Read vault bookmarks from GCS/dataset
3. Generate embeddings using Kaggle GPU
4. Output vault_vec.db + meta.json
"""
import json, os, subprocess, pathlib

# Extract texts locally first (lightweight) — then push to Kaggle
DB = "/opt/vault-sync/vault.db"
SIZE = 0

# Extract first 100 for quick test
import sqlite3
conn = sqlite3.connect(DB)
cur = conn.cursor()
cur.execute("""
    SELECT id, title, content FROM bookmarks
    WHERE is_active=1 AND source_id NOT LIKE 'dm:%' AND length(coalesce(content,'')) > 20
    LIMIT 100
""")
rows = cur.fetchall()
conn.close()

export = []
for bid, title, content in rows:
    text = f"{title or ''} {content or ''}".strip()[:2000]
    export.append({"id": str(bid), "text": text})

# Write as dataset input
with open("kaggle_input.json", "w") as f:
    json.dump(export, f, indent=2)

print(f"Exported {len(export)} embeddable bookmarks to kaggle_input.json")
print("Now push with: kaggle kernels push -p main your-username/vault-embeddings")