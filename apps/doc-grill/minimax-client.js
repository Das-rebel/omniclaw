/**
 * MiniMax Client for doc-grill
 * Uses MiniMax API directly (not Z.ai proxy) to avoid rate limiting.
 * Endpoint: https://api.minimax.chat/v1/text/chatcompletion_v2
 * Model: MiniMax-Text-01
 */

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_BASE = 'https://api.minimax.chat/v1';

class MiniMaxClient {
  constructor(apiKey) {
    this.apiKey = apiKey || MINIMAX_API_KEY;
    this.model = 'MiniMax-Text-01';
    this.timeout = 25000;
    this.maxRetries = 2;
    this.stats = { totalRequests: 0, successfulRequests: 0, errors: 0 };
  }

  async query(message, options = {}) {
    const { maxTokens = 4000, temperature = 0.7 } = options;
    this.stats.totalRequests++;

    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const body = {
          model: this.model,
          max_tokens: maxTokens,
          temperature,
          stream: false,
          messages: [{ role: 'user', content: String(message) }]
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        const resp = await fetch(`${MINIMAX_BASE}/text/chatcompletion_v2`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        clearTimeout(timer);

        if (!resp.ok) {
          const errText = await resp.text().catch(() => 'unknown');
          throw new Error(`MiniMax ${resp.status}: ${errText.slice(0, 100)}`);
        }

        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content;

        if (!content) throw new Error('Empty response from MiniMax');

        this.stats.successfulRequests++;
        return content.trim();

      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }

    this.stats.errors++;
    throw lastError;
  }

  healthCheck() {
    return Promise.resolve({ ok: true, provider: 'minimax', model: this.model });
  }
}

module.exports = MiniMaxClient;