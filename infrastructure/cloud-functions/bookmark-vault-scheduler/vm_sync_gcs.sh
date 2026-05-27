#!/bin/bash
#
# OmniClaw Vault Sync Script (GCS-Enabled)
# Syncs Instagram and Twitter bookmarks to GCS
# Cookies are automatically fetched from GCS
#

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="/home/ubuntu/vault_data"
GCS_BUCKET="omniclaw-knowledge-graph"
SA_KEY="/tmp/vm-sa-key.json"
LOG_FILE="/home/ubuntu/vault_scraper/sync.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Vault Sync Started (GCS-Enabled) ==="

# Use service account key for GCS authentication
export GOOGLE_APPLICATION_CREDENTIALS="$SA_KEY"

# Ensure data directory exists
mkdir -p "$DATA_DIR"

# Export environment variables
# Instagram
export INSTAGRAM_USERNAME="${INSTAGRAM_USERNAME}"
export INSTAGRAM_PASSWORD="${INSTAGRAM_PASSWORD}"
export INSTAGRAM_COOKIES=""  # Will be fetched from GCS
export VAULT_DIR="$DATA_DIR"

# Twitter
export TWITTER_USERNAME="${TWITTER_USERNAME}"
export TWITTER_PASSWORD="${TWITTER_PASSWORD}"
export TWITTER_EMAIL="${TWITTER_EMAIL}"

cd "$SCRIPT_DIR"

# Install Google Cloud Storage library if not present
if ! python3 -c "import google.cloud.storage" 2>/dev/null; then
    log "Installing google-cloud-storage..."
    pip3 install --break-system-packages google-cloud-storage 2>&1 | tee -a "$LOG_FILE"
fi

# Run Instagram scraper (GCS-enabled)
log "Running Instagram scraper (GCS-enabled)..."
if [ -f "instagram_scraper_gcs.py" ]; then
    python3 instagram_scraper_gcs.py >> "$LOG_FILE" 2>&1 || log "Instagram scraper error"
else
    log "WARNING: instagram_scraper_gcs.py not found, using old scraper"
    python3 instagram_scraper.py >> "$LOG_FILE" 2>&1 || log "Instagram scraper error"
fi

# Run Twitter scraper (GCS-enabled)
log "Running Twitter scraper (GCS-enabled)..."
if [ -f "twitter_scraper_gcs.py" ]; then
    python3 twitter_scraper_gcs.py >> "$LOG_FILE" 2>&1 || log "Twitter scraper error"
else
    log "WARNING: twitter_scraper_gcs.py not found, using old scraper"
    python3 twitter_scraper.py >> "$LOG_FILE" 2>&1 || log "Twitter scraper error"
fi

# Upload to GCS using gcloud storage (with SA key auth)
log "Uploading to GCS..."
if [ -f "$DATA_DIR/instagram_scrape.json" ]; then
    gcloud storage cp "$DATA_DIR/instagram_scrape.json" "gs://$GCS_BUCKET/vault/instagram_scrape.json" 2>&1 | tee -a "$LOG_FILE"
fi

if [ -f "$DATA_DIR/twitter_bookmarks_automated.json" ]; then
    gcloud storage cp "$DATA_DIR/twitter_bookmarks_automated.json" "gs://$GCS_BUCKET/vault/twitter_bookmarks_automated.json" 2>&1 | tee -a "$LOG_FILE"
fi

# Make files world-readable for cloud function access
log "Setting public read permissions..."
if [ -f "$DATA_DIR/instagram_scrape.json" ]; then
    gcloud storage objects add-iam-policy-binding "gs://$GCS_BUCKET/vault/instagram_scrape.json" \
        --member="allUsers" --role="roles/storage.objectViewer" 2>&1 | tee -a "$LOG_FILE"
fi

if [ -f "$DATA_DIR/twitter_bookmarks_automated.json" ]; then
    gcloud storage objects add-iam-policy-binding "gs://$GCS_BUCKET/vault/twitter_bookmarks_automated.json" \
        --member="allUsers" --role="roles/storage.objectViewer" 2>&1 | tee -a "$LOG_FILE"
fi

# Merge all sources into consolidated bookmarks_automated.json
log "Merging vault sources into bookmarks_automated.json..."
python3 << 'PYEOF'
import json, subprocess

def gcs_load(path):
    try:
        raw = subprocess.check_output(['gsutil', 'cat', f'gs://omniclaw-knowledge-graph/{path}'], encoding='utf8')
        parsed = json.loads(raw)
        if isinstance(parsed, str):
            parsed = json.loads(parsed)
        return parsed
    except:
        return None

twitter = gcs_load('vault/twitter_bookmarks_automated.json')
instagram = gcs_load('vault/instagram_scrape.json')
browser = gcs_load('vault/browser_bookmarks.json')

bookmarks = []
seen = set()

for tweet in (twitter.get('bookmarks', []) if twitter else []):
    url = tweet.get('url', '')
    if url and url not in seen:
        seen.add(url)
        bookmarks.append({'type':'bookmark','title':tweet.get('vlSubject') or tweet.get('text','')[:80],'url':url,'tags':tweet.get('vlTags',[]),'added':tweet.get('synced_at','')[:10],'source':'twitter'})

for post in (instagram.get('posts', []) if instagram else [])[:2000]:
    url = post.get('permalink') or post.get('url', '')
    if url and url not in seen:
        seen.add(url)
        bookmarks.append({'type':'bookmark','title':post.get('vlSubject') or post.get('caption','')[:80],'url':url,'tags':post.get('vlTags',[]),'added':(post.get('timestamp') or post.get('synced_at') or '')[:10],'source':'instagram'})

for post in (browser.get('posts', []) if browser else []):
    url = post.get('url', '')
    if url and not url.startswith('javascript:') and url not in seen:
        seen.add(url)
        bookmarks.append({'type':'bookmark','title':post.get('vlSubject') or url,'url':url,'tags':post.get('vlTags',[]),'added':(post.get('dateAdded') or '')[:10],'source':f"browser_{post.get('source','unknown')}",'folder':post.get('folder')})

output = {'lastUpdated': '', 'totalCount': len(bookmarks), 'sources': {'twitter': twitter.get('count',0) if twitter else 0, 'instagram': instagram.get('count',0) if instagram else 0, 'browser': len(browser.get('posts',[])) if browser else 0}, 'bookmarks': bookmarks}
output['lastUpdated'] = subprocess.check_output(['date', '-u', '+%Y-%m-%dT%H:%M:%SZ'], encoding='utf8').strip()

with open('/tmp/bookmarks_automated_merged.json', 'w') as f:
    json.dump(output, f, indent=2)
print(f'Merged {len(bookmarks)} bookmarks')
PYEOF

if [ -f /tmp/bookmarks_automated_merged.json ]; then
    gcloud storage cp /tmp/bookmarks_automated_merged.json "gs://$GCS_BUCKET/vault/bookmarks_automated.json" 2>&1 | tee -a "$LOG_FILE"
    gcloud storage objects add-iam-policy-binding "gs://$GCS_BUCKET/vault/bookmarks_automated.json" --member="allUsers" --role="roles/storage.objectViewer" 2>&1 | tee -a "$LOG_FILE" || true
    log "Merged bookmarks_automated.json uploaded"
fi

log "=== Vault Sync Completed ==="
