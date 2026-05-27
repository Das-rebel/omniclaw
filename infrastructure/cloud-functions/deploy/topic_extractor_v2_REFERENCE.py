#!/usr/bin/env python3
"""
Topic Extractor v2 - Extracts topics from TEXT content using multiple signals
Replaces visual-based topic extraction with text-based approach

Signals (in priority order):
1. Hashtags (#AI #startup) - explicit user signals
2. Named Entities (ORG, PRODUCT, TECH) - spaCy NER
3. Keywords - YAKE keyword extraction
4. Topic keywords - pattern matching for known topics

Architecture:
- extract_topic(content) → topic string + entities + hashtags
- Returns: { topic, entities, hashtags, source: 'text' }
"""

import os
import re
import json
import sqlite3
from typing import Dict, List, Tuple

# Try to load spaCy (optional - fallback to regex if not available)
try:
    import spacy
    nlp = spacy.load("en_core_web_sm")
    HAS_SPACY = True
except:
    HAS_SPACY = False
    print("[TOPIC] spaCy not available, using keyword fallback")

# Try to load YAKE (optional)
try:
    import yake
    kw_extractor = yake.KeywordExtractor(lan="en", n=2, top=5, dedupThreshold=0.8)
    HAS_YAKE = True
except:
    HAS_YAKE = False
    print("[TOPIC] YAKE not available, using regex fallback")

# Known topic patterns (hand-crafted for accuracy)
TOPIC_PATTERNS = {
    'AI/ML': {
        'keywords': ['ai', 'ml', 'machine learning', 'llm', 'gpt', 'chatgpt', 'claude', 'gemini', 
                     'openai', 'anthropic', 'model', 'neural', 'deep learning', 'ai model', 
                     'llm router', 'ai agent', 'coding agent', 'vlm', 'transformer', 'embedding'],
        'hashtags': ['ai', 'ml', 'machinelearning', 'llm', 'gpt', 'chatgpt', 'deeplearning', 'aiagent', 'aicoding']
    },
    'Developer': {
        'keywords': ['code', 'coding', 'developer', 'programming', 'software', 'api', 'github', 
                     'git', 'repository', 'npm', 'python', 'javascript', 'rust', 'typescript',
                     'open source', 'cli', 'sdk', 'framework', 'library'],
        'hashtags': ['coding', 'developer', 'programming', 'opensource', 'github', 'python', 'javascript', 'webdev']
    },
    'Startup/Business': {
        'keywords': ['startup', 'business', 'launch', 'product', 'company', 'founder', 'ceo', 
                     'investor', 'funding', 'revenue', 'saas', 'mrr', 'arr', 'pitch', 'vc'],
        'hashtags': ['startup', 'business', 'founder', 'entrepreneur', 'saas', 'marketing', 'business']
    },
    'Marketing': {
        'keywords': ['marketing', 'seo', 'growth', 'content', 'social media', 'twitter', 
                     'instagram', 'linkedin', 'brand', 'campaign', 'conversion', 'funnel'],
        'hashtags': ['marketing', 'growth', 'contentmarketing', 'socialmedia', 'seo', 'branding']
    },
    'Security': {
        'keywords': ['security', 'hack', 'breach', 'vulnerability', 'attack', 'malware', 
                     'cyber', 'privacy', 'exploit', 'zero-day', 'ctf', 'pen testing'],
        'hashtags': ['security', 'cybersecurity', 'hacking', 'ethicalhacking', 'bugbounty', ' infosec']
    },
    'AI Tools': {
        'keywords': ['tool', 'app', 'application', 'software', 'platform', 'service', 'product',
                     'saas', 'no-code', 'low-code', 'automation'],
        'hashtags': ['aitools', 'app', 'saas', 'tool', 'automation', 'productivity']
    },
    'Research': {
        'keywords': ['research', 'paper', 'study', 'analysis', 'data', 'experiment', 'results',
                     'arxiv', 'benchmark', 'evaluation', 'dataset'],
        'hashtags': ['research', 'datascience', 'machinelearning', 'ai', 'ml']
    },
    'Side Project': {
        'keywords': ['side project', 'side hustle', 'weekend project', 'hacker', 'indie hacker',
                     'build in public', 'ship it', 'side gig'],
        'hashtags': ['indiedev', 'buildinpublic', 'shipit', 'sideproject', 'indiehacker', 'hacker']
    }
}

def extract_hashtags(text: str) -> List[str]:
    """Extract hashtags from text"""
    return [h.lower() for h in re.findall(r'#(\w+)', text)]

def extract_entities_spacy(text: str) -> List[Tuple[str, str]]:
    """Extract named entities using spaCy"""
    if not HAS_SPACY:
        return []
    try:
        doc = nlp(text[:1000])  # Limit text length for performance
        entities = [(e.text, e.label_) for e in doc.ents if e.label_ in ['ORG', 'PRODUCT', 'TECH', 'GPE', 'PERSON']]
        return entities[:5]  # Limit to 5 entities
    except:
        return []

def extract_keywords_yake(text: str) -> List[str]:
    """Extract keywords using YAKE"""
    if not HAS_YAKE:
        return []
    try:
        keywords = kw_extractor.extract_keywords(text)
        return [k for k, _ in keywords[:5]]
    except:
        return []

def detect_topics_from_patterns(text: str, hashtags: List[str]) -> List[str]:
    """Detect topics using pattern matching with weighted scoring"""
    text_lower = text.lower()
    scores = {}
    
    for topic, config in TOPIC_PATTERNS.items():
        score = 0
        
        # Check hashtags (higher weight - explicit user signal)
        topic_hashtags = config['hashtags']
        for ht in hashtags:
            if ht in topic_hashtags:
                score += 3  # Hashtag match is strong signal
        
        # Check keywords (lower weight)
        for kw in config['keywords']:
            if kw in text_lower:
                score += 1
        
        if score > 0:
            scores[topic] = score
    
    # Sort by score and return top topics
    sorted_topics = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [t for t, _ in sorted_topics[:3] if _ >= 2]  # Min score threshold of 2

def extract_topic(content: str, name: str = "") -> Dict:
    """
    Main topic extraction function.
    Returns dict with topic, entities, hashtags, and source info.
    """
    combined_text = f"{content or ''} {name or ''}"
    hashtags = extract_hashtags(combined_text)
    
    # 1. First try pattern matching with hashtags (most reliable for short posts)
    detected_topics = detect_topics_from_patterns(combined_text, hashtags)
    
    # 2. If no topics detected, try entity extraction
    entities = extract_entities_spacy(combined_text)
    
    # 3. If still no topics, try keyword extraction
    if not detected_topics:
        keywords = extract_keywords_yake(combined_text)
        if keywords:
            detected_topics = ['AI/ML', 'Developer'] if any('code' in k.lower() for k in keywords) else ['Research']
    
    # 4. Build topic string
    if detected_topics:
        topic_str = ', '.join(detected_topics)
    elif hashtags:
        # Fallback to hashtags as topic
        topic_str = ', '.join(hashtags[:3])
    else:
        topic_str = 'General'
    
    return {
        'topic': topic_str,
        'entities': [e[0] for e in entities[:5]],
        'hashtags': hashtags[:10],
        'topic_source': 'text',
        'detection_method': 'pattern+hashtag' if detected_topics else ('entity' if entities else 'keyword')
    }

def migrate_vault_topics():
    """Migrate vault with improved topic extraction"""
    from google.cloud import storage
    
    BUCKET = 'omniclaw-knowledge-graph'
    DB_FILE = '/tmp/vault.db'
    
    print("[TOPIC] Downloading vault.db...")
    client = storage.Client()
    bucket = client.bucket(BUCKET)
    blob = bucket.blob('learning_base/vault.db')
    blob.download_to_filename(DB_FILE)
    
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # Get stats
    cur.execute("SELECT COUNT(*) FROM nodes")
    total = cur.fetchone()[0]
    print(f"[TOPIC] Total nodes: {total}")
    
    # Process nodes with content
    cur.execute("SELECT id, type, name, content FROM nodes WHERE content IS NOT NULL AND content != '' LIMIT 5000")
    nodes = cur.fetchall()
    print(f"[TOPIC] Processing {len(nodes)} nodes with content...")
    
    updated = 0
    for row in nodes:
        topic_data = extract_topic(row['content'] or '', row['name'] or '')
        
        try:
            # Get existing metadata
            cur.execute("SELECT metadata FROM nodes WHERE id = ?", (row['id'],))
            existing_meta = cur.fetchone()['metadata']
            metadata = json.loads(existing_meta) if existing_meta else {}
        except:
            metadata = {}
        
        # Update with new topic extraction
        metadata['topic'] = topic_data['topic']
        metadata['entities'] = topic_data['entities']
        metadata['hashtags'] = topic_data['hashtags']
        metadata['topic_source'] = topic_data['topic_source']
        metadata['detection_method'] = topic_data['detection_method']
        metadata['visual_description'] = metadata.get('visual_description', '')  # Keep visual separate
        
        # Save updated metadata
        cur.execute("UPDATE nodes SET metadata = ? WHERE id = ?", (json.dumps(metadata), row['id']))
        updated += 1
        
        if updated % 500 == 0:
            print(f"[TOPIC] Updated {updated} nodes...")
    
    conn.commit()
    print(f"[TOPIC] Updated {updated} nodes")
    
    # Upload back
    print("[TOPIC] Uploading to GCS...")
    blob.upload_from_filename(DB_FILE)
    print("[TOPIC] Done!")
    
    conn.close()

if __name__ == '__main__':
    migrate_vault_topics()