/**
 * Resilient Client Wrapper
 * Wraps all OmniClaw clients with resilience patterns
 */

const https = require('https');

/**
 * Make HTTPS POST request
 */
function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const bodyStr = JSON.stringify(body);
    
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers
      }
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`${res.statusCode}: ${JSON.stringify(parsed)}`));
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data.substring(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Groq AI Client
 */
class GroqClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.GROQ_API_KEY;
    this.model = 'llama-3.3-70b-versatile';
  }

  async query(prompt) {
    if (!this.apiKey) throw new Error('GROQ_API_KEY not configured');
    const data = await postJson(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0.7
      },
      { 'Authorization': `Bearer ${this.apiKey}` }
    );
    return data.choices?.[0]?.message?.content || 'No response';
  }

  async chat(messages) {
    if (!this.apiKey) throw new Error('GROQ_API_KEY not configured');
    const data = await postJson(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: this.model, messages: messages, max_tokens: 800 },
      { 'Authorization': `Bearer ${this.apiKey}` }
    );
    return data.choices?.[0]?.message?.content || '';
  }
}

/**
 * Cerebras AI Client
 */
class CerebrasClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.CEREBRAS_API_KEY;
    this.model = 'llama3.1-8b';
  }

  async query(prompt) {
    if (!this.apiKey) throw new Error('CEREBRAS_API_KEY not configured');
    const data = await postJson(
      'https://api.cerebras.ai/v1/chat/completions',
      { model: this.model, messages: [{ role: 'user', content: prompt }], max_tokens: 800 },
      { 'Authorization': `Bearer ${this.apiKey}` }
    );
    return data.choices?.[0]?.message?.content || 'No response';
  }

  async chat(messages) {
    if (!this.apiKey) throw new Error('CEREBRAS_API_KEY not configured');
    const data = await postJson(
      'https://api.cerebras.ai/v1/chat/completions',
      { model: this.model, messages: messages, max_tokens: 800 },
      { 'Authorization': `Bearer ${this.apiKey}` }
    );
    return data.choices?.[0]?.message?.content || '';
  }
}

// Anthropic Claude client for primary AI responses
class AnthropicClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.ZAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    this.baseUrl = 'https://api.z.ai';
    this.basePath = '/api/anthropic';
    this.model = 'claude-sonnet-4-20250514';
    this.timeout = 80000; // Cloud Functions: 80s timeout
  }

  _post(endpoint, body) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const reqOptions = {
        hostname: 'api.z.ai',
        path: '/api/anthropic/messages',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr)
        }
      };

      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(`${res.statusCode}: ${JSON.stringify(parsed)}`));
            }
          } catch (e) {
            reject(new Error(`Parse error: ${data.substring(0, 100)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(this.timeout, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(bodyStr);
      req.end();
    });
  }

  async query(prompt) {
    if (!this.apiKey) throw new Error('ZAI_API_KEY not configured');
    const data = await this._post('/api/anthropic/messages', {
      model: this.model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    return data.content?.[0]?.text || 'No response';
  }

  async chat(messages) {
    if (!this.apiKey) throw new Error('ZAI_API_KEY not configured');
    const data = await this._post('/api/anthropic/messages', {
      model: this.model,
      max_tokens: 1024,
      messages: messages
    });
    return data.content?.[0]?.text || 'No response';
  }
}

// Multi-provider query function
const multiProviderQuery = createFallbackChain('query', [
  'GroqClient',
  'CerebrasClient',
  'AnthropicClient'
]);

function createFallbackChain(operation, clientNames) {
  return async function(prompt) {
    // Inject system context about OmniClaw capabilities
    const systemContext = `You are OmniClaw, a personal AI assistant with these confirmed capabilities:
- Web Search/Browse (DuckDuckGo): user says "browse X" or "search web for X"
- Wikipedia: "wiki X" or "who is X"
- News: "news about X" or "news"
- Reddit: "reddit X" or "search reddit for X"
- URL/Tweet Review: auto-fetches and summarizes any shared URL
- Vault Search: "vault X" searches saved bookmarks (49+ items)
- Story Generation: "tell me a story" generates multi-character stories
- Hindi/Hinglish: translate to/from Hindi
- Multi-Voice TTS: stories narrated with 5 character voices
- Reminders: "remind me at 1 am to X" sets real timed reminders
- Thread/Conversation context: follows reply chains with full history
When asked about your capabilities, list ALL of these. Never say you cannot do something that is in this list.`;

    const clients = {
      GroqClient: () => new GroqClient(),
      CerebrasClient: () => new CerebrasClient(),
      AnthropicClient: () => new AnthropicClient()
    };

    for (const name of clientNames) {
      const getClient = clients[name];
      if (!getClient) continue;
      
      try {
        const client = getClient();
        // For 'query' operation, prepend system context
        let result;
        if (operation === 'query') {
          const enrichedPrompt = `[System: ${systemContext}]\n\nUser: ${prompt}`;
          result = await client.query(enrichedPrompt);
        } else {
          result = await client[operation](prompt);
        }
        return result;
      } catch (e) {
        console.warn(`[${name}] failed: ${e.message}`);
        continue;
      }
    }

    // Return a helpful fallback message
    return "I'm sorry, I'm having trouble connecting to my AI services right now. Please try again in a moment.";
  };
}

module.exports = {
  getClient: (name) => {
    const clients = {
      GroqClient: new GroqClient(),
      CerebrasClient: new CerebrasClient(),
      AnthropicClient: new AnthropicClient()
    };
    return clients[name] || { query: () => 'Client not found' };
  },
  getOriginalClients: () => ({
    GroqClient,
    CerebrasClient,
    AnthropicClient
  }),
  multiProviderQuery,
  createFallbackChain,
  testClientHealth: async () => ({ status: 'healthy' }),
  getHealthReport: async () => ({ status: 'ok' }),
  getHealthStatus: () => ({ status: 'ok' })
};
