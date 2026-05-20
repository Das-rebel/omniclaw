/**
 * Kokoro TTS Routes
 * Handles Kokoro-82M TTS synthesis via Python subprocess
 */

const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');

const KOKORO_PORT = process.env.KOKORO_PORT || 8081;
const KOKORO_HOST = process.env.KOKORO_HOST || 'localhost';

// Voice catalog - validated against Kokoro voices
const KOKORO_VOICES = [
  // American English
  'af_heart', 'af_nicole', 'af_sarah', 'af_sky', 'af_bella', 'af_scallop',
  'am_adam', 'am_anthony', 'am_fenris', 'am_michael',
  // British English
  'bf_alice', 'bf_emma', 'bf_lily', 'bm_daniel', 'bm_george', 'bm_lewis',
  // Spanish
  'ef_iyera', 'em_alvaro', 'em_pedro',
  // French
  'ff_siwis',
  // Hindi
  'hf_niya', 'hf_priya', 'hm_arpit', 'hm_rahul',
  // Italian
  'if_chiara', 'im_alessandro',
  // Japanese
  'jf_abigail', 'jf_miyu', 'jm_ken', 'jm_masaru', 'jm_osamu',
  // Portuguese
  'pf_dora', 'pm_alberto', 'pm_carlos',
  // Mandarin
  'zf_yunxi', 'zf_yunxia', 'zm_yunyang'
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

// Initialize Kokoro server
startKokoroServer();

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
  const { text, voice = 'af_heart', speed = 1.0, language = 'en' } = req.body;
  
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
      timeout: 30000
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
  const { text, voice = 'af_heart', speed = 1.0, language = 'en' } = req.body;
  
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
      timeout: 30000
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