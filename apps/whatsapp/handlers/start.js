/**
 * Start Handler - Welcome message
 */
const { send } = require('./base');

async function handleStart(phone, fromName) {
  await send(phone, 'Hey ' + fromName + '! 🦞\n\nI\'m OmniClaw - your AI assistant on WhatsApp.\n\nType /help for commands!');
}

module.exports = { handleStart };
