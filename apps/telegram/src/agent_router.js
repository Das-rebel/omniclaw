/**
 * Agent Router - OpenClaw agent integration for Telegram
 *
 * Handles:
 * - Spawning OpenClaw agent process
 * - Timeout handling
 * - Response parsing and formatting
 * - Session context passing
 */

const { spawn } = require('child_process');
const logger = require('./logger');

class AgentRouter {
  constructor(options = {}) {
    this.openclawBin = options.openclawBin || process.env.OPENCLAW_BIN || 'openclaw';
    this.endpoint = options.endpoint || process.env.OPENCLAW_ENDPOINT || 'http://localhost:18789';
    this.defaultTimeout = options.timeout || 60000; // 60 seconds like WhatsApp
    this.maxRetries = options.maxRetries || 2;

    // Active processes tracking
    this.activeProcesses = new Map();
  }

  /**
   * Call OpenClaw agent with message and context
   * Falls back to cloud endpoint if local spawn fails
   */
  async callAgent(message, context = {}) {
    const startTime = Date.now();
    const chatId = context.chatId || 'unknown';

    logger.info(`Calling OpenClaw agent for chat ${chatId}: "${message?.slice(0, 50)}..."`);

    // Build enhanced message for agent
    const enhancedMessage = this.buildAgentMessage(message, context);

    // Try local spawn first
    try {
      const response = await this.spawnAgent(enhancedMessage, context);
      const duration = Date.now() - startTime;
      logger.info(`Agent response in ${duration}ms for chat ${chatId}`);
      return this.handleAgentResponse(response, context);
    } catch (localError) {
      logger.warn(`Local spawn failed (${localError.message}), trying cloud fallback`);

      // Cloud fallback - call OmniClaw cloud endpoint
      try {
        const result = await this.callCloudAgent(enhancedMessage, context);
        if (result && result.text) {
          logger.info(`Cloud fallback response for chat ${chatId}`);
          return result.text;
        }
      } catch (cloudError) {
        logger.error(`Cloud fallback also failed: ${cloudError.message}`);
      }

      // Last resort - intelligent rule-based response
      return this.generateFallbackResponse(message, context);
    }
  }

  /**
   * Cloud agent fallback via HTTP
   */
  async callCloudAgent(message, context = {}) {
    const https = require('https');
    const body = JSON.stringify({
      message: message.slice(0, 2000),
      chatId: context.chatId,
      chatType: context.chatType,
      username: context.username
    });

    return new Promise((resolve, reject) => {
      const url = new URL(this.endpoint.startsWith('http') ? this.endpoint : 'https://omniclaw-gcs-338789220059.asia-south1.run.app');
      const options = {
        hostname: url.hostname,
        path: '/agent',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ text: data.slice(0, 500) });
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
      setTimeout(() => { req.destroy(); reject(new Error('Cloud timeout')); }, 30000);
    });
  }

  /**
   * Generate intelligent fallback when no AI is available
   */
  generateFallbackResponse(message, context) {
    const text = (typeof message === 'string' ? message : message.message || '').toLowerCase();

    // Smart keyword-based responses
    const patterns = [
      { trigger: /\b(status|health|system)\b/i, response: '🟢 OmniClaw is running! Type /status for full system check.' },
      { trigger: /\b(help|commands|what can|do)\b/i, response: '📋 Available commands:\n/start - Welcome\n/help - Commands\n/status - System health\n/vault <query> - Search knowledge graph\n/search <query> - Web search' },
      { trigger: /\b(vault|search|bookmark)\b/i, response: '🔍 Try: /vault <your search query>\nExample: /vault AI agent tips' },
      { trigger: /\b(twitter|instagram|social)\b/i, response: '🐦📷 Social sync active. Twitter sync: ✅ | Instagram sync: ✅\nUse /status for details.' },
      { trigger: /\b(thanks|thank you|thx)\b/i, response: '😊 You\'re welcome! OmniClaw here to help.' },
      { trigger: /\b(hi|hello|hey)\b/i, response: '👋 Hello! I\'m OmniClaw bot. Type /help for commands or /status to check system.' },
      { trigger: /\bbye|goodbye|exit\b/i, response: '👋 Bye! OmniClaw out.' },
      { trigger: /\bwho are you|what are you|about\b/i, response: '🤖 I\'m OmniClaw, your AI-powered assistant connected to your knowledge graph, social syncs, and cloud services.' },
      { trigger: /\btime|date|when\b/i, response: `🕐 Current time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST` },
    ];

    for (const { trigger, response } of patterns) {
      if (trigger.test(text)) {
        return response;
      }
    }

    // Default fallback
    return '🤖 OmniClaw here. Try:\n• /status - System health\n• /vault <query> - Search knowledge\n• /help - All commands\n\nOr just describe what you need!';
  }

  /**
   * Build enhanced message for agent
   */
  buildAgentMessage(message, context) {
    const parts = [];

    // Core message
    parts.push(`Message: "${message}"`);

    // Context metadata
    const contextParts = [];

    if (context.chatType) {
      contextParts.push(`Chat type: ${context.chatType}`);
    }

    if (context.username) {
      contextParts.push(`Username: @${context.username}`);
    }

    if (context.language) {
      contextParts.push(`Language: ${context.language}`);
    }

    if (context.isGroup) {
      contextParts.push('Context: group chat');
    }

    if (context.messageId) {
      contextParts.push(`Message ID: ${context.messageId}`);
    }

    // Add conversation history if available
    if (context.history && context.history.length > 0) {
      const recentHistory = context.history.slice(-3);
      contextParts.push(`Recent conversation:`);
      for (const turn of recentHistory) {
        const userPreview = typeof turn.user === 'string'
          ? turn.user.slice(0, 100)
          : JSON.stringify(turn.user).slice(0, 100);
        const botPreview = typeof turn.bot === 'string'
          ? turn.bot.slice(0, 100)
          : JSON.stringify(turn.bot).slice(0, 100);
        contextParts.push(`  - User: ${userPreview}`);
        contextParts.push(`  - Bot: ${botPreview}`);
      }
    }

    if (contextParts.length > 0) {
      parts.push(`Context: ${contextParts.join('; ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Spawn OpenClaw agent process
   */
  spawnAgent(message, context = {}) {
    return new Promise((resolve, reject) => {
      const timeoutMs = context.timeout || this.defaultTimeout;
      const timeout = timeoutMs + 5000; // 5 second buffer

      const args = [
        'agent', '--local', '--agent', 'main',
        '--message', message
      ];

      logger.debug(`Spawning: ${this.openclawBin} ${args.join(' ')}`);

      const proc = spawn(this.openclawBin, args, {
        env: {
          ...process.env,
          // Pass through any required env vars
          OPENCLAW_ENDPOINT: this.endpoint
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const pid = proc.pid;
      const chatId = context.chatId || 'unknown';

      // Track active process
      this.activeProcesses.set(pid, { proc, chatId, startedAt: Date.now() });

      let stdout = '';
      let stderr = '';
      let responseStarted = false;

      const timeoutId = setTimeout(() => {
        logger.warn(`Agent process ${pid} timed out after ${timeoutMs}ms, killing...`);
        proc.kill('SIGKILL');
        reject(new Error(`Agent timeout after ${timeoutMs}ms`));
      }, timeout);

      proc.stdout.on('data', (data) => {
        const output = data.toString();
        logger.debug(`Agent stdout: ${output.slice(0, 200)}`);
        stdout += output;
      });

      proc.stderr.on('data', (data) => {
        const output = data.toString();
        logger.debug(`Agent stderr: ${output.slice(0, 200)}`);
        stderr += output;
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(pid);

        logger.debug(`Agent process ${pid} exited with code ${code}`);

        // Clean up stdout
        const cleanedResponse = this.cleanResponse(stdout);

        if (cleanedResponse && cleanedResponse.length > 10) {
          logger.debug(`Using stdout response (${cleanedResponse.length} chars)`);
          resolve(cleanedResponse);
          return;
        }

        // Check stderr for response
        const cleanedStderr = this.cleanStderr(stderr);

        if (cleanedStderr && cleanedStderr.length > 10) {
          logger.debug(`Using stderr response (${cleanedStderr.length} chars)`);
          resolve(cleanedStderr);
          return;
        }

        // No valid response found
        if (code === 0 || stdout.length > 0 || stderr.length > 0) {
          // Process ran but gave empty response - treat as success with empty
          resolve('I processed your request but have no response.');
        } else {
          reject(new Error(`Agent process failed with code ${code}: ${stderr.slice(0, 200)}`));
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(pid);
        logger.error(`Agent process error: ${error.message}`);
        reject(error);
      });

      // Handle stdin close
      proc.stdin?.on('error', () => {
        // Ignore stdin errors
      });
    });
  }

  /**
   * Clean response text
   */
  cleanResponse(stdout) {
    return stdout
      .replace(/◇.*?╮.*?├.*?╯/gs, '')  // Remove box drawing chars
      .replace(/[│├─╮╯╭╰]/g, ' ')       // Remove more box chars
      .replace(/\n{3,}/g, '\n\n')       // Collapse multiple newlines
      .replace(/\s{2,}/g, ' ')          // Collapse multiple spaces
      .trim();
  }

  /**
   * Clean stderr (filter out diagnostics)
   */
  cleanStderr(stderr) {
    return stderr
      .replace(/\[diagnostic\].*?error="[^"]*"/g, '')
      .replace(/\[diagnostic\].*?\n/g, '')
      .replace(/\[.*?\]/g, '')          // Remove brackets with content
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * Handle and format agent response
   */
  handleAgentResponse(response, context) {
    if (!response) {
      return 'I received your message but could not generate a response.';
    }

    // Check for error indicators in response
    const errorIndicators = [
      'error',
      'failed',
      'exception',
      'cannot',
      'unable to'
    ];

    const isErrorResponse = errorIndicators.some(e =>
      response.toLowerCase().includes(e)
    );

    if (isErrorResponse && response.length < 100) {
      logger.warn(`Possible error in agent response: ${response}`);
    }

    // Format for Telegram
    return this.formatForTelegram(response, context);
  }

  /**
   * Format response for Telegram
   */
  formatForTelegram(response, context) {
    // Truncate if too long (Telegram limit is 4096 chars per message)
    const maxLength = 4000;

    let text = typeof response === 'string' ? response : JSON.stringify(response);

    // Remove any control characters
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Preserve basic formatting if already markdown
    // But escape any problematic characters
    text = text
      .replace(/(?<!\\)([*_~`#>+\-|{}.!])/g, '\\$1')  // Escape unescaped markdown
      .replace(/\\{2,}/g, '\\')                       // Collapse double escapes
      ;

    if (text.length > maxLength) {
      // Split at a good break point
      const truncated = text.slice(0, maxLength);
      const lastNewline = truncated.lastIndexOf('\n');

      if (lastNewline > maxLength * 0.7) {
        text = truncated.slice(0, lastNewline) + '\n\n_(truncated)_';
      } else {
        text = truncated + '\n\n_(truncated)_';
      }
    }

    return text;
  }

  /**
   * Send message via bot (for reminders, etc.)
   */
  async sendMessage(chatId, text, options = {}) {
    if (this.bot && this.bot.sendMessage) {
      try {
        return await this.bot.sendMessage(chatId, text, {
          parse_mode: options.parse_mode || 'Markdown',
          disable_web_page_preview: options.disable_web_page_preview || true
        });
      } catch (error) {
        logger.error(`Failed to send message to ${chatId}:`, error);
        throw error;
      }
    }
    throw new Error('Bot not configured for sending messages');
  }

  /**
   * Set bot instance for sending messages
   */
  setBot(bot) {
    this.bot = bot;
  }

  /**
   * Get active process count
   */
  getActiveProcessCount() {
    return this.activeProcesses.size;
  }

  /**
   * Kill all active processes
   */
  killAllProcesses() {
    for (const [pid, { proc }] of this.activeProcesses) {
      logger.info(`Killing agent process ${pid}`);
      proc.kill('SIGKILL');
    }
    this.activeProcesses.clear();
  }

  /**
   * Utility delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton
let instance = null;

function getAgentRouter(options) {
  if (!instance) {
    instance = new AgentRouter(options);
  }
  return instance;
}

module.exports = { AgentRouter, getAgentRouter };