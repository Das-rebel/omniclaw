/**
 * WhatsApp Client — OpenWA REST API
 * 
 * OpenWA replaces Baileys for WhatsApp Web communication.
 * All methods match the old BaileysWhatsAppClient interface for compatibility.
 * 
 * OpenWA runs as a service, this client communicates via REST API.
 */

const http = require('http');
const https = require('https');

const OPENWA_URL = process.env.OPENWA_URL || 'http://localhost:2785';
const OPENWA_KEY = process.env.OPENWA_KEY || 'dev-admin-key';

class OpenWAWhatsAppClient {
  constructor(config = {}) {
    this.url = config.url || OPENWA_URL;
    this.key = config.key || OPENWA_KEY;
    this.sessionId = null;
  }

  async openwaReq(method, endpoint, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.url + endpoint);
      const mod = url.protocol === 'https:' ? https : http;
      const opts = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method,
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.key },
      };
      const req = mod.request(opts, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch { resolve({ raw: d, statusCode: res.statusCode }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async getActiveSession() {
    if (this.sessionId) return this.sessionId;
    try {
      const sessions = await this.openwaReq('GET', '/api/sessions');
      if (Array.isArray(sessions)) {
        const active = sessions.find(s => s.status === 'ready');
        if (active) { this.sessionId = active.id; return active.id; }
      }
    } catch {}
    return null;
  }

  async getMessages(limit = 50) {
    const sid = await this.getActiveSession();
    if (!sid) return [];
    try {
      const msgs = await this.openwaReq('GET', `/api/sessions/${sid}/messages?limit=${limit}`);
      return Array.isArray(msgs) ? msgs : [];
    } catch { return []; }
  }

  async sendMessage(chatId, content) {
    const sid = await this.getActiveSession();
    if (!sid) throw new Error('No active WhatsApp session');
    const body = typeof content === 'string' ? { chatId, text: content } : { chatId, ...content };
    const result = await this.openwaReq('POST', `/api/sessions/${sid}/messages/send-text`, body);
    return result;
  }

  // Alias for sendMessage (Baileys compatibility)
  async sendText(chatId, text) {
    return this.sendMessage(chatId, text);
  }

  // Connection status
  async isConnected() {
    const sid = await this.getActiveSession();
    return !!sid;
  }

  // Get session info
  async getSessionInfo() {
    const sid = await this.getActiveSession();
    if (!sid) return null;
    try {
      const sessions = await this.openwaReq('GET', '/api/sessions');
      return sessions.find(s => s.id === sid) || null;
    } catch { return null; }
  }

  // Destroy/cleanup (no-op for REST API client)
  async destroy() {
    this.sessionId = null;
  }
}

module.exports = OpenWAWhatsAppClient;
