#!/usr/bin/env python3
"""Backfill entities, topics, and sentiment for all Instagram nodes."""
import sqlite3, json, re, time
from pathlib import Path

DB_FILE = Path(__file__).parent / 'learning_base' / 'vault.db'

TOPIC_MAP = [
    ('AI & Machine Learning', ['ai', 'llm', 'gpt', 'neural', 'model', 'training', 'deep learning', 'agent']),
    ('Programming', ['code', 'programming', 'python', 'javascript', 'rust', 'function', 'api', 'bug', 'dev']),
    ('Web Development', ['react', 'vue', 'html', 'css', 'frontend', 'backend', 'http', 'website']),
    ('Startup & Business', ['startup', 'funding', 'revenue', 'saas', 'customer', 'product', 'business', 'entrepreneur', 'founder']),
    ('Export & Trade', ['export', 'import', 'shipping', 'freight', 'cargo', 'trade', 'supplier', 'logistics', 'customs']),
    ('Food & Cooking', ['food', 'recipe', 'cook', 'cuisine', 'restaurant', 'dish', 'meal', 'chef', 'kitchen', 'eat', 'delicious']),
    ('Design & Creative', ['figma', 'ui', 'ux', 'design', 'prototype', 'art', 'creative', 'aesthetic']),
    ('Data Science', ['data', 'analytics', 'pandas', 'numpy', 'visualization', 'statistics', 'ml', 'dataset']),
    ('Cloud & DevOps', ['aws', 'gcp', 'azure', 'kubernetes', 'docker', 'ci/cd', 'cloud', 'deploy']),
    ('Mobile & Apps', ['ios', 'android', 'swift', 'kotlin', 'react native', 'flutter', 'app', 'mobile']),
    ('Security', ['security', 'vulnerability', 'encryption', 'auth', 'oauth', 'https', 'privacy']),
    ('Real Estate', ['property', 'real estate', 'villa', 'apartment', 'sqft', 'bhk', 'luxury home']),
    ('Travel', ['travel', 'trip', 'tour', 'destination', 'visit', 'journey', 'flight', 'hotel']),
    ('Fashion & Lifestyle', ['fashion', 'style', 'outfit', 'wear', 'clothing', 'dress', 'lifestyle', 'trend']),
    ('Health & Wellness', ['health', 'fitness', 'wellness', 'yoga', 'meditation', 'healthy', 'doctor', 'medical']),
    ('Education', ['learn', 'course', 'study', 'education', 'student', 'university', 'college', 'teach']),
    ('Marketing', ['marketing', 'brand', 'social media', 'content', 'growth', 'seo', 'ads', 'audience']),
    ('Automotive', ['car', 'bike', 'vehicle', 'automobile', 'ev', 'electric vehicle', 'drive']),
    ('Home & Decor', ['home', 'decor', 'interior', 'furniture', 'room', 'house', 'living', 'wall']),
    ('Gadgets & Electronics', ['gadget', 'electronic', 'device', 'tech', 'phone', 'laptop', 'camera', 'smart']),
]

def extract_topic(content, name=''):
    """Extract best-matching topic from content + name."""
    text = f"{name or ''} {content or ''}".lower()
    best_topic = ''
    best_score = 0
    for topic, keywords in TOPIC_MAP:
        score = sum(1 for kw in keywords if kw in text)
        if score > best_score:
            best_score = score
            best_topic = topic
    return best_topic if best_score >= 2 else ''

def extract_entities(content):
    """Extract hashtags and @mentions as entities."""
    entities = []
    for tag in re.findall(r'#(\w+)', content or ''):
        entities.append({'name': tag, 'type': 'hashtag'})
    for mention in re.findall(r'@(\w+)', content or ''):
        entities.append({'name': mention, 'type': 'mention'})
    return entities

def detect_sentiment(content):
    """Lightweight sentiment: positive/neutral/negative."""
    text = (content or '').lower()
    positive = ['🔥', '😍', '❤️', 'amazing', 'love', 'best', 'great', 'beautiful', 'awesome', 'wow', 'incredible', 'perfect', 'must try', 'worth']
    negative = ['worst', 'terrible', 'awful', 'hate', 'avoid', 'scam', 'fake', 'broken', 'disappointing', 'waste']
    pos = sum(1 for w in positive if w in text)
    neg = sum(1 for w in negative if w in text)
    if pos > neg: return 'positive'
    if neg > pos: return 'negative'
    return 'neutral'

def main():
    conn = sqlite3.connect(str(DB_FILE))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("SELECT id, name, content, metadata FROM nodes WHERE type='instagram_post'")
    rows = cur.fetchall()
    total = len(rows)
    print(f'Processing {total} Instagram nodes...')

    updated = 0
    for row in rows:
        content = row['content'] or ''
        name = row['name'] or ''
        meta = json.loads(row['metadata'] or '{}')

        # Extract entities (if not already present)
        if not meta.get('entities'):
            entities = extract_entities(content)
            if entities:
                meta['entities'] = entities

        # Extract topic (if not already present)
        if not meta.get('topic'):
            topic = extract_topic(content, name)
            if topic:
                meta['topic'] = topic

        # Add sentiment
        if not meta.get('sentiment'):
            sentiment = detect_sentiment(content)
            meta['sentiment'] = {'sentiment': sentiment, 'score': 0}

        cur.execute("UPDATE nodes SET metadata=? WHERE id=?", (json.dumps(meta), row['id']))
        updated += 1

    conn.commit()
    conn.close()
    print(f'Updated {updated}/{total} nodes with entities, topics, sentiment')

if __name__ == '__main__':
    t0 = time.time()
    main()
    print(f'Done in {time.time()-t0:.1f}s')
