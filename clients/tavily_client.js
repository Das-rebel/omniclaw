/**
 * Tavily Search Client
 * Direct API integration for fast live web search
 */

const https = require('https');
const { createValidator } = require('./response_validator');

class TavilyClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.tavily.com';
    this.validator = createValidator('Tavily');
  }

  async search(query, options = {}) {
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
     * Health check with actual query validation
     */
  async healthCheck(testQuery = 'test') {
    console.log('[Tavily] === HEALTH CHECK START ===');

    try {
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
        hasAnswer: !!testResponse?.answer
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
        testQuery: 'failed'
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

module.exports = TavilyClient;
