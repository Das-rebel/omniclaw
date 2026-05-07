/**
 * Unified GLM API Client v2 - Enhanced with Retry Logic
 *
 * Improvements over v1:
 * - Exponential backoff retry for transient errors
 * - Better error classification (transient vs permanent)
 * - Improved logging for debugging
 * - Faster timeout in Cloud Functions (80s instead of 100s)
 * - Graceful degradation for network issues
 *
 * Models: claude-sonnet-4-20250514 (via Anthropic API through Z.ai proxy)
 */
class UnifiedGLMClientV2 {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.ZAI_API_KEY;
    this.baseUrl = 'https://api.z.ai';
    this.basePath = '/api/anthropic';
    this.model = 'claude-sonnet-4-20250514';

    // Detect environment
    this.isCloudFunctions = process.env.FUNCTION_TARGET === 'alexaHandler' ||
                                  process.env.K_SERVICE !== undefined;

    // Shorter timeout for Cloud Functions (gives faster feedback on network issues)
    this.timeout = this.isCloudFunctions ? 80000 : 30000; // 80s for CF, 30s for local

    // Retry configuration
    this.maxRetries = 3;
    this.retryDelay = 1000; // 1s initial delay
    this.retryMultiplier = 2; // Exponential backoff multiplier

    // Statistics
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      transientErrors: 0,
      permanentErrors: 0,
      retrySuccess: 0,
      totalRetries: 0
    };

    console.log('[GLMv2] === INITIALIZED ===');
    console.log(`[GLMv2] Environment: ${this.isCloudFunctions ? 'Cloud Functions' : 'Local Development'}`);
    console.log(`[GLMv2] Timeout: ${this.timeout}ms`);
    console.log(`[GLMv2] Max Retries: ${this.maxRetries}`);
    console.log(`[GLMv2] API Key: ${this.apiKey ? 'configured' : 'missing'}`);
  }

  /**
     * Check if error is retryable (transient network error)
     */
  isRetryableError(error) {
    if (!error) return false;

    const errorLower = error.toString().toLowerCase();
    const retryablePatterns = [
      'network',
      'timeout',
      'fetch',
      'connection',
      'econnrefused',
      'etimedout',
      'enotfound',
      'eaireset'
    ];

    // Check if error message or name contains retryable patterns
    const isRetryable = retryablePatterns.some(pattern =>
      errorLower.includes(pattern) ||
            (error.name && error.name.toLowerCase().includes('timeout'))
    );

    // Don't retry on permanent errors
    const permanentPatterns = [
      'internal',
      'invalid',
      'unauthorized',
      'forbidden',
      'not found',
      'authentication',
      'permission'
    ];

    const isPermanent = permanentPatterns.some(pattern =>
      errorLower.includes(pattern) ||
            (String(error.message || '').toLowerCase().includes('auth'))
    );

    if (isPermanent) {
      console.log(`[GLMv2] Permanent error detected: ${error}`);
      return false;
    }

    if (isRetryable) {
      console.log(`[GLMv2] Retryable error detected: ${error}`);
      return true;
    }

    console.log(`[GLMv2] Unknown error type, assuming retryable: ${error}`);
    return true;
  }

  /**
     * Classify error type for logging
     */
  classifyError(error) {
    if (!error) return 'unknown';

    if (this.isRetryableError(error)) {
      return 'transient';
    }

    if (error.name === 'AbortError') {
      return 'timeout';
    }

    return 'permanent';
  }

  /**
     * Calculate exponential backoff delay
     */
  calculateRetryDelay(attempt) {
    const delay = this.retryDelay * Math.pow(this.retryMultiplier, attempt - 1);
    const maxDelay = 10000; // Cap at 10 seconds
    return Math.min(delay, maxDelay);
  }

  /**
     * Generate AI response for a given query
     */
  async query(message, options = {}) {
    const {
      maxTokens = 500,
      temperature = 0.7,
      timeout = this.timeout
    } = options;

    this.stats.totalRequests++;

    let attempt = 1;
    let lastError = null;

    while (attempt <= this.maxRetries) {
      try {
        const startTime = Date.now();

        if (attempt > 1) {
          const delay = this.calculateRetryDelay(attempt);
          console.log(`[GLMv2] === RETRY ATTEMPT ${attempt} ===`);
          console.log(`[GLMv2] === RETRY DELAY: ${delay}ms ===`);
          console.log(`[GLMv2] === LAST ERROR: ${lastError}`);

          await new Promise(resolve => setTimeout(resolve, delay));
        }

        console.log(`[GLMv2] === QUERY START (Attempt ${attempt}) ===`);
        console.log(`[GLMv2] === Message: "${String(message).substring(0, 50)}..."`);
        console.log(`[GLMv2] === Environment: ${this.isCloudFunctions ? 'Cloud Functions' : 'Local Development'}`);
        console.log(`[GLMv2] === Timeout: ${timeout}ms ===`);

        const response = await this.executeRequest(message, maxTokens, temperature, timeout);

        const duration = Date.now() - startTime;
        console.log(`[GLMv2] === REQUEST DURATION: ${duration}ms ===`);

        // Success!
        this.stats.successfulRequests++;
        this.updateStats('success', duration);

        const content = response; // executeRequest already returns the text content
        console.log('[GLMv2] === SUCCESS ===');
        console.log(`[GLMv2] === Response length: ${content ? content.length : 0} characters`);
        console.log(`[GLMv2] === Generated response: ${content ? content.substring(0, 100) : ''}...`);

        return content.trim();

      } catch (error) {
        lastError = error;
        const errorType = this.classifyError(error);

        if (errorType === 'transient') {
          this.stats.transientErrors++;
          this.stats.totalRetries++;
        } else if (errorType === 'permanent') {
          this.stats.permanentErrors++;
        } else {
          this.stats.totalRetries++;
        }

        this.updateStats('error', Date.now() - Date.now(), error);

        console.log(`[GLMv2] === ERROR (Attempt ${attempt}) ===`);
        console.log(`[GLMv2] === Error Type: ${errorType} ===`);
        console.log(`[GLMv2] === Error: ${error.message}`);
        console.log(`[GLMv2] === Error Name: ${error.name}`);

        // Check if we should retry
        if (attempt < this.maxRetries && this.isRetryableError(error)) {
          console.log(`[GLMv2] === Will retry in ${this.calculateRetryDelay(attempt + 1)}ms`);
          continue; // Retry loop
        }

        // Max retries reached or permanent error - throw
        console.log('[GLMv2] === MAX RETRIES REACHED OR PERMANENT ERROR ===');
        throw error;
      }
    }
  }

  /**
     * Execute the HTTP request
     */
  async executeRequest(message, maxTokens, temperature, timeout) {
    const data = {
      model: this.model,
      messages: [{
        role: 'user',
        content: message
      }],
      max_tokens: maxTokens,
      temperature: temperature,
      stream: false
    };

    const url = `${this.baseUrl}${this.basePath}/v1/messages`;

    console.log(`[GLMv2] === Request URL: ${url} ===`);
    console.log(`[GLMv2] === Request body: ${JSON.stringify(data).substring(0, 200)}... ===`);

    if (this.isCloudFunctions) {
      return this.fetchRequest(url, data, timeout);
    } else {
      return this.httpsRequest(url, data, timeout);
    }
  }

  /**
     * Fetch-based request (Cloud Functions)
     */
  async fetchRequest(url, data, timeout) {
    console.log('[GLMv2] === USING FETCH API (Cloud Functions) ===');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.error(`[GLMv2] === TIMEOUT AFTER ${timeout}ms ===`);
      controller.abort();
    }, timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(data),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      console.log(`[GLMv2] === RESPONSE STATUS: ${response.status} ===`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[GLMv2] === HTTP ERROR ${response.status}: ${errorText.substring(0, 200)} ===`);

        // Check if it's a network error
        if (response.status === 0) {
          throw new Error('Network connection failed');
        } else if (response.status === 500) {
          const errorData = await response.text().then(t => t.trim()).catch(() => '{}');
          throw new Error(`Server error: ${errorData}`);
        } else if (response.status >= 400 && response.status < 500) {
          throw new Error(`Client error: ${response.status}`);
        }

        throw new Error(`API error ${response.status}`);
      }

      console.log('[GLMv2] === RESPONSE RECEIVED ===');
      const body = await response.json();
      console.log(`[GLMv2] === Response: ${JSON.stringify(body).substring(0, 200)}... ===`);

      if (body.error) {
        console.error(`[GLMv2] === API ERROR: ${JSON.stringify(body.error)} ===`);
        throw new Error(body.error.message || 'API error');
      }

      if (!body.content || !Array.isArray(body.content) || !body.content[0]) {
        throw new Error('Invalid response structure: missing content');
      }

      const content = body.content[0].text;
      return content;

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        console.error('[GLMv2] === REQUEST TIMEOUT ===');
        throw new Error(`Request timeout after ${timeout}ms`);
      }

      throw error;
    }
  }

  /**
     * HTTPS-based request (Local Development)
     */
  async httpsRequest(url, data, timeout) {
    console.log('[GLMv2] === USING HTTPS (Local Development) ===');

    return new Promise((resolve, reject) => {
      const https = require('https');
      const reqOptions = {
        hostname: this.baseUrl,
        path: this.basePath + '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: timeout
      };

      console.log(`[GLMv2] === Request options: ${JSON.stringify(reqOptions).substring(0, 200)}... ===`);
      const req = https.request(reqOptions, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          console.log('[GLMv2] === RESPONSE RECEIVED ===');
          console.log(`[GLMv2] === Body length: ${body.length} characters`);

          try {
            const parsed = JSON.parse(body);
            if (parsed.error) {
              reject(new Error(parsed.error.message || 'API error'));
            } else if (!parsed.content || !Array.isArray(parsed.content) || !parsed.content[0]) {
              reject(new Error('Invalid response structure'));
            } else {
              resolve(parsed.content[0].text);
            }
          } catch (parseError) {
            reject(parseError);
          }
        });
      });

      req.on('error', (error) => {
        console.error(`[GLMv2] === REQUEST ERROR: ${error.message} ===`);
        reject(error);
      });

      req.setTimeout(() => {
        req.destroy();
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);
    });
  }

  /**
     * Update statistics
     */
  updateStats(event, duration = 0, error = null) {
    const now = Date.now();

    if (event === 'success') {
      this.stats.successfulRequests++;
      // Update error tracking for successful requests after retries
      if (this.stats.totalRetries > 0) {
        this.stats.retrySuccess++;
      }
    } else if (event === 'error') {
      // Already updated in retry loop, don't double count
    }

    console.log('[GLMv2] === STATS UPDATE ===');
    console.log(`[GLMv2] === Event: ${event}`);
    console.log(`[GLMv2] === Total Requests: ${this.stats.totalRequests}`);
    console.log(`[GLMv2] === Successful: ${this.stats.successfulRequests}`);
    console.log(`[GLMv2] === Transient Errors: ${this.stats.transientErrors}`);
    console.log(`[GLMv2] === Permanent Errors: ${this.stats.permanentErrors}`);
    console.log(`[GLMv2] === Total Retries: ${this.stats.totalRetries}`);
    console.log(`[GLMv2] === Retry Success: ${this.stats.retrySuccess}`);
  }

  /**
     * Get statistics
     */
  getStats() {
    const successRate = this.stats.totalRequests > 0
      ? (this.stats.successfulRequests / this.stats.totalRequests * 100).toFixed(2)
      : '0.00';

    return {
      ...this.stats,
      successRate: parseFloat(successRate),
      environment: this.isCloudFunctions ? 'Cloud Functions' : 'Local Development'
    };
  }

  /**
     * Health check with actual query validation
     */
  async healthCheck() {
    console.log('[GLMv2] === HEALTH CHECK START ===');

    try {
      const testResponse = await this.query('Say hello', { maxTokens: 50 });

      console.log('[GLMv2] === HEALTH CHECK SUCCESS ===');
      console.log(`[GLMv2] === Test response: ${testResponse.substring(0, 100)}... ===`);

      return {
        status: 'healthy',
        provider: 'GLMv2',
        model: this.model,
        environment: this.isCloudFunctions ? 'Cloud Functions' : 'Local Development',
        testQuery: 'passed',
        testResponse: testResponse.substring(0, 100),
        stats: this.getStats()
      };
    } catch (error) {
      console.error(`[GLMv2] === HEALTH CHECK ERROR: ${error.message}`);
      this.updateStats('error', 0, error);

      return {
        status: 'unhealthy',
        provider: 'GLMv2',
        model: this.model,
        environment: this.isCloudFunctions ? 'Cloud Functions' : 'Local Development',
        testQuery: 'failed',
        testResponse: error.message,
        stats: this.getStats()
      };
    }
  }

  /**
     * Set a specific model
     */
  setModel(model) {
    const validModels = ['anthropic/claude-sonnet-4-20250514', 'claude-sonnet-4-20250514'];
    if (validModels.includes(model)) {
      this.model = model;
      console.log(`[GLMv2] === Model changed to: ${model}`);
    } else {
      console.warn(`[GLMv2] === Invalid model: ${model}, using default`);
    }
  }

  /**
     * Get current model
     */
  getModel() {
    return this.model;
  }

  /**
     * Get current environment
     */
  getEnvironment() {
    return this.isCloudFunctions ? 'Cloud Functions' : 'Local Development';
  }

  /**
     * Get current timeout
     */
  getTimeout() {
    return this.timeout;
  }

  /**
     * Reset statistics
     */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      transientErrors: 0,
      permanentErrors: 0,
      retrySuccess: 0,
      totalRetries: 0
    };
    console.log('[GLMv2] === Statistics reset');
  }
}

module.exports = UnifiedGLMClientV2;
