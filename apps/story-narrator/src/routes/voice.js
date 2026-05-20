/**
 * Voice Routes - Unified voice catalog
 */

const express = require('express');
const router = express.Router();

// Complete voice catalog
const VOICE_CATALOG = {
  // Kokoro voices (54 voices, 9 languages)
  kokoro: {
    'American English': {
      'af_heart': { gender: 'f', description: 'Warm, friendly female' },
      'af_nicole': { gender: 'f', description: 'Professional female' },
      'af_sarah': { gender: 'f', description: 'Clear, articulate female' },
      'af_sky': { gender: 'f', description: 'Young, energetic female' },
      'af_bella': { gender: 'f', description: 'Soft, gentle female' },
      'af_scallop': { gender: 'f', description: 'Smooth, flowing female' },
      'am_adam': { gender: 'm', description: 'Deep, authoritative male' },
      'am_anthony': { gender: 'm', description: 'Strong, confident male' },
      'am_fenris': { gender: 'm', description: 'Bold, dynamic male' },
      'am_michael': { gender: 'm', description: 'Warm, trustworthy male' }
    },
    'British English': {
      'bf_alice': { gender: 'f', description: 'Elegant British female' },
      'bf_emma': { gender: 'f', description: 'Sophisticated female' },
      'bf_lily': { gender: 'f', description: 'Natural British female' },
      'bm_daniel': { gender: 'm', description: 'Refined British male' },
      'bm_george': { gender: 'm', description: 'Distinguished male' },
      'bm_lewis': { gender: 'm', description: 'Classic British male' }
    },
    'Spanish': {
      'ef_iyera': { gender: 'f', description: 'Spanish female' },
      'em_alvaro': { gender: 'm', description: 'Spanish male' },
      'em_pedro': { gender: 'm', description: 'Latin Spanish male' }
    },
    'French': {
      'ff_siwis': { gender: 'f', description: 'French female' }
    },
    'Hindi': {
      'hf_niya': { gender: 'f', description: 'Hindi female' },
      'hf_priya': { gender: 'f', description: 'Warm Hindi female' },
      'hm_arpit': { gender: 'm', description: 'Hindi male' },
      'hm_rahul': { gender: 'm', description: 'Deep Hindi male' }
    },
    'Italian': {
      'if_chiara': { gender: 'f', description: 'Italian female' },
      'im_alessandro': { gender: 'm', description: 'Italian male' }
    },
    'Japanese': {
      'jf_abigail': { gender: 'f', description: 'Japanese female' },
      'jf_miyu': { gender: 'f', description: 'Japanese female' },
      'jm_ken': { gender: 'm', description: 'Japanese male' },
      'jm_masaru': { gender: 'm', description: 'Japanese male' },
      'jm_osamu': { gender: 'm', description: 'Japanese male' }
    },
    'Portuguese': {
      'pf_dora': { gender: 'f', description: 'Portuguese female' },
      'pm_alberto': { gender: 'm', description: 'Portuguese male' },
      'pm_carlos': { gender: 'm', description: 'Brazilian male' }
    },
    'Mandarin': {
      'zf_yunxi': { gender: 'f', description: 'Mandarin female' },
      'zf_yunxia': { gender: 'f', description: 'Mandarin female' },
      'zm_yunyang': { gender: 'm', description: 'Mandarin male' }
    }
  },
  
  // Celebrity XTTS voices
  celebrity: {
    morgan_freeman: { gender: 'm', language: 'en', archetype: 'narrator' },
    tom_cruise: { gender: 'm', language: 'en', archetype: 'hero' },
    amitabh_bachchan: { gender: 'm', language: 'hi', archetype: 'wise_elder' },
    shah_rukh_khan: { gender: 'm', language: 'hi', archetype: 'romantic' },
    sandra_bullock: { gender: 'f', language: 'en', archetype: 'villain' },
    alia_bhatt: { gender: 'f', language: 'hi', archetype: 'female_lead' }
  }
};

// Get total voice count
function countVoices(catalog) {
  let count = 0;
  for (const lang of Object.values(catalog.kokoro)) {
    count += Object.keys(lang).length;
  }
  return count;
}

/**
 * Get all voices
 */
router.get('/', (req, res) => {
  const kokoroCount = countVoices(VOICE_CATALOG);
  
  res.json({
    providers: {
      kokoro: {
        count: kokoroCount,
        languages: Object.keys(VOICE_CATALOG.kokoro)
      },
      celebrity: {
        count: Object.keys(VOICE_CATALOG.celebrity).length,
        voices: VOICE_CATALOG.celebrity
      }
    },
    total_voices: kokoroCount + Object.keys(VOICE_CATALOG.celebrity).length
  });
});

/**
 * Get voices by language
 */
router.get('/language/:lang', (req, res) => {
  const { lang } = req.params;
  const langKey = lang.charAt(0).toUpperCase() + lang.slice(1).toLowerCase();
  
  const voices = VOICE_CATALOG.kokoro[langKey];
  
  if (!voices) {
    return res.status(404).json({
      error: `Language ${lang} not found`,
      available: Object.keys(VOICE_CATALOG.kokoro)
    });
  }
  
  res.json({
    language: lang,
    voices: Object.entries(voices).map(([id, info]) => ({ id, ...info }))
  });
});

/**
 * Get voices by gender
 */
router.get('/gender/:gender', (req, res) => {
  const { gender } = req.params;
  
  const result = {};
  for (const [lang, voices] of Object.entries(VOICE_CATALOG.kokoro)) {
    const filtered = Object.entries(voices)
      .filter(([_, info]) => info.gender === gender)
      .map(([id, info]) => ({ id, language: lang, ...info }));
    
    if (filtered.length > 0) {
      result[lang] = filtered;
    }
  }
  
  res.json({ gender, voices: result });
});

/**
 * Get specific voice info
 */
router.get('/:voiceId', (req, res) => {
  const { voiceId } = req.params;
  
  // Search Kokoro
  for (const [lang, voices] of Object.entries(VOICE_CATALOG.kokoro)) {
    if (voices[voiceId]) {
      return res.json({
        id: voiceId,
        provider: 'kokoro',
        language: lang,
        ...voices[voiceId]
      });
    }
  }
  
  // Search celebrity
  if (VOICE_CATALOG.celebrity[voiceId]) {
    return res.json({
      id: voiceId,
      provider: 'celebrity',
      ...VOICE_CATALOG.celebrity[voiceId]
    });
  }
  
  res.status(404).json({
    error: `Voice ${voiceId} not found`,
    available: {
      kokoro: Object.keys(VOICE_CATALOG.kokoro).flatMap(l => Object.keys(VOICE_CATALOG.kokoro[l])),
      celebrity: Object.keys(VOICE_CATALOG.celebrity)
    }
  });
});

module.exports = router;