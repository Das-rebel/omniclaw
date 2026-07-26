#!/usr/bin/env python3
"""
Cloud Function: Vault Upload GCS
Triggered daily to upload vault database to GCS
"""

import os
import logging
import sqlite3
import json
from datetime import datetime
from google.cloud import storage
from google.cloud import firestore

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

GCS_BUCKET = 'omniclaw-knowledge-graph'
LOCAL_DB = '/tmp/vault.db'
EXPORT_FILE = '/tmp/vault_export.json'

def upload_vault_to_gcs(request):
    """Cloud Function to upload vault to GCS"""
    logger.info("Starting vault GCS upload...")
    
    try:
        # Initialize GCS client
        storage_client = storage.Client()
        bucket = storage_client.bucket(GCS_BUCKET)
        
        # Check if local DB exists
        if not os.path.exists(LOCAL_DB):
            logger.error(f"Local DB not found at {LOCAL_DB}")
            return {"error": "Local DB not found"}, 500
        
        # Get stats
        conn = sqlite3.connect(LOCAL_DB)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM nodes")
        node_count = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM nodes WHERE type='twitter_tweet'")
        twitter_count = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM nodes WHERE type='instagram_post'")
        instagram_count = cur.fetchone()[0]
        conn.close()
        
        logger.info(f"DB stats: {node_count} nodes ({twitter_count} twitter, {instagram_count} instagram)")
        
        # Export to JSON
        conn = sqlite3.connect(LOCAL_DB)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("""
            SELECT id, type, name, content, url, timestamp, metadata
            FROM nodes ORDER BY timestamp DESC
        """)
        
        bookmarks = []
        for row in cur.fetchall():
            try:
                meta = json.loads(row['metadata']) if row['metadata'] else {}
            except:
                meta = {}
            bookmarks.append({
                'id': row['id'],
                'type': row['type'],
                'name': row['name'] or '',
                'content': row['content'] or '',
                'url': row['url'] or '',
                'timestamp': row['timestamp'] or '',
                'metadata': meta,
            })
        
        conn.close()
        
        # Save to JSON file
        with open(EXPORT_FILE, 'w') as f:
            json.dump(bookmarks, f, indent=2, default=str)
        
        logger.info(f"Exported {len(bookmarks)} bookmarks to {EXPORT_FILE}")
        
        # Upload vault.db to GCS
        blob_db = bucket.blob('learning_base/vault.db')
        blob_db.upload_from_filename(LOCAL_DB)
        logger.info(f"Uploaded vault.db to GCS")
        
        # Upload unified_bookmarks.json to GCS
        blob_json = bucket.blob('vault/unified_bookmarks.json')
        blob_json.upload_from_filename(EXPORT_FILE)
        logger.info(f"Uploaded unified_bookmarks.json to GCS")
        
        # Update Firestore with sync status
        firestore_client = firestore.Client()
        doc_ref = firestore_client.collection('vault_sync').document('last_sync')
        doc_ref.set({
            'timestamp': datetime.utcnow().isoformat(),
            'success': True,
            'node_count': node_count,
            'twitter_count': twitter_count,
            'instagram_count': instagram_count,
            'source': 'cloud_function',
            'uploaded_to_gcs': True
        })
        
        logger.info("Vault upload to GCS completed successfully")
        
        return {
            "status": "success",
            "node_count": node_count,
            "twitter_count": twitter_count,
            "instagram_count": instagram_count,
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Vault upload failed: {e}")
        return {"error": str(e)}, 500


# For local testing
if __name__ == "__main__":
    upload_vault_to_gcs(None)