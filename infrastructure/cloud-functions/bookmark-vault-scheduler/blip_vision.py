#!/usr/bin/env python3
"""
Vision fallback using HuggingFace Transformers (BLIP).
Works on CPU, no GPU needed.
"""

import sys
import os
import json
import base64
import time
import io
from PIL import Image

from transformers import BlipProcessor, BlipForConditionalGeneration
import torch

# Global model (loaded once)
_processor = None
_model = None

def load_models():
    global _processor, _model
    if _processor is None:
        print("Loading BLIP model...", file=sys.stderr, flush=True)
        _processor = BlipProcessor.from_pretrained('Salesforce/blip-image-captioning-base')
        _model = BlipForConditionalGeneration.from_pretrained('Salesforce/blip-image-captioning-base')
        print("BLIP loaded.", file=sys.stderr, flush=True)

def resize_for_blip(image_path, max_size=384):
    """Resize image to max dimension for faster BLIP processing"""
    img = Image.open(image_path)
    if img.mode != 'RGB':
        img = img.convert('RGB')
    ratio = min(max_size / img.width, max_size / img.height)
    if ratio < 1:
        new_size = (int(img.width * ratio), int(img.height * ratio))
        img = img.resize(new_size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()

def extract_aesthetic_tags(caption, context):
    """Simple heuristic extraction of visual tags and mood from caption + context"""
    text = (caption + ' ' + context).lower()
    
    # Common visual elements detection
    visual_keywords = {
        'food': ['food', 'dish', 'meal', 'biryani', 'curry', 'restaurant', 'eating', 'cuisine'],
        'landscape': ['mountain', 'beach', 'sunset', 'sky', 'ocean', 'nature', 'forest', 'river'],
        'urban': ['city', 'street', 'building', 'architecture', 'downtown', 'road'],
        'people': ['person', 'people', 'portrait', 'crowd', 'family', 'friends'],
        'art': ['art', 'painting', 'design', 'creative', 'aesthetic', 'artistic'],
        'technology': ['tech', 'computer', 'phone', 'gadget', 'screen', 'digital'],
        'nature': ['plant', 'flower', 'tree', 'garden', 'green', 'leaf'],
    }
    
    tags = []
    for category, keywords in visual_keywords.items():
        if any(kw in text for kw in keywords):
            tags.append(category)
    
    if not tags:
        tags = ['scene']
    
    # Mood detection
    mood_keywords = {
        'Vibrant': ['colorful', 'bright', 'vibrant', 'lively', ' energetic'],
        'Minimalist': ['minimal', 'clean', 'simple', 'minimalist', 'plain'],
        'Nostalgic': ['old', 'vintage', 'nostalgic', 'retro', 'classic', 'traditional'],
        'Cinematic': ['dramatic', 'cinematic', 'epic', 'stunning', 'beautiful'],
        'Gritty': ['gritty', 'raw', 'real', 'authentic', 'street'],
        'Warm': ['warm', 'cozy', 'comforting', 'homely', 'cozy'],
        'Cool': ['cool', 'modern', 'sleek', 'fresh', 'contemporary'],
    }
    
    mood = 'Neutral'
    for m, keywords in mood_keywords.items():
        if any(kw in text for kw in keywords):
            mood = m
            break
    
    # Aesthetic score heuristics
    score = 5
    if any(w in text for w in ['beautiful', 'stunning', 'amazing', 'breathtaking']):
        score = 8
    elif any(w in text for w in ['nice', 'good', 'pretty']):
        score = 7
    elif any(w in text for w in ['simple', 'basic', 'plain']):
        score = 4
    
    return tags[:5], mood, score

def analyze_image(image_path, caption="", timeout=120):
    """Analyze image using BLIP + heuristic extraction"""
    try:
        load_models()
        
        img_bytes = resize_for_blip(image_path, max_size=384)
        img = Image.open(io.BytesIO(img_bytes))
        
        start = time.time()
        
        # Generate caption with BLIP
        inputs = _processor(img, return_tensors='pt')
        out = _model.generate(**inputs)
        blip_caption = _processor.decode(out[0], skip_special_tokens=True)
        
        # Extract visual tags and mood using heuristics
        visual_tags, mood, aesthetic_score = extract_aesthetic_tags(blip_caption, caption)
        
        return {
            'success': True,
            'subject': blip_caption[:100],
            'mood': mood,
            'visual_tags': visual_tags,
            'narrative_summary': f'The image shows {blip_caption}.',
            'aesthetic_score': aesthetic_score,
            'elapsed': time.time() - start,
            'blip_caption': blip_caption,
            'provider': 'blip-cpu'
        }
        
    except Exception as e:
        return {'success': False, 'error': str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: python3 blip_vision.py <image_path> [caption]"}))
        sys.exit(1)
    
    image_path = sys.argv[1]
    caption = sys.argv[2] if len(sys.argv) > 2 else ""
    
    if not os.path.exists(image_path):
        print(json.dumps({"success": False, "error": f"Image not found: {image_path}"}))
        sys.exit(1)
    
    result = analyze_image(image_path, caption, timeout=120)
    print(json.dumps(result))