/**
 * Model Router - Intelligent model selection and fallback
 *
 * Provides:
 * - Model fallback chain
 * - Health tracking per model
 * - Quota-aware routing
 * - Performance-based selection
 */

class ModelRouter {
  constructor(options = {}) {
    this.models = options.models || {
      // FASTEST > FREE: Groq llama-3.3-70b (~168ms, FREE) is primary.
      // Groq API uses model IDs directly (no provider prefix).
      // OpenRouter models need 'openrouter/' prefix.
      primary: 'llama-3.3-70b-versatile',
      fallback: [
        'llama-3.1-8b-instant',        // Groq free, ~150ms, fastest
        'qwen/qwen3-32b',              // Groq free, Chinese/multilingual
        'qwen/qwen3.6-27b',            // Groq free, larger Chinese
        'open-mistral-nemo',            // Mistral free, backup
        'gemini-2.5-flash',            // Gemini free, multimodal
        'openrouter/nvidia/nemotron-3-super-120b-a12b:free',  // OpenRouter 1M ctx ONLY
        'openrouter/google/gemma-4-31b-it:free',               // OpenRouter Gemma
        'openrouter/openai/gpt-oss-120b:free',                // OpenRouter GPT-OSS
      ]
    };

    this.resetTimeoutMs = options.resetTimeoutMs || 60000;
    this.minRequestsForBestModel = options.minRequestsForBestModel ?? 1;
    this.resetTimers = new Map();

    // Model health tracking
    this.modelHealth = new Map();

    // Initialize health for all models
    this.initializeHealth();

    // Performance metrics
    this.performanceMetrics = new Map();

    // Current model index in fallback chain
    this.currentModelIndex = 0;
  }

  /**
     * Initialize model health tracking
     */
  initializeHealth() {
    // Initialize primary model
    this.modelHealth.set(this.models.primary, {
      model: this.models.primary,
      isHealthy: true,
      failureCount: 0,
      successCount: 0,
      lastFailure: null,
      lastSuccess: null,
      consecutiveFailures: 0
    });

    // Initialize fallback models
    for (const model of this.models.fallback) {
      this.modelHealth.set(model, {
        model,
        isHealthy: true,
        failureCount: 0,
        successCount: 0,
        lastFailure: null,
        lastSuccess: null,
        consecutiveFailures: 0
      });
    }
  }

  /**
     * Get current model to use
     * @returns {string} - Model name
     */
  getCurrentModel() {
    const allModels = [this.models.primary, ...this.models.fallback];

    // Try to find a healthy model
    for (let i = 0; i < allModels.length; i++) {
      const model = allModels[i];
      const health = this.modelHealth.get(model);

      if (health && health.isHealthy) {
        this.currentModelIndex = i;
        return model;
      }
    }

    // All models unhealthy - use primary anyway
    return this.models.primary;
  }

  /**
     * Get next fallback model
     * @param {string} currentModel - Current model that failed
     * @returns {string|null} - Next model or null if no more fallbacks
     */
  getNextModel(currentModel) {
    const allModels = [this.models.primary, ...this.models.fallback];
    const currentIndex = allModels.indexOf(currentModel);

    if (currentIndex === -1) {
      return this.models.fallback[0] || null;
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex < allModels.length) {
      return allModels[nextIndex];
    }

    return null; // No more fallback models
  }

  /**
     * Report model success
     * @param {string} model - Model name
     * @param {number} duration - Response duration
     */
  reportSuccess(model, duration = 0) {
    const health = this.modelHealth.get(model);
    if (!health) return;

    health.successCount++;
    health.lastSuccess = Date.now();
    health.consecutiveFailures = 0;

    // Mark as healthy if it was unhealthy
    if (!health.isHealthy) {
      health.isHealthy = true;
      console.log(`✅ Model ${model} is now healthy`);
    }

    // Update performance metrics
    this.updatePerformanceMetrics(model, duration, true);
  }

  /**
     * Report model failure
     * @param {string} model - Model name
     * @param {Error} error - Error that occurred
     */
  reportFailure(model, error) {
    const health = this.modelHealth.get(model);
    if (!health) return;

    health.failureCount++;
    health.lastFailure = Date.now();
    health.consecutiveFailures++;

    // Mark as unhealthy after 3 consecutive failures
    if (health.consecutiveFailures >= 3) {
      health.isHealthy = false;
      console.error(`❌ Model ${model} marked as unhealthy after ${health.consecutiveFailures} failures`);
      this.scheduleReset(model);
    }

    // Update performance metrics
    this.updatePerformanceMetrics(model, 0, false);
  }

  /**
     * Update performance metrics for model
     * @param {string} model - Model name
     * @param {number} duration - Response duration
     * @param {boolean} success - Whether request was successful
     */
  updatePerformanceMetrics(model, duration, success) {
    if (!this.performanceMetrics.has(model)) {
      this.performanceMetrics.set(model, {
        model,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalDuration: 0,
        avgDuration: 0,
        successRate: 0
      });
    }

    const metrics = this.performanceMetrics.get(model);
    metrics.totalRequests++;

    if (success) {
      metrics.successfulRequests++;
      metrics.totalDuration += duration;
    } else {
      metrics.failedRequests++;
    }

    metrics.avgDuration = metrics.successfulRequests > 0
      ? metrics.totalDuration / metrics.successfulRequests
      : 0;
    metrics.successRate = (metrics.successfulRequests / metrics.totalRequests) * 100;
  }

  /**
     * Get health status for all models
     * @returns {Array} - Health status array
     */
  getHealthStatus() {
    return Array.from(this.modelHealth.values());
  }

  /**
     * Get health status for specific model
     * @param {string} model - Model name
     * @returns {object|null} - Health status or null
     */
  getModelHealth(model) {
    return this.modelHealth.get(model) || null;
  }

  /**
     * Get performance metrics for all models
     * @returns {Array} - Performance metrics array
     */
  getPerformanceMetrics() {
    return Array.from(this.performanceMetrics.values());
  }

  /**
     * Get best performing model
     * @returns {string} - Best model name
     */
  getBestModel() {
    const metrics = Array.from(this.performanceMetrics.values())
      .filter(m => m.totalRequests >= this.minRequestsForBestModel)
      .sort((a, b) => {
        // Prefer higher success rate, then lower avg duration
        if (b.successRate !== a.successRate) {
          return b.successRate - a.successRate;
        }
        return (a.avgDuration || Infinity) - (b.avgDuration || Infinity);
      });

    return metrics[0]?.model || this.models.primary;
  }

  /**
     * Mark model as healthy
     * @param {string} model - Model name
     */
  markHealthy(model) {
    const health = this.modelHealth.get(model);
    if (health) {
      health.isHealthy = true;
      health.consecutiveFailures = 0;
      console.log(`✅ Model ${model} manually marked as healthy`);
    }
  }

  /**
     * Mark model as unhealthy
     * @param {string} model - Model name
     */
  markUnhealthy(model) {
    const health = this.modelHealth.get(model);
    if (health) {
      health.isHealthy = false;
      console.log(`❌ Model ${model} manually marked as unhealthy`);
      this.scheduleReset(model);
    }
  }

  scheduleReset(model) {
    if (this.resetTimers.has(model)) {
      return;
    }
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
      return;
    }
    const timer = setTimeout(() => {
      this.resetTimers.delete(model);
      this.markHealthy(model);
    }, this.resetTimeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.resetTimers.set(model, timer);
  }

  /**
     * Reset all health statuses
     */
  resetHealth() {
    for (const health of this.modelHealth.values()) {
      health.isHealthy = true;
      health.consecutiveFailures = 0;
      health.failureCount = 0;
      health.lastFailure = null;
    }
    console.log('🔄 All model health statuses reset');
  }

  /**
     * Get recommended model for request
     * @param {object} options - Request options
     * @returns {string} - Recommended model
     */
  getRecommendedModel(options = {}) {
    const {
      complexity = 0,
      requiresFastResponse = false,
      requiresHighQuality = false
    } = options;

    // If high quality needed and healthy, prefer claude
    if (requiresHighQuality) {
      const claude = this.models.fallback.find(m => m.includes('claude'));
      const claudeHealth = this.modelHealth.get(claude);
      if (claude && claudeHealth?.isHealthy) {
        return claude;
      }
    }

    // If fast response needed, prefer primary
    if (requiresFastResponse) {
      const primaryHealth = this.modelHealth.get(this.models.primary);
      if (primaryHealth?.isHealthy) {
        return this.models.primary;
      }
    }

    // Default: use current healthy model
    return this.getCurrentModel();
  }

  /**
     * Get router statistics
     * @returns {object} - Router statistics
     */
  getStats() {
    const healthStatus = this.getHealthStatus();
    const performanceMetrics = this.getPerformanceMetrics();

    return {
      currentModel: this.getCurrentModel(),
      primaryModel: this.models.primary,
      fallbackModels: this.models.fallback,
      healthyModels: healthStatus.filter(h => h.isHealthy).length,
      totalModels: healthStatus.length,
      modelHealth: healthStatus,
      performanceMetrics,
      bestModel: this.getBestModel()
    };
  }

  /**
     * Export router configuration
     * @returns {object} - Configuration export
     */
  export() {
    return {
      models: this.models,
      health: Array.from(this.modelHealth.values()),
      performance: Array.from(this.performanceMetrics.values()),
      exportedAt: new Date().toISOString()
    };
  }

  /**
     * Import router configuration
     * @param {object} config - Configuration to import
     */
  import(config) {
    if (config.models) {
      this.models = config.models;
    }

    if (config.health) {
      for (const health of config.health) {
        this.modelHealth.set(health.model, health);
      }
    }

    if (config.performance) {
      for (const perf of config.performance) {
        this.performanceMetrics.set(perf.model, perf);
      }
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create model router singleton
 * @param {object} options - Configuration options
 * @returns {ModelRouter} - Model router instance
 */
function getModelRouter(options) {
  if (!instance) {
    instance = new ModelRouter(options);
  }
  return instance;
}

module.exports = { ModelRouter, getModelRouter };
