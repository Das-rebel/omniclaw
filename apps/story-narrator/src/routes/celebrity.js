/**
 * Celebrity XTTS Routes
 * Celebrity voice synthesis using XTTS-v2
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');

const CELEBRITY_TTS_URL = process.env.CELEBRITY_TTS_URL || 'https://celebrity-tts-338789220059.asia-south1.run.app';

// Celebrity configuration
const CELEBRITIES = {
  morgan_freeman: { archetype: 'narrator', language: 'en', gender: 'm' },
  tom_cruise: { archetype: 'hero', language: 'en', gender: 'm' },
  amitabh_bachchan: { archetype: 'wise_elder', language: 'hi', gender: 'm' },
  shah_rukh_khan: { archetype: 'romantic', language: 'hi', gender: 'm' },
  sandra_bullock: { archetype: 'villain', language: 'en', gender: 'f' },
  alia_bhatt: { archetype: 'female_lead', language: 'hi', gender: 'f' }
};

// Celebrity to Kokoro voice mapping (for fallback)
const CELEBRITY_KOKORO_MAP = {
  morgan_freeman: 'bm_daniel',
  tom_cruise: 'am_michael',
  amitabh_bachchan: 'hm_rahul',
  shah_rukh_khan: 'hm_arpit',
  sandra_bullock: 'af_nicole',
  alia_bhatt: 'hf_priya'
};

/**
 * List available celebrities
 */
router.get('/', (req, res) => {
  res.json({
    celebrities: Object.entries(CELEBRITIES).map(([name, info]) => ({
      id: name,
      ...info
    })),
    count: Object.keys(CELEBRITIES).length
  });
});

/**
 * Get specific celebrity info
 */
router.get('/:celebrityId', (req, res) => {
  const { celebrityId } = req.params;
  
  if (!CELEBRITIES[celebrityId]) {
    return res.status(404).json({
      error: `Celebrity ${celebrityId} not found`,
      available: Object.keys(CELEBRITIES)
    });
  }
  
  res.json({
    id: celebrityId,
    ...CELEBRITIES[celebrityId],
    kokoro_voice: CELEBRITY_KOKORO_MAP[celebrityId]
  });
});

/**
 * Health check for celebrity TTS service
 */
router.get('/health', async (req, res) => {
  try {
    const response = await axios.get(`${CELEBRITY_TTS_URL}/health`, { timeout: 3000 });
    res.json({ status: 'healthy', celebrity_tts: response.data });
  } catch (error) {
    res.json({ 
      status: 'unavailable', 
      error: error.message,
      fallback_available: true,
      kokoro_voices: CELEBRITY_KOKORO_MAP
    });
  }
});

/**
 * Synthesize with celebrity voice via XTTS
 */
router.post('/synthesize', async (req, res) => {
  const { text, celebrity, language = 'en' } = req.body;
  
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }
  
  if (!celebrity || !CELEBRITIES[celebrity]) {
    return res.status(400).json({
      error: `Invalid celebrity`,
      available: Object.keys(CELEBRITIES)
    });
  }
  
  try {
    // Try celebrity TTS service first
    const response = await axios.post(
      `${CELEBRITY_TTS_URL}/synthesize`,
      { text, celebrity, language },
      { timeout: 30000, responseType: 'arraybuffer' }
    );
    
    res.json({
      success: true,
      audio: Buffer.from(response.data).toString('base64'),
      format: 'wav',
      sample_rate: 24000,
      celebrity,
      source: 'xtts'
    });
    
  } catch (error) {
    console.warn('XTTS unavailable, using Kokoro fallback:', error.message);
    
    // Fallback to Kokoro
    const kokoroVoice = CELEBRITY_KOKORO_MAP[celebrity];
    
    res.json({
      success: true,
      audio: null,
      format: 'wav',
      kokoro_voice: kokoroVoice,
      celebrity,
      source: 'kokoro_fallback',
      message: 'XTTS unavailable, use /api/kokoro/synthesize with kokoro_voice'
    });
  }
});

/**
 * Synthesize by archetype (auto-select celebrity)
 */
router.post('/synthesize-by-archetype', async (req, res) => {
  const { text, archetype, language = 'en' } = req.body;
  
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }
  
  // Find celebrity by archetype
  const celebrityEntry = Object.entries(CELEBRITIES).find(([_, info]) => info.archetype === archetype);
  
  if (!celebrityEntry) {
    return res.status(400).json({
      error: `Archetype ${archetype} not found`,
      available: [...new Set(Object.values(CELEBRITIES).map(i => i.archetype))]
    });
  }
  
  const [celebrity] = celebrityEntry;
  
  // Forward to synthesize
  req.body.celebrity = celebrity;
  return router.post('/synthesize')(req, res);
});

module.exports = router;