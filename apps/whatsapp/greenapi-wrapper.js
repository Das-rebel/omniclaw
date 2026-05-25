/**
 * GreenAPI Wrapper - all available endpoints
 * Wraps the GreenAPI REST API with proper error handling.
 */
const axios = require('axios');

class GreenAPI {
  constructor(instanceId, token) {
    this.instanceId = instanceId;
    this.token = token;
    this.baseURL = `https://${instanceId.slice(0, 4)}.api.greenapi.com`;
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 25000,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async _post(method, payload) {
    try {
      const res = await this.client.post(`/waInstance${this.instanceId}/${method}/${this.token}`, payload);
      return { ok: true, data: res.data };
    } catch (e) {
      if (e.code === 'ECONNABORTED') {
        console.error(`❌ GreenAPI ${method} timeout`);
        return { ok: false, error: 'TIMEOUT', message: 'Request timed out' };
      }
      if (e.response) {
        const status = e.response.status;
        const msg = e.response?.data?.message || e.response?.data?.error || e.message;
        if (status >= 400 && status < 500) {
          console.error(`❌ GreenAPI ${method} ${status}:`, msg.slice(0, 200));
          return { ok: false, error: 'VALIDATION', message: msg };
        }
        console.error(`❌ GreenAPI ${method} ${status}:`, msg.slice(0, 200));
        return { ok: false, error: 'SERVER', message: msg };
      }
      console.error(`❌ GreenAPI ${method}:`, e.message.slice(0, 200));
      return { ok: false, error: 'NETWORK', message: e.message };
    }
  }

  // ─── Text ──────────────────────────────────────────
  async sendText(chatId, message) {
    const result = await this._post('sendMessage', { chatId, message });
    return result.ok ? result.data : result;
  }

  // ─── Interactive Buttons ──────────────────────────
  async sendButtons(chatId, message, buttons, footer) {
    // GreenAPI expects {buttonId, buttonText} format
    const normalized = buttons.map(b => ({
      buttonId: b.id || b.buttonId || '1',
      buttonText: b.text || b.buttonText || 'Button'
    }));
    const result = await this._post('sendButtons', { chatId, message, buttons: normalized, footer });
    return result.ok ? result.data : result;
  }

  // ─── Interactive List (Native WhatsApp list menu) ───
  async sendList(chatId, message, buttonText, sections, title, footer) {
    const result = await this._post('sendListMessage', { chatId, message, buttonText, sections, title, footer });
    return result.ok ? result.data : result;
  }

  // ─── File/Image/Video by URL ──────────────────────
  async sendFileByUrl(chatId, urlFile, fileName, caption) {
    const result = await this._post('sendFileByUrl', { chatId, urlFile, fileName, caption });
    return result.ok ? result.data : result;
  }

  // ─── Location ─────────────────────────────────────
  async sendLocation(chatId, latitude, longitude, name, address) {
    const result = await this._post('sendLocation', { chatId, latitude, longitude, name, address });
    return result.ok ? result.data : result;
  }

  // ─── Contact ──────────────────────────────────────
  async sendContact(chatId, contact) {
    const result = await this._post('sendContact', { chatId, contact });
    return result.ok ? result.data : result;
  }

  // ─── Link Preview (auto from URL in text) ─────────
  // Just send the URL in sendText - WhatsApp generates a preview automatically

  // ─── Quote/Reply ──────────────────────────────────
  async sendReply(chatId, message, quotedMessageId) {
    const result = await this._post('sendMessage', { chatId, message, quotedMessageId });
    return result.ok ? result.data : result;
  }

  // ─── Reaction ────────────────────────────────────
  async sendReaction(chatId, messageId, emoji) {
    const result = await this._post('setReaction', { chatId, idMessage: messageId, reaction: emoji });
    return result.ok ? result.data : result;
  }
}

module.exports = GreenAPI;
