/**
 * OmniClaw Telegram Bot - Main Express-based handler
 *
 * Supports both polling and webhook modes
 * Integrates with OpenClaw agent for AI responses
 */

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// Import Telegram bot (lazy loaded based on mode)
const TelegramBot = require('node-telegram-bot-api');

// Import our modules
const { MessageHandler } = require('./src/message_handler');
const { SessionManager, getSessionManager } = require('./src/session_manager');
const { VaultIntegration, getVaultIntegration } = require('./src/vault_integration');
const { GroupManager } = require('./src/group_manager');
const { AgentRouter, getAgentRouter } = require('./src/agent_router');
const logger = require('./src/logger');

// Configuration
const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  mode: process.env.TELEGRAM_MODE || 'polling',
  webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  openclawEndpoint: process.env.OPENCLAW_ENDPOINT || 'http://localhost:18789',
  port: parseInt(process.env.PORT || '18792'),
  logLevel: process.env.LOG_LEVEL || 'info'
};

// Validate config
if (!config.botToken) {
  logger.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

// Load feature flags
let featureConfig = {
  channels_enabled: true,
  groups_enabled: true,
  media_download: true,
  voice_messages: true
};

try {
  const configPath = path.join(__dirname, 'config', 'features.json');
  if (fs.existsSync(configPath)) {
    featureConfig = { ...featureConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  }
} catch (e) {
  logger.warn('Could not load features.json, using defaults');
}

// Initialize components
const sessionManager = getSessionManager({
  sessionTimeout: 30 * 60 * 1000, // 30 minutes
  maxHistory: 10
});

const agentRouter = getAgentRouter({
  endpoint: config.openclawEndpoint,
  timeout: 60000 // 60 seconds
});

const vaultIntegration = getVaultIntegration({
  vaultEndpoint: config.openclawEndpoint
});

const groupManager = new GroupManager({
  sessionManager,
  bot: null // Will be set after bot init
});

const messageHandler = new MessageHandler({
  intentRecognizer: null, // Will use built-in patterns
  agentRouter,
  sessionManager,
  vaultIntegration,
  groupManager,
  config: featureConfig
});

// Express app
const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // Disable for API
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '30'),
  message: {
    text: '⚠️ Too many requests. Please slow down.',
    parse_mode: 'Markdown'
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/webhook', limiter);
app.use('/send', limiter); // Message sending endpoint

// Body parsing
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    server: 'omniclaw-telegram',
    mode: config.mode,
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    sessions: sessionManager.getStats(),
    agentProcesses: agentRouter.getActiveProcessCount()
  });
});

// Stats endpoint
app.get('/stats', (req, res) => {
  res.json({
    mode: config.mode,
    uptime: process.uptime(),
    sessions: sessionManager.getStats(),
    vault: vaultIntegration.getCacheStats(),
    features: featureConfig
  });
});

// Telegram webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const { body } = req;

    // Verify secret if set
    if (config.webhookSecret) {
      const secret = req.headers['x-telegram-bot-api-secret-token'];
      if (secret !== config.webhookSecret) {
        logger.warn('Invalid webhook secret');
        return res.status(403).send('Forbidden');
      }
    }

    // Process update
    if (body.message || body.callback_query) {
      await processUpdate(body);
    }

    res.send('OK');
  } catch (error) {
    logger.error('Webhook error:', error);
    res.status(500).send('Error');
  }
});

// Webhook setup endpoint (for setting webhook URL)
app.post('/set-webhook', async (req, res) => {
  const { url, secret } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const bot = getBot();
    const result = await bot.setWebHook(url, {
      secret_token: secret || config.webhookSecret
    });

    logger.info(`Webhook set to: ${url}`);
    res.json({ success: true, webhook_url: url });
  } catch (error) {
    logger.error('Failed to set webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Message sending endpoint (for testing/external use)
app.post('/send', async (req, res) => {
  const { chat_id, text, parse_mode } = req.body;

  if (!chat_id || !text) {
    return res.status(400).json({ error: 'chat_id and text are required' });
  }

  try {
    const bot = getBot();
    await bot.sendMessage(chat_id, text, { parse_mode: parse_mode || 'Markdown' });
    res.json({ success: true });
  } catch (error) {
    logger.error('Send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bot instance
let bot = null;

function getBot() {
  if (!bot) {
    throw new Error('Bot not initialized');
  }
  return bot;
}

function initBot() {
  const botOptions = {
    polling: config.mode === 'polling'
  };

  if (config.mode === 'webhook' && config.webhookUrl) {
    delete botOptions.polling;
    botOptions.webhook = {
      port: config.port,
      host: '0.0.0.0'
    };
  }

  bot = new TelegramBot(config.botToken, botOptions);

  // Set webhook if in webhook mode
  if (config.mode === 'webhook' && config.webhookUrl) {
    bot.setWebHook(config.webhookUrl)
      .then(() => logger.info(`Webhook set to ${config.webhookUrl}`))
      .catch(err => logger.error('Failed to set webhook:', err));
  }

  // Set bot on agent router and group manager
  agentRouter.setBot(bot);
  groupManager.bot = bot;

  return bot;
}

/**
 * Process incoming Telegram update
 */
async function processUpdate(update) {
  try {
    // Handle callback queries
    if (update.callback_query) {
      return handleCallbackQuery(update.callback_query);
    }

    // Handle messages
    if (update.message) {
      return handleMessage(update.message);
    }

    // Handle edited messages
    if (update.edited_message) {
      return handleEditedMessage(update.edited_message);
    }

    // Handle channel posts
    if (update.channel_post) {
      return handleChannelPost(update.channel_post);
    }

    // Handle inline queries (if enabled)
    if (update.inline_query && featureConfig.inline_mode) {
      return handleInlineQuery(update.inline_query);
    }

    logger.debug('Unhandled update type:', Object.keys(update));
  } catch (error) {
    logger.error('Error processing update:', error);
  }
}

/**
 * Handle incoming message
 */
async function handleMessage(message) {
  const chatId = message.chat.id;
  const chatType = message.chat.type;

  logger.info(`[${chatType}] ${chatId} from @${message.from?.username || 'unknown'}: ${message.text?.slice(0, 50) || '[media]'}`);

  // Build context
  const context = {
    chatId,
    chatType,
    messageId: message.message_id,
    username: message.from?.username,
    firstName: message.from?.first_name,
    lastName: message.from?.last_name,
    isReply: !!message.reply_to_message,
    replyToMessageId: message.reply_to_message?.message_id
  };

  // Track session
  const session = sessionManager.getOrCreate(chatId, {
    chatType,
    username: message.from?.username,
    firstName: message.from?.first_name,
    lastName: message.from?.last_name
  });

  context.history = session.history;

  try {
    let response;

    // Detect command vs message
    const text = message.text || message.caption || '';

    if (text.startsWith('/')) {
      // Command
      const [command, ...args] = text.split(' ');
      response = await messageHandler.handleCommand(command, args.join(' '), message);
    } else if (message.photo || message.video || message.document) {
      // Media
      response = await messageHandler.handleMedia(message);
    } else if (message.location) {
      // Location
      response = messageHandler.handleLocation(message);
    } else if (text.includes('@')) {
      // Group mention
      const mentionResult = await groupManager.handleGroupMention(message);
      if (mentionResult.botMentioned !== undefined) {
        // Bot was mentioned, process as query
        response = await messageHandler.processMessage(message, context);
      } else {
        // Just a mention notification
        response = null;
      }
    } else {
      // Regular message - route to agent
      response = await messageHandler.processMessage(message, context);
    }

    // Send response if exists
    if (response && response.text) {
      const sentMessage = await bot.sendMessage(chatId, response.text, {
        parse_mode: response.parse_mode,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: response.disable_web_page_preview
      });

      // Track conversation
      sessionManager.trackMessage(chatId, text, response.text, {
        language: messageHandler.detectLanguage(text),
        username: message.from?.username
      });

      // Store interaction in vault
      vaultIntegration.storeInteraction(chatId, text, response.text, {
        language: messageHandler.detectLanguage(text)
      }).catch(err => logger.warn('Failed to store vault interaction:', err));

      return sentMessage;
    }
  } catch (error) {
    logger.error(`Error handling message in ${chatId}:`, error);

    // Send error message
    bot.sendMessage(chatId, 'Sorry, I encountered an error processing your message.', {
      parse_mode: 'Markdown'
    }).catch(err => logger.error('Failed to send error message:', err));
  }
}

/**
 * Handle callback query (inline keyboard)
 */
async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data;

  logger.info(`Callback query from ${callbackQuery.from?.username}: ${data}`);

  try {
    // Acknowledge callback
    await bot.answerCallbackQuery(callbackQuery.id);

    const result = await messageHandler.handleCallback(callbackQuery);

    if (result.callbackQueryId) {
      // Query was acknowledged, message update handled separately
      return;
    }

    // Edit message if result provided
    if (result.result && chatId) {
      await bot.editMessageText(result.result.text, {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        parse_mode: result.result.parse_mode
      });
    }
  } catch (error) {
    logger.error('Callback query error:', error);
  }
}

/**
 * Handle edited message
 */
async function handleEditedMessage(message) {
  logger.debug(`Message edited in ${message.chat.id}: ${message.text?.slice(0, 50)}`);
  // Could implement edit tracking here
}

/**
 * Handle channel post
 */
async function handleChannelPost(message) {
  if (!featureConfig.channels_enabled) return;

  const chatId = message.chat.id;
  logger.info(`Channel post in ${chatId}: ${message.text?.slice(0, 50)}`);

  // Process channel posts similar to regular messages
  // But don't send responses (channels are broadcast)
}

/**
 * Handle inline query
 */
async function handleInlineQuery(inlineQuery) {
  if (!featureConfig.inline_mode) return;

  // For inline mode, we need to implement answerInlineQuery
  // This is a simplified version
  try {
    await bot.answerInlineQuery(inlineQuery.id, [{
      type: 'article',
      id: '1',
      title: 'OmniClaw',
      input_message_content: {
        message_text: `Query: ${inlineQuery.query}\n\nI can help you with this!`
      },
      description: 'Ask me anything via OmniClaw'
    }], {
      cache_time: 0
    });
  } catch (error) {
    logger.error('Inline query error:', error);
  }
}

// Start server
function start() {
  // Initialize bot
  initBot();

  // Register bot handlers
  const telegramBot = getBot();

  // Message handler
  telegramBot.on('message', async (msg) => {
    // Skip updates we don't handle directly (they come through webhook/polling)
  });

  // Polling errors
  telegramBot.on('polling_error', (error) => {
    logger.error('Polling error:', error);
  });

  // Webhook errors
  telegramBot.on('webhook_error', (error) => {
    logger.error('Webhook error:', error);
  });

  // Start Express server for webhook mode or health checks
  if (config.mode === 'webhook') {
    app.listen(config.port, () => {
      logger.info(`🚀 Telegram bot webhook server running on port ${config.port}`);
      logger.info(`📡 Webhook URL: ${config.webhookUrl}`);
    });
  } else {
    // For polling mode, still start Express for health/stats
    app.listen(config.port, () => {
      logger.info(`🚀 Telegram bot polling server running on port ${config.port}`);
      logger.info(`🔄 Mode: polling`);
      logger.info(`💬 Send messages to your bot to test!`);
    });
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  agentRouter.killAllProcesses();
  sessionManager.destroy();
  if (bot) {
    bot.stopPolling?.();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  agentRouter.killAllProcesses();
  sessionManager.destroy();
  if (bot) {
    bot.stopPolling?.();
  }
  process.exit(0);
});

// Start the application
start();

module.exports = { app, bot, messageHandler, sessionManager, agentRouter };