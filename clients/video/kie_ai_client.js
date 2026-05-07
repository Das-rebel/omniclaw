/**
 * Kie.ai API Client for OmniClaw
 * Seedance 2.0 Video Generation API
 * Docs: https://docs.kie.ai | Market: https://kie.ai/seedance-2-0
 *
 * Auth: Bearer token (https://kie.ai/api-key)
 * Base URL: https://api.kie.ai/api/v1
 *
 * Free/Trial Models (no paid credits needed):
 *   - bytedance/seedance-2-fast (Seedance 2.0 Fast)
 *   - bytedance/seedance-2 (Seedance 2.0 Standard)
 *
 * Pricing (Seedance 2.0):
 *   480P: $0.0575/s (with video) | $0.095/s (no video)
 *   720P: $0.125/s (with video) | $0.205/s (no video)
 *   1080P: $0.31/s (with video) | $0.51/s (no video)
 *
 *   Seedance 2.0 Fast: same structure, ~4 min generation
 */

const BASE_URL = 'https://api.kie.ai/api/v1';

class KieAiClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('Kie.ai API key required');
    this.apiKey = apiKey;
    this.baseUrl = BASE_URL;

    // Free models (don't consume paid credits)
    this.FREE_MODELS = [
      'bytedance/seedance-2-fast',
      'bytedance/seedance-2',
      'doubao/seedance-2-fast',
      'doubao/seedance-2',
    ];

    // All supported models
    this.MODELS = {
      'seedance-2-fast': 'bytedance/seedance-2-fast',
      'seedance-2': 'bytedance/seedance-2',
      'seedance-1.5-pro': 'bytedance/seedance-1.5-pro',
      'seedance-1.5': 'bytedance/seedance-1.5',
      'seedance-1-pro': 'bytedance/seedance-1-pro',
    };
  }

  _headers(extra = {}) {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  /**
   * Get free credits remaining
   */
  async getFreeCredits() {
    try {
      const res = await fetch(`${this.baseUrl}/user/freeCredits`, {
        method: 'GET',
        headers: this._headers(),
      });
      if (res.ok) {
        return res.json();
      }
    } catch {}
    return { freeCredits: null };
  }

  /**
   * Check account info
   */
  async getAccountInfo() {
    const res = await fetch(`${this.baseUrl}/user/info`, {
      method: 'GET',
      headers: this._headers(),
    });
    if (!res.ok) throw new Error(`Kie.ai API error ${res.status}`);
    return res.json();
  }

  /**
   * Generate video from text prompt
   * @param {Object} params
   * @param {string} params.prompt - Text prompt for video generation
   * @param {string} [params.model='bytedance/seedance-2-fast'] - Model name
   * @param {string} [params.resolution='720p'] - 480p | 720p | 1080p
   * @param {string} [params.aspect_ratio='16:9'] - 16:9 | 4:3 | 1:1 | 3:4 | 9:16 | 21:9
   * @param {number} [params.duration=5] - Duration in seconds (4-15)
   * @param {boolean} [params.generate_audio=false] - Generate synchronized AI audio
   * @param {boolean} [params.web_search=false] - Use online search
   * @param {boolean} [params.nsfw_checker=false] - Enable NSFW filter
   * @param {string[]} [params.reference_image_urls] - Input image URLs for I2V
   * @param {string[]} [params.reference_video_urls] - Input video URLs (max 3, total ≤15s)
   * @param {string[]} [params.reference_audio_urls] - Input audio URLs for rhythm guidance
   * @param {string} [params.first_frame_url] - First frame image URL
   * @param {string} [params.last_frame_url] - Last frame image URL
   * @param {string} [params.callBackUrl] - Webhook callback URL
   * @param {boolean} [params.useFreeModel=true] - Auto-select free model if available
   * @returns {Promise<Object>} { taskId, status }
   */
  async generateVideo({
    prompt,
    model,
    resolution = '720p',
    aspect_ratio = '16:9',
    duration = 5,
    generate_audio = false,
    web_search = false,
    nsfw_checker = false,
    reference_image_urls = [],
    reference_video_urls = [],
    reference_audio_urls = [],
    first_frame_url,
    last_frame_url,
    callBackUrl,
    useFreeModel = true,
  } = {}) {
    if (!prompt) throw new Error('prompt is required');
    if (duration < 4 || duration > 15) throw new Error('duration must be 4-15 seconds');

    // Select model: use provided model, or auto-select free model
    let selectedModel = model || 'bytedance/seedance-2-fast';

    // Build input payload
    const input = {
      prompt,
      resolution,
      aspect_ratio: aspect_ratio,
      duration: String(duration),
      generate_audio: String(generate_audio),
      web_search: String(web_search),
      nsfw_checker: String(nsfw_checker),
    };

    if (reference_image_urls?.length) input.reference_image_urls = reference_image_urls;
    if (reference_video_urls?.length) input.reference_video_urls = reference_video_urls;
    if (reference_audio_urls?.length) input.reference_audio_urls = reference_audio_urls;
    if (first_frame_url) input.first_frame_url = first_frame_url;
    if (last_frame_url) input.last_frame_url = last_frame_url;

    const payload = {
      model: selectedModel,
      input,
    };

    if (callBackUrl) payload.callBackUrl = callBackUrl;

    const res = await fetch(`${this.baseUrl}/jobs/createTask`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ msg: res.statusText }));
      throw new Error(`Kie.ai API error ${res.status}: ${err.msg || JSON.stringify(err)}`);
    }

    const data = await res.json();
    return {
      taskId: data.data?.taskId,
      status: data.data?.status || 'submitted',
      model: selectedModel,
      isFree: this.FREE_MODELS.includes(selectedModel),
      ...data,
    };
  }

  /**
   * Query task status and result
   * @param {string} taskId - Task ID from generateVideo response
   * @returns {Promise<Object>} Task status and result URL
   */
  async getTaskResult(taskId) {
    if (!taskId) throw new Error('taskId is required');

    const res = await fetch(`${this.baseUrl}/jobs/queryTask?taskId=${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: this._headers(),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ msg: res.statusText }));
      throw new Error(`Kie.ai API error ${res.status}: ${err.msg || JSON.stringify(err)}`);
    }

    return res.json();
  }

  /**
   * Wait for task completion with polling
   * @param {string} taskId - Task ID
   * @param {Object} [opts]
   * @param {number} [opts.maxWait=600] - Max wait time in seconds (default 10 min)
   * @param {number} [opts.interval=15] - Poll interval in seconds
   * @returns {Promise<Object>} Completed task result
   */
  async waitForTask(taskId, { maxWait = 600, interval = 15 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxWait * 1000) {
      const result = await this.getTaskResult(taskId);
      const status = result.data?.status || result.status;

      if (status === 'completed' || status === 'success') {
        return result;
      }
      if (status === 'failed' || status === 'error') {
        throw new Error(`Task failed: ${result.data?.error || result.msg || 'unknown'}`);
      }
      if (status === 'pending' || status === 'processing') {
        await new Promise(r => setTimeout(r, interval * 1000));
        continue;
      }
      // Unknown status, wait and retry
      await new Promise(r => setTimeout(r, interval * 1000));
    }
    throw new Error(`Task timeout after ${maxWait}s`);
  }

  /**
   * Text-to-Video shorthand
   */
  t2v(prompt, opts = {}) {
    return this.generateVideo({ prompt, ...opts });
  }

  /**
   * Image-to-Video shorthand
   * @param {string} prompt - Text prompt
   * @param {string[]} imageUrls - Input image URLs
   */
  i2v(prompt, imageUrls, opts = {}) {
    return this.generateVideo({ prompt, reference_image_urls: imageUrls, ...opts });
  }

  /**
   * Video-to-Video shorthand
   * @param {string} prompt - Text prompt
   * @param {string[]} videoUrls - Input video URLs
   */
  v2v(prompt, videoUrls, opts = {}) {
    return this.generateVideo({ prompt, reference_video_urls: videoUrls, ...opts });
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const info = await this.getAccountInfo();
      return { success: true, status: 'ok', account: info };
    } catch (err) {
      return { success: false, status: 'error', error: err.message };
    }
  }
}

module.exports = { KieAiClient };
