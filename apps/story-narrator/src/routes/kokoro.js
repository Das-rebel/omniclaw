/**
 * Kokoro TTS Routes
 * Handles Kokoro-82M TTS synthesis via Python subprocess
 */

const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');

// Hindi voices (hf_/hm_) must always be phonemized as Hindi: espeak with an
// en-us voice cannot read Devanagari and speaks the language tags aloud
// ('hi ... en-us' becomes audible). The voice wins over the request.
const resolveLang = (language, voice) => {
  if (typeof voice === 'string' && /^(hf_|hm_)/.test(voice)) return 'hi';
  return language || 'en';
};


const KOKORO_PORT = process.env.KOKORO_PORT || 8081;
const KOKORO_HOST = process.env.KOKORO_HOST || 'localhost';

// Voice catalog — verified against voices-v1.0.bin (54 real voices)
const KOKORO_VOICES = [
  // American English
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  // British English
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
  // Spanish / French
  'ef_dora', 'em_alex', 'em_santa', 'ff_siwis',
  // Hindi (real v1.0 pack voices)
  'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
  // Italian / Japanese
  'if_sara', 'im_nicola', 'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo',
  // Portuguese / Mandarin
  'pf_dora', 'pm_alex', 'pm_santa', 'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
  'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang'
];

// Language mapping for Kokoro
const LANG_MAP = {
  'en': 'american', 'american': 'american',
  'british': 'british',
  'es': 'spanish', 'spanish': 'spanish',
  'fr': 'french', 'french': 'french',
  'hi': 'hindi', 'hindi': 'hindi',
  'it': 'italian', 'italian': 'italian',
  'ja': 'japanese', 'japanese': 'japanese',
  'pt': 'portuguese', 'portuguese': 'portuguese',
  'zh': 'mandarin', 'mandarin': 'mandarin', 'chinese': 'mandarin'
};

// Spawn Python Kokoro server
let kokoroProcess = null;

function startKokoroServer() {
  if (kokoroProcess) return;
  
  const kokoroPath = path.join(__dirname, '../../kokoro/tts_server.py');
  kokoroProcess = spawn('python3', [kokoroPath], {
    env: { ...process.env, PORT: KOKORO_PORT }
  });
  
  kokoroProcess.stdout.on('data', d => console.log('[Kokoro]', d.toString().trim()));
  kokoroProcess.stderr.on('data', d => console.error('[Kokoro Error]', d.toString().trim()));
  
  console.log('Kokoro TTS server starting...');
}

// Initialize Kokoro server (skipped when KOKORO_EXTERNAL=1 — e.g. systemd-managed python service)
if (process.env.KOKORO_EXTERNAL === '1') {
  console.log(`[Kokoro] external mode: expecting TTS server at ${KOKORO_HOST}:${KOKORO_PORT}`);
} else {
  startKokoroServer();
}

// List available voices
router.get('/voices', (req, res) => {
  res.json({
    voices: KOKORO_VOICES.map(v => ({ id: v, provider: 'kokoro' })),
    count: KOKORO_VOICES.length,
    languages: Object.keys(LANG_MAP)
  });
});

// Get specific voice info
router.get('/voices/:voiceId', (req, res) => {
  const { voiceId } = req.params;
  if (!KOKORO_VOICES.includes(voiceId)) {
    return res.status(404).json({ error: `Voice ${voiceId} not found` });
  }
  res.json({ id: voiceId, provider: 'kokoro' });
});

// Health check for Kokoro service
router.get('/health', async (req, res) => {
  try {
    const http = require('http');
    const options = { hostname: KOKORO_HOST, port: KOKORO_PORT, path: '/health', method: 'GET', timeout: 2000 };
    
    const promise = new Promise((resolve, reject) => {
      const req = http.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ status: 'unknown' }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', reject);
      req.end();
    });
    
    const health = await promise;
    res.json({ status: 'healthy', kokoro: health });
  } catch (error) {
    res.json({ status: 'unavailable', kokoro: { error: error.message } });
  }
});

// Synthesize with Kokoro
router.post('/synthesize', async (req, res) => {
  const { text, voice = 'af_heart', speed = 1.0, language: _requestedLang = 'en' } = req.body;
  const language = resolveLang(_requestedLang, voice);
  
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }
  
  if (!KOKORO_VOICES.includes(voice)) {
    return res.status(400).json({ 
      error: `Voice ${voice} not found`,
      available: KOKORO_VOICES.slice(0, 10)
    });
  }
  
  try {
    const http = require('http');
    const postData = JSON.stringify({ text, voice, speed, language });
    
    const options = {
      hostname: KOKORO_HOST,
      port: KOKORO_PORT,
      path: '/synthesize',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 120000
    };
    
    const promise = new Promise((resolve, reject) => {
      const req = http.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { resolve({ audio: data }); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', reject);
      req.write(postData);
      req.end();
    });
    
    const result = await promise;
    res.json(result);
    
  } catch (error) {
    console.error('Kokoro synthesis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stream synthesis
router.post('/synthesize-stream', async (req, res) => {
  const { text, voice = 'af_heart', speed = 1.0, language: _requestedLang = 'en' } = req.body;
  const language = resolveLang(_requestedLang, voice);
  
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }
  
  try {
    const http = require('http');


    const postData = JSON.stringify({ text, voice, speed, language });
    
    const options = {
      hostname: KOKORO_HOST,
      port: KOKORO_PORT,
      path: '/synthesize-stream',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 120000
    };
    
    const promise = new Promise((resolve, reject) => {
      const req = http.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ chunks: [data] }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', reject);
      req.write(postData);
      req.end();
    });
    
    const result = await promise;
    res.json(result);
    
  } catch (error) {
    console.error('Kokoro stream error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;