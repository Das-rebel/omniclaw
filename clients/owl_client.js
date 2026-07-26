/**
 * OWL-Lite Research Client
 * 
 * Multi-agent research using Claude + GPT in parallel.
 * Lightweight alternative to full OWL (camel-ai/owl).
 * 
 * Usage:
 *   const owl = new OWLClient();
 *   const results = await owl.research("latest AI developments");
 */

const https = require('https');

class OWLClient {
  constructor(options = {}) {
    this.anthropicKey = options.anthropicKey || process.env.ANTHROPIC_API_KEY;
    this.openaiKey = options.openaiKey || process.env.OPENAI_API_KEY;
    this.vpsUrl = options.vpsUrl || 'http://35.200.164.45:8000'; // OWL-Lite API on VPS
    this.timeout = options.timeout || 60000;
  }

  async initialize() {
    console.log('🦉 OWL Client: Initializing...');
    if (!this.anthropicKey && !this.openaiKey) {
      console.warn('⚠️ OWL Client: No API keys set. Set ANTHROPIC_API_KEY or OPENAI_API_KEY');
    }
    console.log('✅ OWL Client: Ready');
    return this;
  }

  _request(method, path, body = null, host, port, headers = {}) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: host || this.vpsUrl.replace(/http:\/\/|https:\/\//, '').split(':')[0],
        port: port || 8000,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        timeout: this.timeout,
      };

      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (e) {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async research(query, options = {}) {
    /**
     * Run multi-agent research using Claude + GPT.
     * @param {string} query - Research question
     * @param {object} options - { models: ['claude', 'gpt'], maxTokens: 1024 }
     */
    const results = {};
    const models = options.models || ['claude', 'gpt'];

    if (models.includes('claude') && this.anthropicKey) {
      try {
        results.claude = await this._queryClaude(query);
      } catch (e) {
        results.claude_error = e.message;
      }
    }

    if (models.includes('gpt') && this.openaiKey) {
      try {
        results.gpt = await this._queryOpenAI(query);
      } catch (e) {
        results.gpt_error = e.message;
      }
    }

    // Synthesize results if multiple agents
    if (results.claude && results.gpt) {
      results.synthesis = await this._synthesize(results.claude, results.gpt, query);
    }

    return results;
  }

  async _queryClaude(query) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        timeout: this.timeout,
      };

      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed.content?.[0]?.text || parsed.content?.[0]?.type);
          } catch (e) {
            reject(new Error(data.slice(0, 200)));
          }
        });
      });

      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: `Research and provide key findings about: ${query}` }],
      }));
      req.end();
    });
  }

  async _queryOpenAI(query) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiKey}`,
        },
        timeout: this.timeout,
      };

      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed.choices?.[0]?.message?.content);
          } catch (e) {
            reject(new Error(data.slice(0, 200)));
          }
        });
      });

      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 1024,
        messages: [{ role: 'user', content: `Research and provide key findings about: ${query}` }],
      }));
      req.end();
    });
  }

  async _synthesize(claudeResult, gptResult, query) {
    if (!this.anthropicKey) return null;
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        timeout: this.timeout,
      };

      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.content?.[0]?.text || '');
          } catch (e) {
            resolve('');
          }
        });
      });

      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `Synthesize these two research findings into a coherent answer about "${query}":\n\nClaude:\n${claudeResult}\n\nGPT:\n${gptResult}`
        }],
      }));
      req.end();
    });
  }

  async quickResearch(query) {
    /**
     * Single-agent quick research (Claude only).
     */
    return this.research(query, { models: ['claude'] });
  }
}

module.exports = { OWLClient };
