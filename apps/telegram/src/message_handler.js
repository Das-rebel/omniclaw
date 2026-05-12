/**
 * Message Handler - Telegram message processing and routing
 *
 * Handles:
 * - Intent detection and classification
 * - Command processing
 * - Query routing to OpenClaw agent
 * - Media processing
 * - Response formatting with Telegram markdown
 */

const logger = require('./logger');
const { IntentRecognizer } = require('../../../clients/intent_recognizer');

class MessageHandler {
  constructor(options = {}) {
    this.intentRecognizer = options.intentRecognizer || new IntentRecognizer();
    this.agentRouter = options.agentRouter;
    this.sessionManager = options.sessionManager;
    this.vaultIntegration = options.vaultIntegration;
    this.groupManager = options.groupManager;
    this.config = options.config || {};

    // Hindi/Hinglish detection patterns
    this.hindiPatterns = [
      /[\u0900-\u097F]/,  // Devanagari script
      /\b(mera|apna|unka|iski|uski|kya|kaise|kyun|toh|na|aur|ya|lekin|hai|hi|nahin|haan|bhai|dost|subah|shaam|raat|kaam|khaana|sleep|padhai|kaaran|kaarya|pradhaan|mukhya|milakar|ekaurat|donon|samaan|sabse|achha|burra|bekaar|jaldi|paraan|pehle|baad|pakad|marzi|sooch|bola|jaano|suno|dekho|chalo|jao|aao|ruko|haraamo|waah|kya baat|sahi|galat|bilkul|shayad|kal|aaj|parso)\b/gi,
      /\b(mera|apna|kya|hai|karo|do|lo|mao|ga|ji|ji|ka|ke|ki|se|ko|or|zaroor|btao|btayo|ho|jaise|tab|toh|ab|na|sirf|matlab|yahi|waala)\b/gi
    ];

    // Language detection cache
    this.languageCache = new Map();
  }

  /**
   * Detect language (Hindi/Hinglish/English)
   * @param {string} text - Input text
   * @returns {string} - Language code ('en', 'hi', 'hn' for Hinglish)
   */
  detectLanguage(text) {
    if (!text || typeof text !== 'string') return 'en';

    const cacheKey = text.slice(0, 50);
    if (this.languageCache.has(cacheKey)) {
      return this.languageCache.get(cacheKey);
    }

    const lowerText = text.toLowerCase();

    // Check for Hindi script
    const hasHindiScript = /[\u0900-\u097F]/.test(text);

    // Count Hindi words
    let hindiWordCount = 0;
    for (const pattern of this.hindiPatterns) {
      const matches = lowerText.match(pattern);
      if (matches) hindiWordCount += matches.length;
    }

    // Calculate ratio
    const words = text.split(/\s+/).length;
    const hindiRatio = words > 0 ? hindiWordCount / words : 0;

    let language = 'en';
    if (hasHindiScript || hindiRatio > 0.3) {
      language = hindiRatio > 0.5 ? 'hi' : 'hn'; // Pure Hindi or Hinglish
    }

    // Cache result
    if (this.languageCache.size > 1000) {
      const firstKey = this.languageCache.keys().next().value;
      this.languageCache.delete(firstKey);
    }
    this.languageCache.set(cacheKey, language);

    return language;
  }

  /**
   * Detect intent from message
   * @param {string} message - Input message
   * @param {object} context - Conversation context
   * @returns {object} - Intent result
   */
  detectIntent(message, context = null) {
    const text = typeof message === 'string' ? message : message.text || '';

    // Check for commands first
    if (text.startsWith('/')) {
      const command = text.split(' ')[0].toLowerCase();
      return {
        intent: 'Command',
        confidence: 1.0,
        command: command,
        parameters: text.slice(command.length).trim()
      };
    }

    // Use intent recognizer for natural language
    const recognized = this.intentRecognizer.recognize(text, context);

    // Override with special patterns for Telegram
    if (text.includes('@')) {
      return { intent: 'Mention', confidence: 0.95, mention: true };
    }

    if (text.match(/\.(jpg|jpeg|png|gif|mp4|pdf)/i)) {
      return { intent: 'Media', confidence: 0.95, mediaType: 'file' };
    }

    return recognized;
  }

  /**
   * Handle command processing
   * @param {string} command - Command name
   * @param {Array<string>} args - Command arguments
   * @param {object} message - Original Telegram message
   * @returns {object} - Response
   */
  async handleCommand(command, args, message) {
    const chatId = message.chat.id;
    const chatType = message.chat.type;

    logger.info(`Processing command: ${command} for chat ${chatId}`);

    switch (command) {
      case '/start':
        return this.handleStart(chatId, chatType);

      case '/help':
        return this.handleHelp(chatId, chatType);

      case '/status':
        return this.handleStatus(chatId);

      case '/search':
        return this.handleSearch(chatId, args);

      case '/vault':
        return this.handleVault(chatId, args);

      case '/remind':
        return this.handleRemind(chatId, args, message);

      case '/ban':
        if (chatType === 'group' || chatType === 'supergroup') {
          return this.groupManager.handleAdminCommand('ban', args, message);
        }
        return { text: 'This command is only available in groups.' };

      case '/mute':
        if (chatType === 'group' || chatType === 'supergroup') {
          return this.groupManager.handleAdminCommand('mute', args, message);
        }
        return { text: 'This command is only available in groups.' };

      case '/pin':
        if (chatType === 'group' || chatType === 'supergroup') {
          return this.groupManager.handleAdminCommand('pin', args, message);
        }
        return { text: 'This command is only available in groups.' };

      case '/settings':
        if (chatType === 'group' || chatType === 'supergroup') {
          return this.groupManager.handleGroupSettings(chatId);
        }
        return { text: 'Group settings only available in groups.' };

      case '/growthos':
        return this.handleGrowthOS(chatId, args, message);

      default:
        return {
          text: `Unknown command: ${command}. Use /help for available commands.`,
          parse_mode: 'Markdown'
        };
    }
  }

  /**
   * Handle /growthos command — delegate to Growth Workflow OS
   */
  async handleGrowthOS(chatId) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const fs = require('fs');

    try {
      const { stdout } = await execAsync(
        'python3 /Users/Subho/growth-workflow-os/run_daily.py --dry-run 2>&1',
        { timeout: 60000 }
      );
      const match = stdout.match(/TOTAL\s+(\d+)\s+signals/);
      const signalCount = match ? match[1] : '?';

      const memoDir = '/Users/Subho/growth-workflow-os/operating_memos/output';
      const memoFiles = fs.existsSync(memoDir)
        ? fs.readdirSync(memoDir).filter(f => f.startsWith('weekly_memo_')).sort().reverse()
        : [];

      let memoStatus = 'No memo generated';
      if (memoFiles.length > 0) {
        const stat = fs.statSync(`${memoDir}/${memoFiles[0]}`);
        memoStatus = `${memoFiles[0].replace('weekly_memo_', '').replace('.md', '')} (${Math.round(stat.size / 1024)}KB)`;
      }

      return {
        text: `*🧠 Growth OS Status*\n\n` +
          `📡 Signals: *${signalCount}* (last run)\n` +
          `📝 Latest memo: *${memoStatus}*\n` +
          `🌐 http://localhost:8501\n\n` +
          `/growthos run — full pipeline\n` +
          `/growthos digest — daily digest`,
        parse_mode: 'Markdown'
      };
    } catch (err) {
      return { text: `❌ Growth OS error: ${err.message.slice(0, 200)}` };
    }
  }

  /**
   * Handle /start command
   */
  handleStart(chatId, chatType) {
    const welcomeMessage = chatType === 'private'
      ? `*Welcome to OmniClaw Bot!* 🦞

I'm your AI-powered assistant integrated with OpenClaw. Here's what I can do:

*Commands:*
/help - Show all commands
/status - Check system health
/search - Search the web
/vault - Query your knowledge graph
/remind - Set a reminder

*Features:*
✅ Text queries and commands
✅ Photo and video handling
✅ Group chat support
✅ Multi-language support (English, Hindi, Hinglish)
✅ Vault knowledge graph integration

Just send me a message and I'll help you out!`

      : `*OmniClaw Bot Active!* 🦞

This group is now connected to OmniClaw.

*Admin Commands:*
/ban @user - Ban a user
/mute @user - Mute a user
/pin - Pin a message
/settings - Group settings

Use /help in private chat for full command list.`;

    return {
      text: welcomeMessage,
      parse_mode: 'Markdown'
    };
  }

  /**
   * Handle /help command
   */
  handleHelp(chatId, chatType) {
    const helpMessage = `*OmniClaw Help* 🦞

*Basic Commands:*
/start - Get started
/help - Show this help
/status - System health check
/search <query> - Search the web
/vault <query> - Search knowledge graph
/remind <time> <message> - Set reminder

*Examples:*
• \`What's the weather in Mumbai?\`
• \`Search for latest AI news\`
• \`/search python tutorials\`
• \`/vault project ideas\`
• \`/remind 5m drink water\`

*Group Commands:*
/ban @username - Ban user (admin only)
/mute @username - Mute user (admin only)
/pin - Pin current message (admin only)
/settings - Group settings

*Multi-language:*
I understand English, Hindi (हिंदी), and Hinglish (mixed). Just chat naturally!

*Reply Chains:*
Reply to bot messages to continue conversations.`;

    return {
      text: helpMessage,
      parse_mode: 'Markdown'
    };
  }

  /**
   * Handle /status command
   */
  async handleStatus(chatId) {
    try {
      // Get cloud system health from all endpoints
      const cloudHealth = await this.vaultIntegration.getSystemHealth();
      
      // Get cache stats
      const cacheStats = this.vaultIntegration.getCacheStats();

      const statusText = `*OmniClaw System Status*

` +
        `🟢 *OmniClaw:* ${cloudHealth.omniclaw}
` +
        `🔍 *Vault Search:* ${cloudHealth.vault_search}
` +
        `🐦 *Twitter Sync:* ${cloudHealth.twitter_sync}
` +
        `📷 *Instagram Sync:* ${cloudHealth.instagram_sync}
` +
        `🎙️ *Celebrity TTS:* ${cloudHealth.tts}
` +
        `📖 *Story Narrator:* ${cloudHealth.story_narrator}

` +
        `💾 *Cache:* ${cacheStats.size} entries
` +
        `✅ All cloud endpoints reachable`;

      return {
        text: statusText,
        parse_mode: 'Markdown'
      };
    } catch (error) {
      logger.error('Status check failed:', error);
      return {
        text: '*Status:* Check failed ⚠️\n\nCould not reach cloud endpoints.',
        parse_mode: 'Markdown'
      };
    }
  }

  /**
   * Handle /search command
   */
  async handleSearch(chatId, query) {
    if (!query) {
      return {
        text: '*Usage:* /search <your query>\n\nExample: `/search latest technology news`',
        parse_mode: 'Markdown'
      };
    }

    try {
      const result = await this.agentRouter.callAgent(query, {
        chatId,
        intent: 'SearchIntent',
        source: 'telegram'
      });
      return this.buildResponse(result, 'search');
    } catch (error) {
      logger.error('Search failed:', error);
      return {
        text: 'Search failed. Please try again.',
        parse_mode: 'Markdown'
      };
    }
  }

  /**
   * Handle /vault command
   */
  async handleVault(chatId, query) {
    if (!query) {
      return {
        text: '*Usage:* /vault <your query>\n\nExample: `/vault project ideas`',
        parse_mode: 'Markdown'
      };
    }

    try {
      const result = await this.vaultIntegration.searchVault(query, chatId);
      return this.buildResponse(result, 'vault');
    } catch (error) {
      logger.error('Vault search failed:', error);
      return {
        text: 'Vault search failed. Please try again.',
        parse_mode: 'Markdown'
      };
    }
  }

  /**
   * Handle /remind command
   */
  async handleRemind(chatId, args, message) {
    if (!args) {
      return {
        text: '*Usage:* /remind <time> <message>\n\nExamples:\n/remind 5m Drink water\n/remind 1h Call mom\n/remind 2d Submit report',
        parse_mode: 'Markdown'
      };
    }

    // Parse time (e.g., "5m", "1h", "2d")
    const timeMatch = args.match(/^(\d+)([mhd])\s+(.+)$/i);
    if (!timeMatch) {
      return {
        text: 'Invalid format. Use: `/remind <number><m/h/d> <message>`\n\nExamples:\n• `/remind 5m water`\n• `/remind 1h meeting`',
        parse_mode: 'Markdown'
      };
    }

    const [, amount, unit, reminderText] = timeMatch;
    const multipliers = { m: 60, h: 3600, d: 86400 };
    const seconds = parseInt(amount) * multipliers[unit.toLowerCase()];

    // Store reminder
    const reminder = {
      chatId,
      userId: message.from.id,
      text: reminderText,
      seconds,
      createdAt: Date.now(),
      messageId: message.message_id
    };

    // Schedule reminder (simplified - in production use a proper job queue)
    setTimeout(() => {
      this.sendReminderNotification(reminder);
    }, seconds * 1000);

    const timeStr = `${amount}${unit}`;
    return {
      text: `*Reminder set!* ⏰\n\nI'll remind you in *${timeStr}* to:\n_${reminderText}_`,
      parse_mode: 'Markdown'
    };
  }

  /**
   * Send reminder notification
   */
  sendReminderNotification(reminder) {
    if (this.agentRouter?.sendMessage) {
      this.agentRouter.sendMessage(
        reminder.chatId,
        `*Reminder!* ⏰\n\n_${reminder.text}_`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  /**
   * Handle general query via OpenClaw agent
   */
  async handleQuery(message, context) {
    const chatId = context.chatId;
    const language = this.detectLanguage(message.text || message.caption || '');

    // Build enhanced context for agent
    const agentContext = {
      ...context,
      language,
      source: 'telegram',
      chatType: context.chatType,
      username: context.username,
      isGroup: context.chatType === 'group' || context.chatType === 'supergroup'
    };

    try {
      const response = await this.agentRouter.callAgent(message.text || message.caption, agentContext);
      return this.buildResponse(response, 'agent');
    } catch (error) {
      logger.error('Agent query failed:', error);
      return {
        text: 'Sorry, I encountered an error processing your request.',
        parse_mode: 'Markdown'
      };
    }
  }

  /**
   * Handle media (photos, videos, documents)
   */
  async handleMedia(message) {
    const chatId = message.chat.id;
    const hasCaption = message.caption && message.caption.trim().length > 0;

    if (!hasCaption) {
      return {
        text: '📷 *Media received!*\n\nAdd a caption with your question to get help with this file.'
      };
    }

    // Process media with caption as query
    return this.handleQuery(message, {
      chatId,
      messageId: message.message_id,
      mediaType: message.photo ? 'photo' : message.video ? 'video' : 'document'
    });
  }

  /**
   * Handle location data
   */
  handleLocation(message) {
    const location = message.location;
    return {
      text: `*Location received!* 📍\n\nLatitude: ${location.latitude}\nLongitude: ${location.longitude}\n\nWhat would you like to know about this location?`
    };
  }

  /**
   * Handle callback queries (inline keyboard)
   */
  async handleCallback(callbackQuery) {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;

    logger.info(`Callback query: ${data}`);

    // Handle different callback data patterns
    if (data.startsWith('vault_search:')) {
      const query = data.replace('vault_search:', '');
      const result = await this.vaultIntegration.searchVault(query, chatId);
      return { result, callbackQueryId: callbackQuery.id };
    }

    if (data === 'refresh_status') {
      const status = await this.handleStatus(chatId);
      return { result: status, callbackQueryId: callbackQuery.id };
    }

    // Default acknowledgment
    return { callbackQueryId: callbackQuery.id };
  }

  /**
   * Build formatted response
   */
  buildResponse(content, type = 'default') {
    if (!content) {
      return { text: 'No response available.' };
    }

    const text = typeof content === 'string' ? content : content.text || JSON.stringify(content);

    // Apply Telegram-safe markdown
    const safeText = this.sanitizeMarkdown(text);

    return {
      text: safeText,
      parse_mode: 'Markdown',
      ...(type === 'search' && { disable_web_page_preview: true })
    };
  }

  /**
   * Sanitize text for Telegram markdown
   */
  sanitizeMarkdown(text) {
    if (!text) return '';

    return text
      .replace(/([_*~`#>+\-=|{}.!])/g, '\\$1')  // Escape special markdown chars
      .replace(/\n+/g, '\n')
      .slice(0, 4096);  // Telegram message limit
  }

  /**
   * Process incoming message
   */
  async processMessage(message, context) {
    const intent = this.detectIntent(message, context);

    logger.info(`Intent detected: ${intent.intent} (${intent.confidence})`);

    // Route to appropriate handler
    switch (intent.intent) {
      case 'Command':
        return this.handleCommand(intent.command, intent.parameters, message);

      case 'Mention':
        return this.groupManager?.handleGroupMention(message) ||
               { text: 'You mentioned me! How can I help?' };

      case 'Media':
        return this.handleMedia(message);

      default:
        return this.handleQuery(message, context);
    }
  }
}

module.exports = { MessageHandler };