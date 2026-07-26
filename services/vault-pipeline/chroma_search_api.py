#!/usr/bin/env python3
"""
Simple Flask API for ChromaDB Semantic Search
Provides REST endpoint for searching vault bookmarks
"""

import os
import json
from flask import Flask, request, jsonify
from datetime import datetime

app = Flask(__name__)

# Configuration
CHROMA_PATH = os.getenv("CHROMA_PATH", "/tmp/vault_chroma")
COLLECTION_NAME = "bookmarks"

# Import ChromaDB
try:
    import chromadb
    from chromadb.config import Settings
    CHROMA_AVAILABLE = True
except ImportError:
    CHROMA_AVAILABLE = False

# Import sentence transformers
try:
    from sentence_transformers import SentenceTransformer
    ST_AVAILABLE = True
except ImportError:
    ST_AVAILABLE = False


def log(msg: str):
    print(f"[CHROMA-SEARCH] {datetime.now().isoformat()} {msg}", flush=True)


@app.route("/health")
def health():
    """Health check endpoint"""
    return jsonify({
        "status": "ok",
        "chroma_available": CHROMA_AVAILABLE,
        "sentence_transformers_available": ST_AVAILABLE,
        "chroma_path": CHROMA_PATH
    })


@app.route("/search", methods=["POST"])
def search():
    """
    Semantic search endpoint
    
    Request body:
    {
        "query": "search query",
        "n_results": 10
    }
    
    Returns:
    {
        "results": [
            {
                "id": "instagram_123456",
                "content": "...",
                "url": "https://...",
                "source": "instagram",
                "distance": 0.123
            }
        ]
    }
    """
    if not CHROMA_AVAILABLE or not ST_AVAILABLE:
        return jsonify({
            "error": "ChromaDB or sentence-transformers not installed"
        }), 500
    
    data = request.get_json() or {}
    query = data.get("query", "")
    n_results = data.get("n_results", 10)
    
    if not query:
        return jsonify({"error": "Missing query parameter"}), 400
    
    try:
        # Initialize ChromaDB client
        chroma_client = chromadb.Client(Settings(
            persist_directory=CHROMA_PATH,
            anonymized_telemetry=False
        ))
        
        # Get collection
        collection = chroma_client.get_collection(COLLECTION_NAME)
        
        # Search
        results = collection.query(
            query_texts=[query],
            n_results=n_results
        )
        
        # Format results
        search_results = []
        if results and results.get("ids"):
            for i in range(len(results["ids"][0])):
                search_results.append({
                    "id": results["ids"][0][i],
                    "content": results["documents"][0][i],
                    "url": results["metadatas"][0][i].get("url", ""),
                    "source": results["metadatas"][0][i].get("source", ""),
                    "bookmarked_at": results["metadatas"][0][i].get("bookmarked_at", ""),
                    "distance": results["distances"][0][i]
                })
        
        return jsonify({
            "query": query,
            "n_results": len(search_results),
            "results": search_results
        })
        
    except Exception as e:
        log(f"Search error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/stats")
def stats():
    """Get collection stats"""
    if not CHROMA_AVAILABLE:
        return jsonify({"error": "ChromaDB not installed"}), 500
    
    try:
        chroma_client = chromadb.Client(Settings(
            persist_directory=CHROMA_PATH,
            anonymized_telemetry=False
        ))
        
        collection = chroma_client.get_collection(COLLECTION_NAME)
        count = collection.count()
        
        return jsonify({
            "collection": COLLECTION_NAME,
            "count": count,
            "chroma_path": CHROMA_PATH
        })
        
    except Exception as e:
        return jsonify({"error": str(e), "count": 0}), 500


@app.route("/reindex", methods=["POST"])
def reindex():
    """Trigger a full reindex (call chroma_indexer.py)"""
    import subprocess
    
    try:
        result = subprocess.run(
            ["python3", "/Users/Subho/omniclaw/services/vault-pipeline/chroma_indexer.py", "--reindex"],
            capture_output=True,
            text=True,
            timeout=300
        )
        
        if result.returncode == 0:
            output = json.loads(result.stdout)
            return jsonify(output)
        else:
            return jsonify({
                "error": "Reindex failed",
                "stderr": result.stderr
            }), 500
            
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# For Gunicorn/Cloud Run - bind to PORT environment variable
app.run(host="0.0.0.0", port=int(os.getenv("PORT", 8080)))