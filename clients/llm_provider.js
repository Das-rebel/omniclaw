/**
 * LLM Provider Interface
 * Unified interface for multiple LLM providers
 * 
 * Architecture:
 * - This is the SEAM - callers use this interface, not specific providers
 * - Providers are adapters that satisfy this interface
 * - Enables testing with mocks and graceful provider failover
 * 
 * Usage:
 *   const llm = new LLMProvider();
 *   const response = await llm.complete('Hello world');
 *   const response = await llm.complete('Explain AI', { provider: 'nvidia', model: 'claude' });
 */

class LLMProvider {
  constructor() {
    this.providers = {};
    this.defaultProvider = 'nvidia';
    this.initProviders();
  }

  /**
   * Initialize all available providers
   */
  initProviders() {
    // Lazy-load providers to avoid circular dependencies
    try {
      this.providers.nvidia = this.loadProvider('nvidia');
      this.providers.groq = this.loadProvider('groq');
      this.providers.glm = this.loadProvider('glm');
    } catch (e) {
      console.warn('[LLMProvider] Some providers failed to load:', e.message);
    }
    
    console.log('[LLMProvider] Available providers:', Object.keys(this.providers));
  }

  /**
   * Load a specific provider adapter
   */
  loadProvider(name) {
    switch (name) {
      case 'nvidia':
        return new NVIDIAProvider();
      case 'groq':
        return new GroqProvider();
      case 'glm':
        return new GLMProvider();
      default:
        throw new Error(`Unknown provider: ${name}`);
    }
  }

  /**
   * Get a provider instance
   */
  getProvider(name) {
    const providerName = name || this.defaultProvider;
    const provider = this.providers[providerName];
    if (!provider) {
      throw new Error(`Provider ${providerName} not available`);
    }
    return provider;
  }

  /**
   * Complete a prompt (unified interface)
   * 
   * @param {string} prompt - The prompt to complete
   * @param {Object} options - Optional settings
   * @param {string} options.provider - Provider to use (default: nvidia)
   * @param {number} options.temperature - Temperature (default: 0.3)
   * @param {number} options.maxTokens - Max tokens (default: 1024)
   * @param {number} options.timeout - Timeout in ms (default: 30000)
   * @returns {Promise<string>} - The completion
   */
  async complete(prompt, options = {}) {
    const {
      provider = this.defaultProvider,
      temperature = 0.3,
      maxTokens = 1024,
      timeout = 30000
    } = options;

    const p = this.getProvider(provider);
    return p.complete(prompt, { temperature, maxTokens, timeout });
  }

  /**
   * Complete with system prompt
   */
  async completeWithSystem(system, prompt, options = {}) {
    const {
      provider = this.defaultProvider,
      temperature = 0.3,
      maxTokens = 1024,
      timeout = 30000
    } = options;

    const p = this.getProvider(provider);
    return p.completeWithSystem(system, prompt, { temperature, maxTokens, timeout });
  }

  /**
   * Check if a provider is healthy
   */
  async healthCheck(providerName) {
    try {
      const p = this.getProvider(providerName);
      return await p.healthCheck();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Get health status of all providers
   */
  async getAllHealth() {
    const results = {};
    for (const name of Object.keys(this.providers)) {
      results[name] = await this.healthCheck(name);
    }
    return results;
  }

  /**
   * Get stats from all providers
   */
  getStats() {
    const stats = {};
    for (const [name, provider] of Object.entries(this.providers)) {
      if (provider.getStats) {
        stats[name] = provider.getStats();
      }
    }
    return stats;
  }
}

/**
 * NVIDIA Provider Adapter
 */
class NVIDIAProvider {
  constructor() {
    this.name = 'nvidia';
    this.baseUrl = 'https://integrate.api.nvidia.com/v1';
    this.apiKey = process.env.NVIDIA_API_KEY;
    this.model = 'nvidia/llama-3.3-70b-instruct';
    this.stats = { requests: 0, errors: 0, totalTokens: 0 };
  }

  async complete(prompt, options = {}) {
    this.stats.requests++;
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature || 0.3,
          max_tokens: options.maxTokens || 1024
        }),
        signal: AbortSignal.timeout(options.timeout || 30000)
      });

      if (!response.ok) {
        throw new Error(`NVIDIA API error: ${response.status}`);
      }

      const data = await response.json();
      this.stats.totalTokens += data.usage?.total_tokens || 0;
      return data.choices[0].message.content;
    } catch (e) {
      this.stats.errors++;
      throw e;
    }
  }

  async completeWithSystem(system, prompt, options = {}) {
    this.stats.requests++;
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ],
          temperature: options.temperature || 0.3,
          max_tokens: options.maxTokens || 1024
        }),
        signal: AbortSignal.timeout(options.timeout || 30000)
      });

      if (!response.ok) {
        throw new Error(`NVIDIA API error: ${response.status}`);
      }

      const data = await response.json();
      this.stats.totalTokens += data.usage?.total_tokens || 0;
      return data.choices[0].message.content;
    } catch (e) {
      this.stats.errors++;
      throw e;
    }
  }

  async healthCheck() {
    try {
      await this.complete('ping', { timeout: 5000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  getStats() {
    return {
      ...this.stats,
      errorRate: this.stats.errors / this.stats.requests
    };
  }
}

/**
 * Groq Provider Adapter
 */
class GroqProvider {
  constructor() {
    this.name = 'groq';
    this.baseUrl = 'https://api.groq.com/openai/v1';
    this.apiKey = process.env.GROQ_API_KEY;
    this.model = 'llama-3.1-70b-versatile';
    this.stats = { requests: 0, errors: 0, totalTokens: 0 };
  }

  async complete(prompt, options = {}) {
    this.stats.requests++;
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature || 0.3,
          max_tokens: options.maxTokens || 1024
        }),
        signal: AbortSignal.timeout(options.timeout || 30000)
      });

      if (!response.ok) {
        throw new Error(`Groq API error: ${response.status}`);
      }

      const data = await response.json();
      this.stats.totalTokens += data.usage?.total_tokens || 0;
      return data.choices[0].message.content;
    } catch (e) {
      this.stats.errors++;
      throw e;
    }
  }

  async completeWithSystem(system, prompt, options = {}) {
    this.stats.requests++;
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ],
          temperature: options.temperature || 0.3,
          max_tokens: options.maxTokens || 1024
        }),
        signal: AbortSignal.timeout(options.timeout || 30000)
      });

      if (!response.ok) {
        throw new Error(`Groq API error: ${response.status}`);
      }

      const data = await response.json();
      this.stats.totalTokens += data.usage?.total_tokens || 0;
      return data.choices[0].message.content;
    } catch (e) {
      this.stats.errors++;
      throw e;
    }
  }

  async healthCheck() {
    try {
      await this.complete('ping', { timeout: 5000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  getStats() {
    return {
      ...this.stats,
      errorRate: this.stats.errors / this.stats.requests
    };
  }
}

/**
 * GLM Provider Adapter (via Z.ai proxy)
 */
class GLMProvider {
  constructor() {
    this.name = 'glm';
    this.baseUrl = 'https://api.z.ai/api/anthropic';
    this.apiKey = process.env.ZAI_API_KEY;
    this.model = 'claude-sonnet-4-20250514';
    this.stats = { requests: 0, errors: 0, totalTokens: 0 };
  }

  async complete(prompt, options = {}) {
    this.stats.requests++;
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature || 0.3,
          max_tokens: options.maxTokens || 1024
        }),
        signal: AbortSignal.timeout(options.timeout || 30000)
      });

      if (!response.ok) {
        throw new Error(`GLM API error: ${response.status}`);
      }

      const data = await response.json();
      this.stats.totalTokens += data.usage?.input_tokens || 0;
      this.stats.totalTokens += data.usage?.output_tokens || 0;
      return data.content[0].text;
    } catch (e) {
      this.stats.errors++;
      throw e;
    }
  }

  async completeWithSystem(system, prompt, options = {}) {
    this.stats.requests++;
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ],
          temperature: options.temperature || 0.3,
          max_tokens: options.maxTokens || 1024
        }),
        signal: AbortSignal.timeout(options.timeout || 30000)
      });

      if (!response.ok) {
        throw new Error(`GLM API error: ${response.status}`);
      }

      const data = await response.json();
      this.stats.totalTokens += data.usage?.input_tokens || 0;
      this.stats.totalTokens += data.usage?.output_tokens || 0;
      return data.content[0].text;
    } catch (e) {
      this.stats.errors++;
      throw e;
    }
  }

  async healthCheck() {
    try {
      await this.complete('ping', { timeout: 5000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  getStats() {
    return {
      ...this.stats,
      errorRate: this.stats.errors / this.stats.requests
    };
  }
}

module.exports = { LLMProvider };
