/**
 * Telegram Client - Extended node-telegram-bot-api with retry logic and optimizations
 */

const TelegramBot = require('node-telegram-bot-api');
const logger = require('../apps/telegram/src/logger');

class TelegramClient extends TelegramBot {
  constructor(token, options = {}) {
    super(token, options);

    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    this.rateLimit = {
      messagesPerSecond: options.messagesPerSecond || 30,
      lastSent: 0
    };

    this.on('error', (err) => logger.error('Telegram client error:', err));
  }

  async sendMessageWithRetry(chatId, text, options = {}, retryCount = 0) {
    try {
      // Rate limiting
      await this.waitForRateLimit();

      return await this.sendMessage(chatId, text, options);
    } catch (error) {
      if (retryCount < this.maxRetries && this.isRetryableError(error)) {
        const delay = this.retryDelay * Math.pow(2, retryCount);
        logger.warn(`Retrying sendMessage in ${delay}ms (attempt ${retryCount + 1})`);
        await this.delay(delay);
        return this.sendMessageWithRetry(chatId, text, options, retryCount + 1);
      }
      throw error;
    }
  }

  async uploadMediaWithRetry(chatId, media, options = {}, retryCount = 0) {
    try {
      await this.waitForRateLimit();
      return await this.sendMediaGroup(chatId, media, options);
    } catch (error) {
      if (retryCount < this.maxRetries && this.isRetryableError(error)) {
        const delay = this.retryDelay * Math.pow(2, retryCount);
        await this.delay(delay);
        return this.uploadMediaWithRetry(chatId, media, options, retryCount + 1);
      }
      throw error;
    }
  }

  async getChatMemberWithRetry(chatId, userId, retryCount = 0) {
    try {
      return await this.getChatMember(chatId, userId);
    } catch (error) {
      if (retryCount < this.maxRetries && this.isRetryableError(error)) {
        await this.delay(this.retryDelay * Math.pow(2, retryCount));
        return this.getChatMemberWithRetry(chatId, userId, retryCount + 1);
      }
      throw error;
    }
  }

  isRetryableError(error) {
    const codes = [429, 500, 502, 503, 504];
    return codes.includes(error.code) || error.message?.includes('retry');
  }

  async waitForRateLimit() {
    const now = Date.now();
    const minInterval = 1000 / this.rateLimit.messagesPerSecond;
    const elapsed = now - this.rateLimit.lastSent;
    if (elapsed < minInterval) {
      await this.delay(minInterval - elapsed);
    }
    this.rateLimit.lastSent = Date.now();
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { TelegramClient };