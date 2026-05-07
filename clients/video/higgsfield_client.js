/**
 * Higgsfield AI Client
 * Supports: Text-to-Image, Image-to-Video (Flux, Kling, Sora, Veo, etc.)
 *
 * Auth: KEY_ID:KEY_SECRET format (from platform.higgsfield.ai)
 * Free: Self-hosted open-source alternative (Open-Generative-AI by Anil-matcha)
 * Docs: https://github.com/higgsfield-ai/higgsfield-js
 *
 * Free rotation position: #1 (FREE - self-hosted option available)
 * Note: Higgsfield cloud API IS NOT FREE. The open-source self-hosted version is free.
 */

const https = require('https');

class HiggsfieldClient {
  constructor(credentials) {
    // Credentials format: KEY_ID:KEY_SECRET
    if (credentials && credentials.includes(':')) {
      const [keyId, keySecret] = credentials.split(':');
      this.keyId = keyId;
      this.keySecret = keySecret;
      this.credentials = credentials;
    } else {
      this.keyId = credentials;
      this.keySecret = '';
      this.credentials = credentials;
    }
    this.baseUrl = 'https://platform.higgsfield.ai';
    this.timeout = 120000;
  }

  /**
   * Generate content via Higgsfield subscribe() API
   * @param {string} endpoint - e.g. 'flux-pro/kontext/max/text-to-image'
   * @param {object} input - Input parameters
   * @param {object} [options] - { withPolling, webhook }
   * @returns {Promise<object>}
   */
  async subscribe(endpoint, input, options = {}) {
    const {
      withPolling = true,
      webhook,
    } = options;

    let endpointPath = endpoint;
    if (webhook) {
      endpointPath += `?hf_webhook=${encodeURIComponent(webhook.url)}`;
    }

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ input });
      const reqOptions = {
        hostname: 'platform.higgsfield.ai',
        path: `/${endpointPath.replace(/^\//, '')}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Key ${this.credentials}`,
          'User-Agent': 'higgsfield-server-js/2.0',
        },
        timeout: this.timeout,
      };

      const req = https.request(reqOptions, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 202) {
            try {
              const data = JSON.parse(responseBody);
              const jobSet = this._parseJobSet(data);
              
              if (withPolling && !jobSet.isCompleted) {
                this._pollJobSet(jobSet).then(resolve).catch(reject);
              } else {
                resolve(jobSet);
              }
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}: ${responseBody}`));
            }
          } else {
            reject(new Error(`Higgsfield API error ${res.statusCode}: ${responseBody}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Text-to-Image generation
   * @param {object} params
   * @param {string} params.prompt - Text description (required)
   * @param {string} [params.aspectRatio='1:1'] - '1:1'|'9:16'|'16:9'|'4:3'
   * @param {string} [params.model='flux-pro/kontext/max/text-to-image']
   * @param {number} [params.safetyTolerance=2]
   * @param {number} [params.seed]
   * @returns {Promise<object>}
   */
  async textToImage(params = {}) {
    const {
      prompt,
      aspectRatio = '1:1',
      model = 'flux-pro/kontext/max/text-to-image',
      safetyTolerance = 2,
      seed,
    } = params;

    if (!prompt) throw new Error('Prompt is required');

    const input = {
      prompt,
      aspect_ratio: aspectRatio,
      safety_tolerance: safetyTolerance,
      ...(seed !== undefined && { seed }),
    };

    return this.subscribe(model, input);
  }

  /**
   * Text-to-Video generation
   * @param {object} params
   * @param {string} params.prompt - Text description (required)
   * @param {string} [params.aspectRatio='16:9']
   * @param {string} [params.duration] - Duration in seconds
   * @param {string} [params.model] - Video model endpoint
   * @returns {Promise<object>}
   */
  async textToVideo(params = {}) {
    const {
      prompt,
      aspectRatio = '16:9',
      duration,
      model = '/v1/image2video/dop',
    } = params;

    if (!prompt) throw new Error('Prompt is required');

    const input = {
      model: 'dop-turbo',
      prompt,
      input_images: [],
      ...(aspectRatio && { aspect_ratio: aspectRatio }),
    };

    return this.subscribe(model, input);
  }

  /**
   * Image-to-Video generation
   * @param {object} params
   * @param {string} params.imageUrl - Reference image URL (required)
   * @param {string} [params.prompt] - Additional description
   * @param {string} [params.aspectRatio]
   * @param {string} [params.model='/v1/image2video/dop']
   * @returns {Promise<object>}
   */
  async imageToVideo(params = {}) {
    const {
      imageUrl,
      prompt = '',
      aspectRatio = '16:9',
      model = '/v1/image2video/dop',
    } = params;

    if (!imageUrl) throw new Error('imageUrl is required');

    const input = {
      model: 'dop-turbo',
      prompt: prompt || 'Cinematic camera movement',
      input_images: [{
        type: 'image_url',
        image_url: imageUrl,
      }],
      ...(aspectRatio && { aspect_ratio: aspectRatio }),
    };

    return this.subscribe(model, input);
  }

  /**
   * Poll a job set for completion
   * @param {object} jobSet - Job set from subscribe()
   * @param {number} [maxWaitMs=300000]
   * @param {number} [intervalMs=2000]
   * @returns {Promise<object>}
   */
  async _pollJobSet(jobSet, maxWaitMs = 300000, intervalMs = 2000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this._checkStatus(jobSet.id);

      if (status.isCompleted) return status;
      if (status.isFailed || status.isNsfw) {
        return { ...status, success: false };
      }

      await this._sleep(intervalMs);
    }

    return { ...jobSet, success: false, status: 'timeout' };
  }

  /**
   * Check job status
   * @param {string} requestId
   * @returns {Promise<object>}
   */
  async _checkStatus(requestId) {
    return new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: 'platform.higgsfield.ai',
        path: `/requests/${requestId}/status`,
        method: 'GET',
        headers: {
          'Authorization': `Key ${this.credentials}`,
          'User-Agent': 'higgsfield-server-js/2.0',
        },
        timeout: 30000,
      };

      const req = https.request(reqOptions, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              resolve(this._parseJobSet(data));
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}`));
            }
          } else {
            reject(new Error(`Higgsfield status error ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  /**
   * Parse API response into JobSet format
   */
  _parseJobSet(data) {
    const isCompleted = data.status === 'completed';
    const isFailed = data.status === 'failed';
    const isNsfw = data.status === 'nsfw';
    const isQueued = data.status === 'queued';
    const isInProgress = data.status === 'in_progress';

    let results = null;
    if (isCompleted) {
      if (data.video?.url) {
        results = { raw: { url: data.video.url }, min: { url: data.video.url } };
      } else if (data.images?.length > 0) {
        results = { raw: { url: data.images[0].url }, min: { url: data.images[0].url } };
      }
    }

    return {
      id: data.request_id,
      success: isCompleted,
      status: data.status,
      isCompleted,
      isFailed,
      isNsfw,
      isQueued,
      isInProgress,
      jobs: [{
        id: data.request_id,
        results,
        raw: data,
      }],
    };
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      return new Promise((resolve) => {
        const reqOptions = {
          hostname: 'platform.higgsfield.ai',
          path: '/requests/test-status',
          method: 'GET',
          headers: {
            'Authorization': `Key ${this.credentials}`,
            'User-Agent': 'higgsfield-server-js/2.0',
          },
          timeout: 10000,
        };

        const req = https.request(reqOptions, (res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            // 404 means auth passed but endpoint doesn't exist (that's fine for health)
            resolve({
              success: res.statusCode !== 401 && res.statusCode !== 403,
              provider: 'higgsfield',
              status: res.statusCode === 401 ? 'auth_failed' : 'ok',
              code: res.statusCode,
            });
          });
        }));
        req.on('error', e => resolve({ success: false, provider: 'higgsfield', error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ success: false, provider: 'higgsfield', status: 'timeout' }); });
        req.end();
      });
    } catch (e) {
      return { success: false, provider: 'higgsfield', error: e.message };
    }
  }
}

module.exports = { HiggsfieldClient };
