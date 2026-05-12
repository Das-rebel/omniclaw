/**
 * Vault Integration - OmniClaw Cloud endpoints integration for Telegram
 *
 * Provides access to all omniclaw cloud services:
 * - Vault search (FAISS semantic search)
 * - Twitter/Instagram sync status
 * - Bookmark processing
 * - TTS and Story services
 * - Alexa handler
 */

const logger = require('./logger');
const https = require('https');
const http = require('http');

class VaultIntegration {
  constructor(options = {}) {
    this.timeout = options.timeout || 30000;
    this.cache = new Map();
    this.cacheTimeout = options.cacheTimeout || 5 * 60 * 1000; // 5 minutes

    // Load all cloud endpoints from env
    this.endpoints = {
      vaultSearch:     process.env.VAULT_SEARCH_URL     || 'https://serve-vault-search-338789220059.asia-south1.run.app',
      vaultSemantic:    process.env.VAULT_SEMANTIC_URL  || 'https://omniclaw-vault-search-338789220059.asia-south1.run.app',
      twitterSync:      process.env.TWITTER_SYNC_URL     || 'https://twitter-sync-338789220059.asia-south1.run.app',
      instagramSync:    process.env.INSTAGRAM_SYNC_URL   || 'https://instagram-sync-338789220059.asia-south1.run.app',
      instagramScheduler: process.env.INSTAGRAM_SCHEDULER_URL || 'https://instagram-vault-scheduler-338789220059.asia-south1.run.app',
      instatter:        process.env.INSTATTER_URL        || 'https://instatter-338789220059.asia-south1.run.app',
      bookmarkProcessor: process.env.BOOKMARK_PROCESSOR_URL || 'https://bookmark-processor-338789220059.asia-south1.run.app',
      bookmarkVault:    process.env.BOOKMARK_VAULT_SCHEDULER_URL || 'https://bookmark-vault-scheduler-338789220059.asia-south1.run.app',
      celebrityTTS:     process.env.CELEBRITY_TTS_URL    || 'https://celebrity-tts-338789220059.asia-south1.run.app',
      storyNarrator:    process.env.STORY_NARRATOR_URL  || 'https://story-narrator-338789220059.asia-south1.run.app',
      alexaHandler:     process.env.ALEXA_HANDLER_URL    || 'https://alexa-handler-338789220059.asia-south1.run.app',
      omniclawFinal:    process.env.OMNICLAW_FINAL_URL  || 'https://omniclaw-final-338789220059.asia-south1.run.app',
      omniclawGCS:      process.env.OMNICLAW_GCS_URL     || 'https://omniclaw-gcs-338789220059.asia-south1.run.app',
    };

    logger.info('VaultIntegration initialized with endpoints:', Object.keys(this.endpoints));
  }

  /**
   * Generic HTTP GET helper
   */
  async httpGet(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const req = protocol.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch {
            resolve({ raw: data.slice(0, 500) });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, timeout);
    });
  }

  /**
   * Generic HTTP POST helper
   */
  async httpPost(url, body, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
      };

      const req = protocol.request(options, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch {
            resolve({ raw: responseData.slice(0, 500) });
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
      setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, timeout);
    });
  }

  /**
   * Cloud endpoint query helper with caching
   */
  async queryCloud(serviceName, path = '/health', cacheKey = null) {
    const endpoint = this.endpoints[serviceName];
    if (!endpoint) return { error: `Unknown service: ${serviceName}` };

    const url = endpoint + path;
    const key = cacheKey || `${serviceName}:${path}`;

    // Check cache
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.ts < this.cacheTimeout) {
      return { ...cached.data, cached: true };
    }

    try {
      const result = await this.httpGet(url, 10000);
      this.cache.set(key, { data: result, ts: Date.now() });
      return result;
    } catch (err) {
      logger.error(`Cloud query failed for ${serviceName}:`, err.message);
      return { error: err.message, service: serviceName };
    }
  }

  // ===== Per-service methods =====

  /** Vault Search (FAISS semantic) */
  async searchVault(query, chatId = null) {
    try {
      // Try semantic search endpoint
      const result = await this.httpGet(
        `${this.endpoints.vaultSearch}/search?q=${encodeURIComponent(query)}&limit=5`,
        15000
      );
      if (result.error) throw new Error(result.error);

      const items = result.items || result.results || [];
      if (!items.length) return { query, results: [], count: 0 };

      const formatted = items.slice(0, 5).map(item => ({
        title: item.title?.slice(0, 60) || 'Untitled',
        url: item.url || item.link || '',
        source: item.source || 'unknown',
        date: item.bookmarked_at || item.date || '',
        snippet: item.content?.slice(0, 120) || item.text?.slice(0, 120) || ''
      }));

      return { query, results: formatted, count: items.length };
    } catch (err) {
      logger.error('Vault search error:', err.message);
      return { query, results: [], error: err.message };
    }
  }

  /** Twitter sync status */
  async getTwitterStatus() {
    return this.queryCloud('twitterSync', '/health', 'twitter:status');
  }

  /** Instagram sync status */
  async getInstagramStatus() {
    return this.queryCloud('instagramSync', '/health', 'instagram:status');
  }

  /** Instatter status (WhatsApp) */
  async getInstatterStatus() {
    return this.queryCloud('instatter', '/health', 'instatter:status');
  }

  /** All sync statuses combined */
  async getAllSyncStatuses() {
    const [twitter, instagram, instatter, vault] = await Promise.allSettled([
      this.getTwitterStatus(),
      this.getInstagramStatus(),
      this.getInstatterStatus(),
      this.queryCloud('vaultSearch', '/health', 'vault:status')
    ]);

    return {
      twitter: twitter.status === 'fulfilled' ? twitter.value : { error: 'unavailable' },
      instagram: instagram.status === 'fulfilled' ? instagram.value : { error: 'unavailable' },
      instatter: instatter.status === 'fulfilled' ? instatter.value : { error: 'unavailable' },
      vault: vault.status === 'fulfilled' ? vault.value : { error: 'unavailable' }
    };
  }

  /** Bookmark processor status */
  async getBookmarkStatus() {
    return this.queryCloud('bookmarkProcessor', '/health', 'bookmark:status');
  }

  /** Celebrity TTS health */
  async getTTSStatus() {
    return this.queryCloud('celebrityTTS', '/health', 'tts:status');
  }

  /** Story narrator health */
  async getStoryStatus() {
    return this.queryCloud('storyNarrator', '/health', 'story:status');
  }

  /** Alexa handler health */
  async getAlexaStatus() {
    return this.queryCloud('alexaHandler', '/health', 'alexa:status');
  }

  /** OmniClaw main service health */
  async getOmniclawStatus() {
    return this.queryCloud('omniclawGCS', '/health', 'omniclaw:status');
  }

  /** Full system health */
  async getSystemHealth() {
    const [omniclaw, vault, twitter, instagram, tts, story] = await Promise.allSettled([
      this.getOmniclawStatus(),
      this.queryCloud('vaultSearch', '/health'),
      this.getTwitterStatus(),
      this.getInstagramStatus(),
      this.getTTSStatus(),
      this.getStoryStatus()
    ]);

    const formatStatus = (result) => {
      if (result.status !== 'fulfilled') return '❌ down';
      const v = result.value;
      if (v.error) return '⚠️ ' + v.error.slice(0, 30);
      return '✅ healthy';
    };

    return {
      omniclaw: formatStatus(omniclaw),
      vault_search: formatStatus(vault),
      twitter_sync: formatStatus(twitter),
      instagram_sync: formatStatus(instagram),
      tts: formatStatus(tts),
      story_narrator: formatStatus(story),
      cached: false
    };
  }

  /** Store interaction in vault */
  async storeInteraction(chatId, message, response) {
    try {
      const result = await this.httpPost(this.endpoints.omniclawGCS + '/store', {
        type: 'telegram_interaction',
        chatId,
        message,
        response,
        timestamp: new Date().toISOString()
      }, 10000);
      return result;
    } catch (err) {
      logger.error('Store interaction error:', err.message);
      return { stored: false, error: err.message };
    }
  }

  /** Format vault results for Telegram */
  formatVaultResults(results, query) {
    if (!results || !results.results || !results.results.length) {
      return `No results found for "${query}" in vault.`;
    }

    let response = `🔍 *Vault search for:* "${query}"\n`;
    response += `📊 *Found:* ${results.count || results.results.length} results\n\n`;

    for (const item of results.results) {
      const title = item.title || 'Untitled';
      const source = item.source === 'twitter' ? '🐦 Twitter' : item.source === 'instagram' ? '📷 Instagram' : '🌐';
      const date = item.date ? item.date.slice(0, 10) : '';
      const snippet = item.snippet ? `\n   _${item.snippet.slice(0, 80)}..._` : '';

      response += `${source} [${title}](${item.url || item.link || '#'})${snippet}\n`;
      if (date) response += `   📅 ${date}\n`;
      response += '\n';
    }

    return response;
  }

  /** Format system status for Telegram */
  formatSystemStatus(status) {
    const lines = ['🟢 *OmniClaw System Status*\n'];

    for (const [service, state] of Object.entries(status)) {
      if (service === 'cached') continue;
      const label = service.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      lines.push(`${state} *${label}*`);
    }

    return lines.join('\n');
  }

  /** Clear cache */
  clearCache() {
    this.cache.clear();
    logger.info('Vault cache cleared');
    return { cleared: true, size: 0 };
  }

  /** Get cache stats */
  getCacheStats() {
    return {
      size: this.cache.size,
      timeout: this.cacheTimeout,
      entries: Array.from(this.cache.keys()).slice(0, 10)
    };
  }
}

// Singleton
let instance = null;

function getVaultIntegration(options) {
  if (!instance) {
    instance = new VaultIntegration(options);
  }
  return instance;
}

module.exports = { VaultIntegration, getVaultIntegration };