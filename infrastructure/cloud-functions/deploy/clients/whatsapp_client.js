/**
 * WhatsApp Client Alias — OpenWA REST API
 * 
 * Extends OpenWAWhatsAppClient (formerly BaileysWhatsAppClient)
 * All existing code using WhatsAppClient continues to work unchanged.
 */

const OpenWAWhatsAppClient = require('./baileys_whatsapp_client');

class WhatsAppClient extends OpenWAWhatsAppClient {
  constructor(config = {}) {
    super(config);
    this.OPENWA_URL = this.url;
    this.OPENWA_KEY = this.key;
  }
}

module.exports = WhatsAppClient;
