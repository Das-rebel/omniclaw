/**
 * Multi-Provider LLM Client for doc-grill
 * Tries Mistral → Groq (llama-3.1-8b-instant) → Cerebras → MiniMax
 */

const PROVIDERS = {
  mistral: {
    name: 'Mistral',
    key: process.env.MISTRAL_API_KEY,
    base: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    timeout: 25000
  },
  groq: {
    name: 'Groq',
    key: process.env.GROQ_API_KEY,
    base: 'https://api.groq.com/openai/v1',
    model: 'llama-3.1-8b-instant',
    timeout: 20000
  },
  cerebras: {
    name: 'Cerebras',
    key: process.env.CEREBRAS_API_KEY,
    base: 'https://api.cerebras.ai/v1',
    model: 'qwen-3-32b',
    timeout: 25000
  },
  minimax: {
    name: 'MiniMax',
    key: process.env.MINIMAX_API_KEY,
    base: 'https://api.minimax.chat/v1',
    model: 'MiniMax-Text-01',
    timeout: 25000
  }
};

class MultiLLMClient {
  constructor() {
    this.providers = Object.entries(PROVIDERS)
      .filter(([, p]) => p.key)
      .map(([id, p]) => ({ id, ...p }));
    this.activeProvider = null;
    this.stats = { totalRequests: 0, successfulRequests: 0, errors: 0 };
    console.log('[MultiLLM] Providers available:', this.providers.map(p => p.name).join(', '));
  }

  async query(message, options = {}) {
    const { maxTokens = 4000, temperature = 0.7 } = options;
    this.stats.totalRequests++;

    const errors = [];
    for (const prov of this.providers) {
      try {
        const result = await this._call(prov, message, { maxTokens, temperature });
        this.activeProvider = prov.id;
        this.stats.successfulRequests++;
        console.log(`[MultiLLM] Success via ${prov.name}`);
        return result;
      } catch (err) {
        console.warn(`[MultiLLM] ${prov.name} failed: ${err.message}`);
        errors.push(`${prov.name}: ${err.message}`);
      }
    }

    this.stats.errors++;
    throw new Error(`All providers failed: ${errors.join(' | ')}`);
  }

  async _call(prov, message, { maxTokens, temperature }) {
    const body = {
      model: prov.model,
      max_tokens: maxTokens,
      temperature,
      stream: false,
      messages: [{ role: 'user', content: String(message) }]
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), prov.timeout);

    try {
      const resp = await fetch(`${prov.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${prov.key}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!resp.ok) {
        let errText = 'unknown';
        try { errText = await resp.text(); } catch (_) {}
        const err = new Error(`${resp.status}: ${errText.slice(0, 120)}`);
        err.status = resp.status;
        err.statusText = resp.statusText;
        throw err;
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;

      if (!content) throw new Error('Empty response');
      return content.trim();

    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        const t = new Error('Timeout');
        throw t;
      }
      throw err;
    }
  }

  async healthCheck() {
    return { ok: true, activeProvider: this.activeProvider || 'none', stats: this.stats };
  }
}

module.exports = MultiLLMClient;