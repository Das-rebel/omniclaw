/**
 * Flowise RAG Client
 * 
 * Connects to Flowise instance for low-code RAG pipelines.
 * Flowise runs at: http://35.200.164.45:3000
 * Default credentials: no auth (Unauthorized Access means need to set password)
 * 
 * Usage:
 *   const flowise = new FlowiseClient();
 *   const result = await flowise.query('your question', 'chatflow-id');
 */

const http = require('http');

class FlowiseClient {
  constructor(options = {}) {
    this.host = options.host || '35.200.164.45';
    this.port = options.port || 3000;
    this.username = options.username || process.env.FLOWISE_USERNAME || 'admin';
    this.password = options.password || process.env.FLOWISE_PASSWORD || '';
    this.timeout = options.timeout || 30000;
    this.sessionCookie = null;
  }

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const postData = body ? JSON.stringify(body) : '';
      const opts = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.sessionCookie ? { 'Cookie': this.sessionCookie } : {}),
          ...(body ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        },
        timeout: this.timeout,
      };

      const req = http.request(opts, (res) => {
        // Capture session cookie
        if (res.headers['set-cookie']) {
          this.sessionCookie = res.headers['set-cookie'][0].split(';')[0];
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            } else {
              resolve(data ? JSON.parse(data) : {});
            }
          } catch (e) {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      if (body) req.write(postData);
      req.end();
    });
  }

  async initialize() {
    console.log('🌊 Flowise Client: Connecting...');
    try {
      // Test connection
      const version = await this._request('GET', '/api/v1/version');
      console.log('✅ Flowise Client: Connected, version:', version.version || 'unknown');
      
      // Try to get chatflows (may need auth)
      try {
        const chatflows = await this._request('GET', '/api/v1/chatflows');
        console.log('✅ Flowise: Chatflows available:', Array.isArray(chatflows) ? chatflows.length : '?');
      } catch (e) {
        console.log('⚠️ Flowise: Chatflows need auth (set FLOWISE_PASSWORD)');
      }
      return this;
    } catch (e) {
      console.error('❌ Flowise Client: Failed:', e.message);
      throw e;
    }
  }

  async login(username, password) {
    /**
     * Login to Flowise to get session cookie.
     */
    const r = await this._request('POST', '/api/v1/login', { username, password });
    this.sessionCookie = r.token ? `token=${r.token}` : null;
    return r;
  }

  async query(question, chatflowId, options = {}) {
    /**
     * Query a RAG chatflow.
     * @param {string} question - The question
     * @param {string} chatflowId - Chatflow ID from Flowise UI
     * @param {object} options - Additional params
     */
    return this._request('POST', `/api/v1/prediction/${chatflowId}`, {
      question,
      streaming: false,
      ...options,
    });
  }

  async getChatflows() {
    return this._request('GET', '/api/v1/chatflows');
  }

  async getChatflow(chatflowId) {
    return this._request('GET', `/api/v1/chatflows/${chatflowId}`);
  }

  async getVersion() {
    return this._request('GET', '/api/v1/version');
  }
}

module.exports = { FlowiseClient };
