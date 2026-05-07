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
   */
  async callAgent(message, context = {}) {
    const startTime = Date.now();
    const chatId = context.chatId || 'unknown';

    logger.info(`Calling OpenClaw agent for chat ${chatId}: "${message?.slice(0, 50)}..."`);

    // Build enhanced message for agent
    const enhancedMessage = this.buildAgentMessage(message, context);

    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.spawnAgent(enhancedMessage, context);

        const duration = Date.now() - startTime;
        logger.info(`Agent response in ${duration}ms for chat ${chatId}`);

        return this.handleAgentResponse(response, context);
      } catch (error) {
        lastError = error;
        logger.warn(`Agent attempt ${attempt}/${this.maxRetries} failed: ${error.message}`);

        if (attempt < this.maxRetries) {
          // Wait before retry (exponential backoff)
          await this.delay(Math.pow(2, attempt) * 500);
        }
      }
    }

    logger.error(`All ${this.maxRetries} agent attempts failed for chat ${chatId}`);
    throw lastError;
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