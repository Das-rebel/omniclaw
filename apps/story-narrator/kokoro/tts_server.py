#!/usr/bin/env python3
"""
Kokoro-82M TTS Server
FastAPI wrapper for Kokoro TTS with 54 voices and 9 languages.
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import soundfile as sf
import numpy as np
import subprocess
import tempfile
import os
import base64
import json

app = FastAPI(title="Kokoro TTS Service", version="1.0.0")

# Voice catalog
VOICE_CATALOG = {
    # American English (a)
    'af_heart': {'lang': 'a', 'gender': 'f', 'name': 'American Female - Heart'},
    'af_nicole': {'lang': 'a', 'gender': 'f', 'name': 'American Female - Nicole'},
    'af_sarah': {'lang': 'a', 'gender': 'f', 'name': 'American Female - Sarah'},
    'af_sky': {'lang': 'a', 'gender': 'f', 'name': 'American Female - Sky'},
    'am_adam': {'lang': 'a', 'gender': 'm', 'name': 'American Male - Adam'},
    'am_anthony': {'lang': 'a', 'gender': 'm', 'name': 'American Male - Anthony'},
    'am_fenris': {'lang': 'a', 'gender': 'm', 'name': 'American Male - Fenris'},
    'am_michael': {'lang': 'a', 'gender': 'm', 'name': 'American Male - Michael'},
    'af_bella': {'lang': 'a', 'gender': 'f', 'name': 'American Female - Bella'},
    'af_scallop': {'lang': 'a', 'gender': 'f', 'name': 'American Female - Scallop'},
    'af_heart': {'lang': 'a', 'gender': 'f', 'name': 'American Female - Heart'},
    
    # British English (b)
    'bf_alice': {'lang': 'b', 'gender': 'f', 'name': 'British Female - Alice'},
    'bf_emma': {'lang': 'b', 'gender': 'f', 'name': 'British Female - Emma'},
    'bf_lily': {'lang': 'b', 'gender': 'f', 'name': 'British Female - Lily'},
    'bm_daniel': {'lang': 'b', 'gender': 'm', 'name': 'British Male - Daniel'},
    'bm_george': {'lang': 'b', 'gender': 'm', 'name': 'British Male - George'},
    'bm_lewis': {'lang': 'b', 'gender': 'm', 'name': 'British Male - Lewis'},
    
    # Spanish (e)
    'ef_iyera': {'lang': 'e', 'gender': 'f', 'name': 'Spanish Female - Iyera'},
    'em_alvaro': {'lang': 'e', 'gender': 'm', 'name': 'Spanish Male - Alvaro'},
    'em_pedro': {'lang': 'e', 'gender': 'm', 'name': 'Spanish Male - Pedro'},
    
    # French (f)
    'ff_siwis': {'lang': 'f', 'gender': 'f', 'name': 'French Female - Siwis'},
    
    # Hindi (h)
    'hf_niya': {'lang': 'h', 'gender': 'f', 'name': 'Hindi Female - Niya'},
    'hf_priya': {'lang': 'h', 'gender': 'f', 'name': 'Hindi Female - Priya'},
    'hm_arpit': {'lang': 'h', 'gender': 'm', 'name': 'Hindi Male - Arpit'},
    'hm_rahul': {'lang': 'h', 'gender': 'm', 'name': 'Hindi Male - Rahul'},
    
    # Italian (i)
    'if_chiara': {'lang': 'i', 'gender': 'f', 'name': 'Italian Female - Chiara'},
    'im_alessandro': {'lang': 'i', 'gender': 'm', 'name': 'Italian Male - Alessandro'},
    
    # Japanese (j)
    'jf_abigail': {'lang': 'j', 'gender': 'f', 'name': 'Japanese Female - Abigail'},
    'jm_ken': {'lang': 'j', 'gender': 'm', 'name': 'Japanese Male - Ken'},
    'jm_masaru': {'lang': 'j', 'gender': 'm', 'name': 'Japanese Male - Masaru'},
    'jm_osamu': {'lang': 'j', 'gender': 'm', 'name': 'Japanese Male - Osamu'},
    'jf_miyu': {'lang': 'j', 'gender': 'f', 'name': 'Japanese Female - Miyu'},
    
    # Portuguese (p)
    'pf_dora': {'lang': 'p', 'gender': 'f', 'name': 'Portuguese Female - Dora'},
    'pm_alberto': {'lang': 'p', 'gender': 'm', 'name': 'Portuguese Male - Alberto'},
    'pm_carlos': {'lang': 'p', 'gender': 'm', 'name': 'Portuguese Male - Carlos'},
    
    # Mandarin (z)
    'zf_yunxi': {'lang': 'z', 'gender': 'f', 'name': 'Mandarin Female - Yunxi'},
    'zf_yunxia': {'lang': 'z', 'gender': 'f', 'name': 'Mandarin Female - Yunxia'},
    'zm_yunyang': {'lang': 'z', 'gender': 'm', 'name': 'Mandarin Male - Yunyang'},
}

# Lang code to Kokoro pipeline lang_code mapping
LANG_MAP = {
    'en': 'a', 'american': 'a', 'american english': 'a',
    'british': 'b', 'british english': 'b',
    'es': 'e', 'spanish': 'e',
    'fr': 'f', 'french': 'f',
    'hi': 'h', 'hindi': 'h',
    'it': 'i', 'italian': 'i',
    'ja': 'j', 'japanese': 'j',
    'pt': 'p', 'portuguese': 'p',
    'zh': 'z', 'mandarin': 'z', 'chinese': 'z'
}

class TTSRequest(BaseModel):
    text: str
    voice: str = 'af_heart'
    speed: float = 1.0
    language: Optional[str] = 'en'

class TTSResponse(BaseModel):
    success: bool
    audio: Optional[str] = None  # base64 encoded
    format: str
    sample_rate: int
    duration: float
    voice: str

class VoiceListResponse(BaseModel):
    voices: List[dict]
    count: int

class HealthResponse(BaseModel):
    status: str
    model: str
    voices: int
    languages: List[str]

# Global pipeline cache
pipeline_cache = {}

def get_pipeline(lang_code):
    """Get or create Kokoro pipeline for lang code."""
    if lang_code in pipeline_cache:
        return pipeline_cache[lang_code]
    
    try:
        from kokoro import KPipeline
        pipeline = KPipeline(lang_code=lang_code)
        pipeline_cache[lang_code] = pipeline
        return pipeline
    except Exception as e:
        print(f"Failed to load pipeline for {lang_code}: {e}")
        return None

@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="healthy",
        model="kokoro-82M",
        voices=len(VOICE_CATALOG),
        languages=list(set(v['lang'] for v in VOICE_CATALOG.values()))
    )

@app.get("/voices", response_model=VoiceListResponse)
async def list_voices():
    return VoiceListResponse(
        voices=[
            {"id": k, **v} for k, v in VOICE_CATALOG.items()
        ],
        count=len(VOICE_CATALOG)
    )

@app.get("/voices/{voice_id}")
async def get_voice(voice_id: str):
    if voice_id not in VOICE_CATALOG:
        raise HTTPException(status_code=404, detail=f"Voice {voice_id} not found")
    return {"id": voice_id, **VOICE_CATALOG[voice_id]}

@app.post("/synthesize", response_model=TTSResponse)
async def synthesize(request: TTSRequest):
    """Synthesize speech using Kokoro."""
    
    # Resolve language
    lang = request.language.lower() if request.language else 'en'
    lang_code = LANG_MAP.get(lang, 'a')
    
    # Validate voice
    if request.voice not in VOICE_CATALOG:
        raise HTTPException(
            status_code=400,
            detail=f"Voice '{request.voice}' not found. Available: {list(VOICE_CATALOG.keys())[:10]}..."
        )
    
    voice_info = VOICE_CATALOG[request.voice]
    
    # Get pipeline
    pipeline = get_pipeline(lang_code)
    if pipeline is None:
        raise HTTPException(status_code=503, detail="TTS model not available")
    
    try:
        # Generate audio
        audio_segments = []
        
        for gs, ps, audio in pipeline(request.text, voice=request.voice, speed=request.speed):
            audio_segments.append(audio)
        
        if not audio_segments:
            raise HTTPException(status_code=500, detail="No audio generated")
        
        # Concatenate all segments
        final_audio = np.concatenate(audio_segments)
        
        # Convert to WAV
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            sf.write(f.name, final_audio, 24000)
            audio_bytes = f.read()
            os.unlink(f.name)
        
        # Encode to base64
        audio_b64 = base64.b64encode(audio_bytes).decode('utf-8')
        
        # Calculate duration
        duration = len(final_audio) / 24000
        
        return TTSResponse(
            success=True,
            audio=audio_b64,
            format='wav',
            sample_rate=24000,
            duration=duration,
            voice=request.voice
        )
    
    except Exception as e:
        print(f"Synthesis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/synthesize-stream")
async def synthesize_stream(request: TTSRequest):
    """Stream synthesis - returns audio chunks as they're generated."""
    
    lang = request.language.lower() if request.language else 'en'
    lang_code = LANG_MAP.get(lang, 'a')
    
    if request.voice not in VOICE_CATALOG:
        raise HTTPException(status_code=400, detail=f"Voice {request.voice} not found")
    
    pipeline = get_pipeline(lang_code)
    if pipeline is None:
        raise HTTPException(status_code=503, detail="TTS model not available")
    
    try:
        chunks = []
        for gs, ps, audio in pipeline(request.text, voice=request.voice, speed=request.speed):
            # Convert chunk to bytes
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
                sf.write(f.name, audio, 24000)
                chunk_bytes = f.read()
                os.unlink(f.name)
            chunks.append(base64.b64encode(chunk_bytes).decode('utf-8'))
        
        return {"success": True, "chunks": chunks, "voice": request.voice}
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    import os
    
    port = int(os.environ.get("PORT", 8081))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")