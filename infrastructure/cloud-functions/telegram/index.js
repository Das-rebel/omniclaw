/**
 * GCP Cloud Functions - Telegram Handler
 *
 * HTTP webhook handler for GCP Cloud Functions
 * or Cloud Run deployment
 */

require('dotenv').config();

const functions = require('@google-cloud/functions-framework');
const { spawn } = require('child_process');
const logger = require('../../../apps/telegram/src/logger');

// Initialize session manager
const sessions = new Map();

// Health check
functions.http('telegramHealth', (req, res) => {
  res.json({ status: 'ok', service: 'telegram-function' });
});

// Main webhook handler
functions.http('telegramWebhook', async (req, res) => {
  try {
    const body = req.body;

    // Verify Telegram signature
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      logger.warn('Invalid webhook signature');
      return res.status(403).send('Forbidden');
    }

    // Process update
    await processUpdate(body);

    res.send('OK');
  } catch (error) {
    logger.error('Webhook error:', error);
    res.status(500).send('Error');
  }
});

async function processUpdate(update) {
  if (!update.message && !update.callback_query) return;

  const message = update.message || update.callback_query.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text || message.caption || '';

  logger.info(`Telegram update from ${chatId}: ${text.slice(0, 50)}`);

  try {
    const response = await callAgent(text, {
      chatId,
      username: message.from?.username,
      chatType: message.chat.type
    });

    if (response) {
      // Send via Telegram API directly in production
      await sendTelegramMessage(chatId, response);
    }
  } catch (error) {
    logger.error('Process error:', error);
    await sendTelegramMessage(chatId, 'Sorry, an error occurred.');
  }
}

function callAgent(message, context = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('openclaw', [
      'agent', '--local', '--agent', 'main',
      '--message', `Telegram message: "${message}" Context: ${JSON.stringify(context)}`,
      '--timeout', '60'
    ], { env: { ...process.env } });

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Agent timeout'));
    }, 65000);

    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', () => {
      clearTimeout(timeout);
      const response = stdout || stderr.replace(/\[diagnostic\].*?\n/g, '').trim();
      resolve(response.slice(0, 4000));
    });

    proc.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram API error: ${response.status}`);
  }
}

module.exports = { processUpdate, callAgent, sendTelegramMessage };