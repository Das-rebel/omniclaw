/**
 * Vault Integration - Knowledge graph integration for Telegram
 *
 * Provides:
 * - Vault search functionality
 * - Interaction storage
 * - Knowledge graph queries
 */

const logger = require('./logger');

class VaultIntegration {
  constructor(options = {}) {
    this.endpoint = options.vaultEndpoint || process.env.VAULT_ENDPOINT || 'http://localhost:18789';
    this.timeout = options.timeout || 30000;
    this.cache = new Map();
    this.cacheTimeout = options.cacheTimeout || 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Search vault for query
   */
  async searchVault(query, chatId = null) {
    if (!query || typeof query !== 'string') {
      return { error: 'Query is required', results: [] };
    }

    const cacheKey = `vault:${query}:${chatId || 'global'}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      logger.debug(`Vault cache hit for: ${query}`);
      return cached.results;
    }

    try {
      // Try to call OpenClaw agent with vault intent
      const results = await this.queryVaultAgent(query, chatId);

      // Cache results
      this.cache.set(cacheKey, {
        results,
        timestamp: Date.now()
      });

      return results;
    } catch (error) {
      logger.error('Vault search error:', error);
      return {
        error: 'Vault search failed',
        results: [],
        message: error.message
      };
    }
  }

  /**
   * Query vault via OpenClaw agent
   */
  async queryVaultAgent(query, chatId) {
    // Build the agent query for vault search
    const agentQuery = `VAULT SEARCH: "${query}"\n\nChat ID: ${chatId || 'private'}\nFormat results as structured markdown with bullet points.`;

    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';

      const proc = spawn(openclawBin, [
        'agent', '--local', '--agent', 'main',
        '--message', agentQuery,
        '--timeout', '30'
      ], {
        env: { ...process.env },
        timeout: this.timeout
      });

      let stdout = '';
      let stderr = '';

      const timeoutId = setTimeout(() => {
        proc.kill();
        reject(new Error('Vault query timeout'));
      }, this.timeout);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutId);

        // Extract response
        const response = this.extractResponse(stdout, stderr);

        if (response) {
          resolve({
            results: this.parseVaultResults(response),
            raw: response,
            source: 'vault'
          });
        } else {
          // Fallback: just return the query response as results
          resolve({
            results: [{ text: stdout || stderr || 'No vault results found' }],
            raw: stdout || stderr,
            source: 'agent'
          });
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }

  /**
   * Extract response from stdout/stderr
   */
  extractResponse(stdout, stderr) {
    // Clean up output
    let response = stdout
      .replace(/◇.*?╮.*?├.*?╯/gs, '')
      .replace(/[│├─╮╯]/g, '')
      .trim();

    if (response && response.length > 10) {
      return response;
    }

    // Check stderr
    response = stderr
      .replace(/\[diagnostic\].*?error="[^"]*"/g, '')
      .replace(/\[diagnostic\].*?\n/g, '')
      .trim();

    return response && response.length > 10 ? response : null;
  }

  /**
   * Parse vault results into structured format
   */
  parseVaultResults(text) {
    if (!text) return [];

    const results = [];
    const lines = text.split('\n').filter(l => l.trim());

    let currentResult = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for bullet points or numbered lists
      if (trimmed.match(/^[-*•]\s+(.+)/)) {
        const content = trimmed.replace(/^[-*•]\s+/, '');
        if (currentResult) {
          results.push(currentResult);
        }
        currentResult = { type: 'item', text: content };
      } else if (trimmed.match(/^\d+\.\s+(.+)/)) {
        const content = trimmed.replace(/^\d+\.\s+/, '');
        if (currentResult) {
          results.push(currentResult);
        }
        currentResult = { type: 'numbered', text: content };
      } else if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        // Bold header
        if (currentResult) {
          results.push(currentResult);
        }
        currentResult = { type: 'heading', text: trimmed.replace(/\*\*/g, '') };
      } else if (currentResult && trimmed.length > 0) {
        // Continuation of previous item
        currentResult.text += ' ' + trimmed;
      } else if (trimmed.length > 0) {
        // Plain text paragraph
        if (currentResult) {
          results.push(currentResult);
        }
        currentResult = { type: 'paragraph', text: trimmed };
      }
    }

    if (currentResult) {
      results.push(currentResult);
    }

    // If no structured results, wrap entire text
    if (results.length === 0 && text.length > 0) {
      return [{ type: 'text', text: text }];
    }

    return results;
  }

  /**
   * Store useful interaction in vault
   */
  async storeInteraction(chatId, userQuery, botResponse, metadata = {}) {
    try {
      const interaction = {
        type: 'telegram_interaction',
        chatId,
        query: userQuery,
        response: botResponse,
        timestamp: new Date().toISOString(),
        language: metadata.language || 'en',
        intent: metadata.intent || null,
        topic: metadata.topic || null
      };

      // Store via OpenClaw agent
      await this.storeViaAgent(interaction);

      return { success: true };
    } catch (error) {
      logger.error('Failed to store interaction:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Store interaction via OpenClaw agent
   */
  async storeViaAgent(interaction) {
    const agentQuery = `VAULT STORE: Store this interaction\n${JSON.stringify(interaction, null, 2)}`;

    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';

      const proc = spawn(openclawBin, [
        'agent', '--local', '--agent', 'main',
        '--message', agentQuery,
        '--timeout', '15'
      ], {
        env: { ...process.env }
      });

      setTimeout(() => {
        proc.kill();
        resolve(); // Don't wait for confirmation
      }, 15000);

      proc.on('close', () => resolve());
      proc.on('error', () => resolve()); // Ignore errors for storage
    });
  }

  /**
   * Format vault results for Telegram message
   */
  formatForTelegram(results, query) {
    if (!results || results.length === 0) {
      return `No results found for "${query}"`;
    }

    const lines = [`*Results for:* "${query}"\n`];

    for (const result of results.slice(0, 10)) { // Limit to 10 results
      switch (result.type) {
        case 'heading':
          lines.push(`\n*${result.text}*`);
          break;
        case 'item':
        case 'numbered':
          lines.push(`• ${result.text}`);
          break;
        case 'paragraph':
        case 'text':
        default:
          lines.push(result.text);
          break;
      }
    }

    return lines.join('\n');
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache stats
   */
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