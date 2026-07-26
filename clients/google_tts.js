/**
 * Google Cloud Text-to-Speech Client
 * Native Hindi and Bengali pronunciation
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

class GoogleTTSClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://texttospeech.googleapis.com';

    // Language mappings
    this.voiceMap = {
      'hi': 'hi-IN',      // Hindi
      'bn': 'bn-IN',      // Bengali
      'en': 'en-US'       // English
    };

    // Voice preferences
    this.voices = {
      'hi': 'hi-IN-Wavenet', // Hindi - High quality
      'bn': 'bn-IN-Wavenet', // Bengali - High quality
      'en': 'en-US-Neural2'  // English - High quality
    };
  }

  /**
     * Synthesize speech to audio file
     */
  async synthesize(text, language, outputPath) {
    const voice = this.voices[language] || this.voices['en'];

    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        input: { text: text },
        voice: {
          languageCode: this.voiceMap[language],
          name: voice
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 0.95,
          pitch: 0
        }
      });

      const options = {
        hostname: this.baseUrl,
        path: `/v1/text:synthesize?key=${this.apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(body);

              // Decode base64 audio
              const audioBuffer = Buffer.from(response.audioContent, 'base64');

              // Write to file
              fs.writeFileSync(outputPath, audioBuffer);

              resolve({
                success: true,
                audioPath: outputPath,
                duration: response.timeDetails || null
              });
            } catch (error) {
              reject(new Error(`Parse error: ${error.message}`));
            }
          } else {
            reject(new Error(`API error ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  /**
     * Get SSML with lang tag for better pronunciation
     * Fallback if API fails
     */
  static getLocalizedSSML(text, language) {
    const langMap = {
      'hi': 'hi-IN',
      'bn': 'bn-IN',
      'en': 'en-US'
    };

    const lang = langMap[language] || 'en-US';

    // Wrap text in lang tag for better pronunciation
    return `<speak><lang xml:lang="${lang}">${text}</lang></speak>`;
  }
}

module.exports = GoogleTTSClient;
