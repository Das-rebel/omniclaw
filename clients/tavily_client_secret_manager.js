/**
 * Tavily Search Client - Unified Secret Manager Version
 * Direct API integration for fast live web search
 *
 * MIGRATION EXAMPLE: Shows how to migrate from hardcoded keys to Google Secret Manager
 */

const https = require('https');
const { createValidator } = require('./response_validator');
const { getSecret } = require('../shared/security/secrets');

class TavilyClient {
  constructor() {
    this.baseUrl = 'https://api.tavily.com';
    this.validator = createValidator('Tavily');
    this.apiKey = null;
    this.initialized = false;

    // Auto-initialize asynchronously
    this.initializePromise = this.initialize();
  }

  /**
     * Initialize client with secret from Google Secret Manager
     * This replaces the old constructor(apiKey) pattern
     */
  async initialize() {
    try {
      console.log('🔍 Tavily Client: Initializing with Secret Manager...');
      this.apiKey = await getSecret('tavily-api-key');
      this.initialized = true;
      console.log('✅ Tavily Client: Successfully loaded API key from Secret Manager');
      return this;
    } catch (error) {
      console.error('❌ Tavily Client: Failed to initialize', error.message);

      // Fallback to environment variable for backwards compatibility
      const fallbackKey = process.env.TAVILY_API_KEY;
      if (fallbackKey) {
        console.log('⚠️  Tavily Client: Using fallback environment variable');
        this.apiKey = fallbackKey;
        this.initialized = true;
        return this;
      }

      throw new Error(`Tavily Client initialization failed: ${error.message}`);
    }
  }

  /**
     * Ensure client is initialized before operations
     * Call this before any API operation
     */
  async ensureInitialized() {
    if (!this.initialized) {
      await this.initializePromise;
    }
    if (!this.apiKey) {
      throw new Error('Tavily Client not initialized - no API key available');
    }
  }

  /**
     * Enhanced search method with automatic initialization
     * @param {string} query - Search query
     * @param {Object} options - Search options
     * @returns {Promise<Object>} Search results
     */
  async search(query, options = {}) {
    // Ensure initialization before proceeding
    await this.ensureInitialized();

    const {
      maxResults = 5,
      searchDepth = 'basic',
      days = 3,
      answer = true
    } = options;

    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        query: query,
        max_results: maxResults,
        search_depth: searchDepth,
        days: days,
        include_answer: answer,
        include_raw_content: false
      });

      const reqOptions = {
        hostname: this.baseUrl,
        path: '/search',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 7000
      };

      const req = https.request(reqOptions, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const response = JSON.parse(body);
            console.log('[Tavily] Raw API response (first 500 chars):', body.substring(0, 500));

            // Validate API response
            try {
              this.validator.validateTavilyResponse({
                answer: response.answer,
                results: response.results || []
              });
              console.log('[Tavily] Response validation passed');
            } catch (validationError) {
              console.error(`[Tavily] Response validation failed: ${validationError.message}`);
              // Don't reject, allow fallback to handle it
            }

            // Return validated object with answer and results
            if (response.answer) {
              console.log(`[Tavily] Returning answer: "${response.answer.substring(0, 50)}..."`);
              resolve({
                answer: response.answer,
                results: response.results || []
              });
            } else if (response.results && response.results.length > 0) {
              const summary = response.results
                .slice(0, 3)
                .map(r => r.title)
                .join('; ');
              console.log(`[Tavily] Returning summary: "${summary.substring(0, 50)}..."`);
              resolve({
                answer: summary,
                results: response.results
              });
            } else {
              console.log('[Tavily] No results found');
              resolve({
                answer: 'No results found',
                results: []
              });
            }
          } catch (error) {
            console.error('[Tavily] Parse error:', error);
            reject(new Error(`Failed to parse response: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Tavily API error: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Tavily API timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  /**
     * Enhanced health check with initialization validation
     */
  async healthCheck(testQuery = 'test') {
    console.log('[Tavily] === HEALTH CHECK START ===');

    try {
      // Ensure initialization
      await this.ensureInitialized();

      // Execute actual test search
      const testResponse = await this.search(testQuery, {
        maxResults: 1,
        searchDepth: 'basic',
        days: 1,
        answer: true
      });

      console.log('[Tavily] === HEALTH CHECK SUCCESS ===');

      const hasResults = testResponse && (
        testResponse.answer || (testResponse.results && testResponse.results.length > 0)
      );

      const healthResponse = {
        status: 'healthy',
        provider: 'Tavily',
        testQuery: 'passed',
        hasSearchResults: hasResults,
        resultsCount: testResponse?.results?.length || 0,
        hasAnswer: !!testResponse?.answer,
        secretManager: 'enabled'
      };

      // Validate health check response
      try {
        this.validator.validateHealthCheckResponse(healthResponse);
      } catch (validationError) {
        console.warn(`[Tavily] Health check validation warning: ${validationError.message}`);
      }

      return healthResponse;
    } catch (error) {
      console.log('[Tavily] === HEALTH CHECK FAILED ===');
      console.error('[Tavily] Health check error:', error.message);

      const healthResponse = {
        status: 'unhealthy',
        provider: 'Tavily',
        error: error.message,
        errorType: error.name || 'unknown',
        testQuery: 'failed',
        secretManager: 'enabled',
        initialized: this.initialized,
        hasApiKey: !!this.apiKey
      };

      // Validate health check response
      try {
        this.validator.validateHealthCheckResponse(healthResponse);
      } catch (validationError) {
        console.warn(`[Tavily] Health check validation warning: ${validationError.message}`);
      }

      return healthResponse;
    }
  }
}

/**
 * Factory function for easier migration
 * Usage: const client = await createTavilyClient();
 */
async function createTavilyClient() {
  const client = new TavilyClient();
  await client.initializePromise;
  return client;
}

module.exports = { TavilyClient, createTavilyClient };
