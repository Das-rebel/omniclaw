#!/bin/bash
# Deploy serve-vault-search with tag fixes + backfilled hashtags
set -e
cd ~/omniclaw/infrastructure/cloud-functions/deploy

echo "=== Step 1: Verify backfilled DB ==="
python3 -c "
import sqlite3
db = sqlite3.connect('learning_base/vault.db')
c = db.cursor()
c.execute(\"SELECT COUNT(*) FROM nodes WHERE type='instagram_post' AND json_array_length(json_extract(metadata, '\$.hashtags')) > 0\")
with_tags = c.fetchone()[0]
c.execute(\"SELECT COUNT(*) FROM nodes WHERE type='instagram_post'\")
total = c.fetchone()[0]
print(f'Instagram: {with_tags}/{total} have hashtags ({(with_tags/total*100):.0f}%)')
db.close()
"

echo ""
echo "=== Step 2: Verify serve_vault_search.py syntax ==="
python3 -c "
import ast
with open('serve_vault_search.py') as f:
    ast.parse(f.read())
print('✅ Syntax OK')
"

echo ""
echo "=== Step 3: Deploy to Cloud Run ==="
gcloud run deploy serve-vault-search \
  --source . \
  --region=asia-south1 \
  --platform=managed \
  --allow-unauthenticated \
  --memory=1G \
  --timeout=60s

echo ""
echo "=== Step 4: Verify live ==="
SERVICE_URL=$(gcloud run services describe serve-vault-search --region=asia-south1 --format="value(status.url)")
echo "Service: $SERVICE_URL"
sleep 3

echo ""
echo "=== Test: hashtags on Instagram ==="
curl -s --max-time 10 "$SERVICE_URL/search?q=mosquito&limit=3" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d.get('results',[])[:3]:
    n=(r.get('name')or'?')[:60]
    t=r.get('hashtags',[])
    mt=r.get('metadata',{}).get('tags',[])
    print(f'{n}')
    print(f'  hashtags={t}')
    print(f'  metadata.tags={mt}')
"

echo ""
echo "=== Test: vlTags fallback for no-hash posts ==="
curl -s --max-time 10 "$SERVICE_URL/search?q=kitchen+restaurant&limit=2" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d.get('results',[])[:2]:
    n=(r.get('name')or'?')[:60]
    t=r.get('hashtags',[])
    print(f'{n}')
    print(f'  hashtags={t}')
"