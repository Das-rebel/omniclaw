/**
 * Wavespeed AI Video Generation Client
 * Updated: 2026-05-04 - Working API structure
 * 
 * Supports: WAN 2.1 (Text-to-Video, Image-to-Video), Seedance, Minimax
 * 
 * API Base: https://api.wavespeed.ai/api/v3
 * Auth: Bearer token in Authorization header
 * Docs: https://wavespeed.ai/docs
 */

const https = require('https');

class WavespeedClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'api.wavespeed.ai';
    this.apiPath = '/api/v3';
    
    // Working model endpoints (verified 2026-05-04)
    this.ENDPOINTS = {
      // WAN 2.1 Text-to-Video (most affordable)
      WAN_2_1_T2V_480P: '/wavespeed-ai/wan-2.1/t2v-480p',
      WAN_2_1_T2V_480P_ULTRA_FAST: '/wavespeed-ai/wan-2.1/t2v-480p-ultra-fast',
      WAN_2_1_T2V_720P: '/wavespeed-ai/wan-2.1/t2v-720p',
      WAN_2_1_T2V_720P_ULTRA_FAST: '/wavespeed-ai/wan-2.1/t2v-720p-ultra-fast',
      
      // WAN 2.1 Image-to-Video
      WAN_2_1_I2V_480P: '/wavespeed-ai/wan-2.1/i2v-480p',
      WAN_2_1_I2V_720P: '/wavespeed-ai/wan-2.1/i2v-720p',
      
      // WAN 2.1 with LoRA support
      WAN_2_1_T2V_480P_LORA: '/wavespeed-ai/wan-2.1/t2v-480p-lora',
      WAN_2_1_T2V_720P_LORA: '/wavespeed-ai/wan-2.1/t2v-720p-lora',
      
      // Minimax Video
      MINIMAX_VIDEO_01: '/minimax/video-01',
      
      // Seedance (if available)
      SEEDANCE_2_0_T2V: '/bytedance/seedance-2-0-fast/text-to-video',
      SEEDANCE_2_0_I2V: '/bytedance/seedance-2-0-fast/image-to-video',
      
      PREDICTIONS: '/predictions',
    };

    this.timeout = 120000;
  }

  /**
   * Generate video from text prompt (WAN 2.1 - most tested & affordable)
   * @param {object} params
   * @param {string} params.prompt - Scene description (required)
   * @param {number} [params.duration=5] - 5 or 10 seconds
   * @param {string} [params.model='wan-2.1/t2v-480p-ultra-fast'] - Model to use
   * @param {string} [params.negativePrompt] - What to avoid
   * @param {string} [params.size='832*480'] - Resolution (e.g., '832*480', '1280*720')
   * @param {number} [params.seed=-1] - Random seed (-1 for random)
   * @param {string} [params.apiKey]
   * @returns {Promise<object>} - { requestId, status }
   */
  async textToVideo(params = {}) {
    const {
      prompt,
      duration = 5,
      model = 'wan-2.1/t2v-480p-ultra-fast',
      negativePrompt = '',
      size = '832*480',
      seed = -1,
      apiKey = this.apiKey,
    } = params;

    if (!prompt) throw new Error('Prompt is required');
    if (!apiKey) throw new Error('Wavespeed API key is required');

    // Map model name to endpoint
    const endpoint = this._getEndpoint(model);
    
    const body = {
      prompt,
      duration,
      size,
      seed,
    };

    if (negativePrompt) {
      body.negative_prompt = negativePrompt;
    }

    return this._post(endpoint, body, apiKey);
  }

  /**
   * Generate video from reference image (WAN 2.1 I2V)
   * @param {object} params
   * @param {string} params.image - Image URL (required)
   * @param {string} params.prompt - Description of motion (required)
   * @param {number} [params.duration=5] - 5 or 10 seconds
   * @param {string} [params.model='wan-2.1/i2v-480p'] - Model to use
   * @param {string} [params.size='832*480'] - Resolution
   * @param {string} [params.apiKey]
   * @returns {Promise<object>}
   */
  async imageToVideo(params = {}) {
    const {
      image,
      prompt,
      duration = 5,
      model = 'wan-2.1/i2v-480p',
      size = '832*480',
      apiKey = this.apiKey,
    } = params;

    if (!image) throw new Error('Image URL is required');
    if (!prompt) throw new Error('Prompt is required for motion description');
    if (!apiKey) throw new Error('Wavespeed API key is required');

    const endpoint = this._getEndpoint(model);
    
    const body = {
      image,
      prompt,
      duration,
      size,
    };

    return this._post(endpoint, body, apiKey);
  }

  /**
   * Get prediction result
   * @param {string} requestId - Request ID from textToVideo/imageToVideo
   * @param {string} [params.apiKey]
   * @returns {Promise<object>} - { status, videoUrl, cost }
   */
  async getResult(requestId, params = {}) {
    const apiKey = params.apiKey || this.apiKey;
    if (!apiKey) throw new Error('Wavespeed API key is required');
    if (!requestId) throw new Error('requestId is required');

    return new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: this.baseUrl,
        path: `${this.apiPath}/predictions/${requestId}/result`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
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
              const response = JSON.parse(body);
              const data = response.data || response;
              
              resolve({
                success: true,
                status: data.status, // 'created'|'processing'|'completed'|'failed'
                requestId,
                videoUrls: data.outputs || [],
                videoUrl: data.outputs?.[0],
                cost: data.cost,
                timings: data.timings,
                raw: data
              });
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}`));
            }
          } else {
            reject(new Error(`Wavespeed API error ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  /**
   * Wait for video generation to complete
   * @param {string} requestId
   * @param {object} params
   * @param {number} [params.maxWaitMs=180000] - 3 min max
   * @param {number} [params.intervalMs=5000]
   * @param {string} [params.apiKey]
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

      if (result.status === 'completed') {
        return result;
      }
      if (result.status === 'failed') {
        return { ...result, success: false };
      }

      await this._sleep(intervalMs);
    }

    return {
      success: false,
      status: 'timeout',
      requestId,
      error: `Timed out after ${maxWaitMs}ms`
    };
  }

  /**
   * Full generate + wait: submit → poll → return URL
   * @param {object} params - Same as textToVideo
   * @returns {Promise<object>} - { videoUrl, requestId, duration }
   */
  async generateVideo(params = {}) {
    const { requestId } = await this.textToVideo(params);
    return this.waitForCompletion(requestId, params);
  }

  /**
   * Full image-to-video + wait
   * @param {object} params - Same as imageToVideo
   * @returns {Promise<object>}
   */
  async generateVideoFromImage(params = {}) {
    const { requestId } = await this.imageToVideo(params);
    return this.waitForCompletion(requestId, params);
  }

  // ─── Private helpers ─────────────────────────────────────────��─────────────

  _getEndpoint(model) {
    const endpointMap = {
      'wan-2.1/t2v-480p': this.ENDPOINTS.WAN_2_1_T2V_480P,
      'wan-2.1/t2v-480p-ultra-fast': this.ENDPOINTS.WAN_2_1_T2V_480P_ULTRA_FAST,
      'wan-2.1/t2v-720p': this.ENDPOINTS.WAN_2_1_T2V_720P,
      'wan-2.1/t2v-720p-ultra-fast': this.ENDPOINTS.WAN_2_1_T2V_720P_ULTRA_FAST,
      'wan-2.1/i2v-480p': this.ENDPOINTS.WAN_2_1_I2V_480P,
      'wan-2.1/i2v-720p': this.ENDPOINTS.WAN_2_1_I2V_720P,
      'wan-2.1/t2v-480p-lora': this.ENDPOINTS.WAN_2_1_T2V_480P_LORA,
      'wan-2.1/t2v-720p-lora': this.ENDPOINTS.WAN_2_1_T2V_720P_LORA,
      'minimax/video-01': this.ENDPOINTS.MINIMAX_VIDEO_01,
      'seedance-2.0': this.ENDPOINTS.SEEDANCE_2_0_T2V,
    };
    
    return endpointMap[model] || this.ENDPOINTS.WAN_2_1_T2V_480P_ULTRA_FAST;
  }

  _post(endpoint, body, apiKey) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const reqOptions = {
        hostname: this.baseUrl,
        path: `${this.apiPath}${endpoint}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
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
              const data = response.data || response;
              
              resolve({
                success: true,
                requestId: data.id,
                status: data.status,
                resultUrl: data.urls?.get,
                model: data.model,
                rawResponse: response
              });
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}: ${responseBody}`));
            }
          } else {
            reject(new Error(`Wavespeed API error ${res.statusCode}: ${responseBody}`));
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

  /**
   * Health check - list available models
   */
  async healthCheck() {
    try {
      return new Promise((resolve) => {
        const reqOptions = {
          hostname: this.baseUrl,
          path: `${this.apiPath}/models`,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Accept': 'application/json'
          },
          timeout: 10000
        };

        const req = https.request(reqOptions, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve({
                success: true,
                provider: 'wavespeed',
                status: 'ok',
                code: res.statusCode
              });
            } else {
              resolve({
                success: false,
                provider: 'wavespeed',
                status: 'error',
                code: res.statusCode
              });
            }
          });
        });
        req.on('error', e => resolve({ success: false, provider: 'wavespeed', status: 'error', error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ success: false, provider: 'wavespeed', status: 'timeout' }); });
        req.end();
      });
    } catch (e) {
      return { success: false, provider: 'wavespeed', status: 'error', error: e.message };
    }
  }
}

// Example usage:
// const { WavespeedClient } = require('./wavespeed_client.js');
// const client = new WavespeedClient('YOUR_API_KEY');
// 
// // Text-to-video
// const result = await client.generateVideo({
//   prompt: 'A person walking in a sunset, cinematic landscape',
//   duration: 5
// });
// console.log(result.videoUrl);
// 
// // Image-to-video  
// const result = await client.generateVideoFromImage({
//   image: 'https://example.com/image.jpg',
//   prompt: 'Make it wave gently',
//   duration: 5
// });

module.exports = { WavespeedClient };