/**
 * Unified Video Generation Client
 * Wraps: Kie.ai, Runware, Wavespeed, MuAPI/ArtCraft
 *
 * FREE ROTATION ORDER (--provider=auto):
 *   1. MuAPI/ArtCraft — Seedance 2.0 API (free tier, no credit card)
 *   2. Wavespeed (free credits on signup)
 *   3. Runware ($2 free credits)
 *   4. Kie.ai (paid)
 *
 * Usage:
 *   const client = new UnifiedVideoClient({
 *     kieAiKey: '...',
 *     runwareKey: '...',
 *     wavespeedKey: '...',
 *     muapiKey: '...',  // ArtCraft/MuAPI
 *     defaultProvider: 'auto',  // 'auto' = free-first rotation
 *   });
 */

const { KieAiClient } = require('./kie_ai_client');
const { RunwareClient } = require('./runware_client');
const { WavespeedClient } = require('./wavespeed_client');
const { MuAPIArtCraftClient } = require('./muapi_artcraft_client');
const FlowCDPClient = require('./flow_cdp_client');

class UnifiedVideoClient {
  constructor(config = {}) {
    const {
      kieAiKey,
      runwareKey,
      wavespeedKey,
      muapiKey,
      defaultProvider = 'auto',
      defaultModel = 'seedance-2',
      defaultDuration = 5,
      maxRetries = 2,
    } = config;

    this.defaultProvider = defaultProvider;
    this.defaultModel = defaultModel;
    this.defaultDuration = defaultDuration;
    this.maxRetries = maxRetries;
    this._flowOutputDir = '/tmp/flow_output';

    // Initialize clients
    this._clients = {};

    if (kieAiKey) {
      this._clients.kieAi = new KieAiClient(kieAiKey);
    }
    if (runwareKey) {
      this._clients.runware = new RunwareClient(runwareKey);
    }
    if (wavespeedKey) {
      this._clients.wavespeed = new WavespeedClient(wavespeedKey);
    }
    if (muapiKey) {
      this._clients.muapi = new MuAPIArtCraftClient(muapiKey);
    }
    if (config.flowPort || config.flowEnabled) {
      this._clients.flow = new FlowCDPClient(config.flowPort || 60807);
    }

    // Free rotation order (API-based, no GPU needed)
    // NOTE: Flow produces IMAGES only (Nano Banana). For VIDEO, use Wavespeed first.
    this._providerRotation = [
      { key: 'wavespeed',   isFree: true,  costLabel: '$0.125/5s (tested)', label: 'Wavespeed (WAN 2.1)' },
      { key: 'flow',        isFree: true,  costLabel: 'Gemini Pro sub (FREE)', label: 'Google Flow (IMAGES only)' },
      { key: 'muapi',       isFree: true,  costLabel: '$0 free (no card)',   label: 'MuAPI/ArtCraft' },
      { key: 'runware',     isFree: true,  costLabel: '$2 free credits',     label: 'Runware' },
      { key: 'kie-ai',      isFree: false, costLabel: 'paid',                 label: 'Kie.ai' },
    ];
  }

  /**
   * Generate a video — supports 'auto' rotation or specific provider
   * @param {object} params
   * @param {string} params.prompt - Text description (required)
   * @param {string} [params.provider] - 'auto' (default) or specific provider
   * @param {string} [params.imageUrl] - For I2V
   * @param {number} [params.duration]
   * @param {string} [params.aspectRatio]
   * @param {string} [params.resolution]
   * @param {boolean} [params.waitForCompletion]
   * @returns {Promise<object>}
   */
  async generateVideo(params = {}) {
    const {
      prompt,
      provider = this.defaultProvider,
      imageUrl,
      duration = this.defaultDuration,
      aspectRatio,
      resolution,
      waitForCompletion = true,
      maxWaitMs = 180000,
    } = params;

    if (!prompt && !imageUrl) {
      throw new Error('Either prompt or imageUrl is required');
    }

    if (provider === 'auto') {
      return this._rotateAndGenerate({ prompt, imageUrl, duration, aspectRatio, resolution, waitForCompletion, maxWaitMs });
    }

    return this._generateWithProvider(provider, { prompt, imageUrl, duration, aspectRatio, resolution, waitForCompletion, maxWaitMs });
  }

  /**
   * Auto-rotation: try free providers first, then paid
   */
  async _rotateAndGenerate(params, attempt = 0) {
    const { prompt, imageUrl, duration, aspectRatio, resolution, waitForCompletion, maxWaitMs } = params;

    for (const providerInfo of this._providerRotation) {
      const { key, label } = providerInfo;

      if (!this._isProviderConfigured(key)) {
        console.log(`[UnifiedVideoClient] ${key} not configured, skipping...`);
        continue;
      }

      try {
        const result = await this._generateWithProvider(key, { prompt, imageUrl, duration, aspectRatio, resolution, waitForCompletion, maxWaitMs });
        return { ...result, providerLabel: label };
      } catch (error) {
        console.error(`[UnifiedVideoClient] ${key} failed: ${error.message}, trying next...`);
        continue;
      }
    }

    return {
      success: false,
      error: 'All video providers failed or not configured',
      providerLabel: 'none',
    };
  }

  /**
   * Generate with specific provider
   */
  async _generateWithProvider(provider, params) {
    const { prompt, imageUrl, duration, aspectRatio, resolution, waitForCompletion, maxWaitMs } = params;

    const client = this._getClient(provider);
    if (!client) {
      throw new Error(`Provider '${provider}' not configured. Available: ${this.availableProviders().join(', ')}`);
    }

    const startTime = Date.now();

    // Flow uses a single generate() pipeline (produces images, not video)
    if (provider === 'flow' || provider === 'google-flow') {
      try {
        await client.connect();
        const result = await client.generate(prompt, { outputDir: this._flowOutputDir });
        return { provider, ...result, responseTime: Date.now() - startTime };
      } catch (error) {
        return { provider, success: false, error: error.message, responseTime: Date.now() - startTime };
      }
    }

    try {
      let submission;
      if (imageUrl) {
        submission = await client.imageToVideo({ imageUrl, prompt: prompt || '', duration, aspectRatio, resolution });
      } else {
        submission = await client.textToVideo({ prompt, duration, aspectRatio, resolution });
      }

      if (!waitForCompletion) {
        return { provider, ...submission, responseTime: Date.now() - startTime };
      }

      // Get the right ID field for each client
      const requestId = submission.requestId || submission.taskUUID || submission.videoUUID || submission.id;

      const result = await client.waitForCompletion(requestId, { maxWaitMs });
      return { provider, ...result, responseTime: Date.now() - startTime };
    } catch (error) {
      return { provider, success: false, error: error.message, responseTime: Date.now() - startTime };
    }
  }

  _isProviderConfigured(key) {
    return !!this._clients[key];
  }

  _getClient(provider) {
    const map = {
      'kie-ai': this._clients.kieAi,
      'kie': this._clients.kieAi,
      'runware': this._clients.runware,
      'wavespeed': this._clients.wavespeed,
      'muapi': this._clients.muapi,
      'muapi-artcraft': this._clients.muapi,
      'artcraft': this._clients.muapi,
      'flow': this._clients.flow,
      'google-flow': this._clients.flow,
    };
    return map[provider] || null;
  }

  /**
   * List available (configured) providers
   */
  availableProviders() {
    return Object.keys(this._clients).filter(k => this._clients[k]);
  }

  /**
   * Health check all configured providers
   */
  async healthCheck() {
    const results = {};
    const checks = [];

    for (const [name, client] of Object.entries(this._clients)) {
      if (client) {
        checks.push(
          client.healthCheck().then(r => { results[name] = r; }).catch(e => {
            results[name] = { success: false, provider: name, error: e.message };
          })
        );
      }
    }

    await Promise.allSettled(checks);
    return results;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = {
  UnifiedVideoClient,
  KieAiClient,
  RunwareClient,
  WavespeedClient,
  MuAPIArtCraftClient,
  FlowCDPClient,
};