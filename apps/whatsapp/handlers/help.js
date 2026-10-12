/**
 * Help Handler - Show available commands
 */
const { send } = require('./base');

async function handleHelp(phone) {
  await send(phone,
    '🦞 *OmniClaw Bot on WhatsApp*\n\n' +
    '📋 *Commands*\n' +
    '/start - Welcome message\n' +
    '/help - Show this help\n' +
    '/reset - Clear conversation memory\n' +
    '/memory - Show conversation history\n' +
    '/interests - Show your interest profile\n' +
    '/status - Cloud endpoints health\n' +
    '/vault <query> - Search knowledge graph\n' +
    '/sync - Twitter & Instagram sync status\n' +
    '/story <prompt> - Generate an AI story\n' +
    '/search <query> - Wikipedia search\n' +
    '/remind <time> <text> - Set a reminder\n' +
    '/drafts - Content queue (ghost writer)\n' +
    '/growthos - Growth OS dashboard\n' +
    '/digest <topic> - AI-generated vault digest\n' +
    '/prompts - Prompt tracker stats\n' +
    '/ask <question> - Ask AI anything\n' +
    '/tts <text> - Text to speech\n' +
    '/schedule - Manage scheduled tasks\n' +
    '/team - Multi-agent team collaboration\n' +
    '💡 *Tips*\n' +
    '• /vault works with keywords or natural language\n' +
    '• Examples: /vault AI agents, /vault how to build bots\n' +
    '• Conversations timeout after 10 min of inactivity\n' +
    '• Long-term memory persists across sessions'
  );
}

module.exports = { handleHelp };
