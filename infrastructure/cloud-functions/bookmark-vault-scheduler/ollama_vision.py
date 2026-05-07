#!/usr/bin/env python3
"""
Ollama Vision Analyzer - Uses MiniCPM-V model via Ollama API
Fallback for Gemini when quota is exhausted
"""

import sys
import os
import json
import base64
import requests
import time

OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
# Try minicpm-v first, fall back to moondream
DEFAULT_MODEL = os.environ.get('OLLAMA_VISION_MODEL', 'llava:latest')

PROMPT = """You are a world-class Visual Content Auditor and Curator. 
Analyze the provided media asset (image or video thumbnail) and the accompanying caption.
Caption for context: "{caption}"

Provide the analysis in a strict JSON format with the following keys:
- subject: A concise description of the main entity or theme.
- mood: The emotional or aesthetic tone (e.g., "Cinematic", "Gritty", "Minimalist", "Vibrant", "Nostalgic").
- visual_tags: A list of 5-10 specific visual elements detected.
- narrative_summary: A 1-2 sentence description of what is actually happening in the media.
- aesthetic_score: A rating from 1-10 based on visual quality and composition.

Return ONLY the JSON object. No markdown formatting, no preamble."""

def analyze_image(image_path, caption="", model=None, timeout=300):
    """Analyze an image using Ollama vision model"""
    model = model or DEFAULT_MODEL
    try:
        # Ensure PNG format for Ollama compatibility
        from PIL import Image
        import tempfile
        
        ext = os.path.splitext(image_path)[1].lower()
        if ext not in ('.png', '.PNG'):
            img = Image.open(image_path)
            if img.mode != 'RGB':
                img = img.convert('RGB')
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
                img.save(f.name, 'PNG')
                image_path = f.name
        
        with open(image_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode("utf-8")
        
        payload = {
            "model": model,
            "prompt": PROMPT.format(caption=caption[:200]),
            "images": [img_b64],
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.1}
        }
        
        start = time.time()
        resp = requests.post(OLLAMA_URL, json=payload, timeout=timeout)
        elapsed = time.time() - start
        
        if resp.status_code != 200:
            return {"success": False, "error": f"Ollama error: {resp.status_code} - {resp.text}"}
        
        result = resp.json()
        try:
            analysis = json.loads(result.get("response", "{}"))
            analysis["success"] = True
            analysis["elapsed"] = elapsed
            return analysis
        except json.JSONDecodeError:
            return {"success": False, "error": f"Failed to parse response: {result.get('response', '')[:200]}"}
            
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        # Clean up temp file if we created one
        if image_path != sys.argv[1] if len(sys.argv) > 1 else False:
            try: os.unlink(image_path)
            except: pass


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: python3 ollama_vision.py <image_path> [caption] [model]"}))
        sys.exit(1)
    
    image_path = sys.argv[1]
    caption = sys.argv[2] if len(sys.argv) > 2 else ""
    model = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_MODEL
    
    if not os.path.exists(image_path):
        print(json.dumps({"success": False, "error": f"Image not found: {image_path}"}))
        sys.exit(1)
    
    result = analyze_image(image_path, caption, model, timeout=300)
    print(json.dumps(result))