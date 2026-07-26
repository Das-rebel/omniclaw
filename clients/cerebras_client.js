/**
 * Cerebras API Client - Fast LLM for Simple Queries
 * Used within Phase 1 bridge for queries < 70 complexity score
 */

const https = require('https');
const { createValidator } = require('./response_validator');

class CerebrasClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.cerebras.ai';
    this.model = 'llama3.1-8b';
    this.validator = createValidator('Cerebras');
  }

  async query(message, options = {}) {
    const { maxTokens = 300, temperature = 0.7, timeout = 8000 } = options;

    console.log(`[Cerebras] Query called: "${message.substring(0, 50)}..."`);

    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: message }],
        max_tokens: maxTokens,
        temperature: temperature
      });

      const reqOptions = {
        hostname: this.baseUrl,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: timeout
      };

      const req = https.request(reqOptions, (res) => {
        console.log(`[Cerebras] Response status: ${res.statusCode}`);
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(body);

              // Validate response structure
              try {
                this.validator.validateLLMResponse(response);
              } catch (validationError) {
                console.error(`[Cerebras] ${validationError.message}`);
                reject(validationError);
                return;
              }

              const content = response.choices?.[0]?.message?.content;
              if (content) {
                console.log(`[Cerebras] Success: "${content.substring(0, 50)}..."`);
                resolve(content.trim());
              } else {
                console.error('[Cerebras] Invalid response structure:', body.substring(0, 200));
                reject(new Error('Invalid response structure'));
              }
            } catch (error) {
              console.error('[Cerebras] Parse error:', error);
              reject(new Error(`Parse error: ${error.message}`));
            }
          } else {
            console.error(`[Cerebras] API error ${res.statusCode}:`, body.substring(0, 200));
            reject(new Error(`API error ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', (error) => {
        console.error('[Cerebras] Request error:', error);
        reject(error);
      });
      req.on('timeout', () => {
        console.error(`[Cerebras] Request timeout after ${timeout}ms`);
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  /**
     * Health check with actual query validation
     */
  async healthCheck(testQuery = 'Say hello') {
    console.log('[Cerebras] === HEALTH CHECK START ===');

    try {
      // Execute actual test query
      const testResponse = await this.query(testQuery, { timeout: 10000 });

      console.log('[Cerebras] === HEALTH CHECK SUCCESS ===');
      console.log(`[Cerebras] Test response: ${testResponse.substring(0, 50)}...`);

      // Validate health check response
      const healthResponse = {
        status: 'healthy',
        provider: 'Cerebras',
        model: this.model,
        testQuery: 'passed',
        response: testResponse.substring(0, 100)
      };

      try {
        this.validator.validateHealthCheckResponse(healthResponse);
      } catch (validationError) {
        console.warn(`[Cerebras] Health check response validation warning: ${validationError.message}`);
      }

      return healthResponse;
    } catch (error) {
      console.log('[Cerebras] === HEALTH CHECK FAILED ===');
      console.error('[Cerebras] Health check error:', error.message);

      const healthResponse = {
        status: 'unhealthy',
        provider: 'Cerebras',
        error: error.message,
        errorType: error.name || 'unknown',
        testQuery: 'failed'
      };

      try {
        this.validator.validateHealthCheckResponse(healthResponse);
      } catch (validationError) {
        console.warn(`[Cerebras] Health check response validation warning: ${validationError.message}`);
      }

      return healthResponse;
    }
  }
}

module.exports = CerebrasClient;
