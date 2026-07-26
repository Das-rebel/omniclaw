/**
 * GLM API Client - General Language Model for AI Response Generation
 * Uses Z.ai proxy for unified API access with extensive debugging
 *
 * Models: claude-sonnet-4-20250514 (via Anthropic API through Z.ai proxy)
 */

const https = require('https');

class GLMClient {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.ZAI_API_KEY;
    this.baseUrl = 'https://api.z.ai';
    this.basePath = '/api/anthropic'; // Use correct Z.ai Anthropic path
    this.model = 'claude-sonnet-4-20250514'; // Use Anthropic Claude Sonnet 4
    this.timeout = 30000; // 30 seconds timeout
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

    console.log('[GLM] === QUERY START ===');
    console.log(`[GLM] Message: "${message.substring(0, 50)}..."`);
    console.log(`[GLM] Model: ${this.model}`);
    console.log(`[GLM] API Key: ${this.apiKey ? 'configured' : 'missing'}`);
    console.log(`[GLM] Base URL: ${this.baseUrl}`);
    console.log(`[GLM] Base Path: ${this.basePath}`);
    console.log(`[GLM] Full Path: ${this.basePath}/v1/messages`);
    console.log(`[GLM] MaxTokens: ${maxTokens}, Temperature: ${temperature}`);
    console.log(`[GLM] Timeout: ${timeout}ms`);
    console.log('[GLM] === QUERY PREPARATION COMPLETE ===');

    return new Promise((resolve, reject) => {
      console.log('[GLM] === CREATING PROMISE ===');

      const data = JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: message
          }
        ],
        max_tokens: maxTokens,
        temperature: temperature,
        stream: false
      });

      console.log(`[GLM] Request body length: ${data.length} characters`);
      console.log(`[GLM] Request body: ${data.substring(0, 200)}`);

      const reqOptions = {
        hostname: this.baseUrl,
        path: this.basePath + '/v1/messages',  // Anthropic API endpoint via Z.ai
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: timeout
      };

      console.log('[GLM] === MAKING HTTPS REQUEST ===');
      console.log(`[GLM] ReqOptions hostname: ${reqOptions.hostname}`);
      console.log(`[GLM] ReqOptions path: ${reqOptions.path}`);
      console.log(`[GLM] ReqOptions method: ${reqOptions.method}`);
      console.log(`[GLM] ReqOptions timeout: ${reqOptions.timeout}ms`);
      console.log(`[GLM] Authorization header: ${reqOptions.headers.Authorization ? 'present' : 'missing'}`);

      const req = https.request(reqOptions, (res) => {
        console.log('[GLM] === RESPONSE CALLBACK TRIGGERED ===');
        console.log(`[GLM] Response status: ${res.statusCode}`);
        console.log(`[GLM] Response headers: ${JSON.stringify(res.headers)}`);
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          console.log('[GLM] === RESPONSE BODY RECEIVED ===');
          console.log(`[GLM] Response body length: ${body.length} characters`);
          console.log(`[GLM] Response body preview: ${body.substring(0, 200)}`);

          if (res.statusCode === 200) {
            console.log('[GLM] === PARSING SUCCESS RESPONSE ===');
            try {
              const response = JSON.parse(body);
              console.log(`[GLM] Parsed response: ${JSON.stringify(response)}`);

              const content = response.content?.[0]?.text;
              console.log(`[GLM] Response.content[0].text: ${content ? 'present' : 'missing'}`);

              if (content) {
                console.log('[GLM] === SUCCESS ===');
                console.log(`[GLM] Generated response length: ${content.length} characters`);
                console.log(`[GLM] Generated response preview: ${content.substring(0, 100)}`);
                console.log('[GLM] === RESOLVING PROMISE ===');
                resolve(content.trim());
              } else {
                console.log('[GLM] === INVALID RESPONSE STRUCTURE ===');
                console.error('[GLM] Invalid response structure:', body.substring(0, 200));
                reject(new Error('Invalid response structure'));
              }
            } catch (error) {
              console.log('[GLM] === PARSE ERROR ===');
              console.error('[GLM] Parse error:', error);
              reject(new Error(`Parse error: ${error.message}`));
            }
          } else {
            console.log('[GLM] === HTTP ERROR ===');
            console.log(`[GLM] API error ${res.statusCode}:`, body.substring(0, 200));
            reject(new Error(`API error ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', (error) => {
        console.log('[GLM] === REQUEST ERROR ===');
        console.error('[GLM] Request error:', error);
        reject(error);
      });

      req.on('timeout', () => {
        console.log('[GLM] === TIMEOUT ===');
        console.error(`[GLM] Request timeout after ${timeout}ms`);
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(data);
      req.end();
      console.log('[GLM] === REQUEST SENT ===');
    });
  }

  /**
     * Set a specific model
     */
  setModel(model) {
    const validModels = ['anthropic/claude-sonnet-4-20250514', 'claude-sonnet-4-20250514'];
    if (validModels.includes(model)) {
      this.model = model;
      console.log(`[GLM] Model changed to: ${model}`);
    } else {
      console.warn(`[GLM] Invalid model: ${model}, using default: ${this.model}`);
    }
  }

  /**
     * Get current model
     */
  getModel() {
    return this.model;
  }
}

module.exports = GLMClient;
