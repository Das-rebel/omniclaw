/**
 * LLM Router with Failover
 * Unified interface for LLM calls with automatic provider failover
 * 
 * Architecture:
 * - Uses LLMProvider interface (seam)
 * - Automatic failover: tries providers in order until success
 * - Health-based routing (avoids unhealthy providers)
 * - Stats tracking per provider
 */

const { LLMProvider } = require('../../clients/llm_provider');

// Provider priority order (fastest/cheapest first)
const PROVIDER_ORDER = ['groq', 'nvidia', 'glm'];
const HEALTHY_TIMEOUT = 60000; // Re-check health every 60s

class LLMRouter {
  constructor() {
    this.llm = new LLMProvider();
    this.healthStatus = {};
    this.lastHealthCheck = 0;
    this.stats = { calls: 0, successes: 0, failures: 0, fallbacks: 0 };
  }

  /**
   * Complete with automatic failover
   * Tries providers in order until one succeeds
   */
  async complete(prompt, options = {}) {
    const { system = null, temperature = 0.3, maxTokens = 1024, timeout = 30000 } = options;
    
    this.stats.calls++;
    
    // Check health periodically
    await this.ensureHealthy();
    
    // Try each provider in order
    for (const provider of PROVIDER_ORDER) {
      if (!this.isHealthy(provider)) {
        console.log(`[LLMRouter] Skipping unhealthy provider: ${provider}`);
        continue;
      }
      
      try {
        console.log(`[LLMRouter] Trying ${provider}...`);
        const result = system 
          ? await this.llm.completeWithSystem(system, prompt, { provider, temperature, maxTokens, timeout })
          : await this.llm.complete(prompt, { provider, temperature, maxTokens, timeout });
        
        this.stats.successes++;
        this.healthStatus[provider] = { ok: true, lastSuccess: Date.now() };
        return result;
        
      } catch (e) {
        console.log(`[LLMRouter] ${provider} failed: ${e.message}`);
        this.healthStatus[provider] = { ok: false, lastError: e.message, lastAttempt: Date.now() };
        this.stats.fallbacks++;
      }
    }
    
    // All providers failed
    this.stats.failures++;
    throw new Error('All LLM providers failed');
  }

  /**
   * Check if provider is healthy
   */
  isHealthy(provider) {
    const status = this.healthStatus[provider];
    if (!status) return true; // Unknown = assume healthy
    if (!status.ok) return false;
    
    // If last error was recent, might still be unhealthy
    if (status.lastError && Date.now() - status.lastAttempt < 30000) {
      return false;
    }
    
    return true;
  }

  /**
   * Ensure we have recent health data
   */
  async ensureHealthy() {
    if (Date.now() - this.lastHealthCheck < HEALTHY_TIMEOUT) return;
    
    this.lastHealthCheck = Date.now();
    const health = await this.llm.getAllHealth();
    
    for (const [provider, status] of Object.entries(health)) {
      this.healthStatus[provider] = {
        ok: status.ok,
        lastHealthCheck: Date.now(),
        ...status
      };
    }
    
    console.log('[LLMRouter] Health:', JSON.stringify(this.healthStatus));
  }

  /**
   * Get provider-specific completion (no failover)
   */
  async completeWith(prompt, provider, options = {}) {
    return this.llm.complete(prompt, { provider, ...options });
  }

  /**
   * Ensemble: call all providers and merge results
   */
  async ensemble(prompt, options = {}) {
    const { system = null } = options;
    
    const results = {};
    const promises = PROVIDER_ORDER.map(async (provider) => {
      try {
        const result = system
          ? await this.llm.completeWithSystem(system, prompt, { provider })
          : await this.llm.complete(prompt, { provider });
        results[provider] = result;
      } catch (e) {
        results[provider] = null;
      }
    });
    
    await Promise.allSettled(promises);
    
    // Pick best result (longest response as heuristic)
    let best = null;
    let bestProvider = null;
    
    for (const [provider, result] of Object.entries(results)) {
      if (result && (!best || result.length > best.length)) {
        best = result;
        bestProvider = provider;
      }
    }
    
    return {
      best,
      bestProvider,
      all: results,
      stats: this.getStats()
    };
  }

  /**
   * Get routing statistics
   */
  getStats() {
    return {
      ...this.stats,
      providers: this.llm.getStats(),
      health: this.healthStatus
    };
  }
}

// Singleton instance
const llmRouter = new LLMRouter();

module.exports = { LLMRouter, llmRouter };
