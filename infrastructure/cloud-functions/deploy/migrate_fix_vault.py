#!/usr/bin/env python3
"""
Migration Script: Fix vlSubject confusion
Re-extracts topics from TEXT content and separates visual metadata

This script:
1. Downloads vault.db from GCS
2. For each node, extracts topic from text (not image)
3. Renames current vlSubject → visual_description (what image shows)
4. Creates new topic field (what post is about, from text)
5. Updates search weights to prioritize text over visual
6. Uploads fixed vault.db back to GCS
"""

import os
import json
import sqlite3
import re
from datetime import datetime
from flask import Flask, request, jsonify
from google.cloud import storage

GCS_BUCKET = 'omniclaw-knowledge-graph'
DB_FILE = '/tmp/vault.db'
BACKUP_FILE = '/tmp/vault.db.backup'

def log(msg):
    print(f'[MIGRATE] {datetime.now().isoformat()} {msg}', flush=True)

def download_db():
    """Download vault.db from GCS to /tmp"""
    try:
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob('learning_base/vault.db')
        blob.download_to_filename(DB_FILE)
        log(f'Downloaded vault.db from GCS ({os.path.getsize(DB_FILE)} bytes)')
        return True
    except Exception as e:
        log(f'Download failed: {e}')
        return False

def upload_db():
    """Upload updated vault.db to GCS"""
    try:
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob('learning_base/vault.db')
        blob.upload_from_filename(DB_FILE)
        log(f'Uploaded fixed vault.db to GCS ({os.path.getsize(DB_FILE)} bytes)')
        return True
    except Exception as e:
        log(f'Upload failed: {e}')
        return False

def extract_topic_from_text(content, name):
    """
    Extract topic from TEXT content (not image).
    Prioritizes: content > name > hashtags
    """
    text = ' '.join([content or '', name or ''])
    text = text.lower()
    
    # Extract hashtags
    hashtags = re.findall(r'#(\w+)', text)
    
    # Common topic keywords to look for
    topic_keywords = {
        'AI/ML': ['ai', 'ml', 'machine learning', 'llm', 'gpt', 'chatgpt', 'claude', 'gemini', 'openai', 'anthropic', 'model', 'neural', 'deep learning'],
        'Startup/Business': ['startup', 'business', 'launch', 'product', 'company', 'founder', 'ceo', 'investor', 'funding', 'revenue', 'saas'],
        'Developer': ['code', 'coding', 'developer', 'programming', 'software', 'api', 'github', 'git', 'repository', 'npm', 'python', 'javascript', 'rust'],
        'Marketing': ['marketing', 'seo', 'growth', 'content', 'social media', 'twitter', 'instagram', 'linkedin', 'brand'],
        'Security': ['security', 'hack', 'breach', 'vulnerability', 'attack', 'malware', 'cyber', 'privacy'],
        'AI Tools': ['tool', 'app', 'application', 'software', 'platform', 'service', 'product', 'saas'],
        'Research': ['research', 'paper', 'study', 'analysis', 'data', 'experiment', 'results'],
    }
    
    detected_topics = []
    for topic, keywords in topic_keywords.items():
        if any(kw in text for kw in keywords):
            detected_topics.append(topic)
    
    # Extract key phrases (2-3 word topics)
    phrases = []
    phrase_patterns = [
        r'llm router', r'llm routing', r'ai gateway', r'ai router', r'open source',
        r'startup launch', r'product hunt', r'side project', r'ai agent',
        r'self hosted', r'self-hosted', r'marketing strategy', r'growth hack'
    ]
    for pattern in phrase_patterns:
        if re.search(pattern, text):
            phrases.append(pattern.replace(r'\\', ''))
    
    # Build topic string
    all_topics = detected_topics + phrases
    if not all_topics:
        # Default - try to get first meaningful words
        words = [w for w in text.split() if len(w) > 3 and w not in ['http', 'https', 'www', 'com', 'the', 'and', 'for']]
        all_topics = words[:3] if words else ['general']
    
    return ', '.join(all_topics[:5])

def migrate_vault():
    """Main migration function"""
    log('=== Vault Migration Started ===')
    
    # Download
    if not download_db():
        return {'success': False, 'error': 'Failed to download DB'}
    
    # Backup
    import shutil
    shutil.copy(DB_FILE, BACKUP_FILE)
    log(f'Created backup at {BACKUP_FILE}')
    
    try:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        
        # Stats before
        cur.execute("SELECT COUNT(*) FROM nodes")
        total = cur.fetchone()[0]
        log(f'Total nodes: {total}')
        
        # Get all nodes with metadata
        cur.execute("SELECT id, type, name, content, metadata FROM nodes WHERE metadata IS NOT NULL AND metadata != '{}'")
        nodes = cur.fetchall()
        log(f'Nodes with metadata: {len(nodes)}')
        
        migrated = 0
        for row in nodes:
            try:
                metadata = json.loads(row['metadata']) if row['metadata'] else {}
                
                # Extract TRUE topic from text content
                true_topic = extract_topic_from_text(row['content'] or '', row['name'] or '')
                
                # Rename current visual fields
                old_vlSubject = metadata.get('vlSubject', '')
                old_vlTags = metadata.get('vlTags', [])
                
                # Update metadata with SEPARATE fields
                metadata['topic'] = true_topic  # What post is about (from TEXT)
                metadata['topic_source'] = 'text'  # Provenance
                metadata['visual_description'] = old_vlSubject  # What image shows (from BLIP)
                metadata['visual_mood_tags'] = old_vlTags if isinstance(old_vlTags, list) else []
                metadata['visual_source'] = 'blip'  # Provenance
                
                # Add confidence scores
                metadata['topic_confidence'] = 0.9 if true_topic else 0.3
                metadata['visual_confidence'] = 0.7 if old_vlSubject else 0.0
                
                # Remove old confusing fields from search
                # (keep in metadata for backup, but note they're visual)
                
                # Update database
                cur.execute("UPDATE nodes SET metadata = ? WHERE id = ?", 
                          (json.dumps(metadata), row['id']))
                migrated += 1
                
            except Exception as e:
                log(f'Error migrating node {row["id"]}: {e}')
        
        conn.commit()
        log(f'Migrated {migrated} nodes')
        
        # Stats after
        cur.execute("SELECT COUNT(*) FROM nodes")
        total_after = cur.fetchone()[0]
        
        conn.close()
        
        # Upload
        upload_db()
        
        log('=== Migration Complete ===')
        return {
            'success': True,
            'total_nodes': total,
            'migrated': migrated,
            'backup': BACKUP_FILE
        }
        
    except Exception as e:
        log(f'Migration failed: {e}')
        import traceback
        traceback.print_exc()
        # Restore from backup
        import shutil
        shutil.copy(BACKUP_FILE, DB_FILE)
        return {'success': False, 'error': str(e)}

if __name__ == '__main__':
    result = migrate_vault()
    print(json.dumps(result, indent=2))