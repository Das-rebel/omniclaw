#!/usr/bin/env python3
"""
Kokoro-82M TTS Server — ONNX int8 port for 1GB RAM droplets.
API-compatible with the original torch-based tts_server.py.
Uses kokoro-onnx (pure onnxruntime, no torch).
Lazy model load + 15-min idle unload to keep steady RAM low.
"""
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from typing import Optional, List
import asyncio
import base64
import io
import os
import threading
import time

import soundfile as sf
import numpy as np

MODEL_DIR = os.environ.get("KOKORO_MODEL_DIR",
    "/opt/story-narrator/kokoro/models")
MODEL_PATH = os.path.join(MODEL_DIR, "kokoro-v1_0.int8.onnx")
VOICES_PATH = os.path.join(MODEL_DIR, "voices-v1_0.bin")

app = FastAPI(title="Kokoro TTS Service", version="2.0.0-onnx")

# ---- Voice catalog — VERIFIED against voices-v1.0.bin (54 real voices) ----
_REAL = """af_alloy,af_aoede,af_bella,af_heart,af_jessica,af_kore,af_nicole,af_nova,af_river,af_sarah,af_sky,
am_adam,am_echo,am_eric,am_fenrir,am_liam,am_michael,am_onyx,am_puck,am_santa,
bf_alice,bf_emma,bf_isabella,bf_lily,bm_daniel,bm_fable,bm_george,bm_lewis,
ef_dora,em_alex,em_santa,ff_siwis,hf_alpha,hf_beta,hm_omega,hm_psi,
if_sara,im_nicola,jf_alpha,jf_gongitsune,jf_nezumi,jf_tebukuro,jm_kumo,
pf_dora,pm_alex,pm_santa,zf_xiaobei,zf_xiaoni,zf_xiaoxiao,zf_xiaoyi,zm_yunjian,zm_yunxi,zm_yunxia,zm_yunyang"""
VOICE_CATALOG = {}
for _n in [v.strip() for v in _REAL.replace("\n", ",").split(",") if v.strip()]:
    VOICE_CATALOG[_n] = {"lang": _n[0], "gender": _n[1]}
LANG_MAP = {
    'en': 'a', 'american': 'a', 'american english': 'a', 'british': 'b', 'british english': 'b',
    'es': 'e', 'spanish': 'e', 'fr': 'f', 'french': 'f', 'hi': 'h', 'hindi': 'h',
    'it': 'i', 'italian': 'i', 'ja': 'j', 'japanese': 'j', 'pt': 'p', 'portuguese': 'p',
    'zh': 'z', 'mandarin': 'z', 'chinese': 'z',
    'h': 'h', 'hi-in': 'h', 'hi_in': 'h', 'hindi-in': 'h',
}

def _resolve_lang(requested, voice):
    """Resolve the espeak language for a synthesis request.

    Hindi voices (hf_/hm_) are ALWAYS phonemized as Hindi. With an en-us
    voice, espeak cannot read Devanagari and falls back to speaking the
    language tags literally — 'hi ... en-us' becomes audible in the output.
    For Hindi voices the voice wins over the requested language.
    """
    if isinstance(voice, str) and voice.startswith(('hf_', 'hm_')):
        return 'h'
    lang = (requested or '').lower()
    return LANG_MAP.get(lang, 'a')


class TTSRequest(BaseModel):
    text: str
    voice: str = 'af_heart'
    speed: float = 1.0
    language: Optional[str] = 'en'

class TTSResponse(BaseModel):
    success: bool
    audio: Optional[str] = None
    format: str
    sample_rate: int
    duration: float
    voice: str

# ---- Lazy model management ----
_state = {"kokoro": None, "last_used": 0.0}
_lock = threading.Lock()  # serialize synthesis (onnxruntime session)
IDLE_UNLOAD_S = int(os.environ.get("KOKORO_IDLE_UNLOAD_S", "900"))
MUT = threading.Lock()  # guards _state dict

def _get_kokoro():
    with MUT:
        if _state["kokoro"] is None:
            from kokoro_onnx import Kokoro
            t0 = time.time()
            _state["kokoro"] = Kokoro(MODEL_PATH, VOICES_PATH)
            print(f"[kokoro] model loaded in {time.time()-t0:.1f}s")
        _state["last_used"] = time.time()
        return _state["kokoro"]

def _maybe_unload():
    with MUT:
        k = _state["kokoro"]
        if k is not None and time.time() - _state["last_used"] > IDLE_UNLOAD_S:
            _state["kokoro"] = None
            print("[kokoro] idle >%ds, model unloaded" % IDLE_UNLOAD_S)
            import gc; gc.collect()

@app.on_event("startup")
async def _bg():
    async def sweep():
        while True:
            await asyncio.sleep(60)
            _maybe_unload()
    asyncio.create_task(sweep())

@app.get("/health")
async def health():
    loaded = _state["kokoro"] is not None
    return {"status": "healthy", "model": "kokoro-82M-onnx-int8", "voices": len(VOICE_CATALOG),
            "languages": sorted(set(v['lang'] for v in VOICE_CATALOG.values())), "model_loaded": loaded}

@app.get("/voices")
async def list_voices():
    return {"voices": [{"id": k, **v} for k, v in VOICE_CATALOG.items()], "count": len(VOICE_CATALOG)}

@app.get("/voices/{voice_id}")
async def get_voice(voice_id: str):
    if voice_id not in VOICE_CATALOG:
        raise HTTPException(status_code=404, detail=f"Voice {voice_id} not found")
    return {"id": voice_id, **VOICE_CATALOG[voice_id]}

LANG_LOCALE = {'a': 'en-us', 'b': 'en-gb', 'e': 'es-es', 'f': 'fr-fr', 'h': 'hi',
               'i': 'it-it', 'j': 'ja', 'p': 'pt-br', 'z': 'cmn'}

def _synth(text: str, voice: str, speed: float, lang_code: str):
    """Runs in threadpool (blocking onnx call)."""
    with _lock:
        k = _get_kokoro()
        audio, sr = k.create(text, voice=voice, speed=speed, lang=LANG_LOCALE.get(lang_code, 'en-us'))
        return np.asarray(audio, dtype=np.float32), sr

def _wav_b64(audio: np.ndarray, sr: int) -> str:
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    return base64.b64encode(buf.getvalue()).decode()

@app.post("/synthesize", response_model=TTSResponse)
async def synthesize(request: TTSRequest):
    lang = (request.language or 'en').lower()
    lang_code = _resolve_lang(lang, request.voice)
    if request.voice not in VOICE_CATALOG:
        raise HTTPException(400, f"Voice '{request.voice}' not found. Available: {list(VOICE_CATALOG)[:10]}...")
    if not os.path.exists(MODEL_PATH):
        raise HTTPException(503, "TTS model files missing")
    try:
        audio, sr = await run_in_threadpool(_synth, request.text, request.voice, request.speed, lang_code)
        if audio is None or len(audio) == 0:
            raise HTTPException(500, "No audio generated")
        return TTSResponse(success=True, audio=_wav_b64(audio, sr), format='wav',
                           sample_rate=sr, duration=len(audio) / sr, voice=request.voice)
    except HTTPException:
        raise
    except Exception as e:
        print(f"Synthesis error: {e}")
        raise HTTPException(500, str(e))

@app.post("/synthesize-stream")
async def synthesize_stream(request: TTSRequest):
    lang = (request.language or 'en').lower()
    lang_code = _resolve_lang(lang, request.voice)
    if request.voice not in VOICE_CATALOG:
        raise HTTPException(400, f"Voice '{request.voice}' not found")
    try:
        audio, sr = await run_in_threadpool(_synth, request.text, request.voice, request.speed, lang_code)
        return {"success": True, "chunks": [_wav_b64(audio, sr)], "voice": request.voice}
    except Exception as e:
        raise HTTPException(500, str(e))

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8081))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
