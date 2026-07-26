/**
 * GLM API Client - Fixed for Cloud Functions Environment
 * Uses fetch API (available in Node.js 18+) instead of native HTTPS
 *
 * Models: claude-sonnet-4-20250514 (via Anthropic API through Z.ai proxy)
 */

class GLMClient {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.ZAI_API_KEY;
    this.baseUrl = 'https://api.z.ai';
    this.basePath = '/api/anthropic';
    this.model = 'claude-sonnet-4-20250514';
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

    try {
      const data = {
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
      };

      console.log(`[GLM] Request body: ${JSON.stringify(data).substring(0, 200)}`);

      const url = `https://${this.baseUrl}${this.basePath}/v1/messages`;

      console.log(`[GLM] Request URL: ${url}`);
      console.log('[GLM] === MAKING FETCH REQUEST ===');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

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

      console.log('[GLM] === RESPONSE RECEIVED ===');
      console.log(`[GLM] Response status: ${response.status}`);
      console.log(`[GLM] Response headers: ${JSON.stringify(Object.fromEntries(response.headers))}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.log('[GLM] === HTTP ERROR ===');
        console.error(`[GLM] API error ${response.status}:`, errorText.substring(0, 200));
        throw new Error(`API error ${response.status}: ${errorText}`);
      }

      const body = await response.text();
      console.log(`[GLM] Response body length: ${body.length} characters`);
      console.log(`[GLM] Response body preview: ${body.substring(0, 200)}`);

      console.log('[GLM] === PARSING SUCCESS RESPONSE ===');
      const responseObj = JSON.parse(body);
      console.log(`[GLM] Parsed response: ${JSON.stringify(responseObj)}`);

      const content = responseObj.content?.[0]?.text;
      console.log(`[GLM] Response.content[0].text: ${content ? 'present' : 'missing'}`);

      if (content) {
        console.log('[GLM] === SUCCESS ===');
        console.log(`[GLM] Generated response length: ${content.length} characters`);
        console.log(`[GLM] Generated response preview: ${content.substring(0, 100)}`);
        console.log('[GLM] === QUERY COMPLETE ===');
        return content.trim();
      } else {
        console.log('[GLM] === INVALID RESPONSE STRUCTURE ===');
        console.error('[GLM] Invalid response structure:', body.substring(0, 200));
        throw new Error('Invalid response structure');
      }

    } catch (error) {
      console.log('[GLM] === QUERY ERROR ===');
      console.error('[GLM] Query error:', error);
      console.error('[GLM] Error message:', error.message);
      console.error('[GLM] Error stack:', error.stack);
      console.log('[GLM] === QUERY FAILED ===');
      throw error;
    }
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
