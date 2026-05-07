/**
 * MuAPI (ArtCraft) Video Generation Client
 * Supports: Seedance 2.0 (T2V, I2V, Omni-Reference, Video Edit, Character)
 *
 * API Base: https://api.muapi.ai/api/v1
 * Auth: x-api-key header
 * Pricing: $0.18-0.30/sec (NOT free)
 * Docs: https://muapi.ai | https://github.com/Anil-matcha/Seedance-2.0-API
 */

const https = require('https');

class MuAPIArtCraftClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'api.muapi.ai';
    this.version = 'v1';

    // Endpoints
    this.ENDPOINTS = {
      SEEDANCE_2_T2V: '/seedance-v2.0-t2v',
      SEEDANCE_2_I2V: '/seedance-v2.0-i2v',
      SEEDANCE_2_OMNI: '/seedance-2.0-omni-reference',
      SEEDANCE_2_CHAR: '/seedance-2-character',
      SEEDANCE_2_EDIT: '/seedance-v2.0-video-edit',
      PREDICTIONS: '/predictions',
    };

    this.timeout = 180000; // 3 min for video
  }

  /**
   * Text-to-Video generation
   * @param {object} params
   * @param {string} params.prompt - Text description (required)
   * @param {string} [params.aspectRatio='16:9'] - '16:9'|'9:16'|'4:3'|'1:1'
   * @param {number} [params.duration=5] - 1-10 seconds
   * @param {string} [params.quality='high'] - 'basic'|'high'
   * @param {string} [params.resolution='720p'] - '480p'|'720p'|'1080p'
   * @param {string} [params.apiKey]
   * @returns {Promise<object>} - { requestId, status }
   */
  async textToVideo(params = {}) {
    const {
      prompt,
      aspectRatio = '16:9',
      duration = 5,
      quality = 'high',
      resolution = '720p',
      apiKey = this.apiKey,
    } = params;

    if (!prompt) throw new Error('Prompt is required');
    if (!apiKey) throw new Error('MuAPI API key is required');

    const body = {
      prompt,
      aspect_ratio: aspectRatio,
      duration,
      quality,
      resolution,
    };

    return this._post(this.ENDPOINTS.SEEDANCE_2_T2V, body, apiKey);
  }

  /**
   * Image-to-Video generation
   * @param {object} params
   * @param {string} params.imageUrl - Reference image URL (required)
   * @param {string} [params.prompt] - Additional description
   * @param {string} [params.aspectRatio]
   * @param {number} [params.duration]
   * @param {string} [params.quality]
   * @param {string} [params.apiKey]
   * @returns {Promise<object>}
   */
  async imageToVideo(params = {}) {
    const {
      imageUrl,
      prompt = '',
      aspectRatio = '16:9',
      duration = 5,
      quality = 'high',
      apiKey = this.apiKey,
    } = params;

    if (!imageUrl) throw new Error('imageUrl is required');
    if (!apiKey) throw new Error('MuAPI API key is required');

    const body = {
      image_url: imageUrl,
      prompt,
      aspect_ratio: aspectRatio,
      duration,
      quality,
    };

    return this._post(this.ENDPOINTS.SEEDANCE_2_I2V, body, apiKey);
  }

  /**
   * Poll for prediction result
   * @param {string} requestId
   * @param {string} [params.apiKey]
   * @returns {Promise<object>}
   */
  async getResult(requestId, params = {}) {
    const apiKey = params.apiKey || this.apiKey;
    if (!apiKey) throw new Error('MuAPI API key is required');

    return new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: this.baseUrl,
        path: `/${this.version}/predictions/${requestId}/result`,
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'Accept': 'application/json'
        },
        timeout: 30000
      };

      const req = https.request(reqOptions, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              resolve({
                success: true,
                status: data.status,
                requestId,
                videoUrl: data.outputs?.[0],
                outputs: data.outputs,
                raw: data
              });
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}`));
            }
          } else {
            reject(new Error(`MuAPI error ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  /**
   * Wait for video completion
   * @param {string} requestId
   * @param {object} params
   * @param {number} [params.maxWaitMs=180000]
   * @param {number} [params.intervalMs=5000]
   * @returns {Promise<object>}
   */
  async waitForCompletion(requestId, params = {}) {
    const {
      maxWaitMs = 180000,
      intervalMs = 5000,
      apiKey = this.apiKey
    } = params;

    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.getResult(requestId, { apiKey });
      if (result.status === 'completed') return result;
      if (result.status === 'failed') return { ...result, success: false };
      await this._sleep(intervalMs);
    }

    return { success: false, status: 'timeout', requestId };
  }

  /**
   * Full generate + wait
   */
  async generateVideo(params = {}) {
    const { requestId } = await this.textToVideo(params);
    return this.waitForCompletion(requestId, params);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _post(endpoint, body, apiKey) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const reqOptions = {
        hostname: this.baseUrl,
        path: `/${this.version}${endpoint}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        timeout: this.timeout
      };

      const req = https.request(reqOptions, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 201) {
            try {
              const response = JSON.parse(responseBody);
              resolve({
                success: true,
                requestId: response.request_id,
                status: response.status || 'submitted',
                rawResponse: response
              });
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}: ${responseBody}`));
            }
          } else {
            reject(new Error(`MuAPI error ${res.statusCode}: ${responseBody}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) });
      req.write(data);
      req.end();
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async healthCheck() {
    try {
      return new Promise((resolve) => {
        const reqOptions = {
          hostname: this.baseUrl,
          path: `/${this.version}/models`,
          method: 'GET',
          headers: { 'x-api-key': this.apiKey },
          timeout: 10000
        };
        const req = https.request(reqOptions, (res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve({
            success: res.statusCode === 200,
            provider: 'muapi-artcraft',
            status: res.statusCode === 200 ? 'ok' : 'error'
          }));
        }));
        req.on('error', e => resolve({ success: false, provider: 'muapi-artcraft', error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ success: false, provider: 'muapi-artcraft', status: 'timeout' }); });
        req.end();
      });
    } catch (e) {
      return { success: false, provider: 'muapi-artcraft', error: e.message };
    }
  }
}

module.exports = { MuAPIArtCraftClient };
