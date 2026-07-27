/**
 * Whisper API Client for Audio Transcription
 * Supports OpenAI Whisper API
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

class WhisperClient {
  constructor(apiKey = process.env.OPENAI_API_KEY || '') {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.openai.com/v1';
    this.model = 'whisper-1';
  }

  async transcribe(audioUrlOrPath, options = {}) {
    try {
      const { language, prompt, temperature = 0 } = options;
      
      // If it's a URL, download first
      let filePath = audioUrlOrPath;
      let isTempFile = false;
      
      if (audioUrlOrPath.startsWith('http')) {
        const response = await axios.get(audioUrlOrPath, { responseType: 'arraybuffer' });
        filePath = `/tmp/audio_${Date.now()}.ogg`;
        fs.writeFileSync(filePath, response.data);
        isTempFile = true;
      }
      
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath), {
        filename: path.basename(filePath),
        contentType: 'audio/ogg'
      });
      form.append('model', this.model);
      if (language) form.append('language', language);
      if (prompt) form.append('prompt', prompt);
      form.append('temperature', temperature.toString());
      form.append('response_format', 'text');

      const result = await axios.post(`${this.baseUrl}/audio/transcriptions`, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${this.apiKey}`
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });

      // Cleanup temp file
      if (isTempFile && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      return {
        success: true,
        text: result.data,
        language: result.data.language || language || null
      };
    } catch (err) {
      console.error('Whisper transcription error:', err.message);
      return {
        success: false,
        error: err.message
      };
    }
  }

  // Download audio from WhatsApp and transcribe
  async transcribeWhatsAppAudio(downloadUrl, apiToken, options = {}) {
    try {
      // Download audio from WhatsApp
      const response = await axios({
        method: 'get',
        url: downloadUrl,
        headers: {
          'Authorization': `Bearer ${apiToken}`
        },
        responseType: 'arraybuffer'
      });

      const tempPath = `/tmp/wa_audio_${Date.now()}.ogg`;
      fs.writeFileSync(tempPath, response.data);

      const result = await this.transcribe(tempPath, options);

      // Cleanup
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }

      return result;
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }
}

module.exports = WhisperClient;
