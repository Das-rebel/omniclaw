/**
 * Story Narrator Client for Alexa Bridge
 * Handles communication with Story Narrator Cloud Run service
 */

const https = require('https');

class StoryNarratorClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint || process.env.STORY_NARRATOR_ENDPOINT || 'https://omniclaw-story-narrator-338789220059.asia-south1.run.app';
    // Enhanced endpoint for Kokoro voices (when deployed)
    this.enhancedEndpoint = options.enhancedEndpoint || process.env.STORY_NARRATOR_ENHANCED_ENDPOINT || 'https://story-narrator-338789220059.asia-south1.run.app';
    this.timeout = options.timeout || 60000;
  }

  // Kokoro voice catalog (54 voices, 9 languages)
  static KOKORO_VOICES = {
    // American English
    af_heart: { lang: 'a', gender: 'f', name: 'American Female - Heart' },
    af_nicole: { lang: 'a', gender: 'f', name: 'American Female - Nicole' },
    af_sarah: { lang: 'a', gender: 'f', name: 'American Female - Sarah' },
    af_sky: { lang: 'a', gender: 'f', name: 'American Female - Sky' },
    af_bella: { lang: 'a', gender: 'f', name: 'American Female - Bella' },
    am_adam: { lang: 'a', gender: 'm', name: 'American Male - Adam' },
    am_michael: { lang: 'a', gender: 'm', name: 'American Male - Michael' },
    // British English
    bf_emma: { lang: 'b', gender: 'f', name: 'British Female - Emma' },
    bm_daniel: { lang: 'b', gender: 'm', name: 'British Male - Daniel' },
    bm_george: { lang: 'b', gender: 'm', name: 'British Male - George' },
    // Spanish
    ef_iyera: { lang: 'e', gender: 'f', name: 'Spanish Female - Iyera' },
    em_alvaro: { lang: 'e', gender: 'm', name: 'Spanish Male - Alvaro' },
    // French
    ff_siwis: { lang: 'f', gender: 'f', name: 'French Female - Siwis' },
    // Hindi
    hf_niya: { lang: 'h', gender: 'f', name: 'Hindi Female - Niya' },
    hf_priya: { lang: 'h', gender: 'f', name: 'Hindi Female - Priya' },
    hm_arpit: { lang: 'h', gender: 'm', name: 'Hindi Male - Arpit' },
    hm_rahul: { lang: 'h', gender: 'm', name: 'Hindi Male - Rahul' },
    // Italian
    if_chiara: { lang: 'i', gender: 'f', name: 'Italian Female - Chiara' },
    im_alessandro: { lang: 'i', gender: 'm', name: 'Italian Male - Alessandro' },
    // Japanese
    jf_abigail: { lang: 'j', gender: 'f', name: 'Japanese Female - Abigail' },
    jm_ken: { lang: 'j', gender: 'm', name: 'Japanese Male - Ken' },
    // Portuguese
    pf_dora: { lang: 'p', gender: 'f', name: 'Portuguese Female - Dora' },
    pm_alberto: { lang: 'p', gender: 'm', name: 'Portuguese Male - Alberto' },
    // Mandarin
    zf_yunxi: { lang: 'z', gender: 'f', name: 'Mandarin Female - Yunxi' },
    zm_yunyang: { lang: 'z', gender: 'm', name: 'Mandarin Male - Yunyang' }
  };


  // Celebrity voices (XTTS-v2)
  static CELEBRITIES = {
    morgan_freeman: { archetype: 'narrator', language: 'en', gender: 'm' },
    tom_cruise: { archetype: 'hero', language: 'en', gender: 'm' },
    amitabh_bachchan: { archetype: 'wise_elder', language: 'hi', gender: 'm' },
    shah_rukh_khan: { archetype: 'romantic', language: 'hi', gender: 'm' },
    sandra_bullock: { archetype: 'villain', language: 'en', gender: 'f' },
    alia_bhatt: { archetype: 'female_lead', language: 'hi', gender: 'f' }
  };

  // Language code mapping
  static LANG_MAP = {
    en: 'american', american: 'american', british: 'british',
    es: 'spanish', spanish: 'spanish',
    fr: 'french', french: 'french',
    hi: 'hindi', hindi: 'hindi',
    it: 'italian', italian: 'italian',
    ja: 'japanese', japanese: 'japanese',
    pt: 'portuguese', portuguese: 'portuguese',
    zh: 'mandarin', mandarin: 'mandarin', chinese: 'mandarin'
  };

  async _makeRequest(path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.endpoint);
      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: this.timeout
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (res.headers['content-type']?.includes('audio')) {
              resolve({ audio: Buffer.from(data), contentType: res.headers['content-type'] });
            } else {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(data);
              }
            }
          } else {
            try {
              const error = JSON.parse(data);
              reject(new Error(error.error || `HTTP ${res.statusCode}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(JSON.stringify(body));
      req.end();
    });
  }

  async healthCheck() {
    try {
      const url = new URL('/health', this.endpoint);
      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'GET'
      };

      return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({ status: 'unknown' });
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    } catch (error) {
      return { status: 'error', error: error.message };
    }
  }

  async generateStory(config) {
    const { theme, setting, plotOutline, characters, language = 'hinglish' } = config;
    return this._makeRequest('/generate', { theme, setting, plotOutline, characters, language });
  }

  async narrate(config) {
    const { content, url, voice = 'NARRATOR', language = 'en' } = config;
    return this._makeRequest('/narrate', { content, url, voice, language });
  }

  async synthesize(config) {
    const { text, voice = 'NARRATOR', language = 'en' } = config;
    return this._makeRequest('/synthesize', { text, voice, language });
  }

  // Synthesize with Kokoro-82M voice
  // @param {string} text - Text to synthesize
  // @param {string} voiceId - Kokoro voice ID (e.g., 'af_heart', 'bm_daniel', 'hf_priya')
  // @param {string} language - Language code (en, hi, es, fr, etc.)
  // @param {number} speed - Speed (0.5 to 2.0)
  async synthesizeWithVoice(text, voiceId, language = 'en', speed = 1.0) {
    return this._makeRequest('/synthesize-kokoro', { text, voice: voiceId, language, speed });
  }

  // Narrate using celebrity voice (XTTS-v2)
  // @param {string} text - Text to synthesize
  // @param {string} celebrityName - Celebrity ID (morgan_freeman, tom_cruise, etc.)
  // @param {string} language - Language code
  async narrateByCelebrity(text, celebrityName, language = 'en') {
    return this._makeRequest('/synthesize-celebrity', { text, celebrity: celebrityName, language });
  }

  // Convert EPUB to audiobook segments
  // @param {string} epubUrl - URL or path to EPUB file
  // @param {string} voice - Archetype voice (narrator, hero, villain, wise_elder, etc.)
  // @param {string} language - Language code
  // @param {number} speed - Speed (0.5 to 2.0)
  async narrateEPUB(epubUrl, voice = 'narrator', language = 'en', speed = 1.0) {
    return this._makeRequest('/epub/convert', { epubUrl, voice, language, speed });
  }

  // Get EPUB metadata without full conversion
  async getEPUBMetadata(epubUrl) {
    return this._makeRequest('/epub/metadata', { epubUrl });
  }

  // List all available Kokoro voices
  listKokoroVoices() {
    return Object.entries(StoryNarratorClient.KOKORO_VOICES).map(([id, info]) => ({ id, ...info }));
  }

  // List all available celebrities
  listCelebrities() {
    return Object.entries(StoryNarratorClient.CELEBRITIES).map(([id, info]) => ({ id, ...info }));
  }

  // Generate story with enhanced options
  async generateEnhancedStory(config) {
    const { theme, setting, plotOutline, characters, language = 'hinglish', voiceStyle } = config;
    return this._makeRequest('/story/generate', { theme, setting, plotOutline, characters, language, voiceStyle });
  }

  // Synthesize entire story as audiobook
  async synthesizeStory(storyText, voice = 'narrator', language = 'en', speed = 1.0) {
    return this._makeRequest('/story/synthesize-story', { storyText, voice, language, speed });
  }
}

module.exports = StoryNarratorClient;
