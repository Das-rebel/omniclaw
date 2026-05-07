/**
 * Runware Video Generation Client
 * Supports: Seedance 1.0 Pro, 1.5 Pro, 2.0, 2.0 Fast
 *
 * API Base: https://api.runware.ai/v1
 * Auth: Bearer token or x-api-key header
 * Free tier: $2 credits on signup
 * Docs: https://runware.ai/docs
 */

const https = require('https');

class RunwareClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'api.runware.ai';
    this.version = 'v1';
    
    // Model AIR IDs
    this.MODELS = {
      SEEDANCE_1_PRO: 'bytedance:2@1',
      SEEDANCE_1_PRO_FAST: 'bytedance:2@2',
      SEEDANCE_1_5_PRO: 'bytedance:seedance@1.5-pro',
      SEEDANCE_2: 'bytedance:seedance@2.0',
      SEEDANCE_2_FAST: 'bytedance:seedance@2.0-fast',
    };
    
    this.DEFAULT_MODEL = this.MODELS.SEEDANCE_2_FAST;
    this.timeout = 120000; // 2 min for video generation
  }

  /**
   * Generate video from text prompt
   * @param {object} params 
   * @param {string} params.prompt - Text description (2-3000 chars)
   * @param {string} [params.model] - Model AIR ID (default: Seedance 2.0 Fast)
   * @param {number} [params.width] - Output width (default: 1280)
   * @param {number} [params.height] - Output height (default: 720)
   * @param {number} [params.duration] - Duration in seconds 1-15 (default: 5)
   * @param {string} [params.resolution] - Preset: '480p'|'720p'|'1080p'|'auto'
   * @param {string[]} [params.referenceImages] - Reference image URLs
   * @param {string[]} [params.referenceVideos] - Reference video URLs
   * @param {string[]} [params.referenceAudios] - Reference audio URLs
   * @param {boolean} [params.audio] - Generate audio (default: false)
   * @param {number} [params.seed] - Random seed
   * @param {string} [params.outputFormat] - 'MP4'|'WEBM'|'MOV' (default: MP4)
   * @param {string} [params.webhookUrl] - Webhook URL for async callback
   * @param {string} [params.apiKey] - Override API key
   * @returns {Promise<object>} - { requestId, status, videoUrl, cost }
   */
  async textToVideo(params = {}) {
    const {
      prompt,
      model = this.DEFAULT_MODEL,
      width = 1280,
      height = 720,
      duration = 5,
      resolution,
      referenceImages = [],
      referenceVideos = [],
      referenceAudios = [],
      audio = false,
      seed,
      outputFormat = 'MP4',
      webhookUrl,
      apiKey = this.apiKey,
    } = params;

    if (!prompt) throw new Error('Prompt is required for text-to-video');
    if (!apiKey) throw new Error('Runware API key is required');

    const taskUUID = this._generateUUID();
    
    const requestBody = [
      // Auth task
      { taskType: 'authentication', apiKey },
      // Video inference task
      {
        taskType: 'videoInference',
        taskUUID,
        model,
        positivePrompt: prompt,
        width,
        height,
        duration,
        outputFormat,
        outputType: 'URL',
        deliveryMethod: 'async',
        ...(seed !== undefined && { seed }),
        ...(resolution && { resolution }),
        ...(webhookUrl && { webhookURL: webhookUrl }),
        ...(referenceImages.length > 0 && {
          inputs: {
            referenceImages: referenceImages.map(img => ({ image: img }))
          }
        }),
        ...(referenceVideos.length > 0 && {
          inputs: {
            referenceVideos: referenceVideos.map(vid => ({ video: vid }))
          }
        }),
        ...(referenceAudios.length > 0 && {
          inputs: {
            referenceAudios: referenceAudios.map(aud => ({ audio: aud }))
          }
        }),
        ...(audio && {
          providerSettings: {
            bytedance: { audio: true }
          }
        })
      }
    ];

    return this._makeRequest(requestBody, taskUUID);
  }

  /**
   * Generate video from reference image
   * @param {object} params
   * @param {string} params.imageUrl - Reference image URL (required)
   * @param {string} params.prompt - Description (optional, enhances the image)
   * @param {string} [params.model] - Model AIR ID
   * @param {number} [params.width]
   * @param {number} [params.height]
   * @param {number} [params.duration] - 1-15 seconds
   * @param {boolean} [params.audio]
   * @param {string} [params.apiKey]
   * @returns {Promise<object>}
   */
  async imageToVideo(params = {}) {
    const {
      imageUrl,
      prompt = '',
      model = this.DEFAULT_MODEL,
      width = 1280,
      height = 720,
      duration = 5,
      audio = false,
      apiKey = this.apiKey,
    } = params;

    if (!imageUrl) throw new Error('imageUrl is required for image-to-video');
    if (!apiKey) throw new Error('Runware API key is required');

    const taskUUID = this._generateUUID();
    
    const requestBody = [
      { taskType: 'authentication', apiKey },
      {
        taskType: 'videoInference',
        taskUUID,
        model,
        positivePrompt: prompt,
        width,
        height,
        duration,
        outputType: 'URL',
        deliveryMethod: 'async',
        inputs: {
          referenceImages: [{ image: imageUrl }]
        },
        ...(audio && {
          providerSettings: {
            bytedance: { audio: true }
          }
        })
      }
    ];

    return this._makeRequest(requestBody, taskUUID);
  }

  /**
   * Poll for video generation result
   * @param {string} taskUUID - Task UUID from textToVideo/imageToVideo
   * @param {string} [params.apiKey]
   * @returns {Promise<object>} - { status, videoUrl, cost }
   */
  async getResult(taskUUID, params = {}) {
    const apiKey = params.apiKey || this.apiKey;
    if (!apiKey) throw new Error('Runware API key is required');
    if (!taskUUID) throw new Error('taskUUID is required');

    const body = [
      { taskType: 'authentication', apiKey },
      { taskType: 'getResponse', taskUUID }
    ];

    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const reqOptions = {
        hostname: this.baseUrl,
        path: `/${this.version}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 30000
      };

      const req = https.request(reqOptions, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(body);
            const taskData = response.data?.find(d => d.taskUUID === taskUUID);
            
            if (!taskData) {
              resolve({ status: 'unknown', taskUUID });
              return;
            }

            if (taskData.status === 'success') {
              resolve({
                success: true,
                status: 'completed',
                taskUUID,
                videoUrl: taskData.videoURL,
                videoUUID: taskData.videoUUID,
                cost: taskData.cost,
                seed: taskData.seed,
                timings: taskData.timings
              });
            } else if (taskData.status === 'error') {
              resolve({
                success: false,
                status: 'error',
                taskUUID,
                error: taskData.error || 'Generation failed'
              });
            } else {
              resolve({
                success: true,
                status: taskData.status, // 'processing' | 'queued' | etc
                taskUUID
              });
            }
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(data);
      req.end();
    });
  }

  /**
   * Wait for video generation to complete with polling
   * @param {string} taskUUID 
   * @param {object} params
   * @param {number} [params.maxWaitMs=120000] - Max wait time
   * @param {number} [params.intervalMs=5000] - Poll interval
   * @param {string} [params.apiKey]
   * @returns {Promise<object>}
   */
  async waitForCompletion(taskUUID, params = {}) {
    const {
      maxWaitMs = 120000,
      intervalMs = 5000,
      apiKey = this.apiKey
    } = params;

    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.getResult(taskUUID, { apiKey });
      
      if (result.status === 'completed') {
        return result;
      }
      
      if (result.status === 'error') {
        return result;
      }

      await this._sleep(intervalMs);
    }

    return {
      success: false,
      status: 'timeout',
      taskUUID,
      error: `Timed out after ${maxWaitMs}ms`
    };
  }

  /**
   * Full text-to-video with polling: submit → wait → return URL
   * @param {object} params
   * @returns {Promise<object>}
   */
  async generateVideo(params = {}) {
    const { requestId, ...rest } = await this.textToVideo(params);
    return this.waitForCompletion(requestId, rest);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  _makeRequest(body, taskUUID) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const reqOptions = {
        hostname: this.baseUrl,
        path: `/${this.version}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: this.timeout
      };

      const req = https.request(reqOptions, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(responseBody);
              const taskData = response.data?.find(d => d.taskUUID === taskUUID);
              
              if (taskData) {
                resolve({
                  success: true,
                  requestId: taskUUID,
                  status: taskData.status || 'submitted',
                  videoUrl: taskData.videoURL,
                  videoUUID: taskData.videoUUID,
                  cost: taskData.cost
                });
              } else {
                resolve({
                  success: true,
                  requestId: taskUUID,
                  status: 'submitted',
                  rawResponse: response
                });
              }
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}: ${responseBody}`));
            }
          } else {
            reject(new Error(`Runware API error ${res.statusCode}: ${responseBody}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(data);
      req.end();
    });
  }

  _generateUUID() { return require("crypto").randomUUID(); }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const testUUID = this._generateUUID();
      const body = [
        { taskType: 'authentication', apiKey: this.apiKey }
      ];
      const data = JSON.stringify(body);
      
      return new Promise((resolve) => {
        const reqOptions = {
          hostname: this.baseUrl,
          path: `/${this.version}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          timeout: 10000
        };

        const req = https.request(reqOptions, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve({ success: true, provider: 'runware', status: 'ok' });
            } else {
              resolve({ success: false, provider: 'runware', status: 'error', code: res.statusCode });
            }
          });
        });
        req.on('error', e => resolve({ success: false, provider: 'runware', status: 'error', error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ success: false, provider: 'runware', status: 'timeout' }); });
        req.write(data);
        req.end();
      });
    } catch (e) {
      return { success: false, provider: 'runware', status: 'error', error: e.message };
    }
  }
}

module.exports = { RunwareClient };
