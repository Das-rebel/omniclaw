#!/usr/bin/env python3
"""
ChromaDB Semantic Search Indexer for Vault Bookmarks
Creates embeddings for all bookmarks and stores in ChromaDB for semantic search
"""

import json
import sqlite3
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Optional

# ChromaDB
try:
    import chromadb
    from chromadb.config import Settings
    CHROMA_AVAILABLE = True
except ImportError:
    CHROMA_AVAILABLE = False
    print("[CHROMA] chromadb not installed. Install with: pip install chromadb sentence-transformers")

# Sentence transformers for embeddings
try:
    from sentence_transformers import SentenceTransformer
    ST_AVAILABLE = True
except ImportError:
    ST_AVAILABLE = False
    print("[CHROMA] sentence-transformers not installed. Install with: pip install sentence-transformers")

# Configuration
CHROMA_PATH = os.getenv("CHROMA_PATH", "/tmp/vault_chroma")
COLLECTION_NAME = "bookmarks"
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
DB_PATH = os.getenv("DB_PATH", "/tmp/vault_data/vault.db")


def log(msg: str):
    print(f"[CHROMA] {datetime.now().isoformat()} {msg}", flush=True)


def get_bookmarks(conn: sqlite3.Connection, limit: Optional[int] = None) -> List[dict]:
    """Get all bookmarks from vault.db"""
    query = """
        SELECT source, source_id, url, title, content, bookmarked_at, scraped_at, metadata
        FROM bookmarks
        ORDER BY scraped_at DESC
    """
    if limit:
        query += f" LIMIT {limit}"
    
    cursor = conn.execute(query)
    rows = cursor.fetchall()
    
    bookmarks = []
    for row in rows:
        source, source_id, url, title, content, bookmarked_at, scraped_at, metadata_json = row
        
        # Parse metadata
        metadata = {}
        if metadata_json:
            try:
                metadata = json.loads(metadata_json)
            except:
                pass
        
        # Combine title and content for embedding
        text_to_embed = f"{title or ''} {content or ''}".strip()
        
        bookmarks.append({
            "source": source,
            "source_id": source_id,
            "url": url,
            "title": title,
            "content": content,
            "bookmarked_at": bookmarked_at,
            "scraped_at": scraped_at,
            "metadata": metadata,
            "text": text_to_embed,  # Combined text for embedding
            "id": f"{source}_{source_id}"  # Unique ID for ChromaDB
        })
    
    return bookmarks


def create_embeddings(bookmarks: List[dict], model) -> List[list]:
    """Create embeddings for all bookmarks"""
    texts = [b.get("text", "") or "" for b in bookmarks]
    
    if not any(texts):
        log("No text to embed")
        return []
    
    log(f"Creating embeddings for {len(texts)} texts...")
    embeddings = model.encode(texts, show_progress_bar=True)
    return embeddings.tolist()


def index_bookmarks(bookmarks: List[dict], embeddings: List[list], chroma_client, collection):
    """Index bookmarks into ChromaDB"""
    if not embeddings:
        return
    
    log(f"Indexing {len(embeddings)} bookmarks into ChromaDB...")
    
    # Prepare documents and metadata
    ids = [b["id"] for b in bookmarks]
    documents = [b.get("text", "") or "" for b in bookmarks]
    
    # Prepare metadatas
    metadatas = []
    for b in bookmarks:
        meta = {
            "source": b.get("source", ""),
            "url": b.get("url", ""),
            "bookmarked_at": b.get("bookmarked_at", "") or "",
            "scraped_at": b.get("scraped_at", "") or "",
        }
        # Add any metadata from the bookmark
        if b.get("metadata"):
            for k, v in b["metadata"].items():
                if k not in meta and v:
                    meta[k] = str(v) if not isinstance(v, str) else v
        metadatas.append(meta)
    
    # Delete existing collection and recreate
    try:
        chroma_client.delete_collection(COLLECTION_NAME)
        log("Deleted existing collection")
    except:
        pass
    
    # Create collection
    collection = chroma_client.create_collection(
        name=COLLECTION_NAME,
        metadata={"description": "Vault bookmarks semantic search"}
    )
    
    # Add to collection
    collection.add(
        ids=ids,
        embeddings=embeddings,
        documents=documents,
        metadatas=metadatas
    )
    
    log(f"✅ Indexed {len(ids)} bookmarks")


def search_chroma(query: str, n_results: int = 10, collection=None) -> List[dict]:
    """Search ChromaDB for similar bookmarks"""
    if not collection:
        return []
    
    try:
        results = collection.query(
            query_texts=[query],
            n_results=n_results
        )
        
        search_results = []
        if results and results.get("ids") and results["ids"]:
            for i, (ids, distances, documents, metadatas) in enumerate(zip(
                results["ids"][0],
                results["distances"][0],
                results["documents"][0],
                results["metadatas"][0]
            )):
                search_results.append({
                    "id": ids,
                    "distance": distances,
                    "content": documents,
                    "url": metadatas.get("url", ""),
                    "source": metadatas.get("source", ""),
                    "bookmarked_at": metadatas.get("bookmarked_at", "")
                })
        
        return search_results
    except Exception as e:
        log(f"Search error: {e}")
        return []


def full_reindex(chroma_path: str = CHROMA_PATH, db_path: str = DB_PATH) -> dict:
    """Full reindex of all bookmarks into ChromaDB"""
    if not CHROMA_AVAILABLE or not ST_AVAILABLE:
        return {"success": False, "error": "ChromaDB or sentence-transformers not installed"}
    
    log("=" * 50)
    log("ChromaDB Semantic Search Indexer Starting")
    log("=" * 50)
    
    # Initialize ChromaDB
    log(f"Initializing ChromaDB at {chroma_path}")
    os.makedirs(chroma_path, exist_ok=True)
    
    chroma_client = chromadb.Client(Settings(
        persist_directory=chroma_path,
        anonymized_telemetry=False
    ))
    
    # Load embedding model
    log(f"Loading embedding model: {EMBEDDING_MODEL}")
    model = SentenceTransformer(EMBEDDING_MODEL)
    
    # Connect to vault.db
    db_file = Path(db_path)
    if not db_file.exists():
        log(f"Database not found: {db_path}")
        return {"success": False, "error": "Database not found"}
    
    conn = sqlite3.connect(db_path)
    
    # Get all bookmarks
    log("Fetching bookmarks from vault.db...")
    bookmarks = get_bookmarks(conn)
    log(f"Found {len(bookmarks)} bookmarks to index")
    
    if not bookmarks:
        log("No bookmarks to index")
        return {"success": True, "indexed": 0}
    
    # Create embeddings
    embeddings = create_embeddings(bookmarks, model)
    
    # Index into ChromaDB
    collection = chroma_client.get_collection(COLLECTION_NAME)
    index_bookmarks(bookmarks, embeddings, chroma_client, collection)
    
    conn.close()
    
    log(f"✅ Full reindex complete: {len(bookmarks)} bookmarks indexed")
    
    return {
        "success": True,
        "indexed": len(bookmarks),
        "model": EMBEDDING_MODEL,
        "chroma_path": chroma_path
    }


def incremental_update(new_bookmarks: List[dict], chroma_path: str = CHROMA_PATH) -> dict:
    """Incrementally update ChromaDB with new bookmarks only"""
    if not CHROMA_AVAILABLE or not ST_AVAILABLE:
        return {"success": False, "error": "ChromaDB or sentence-transformers not installed"}
    
    if not new_bookmarks:
        return {"success": True, "updated": 0}
    
    log(f"Incremental update: {len(new_bookmarks)} new bookmarks")
    
    # Initialize ChromaDB
    os.makedirs(chroma_path, exist_ok=True)
    chroma_client = chromadb.Client(Settings(
        persist_directory=chroma_path,
        anonymized_telemetry=False
    ))
    
    # Load model
    model = SentenceTransformer(EMBEDDING_MODEL)
    
    # Get existing collection or create new
    try:
        collection = chroma_client.get_collection(COLLECTION_NAME)
    except:
        collection = chroma_client.create_collection(name=COLLECTION_NAME)
    
    # Create embeddings for new bookmarks
    embeddings = create_embeddings(new_bookmarks, model)
    
    # Prepare data
    ids = [b["id"] for b in new_bookmarks]
    documents = [b.get("text", "") or "" for b in new_bookmarks]
    metadatas = [{
        "source": b.get("source", ""),
        "url": b.get("url", ""),
        "bookmarked_at": b.get("bookmarked_at", "") or "",
        "scraped_at": b.get("scraped_at", "") or "",
    } for b in new_bookmarks]
    
    # Add to collection
    collection.add(
        ids=ids,
        embeddings=embeddings,
        documents=documents,
        metadatas=metadatas
    )
    
    log(f"✅ Incremental update complete: {len(new_bookmarks)} bookmarks added")
    
    return {
        "success": True,
        "updated": len(new_bookmarks)
    }


def semantic_search(query: str, n_results: int = 10, chroma_path: str = CHROMA_PATH) -> List[dict]:
    """Search bookmarks using semantic similarity"""
    if not CHROMA_AVAILABLE:
        return []
    
    try:
        chroma_client = chromadb.Client(Settings(
            persist_directory=chroma_path,
            anonymized_telemetry=False
        ))
        collection = chroma_client.get_collection(COLLECTION_NAME)
        
        return search_chroma(query, n_results, collection)
    except Exception as e:
        log(f"Search error: {e}")
        return []


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="ChromaDB Semantic Search Indexer")
    parser.add_argument("--reindex", action="store_true", help="Full reindex of all bookmarks")
    parser.add_argument("--search", type=str, help="Search query")
    parser.add_argument("--limit", type=int, default=10, help="Number of search results")
    
    args = parser.parse_args()
    
    if args.reindex:
        result = full_reindex()
        print(json.dumps(result, indent=2))
    elif args.search:
        results = semantic_search(args.search, args.limit)
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        parser.print_help()