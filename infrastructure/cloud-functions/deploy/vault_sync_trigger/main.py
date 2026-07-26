#!/usr/bin/env python3
"""
Cloud Function: Vault Sync Trigger
Triggered by Cloud Scheduler to run the full vault sync pipeline.
"""

import os
import sys
import json
import subprocess
import tempfile
from datetime import datetime
from google.cloud import storage

# Add the vault-pipeline to the path
VAULT_PIPELINE_DIR = "/tmp/vault-pipeline"
GCS_BUCKET = "omniclaw-knowledge-graph"

def log(msg: str):
    print(f"[VAULT-SYNC] {datetime.now().isoformat()} {msg}", flush=True)

def download_vault_pipeline():
    """Download the vault-pipeline code from Cloud Source."""
    try:
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET)
        
        # Download the vault-pipeline files
        files = [
            "services/vault-pipeline/sync_pipeline.py",
            "services/vault-pipeline/ingest_twitter.py",
            "services/vault-pipeline/ingest_instagram.py",
            "services/vault-pipeline/unified_schema.py",
            "services/vault-pipeline/requirements.txt",
        ]
        
        os.makedirs(VAULT_PIPELINE_DIR, exist_ok=True)
        
        for file_path in files:
            blob = bucket.blob(f"vault/source/{file_path}")
            local_path = os.path.join(VAULT_PIPELINE_DIR, os.path.basename(file_path))
            blob.download_to_filename(local_path)
            log(f"Downloaded {file_path}")
        
        return True
    except Exception as e:
        log(f"Failed to download vault-pipeline: {e}")
        return False

def run_sync(request):
    """Cloud Function entry point."""
    log("Starting vault sync...")
    
    try:
        # Download vault-pipeline code
        if not download_vault_pipeline():
            return {"error": "Failed to download vault-pipeline"}, 500
        
        # Download vault.db from GCS
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET)
        local_db = "/tmp/vault.db"
        
        blob = bucket.blob("learning_base/vault.db")
        blob.download_to_filename(local_db)
        log("Downloaded vault.db from GCS")
        
        # Run sync pipeline
        result = subprocess.run(
            [sys.executable, "sync_pipeline.py", "--db", local_db],
            cwd=VAULT_PIPELINE_DIR,
            capture_output=True,
            text=True,
            timeout=300,
        )
        
        log(f"Sync output: {result.stdout}")
        if result.stderr:
            log(f"Sync errors: {result.stderr}")
        
        if result.returncode != 0:
            return {"error": "Sync failed", "details": result.stderr}, 500
        
        # Upload updated vault.db to GCS
        blob.upload_from_filename(local_db)
        log("Uploaded vault.db to GCS")
        
        # Upload unified_bookmarks.json to GCS
        export_path = "/tmp/vault_export.json"
        if os.path.exists(export_path):
            blob_exp = bucket.blob("vault/unified_bookmarks.json")
            blob_exp.upload_from_filename(export_path)
            log("Uploaded unified_bookmarks.json to GCS")
        
        return {
            "status": "success",
            "timestamp": datetime.now().isoformat(),
            "output": result.stdout,
        }
        
    except Exception as e:
        log(f"Sync failed: {e}")
        return {"error": str(e)}, 500

if __name__ == "__main__":
    print(run_sync(None))