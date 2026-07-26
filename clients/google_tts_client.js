/**
 * Google Cloud Text-to-Speech Client
 *
 * Generates high-quality native speech using Google Cloud TTS.
 * Supports 80+ languages with WaveNet voices for superior quality.
 */

const https = require('https');

class GoogleTTSClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = 'https://texttospeech.googleapis.com';
  }

  /**
     * Synthesize speech using Google Cloud TTS
     * @param {string} text - Text to convert to speech
     * @param {string} language - Language code ('hi', 'bn', 'en')
     * @param {string} voiceType - Voice type ('standard' or 'wavenet')
     * @returns {Promise<Buffer>} Audio buffer (MP3 format)
     */
  async synthesize(text, language = 'hi', voiceType = 'standard') {
    const langVoiceMap = {
      'hi': {
        'standard': 'hi-IN-Standard-A',
        'wavenet': 'hi-IN-Wavenet-A'
      },
      'bn': {
        'standard': 'bn-IN-Standard-A',
        'wavenet': 'bn-IN-Wavenet-A'
      },
      'en': {
        'standard': 'en-US-Standard-B',
        'wavenet': 'en-US-Wavenet-B'
      }
    };

    const voiceName = langVoiceMap[language]?.[voiceType] || langVoiceMap['hi']['standard'];
    const langCode = language === 'hi' ? 'hi-IN' : language === 'bn' ? 'bn-IN' : 'en-US';

    console.log(`🎙️  Google TTS: Generating ${language} audio (${voiceType}) for "${text.substring(0, 50)}..."`);

    const requestData = {
      input: { text: text },
      voice: {
        languageCode: langCode,
        name: voiceName
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 1.0,
        pitch: 0.0
      }
    };

    return new Promise((resolve, reject) => {
      const data = JSON.stringify(requestData);

      const options = {
        hostname: this.baseURL,
        path: `/v1/text:synthesize?key=${this.apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 15000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(body);

            if (response.audioContent) {
              const audioBuffer = Buffer.from(response.audioContent, 'base64');

              console.log(`✅ Google TTS: Generated ${audioBuffer.length} bytes of MP3 audio`);
              resolve(audioBuffer);
            } else if (response.error) {
              reject(new Error(`Google TTS Error: ${response.error.message}`));
            } else {
              reject(new Error('No audio content in response'));
            }
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Google TTS request timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  /**
     * Synthesize with automatic voice type selection based on text length
     * @param {string} text - Text to convert
     * @param {string} language - Language code
     * @returns {Promise<Buffer>} Audio buffer
     */
  async synthesizeAuto(text, language = 'hi') {
    // Use WaveNet for longer texts (better quality), Standard for short (faster)
    const voiceType = text.length > 100 ? 'wavenet' : 'standard';
    return await this.synthesize(text, language, voiceType);
  }

  /**
     * Synthesize and save audio to file
     * @param {string} text - Text to convert
     * @param {string} outputPath - Where to save the audio file
     * @param {string} language - Language code
     * @returns {Promise<string>} Path to saved audio file
     */
  async synthesizeToFile(text, outputPath, language = 'hi') {
    const audioBuffer = await this.synthesizeAuto(text, language);

    // Ensure directory exists
    const dir = require('path').dirname(outputPath);
    require('fs').mkdirSync(dir, { recursive: true });

    // Write audio file
    require('fs').writeFileSync(outputPath, audioBuffer);

    console.log(`💾 Google TTS: Saved audio to ${outputPath}`);
    return outputPath;
  }
}

module.exports = GoogleTTSClient;
