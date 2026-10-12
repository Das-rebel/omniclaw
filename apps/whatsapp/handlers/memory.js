/**
 * Memory Handler - Conversation history and reset
 */
const { send } = require('./base');

async function handleMemory(phone, deps = {}) {
  const { getLongTermContext } = deps;
  if (!getLongTermContext) {
    return send(phone, 'Memory not available');
  }
  
  const context = getLongTermContext(phone, 1500);
  if (!context) {
    return send(phone, 'No conversation history yet. Start chatting!');
  }
  await send(phone, '📜 *Recent conversations:*\n\n' + context.slice(0, 1500));
}

async function handleReset(phone, deps = {}) {
  const { resetConversation } = deps;
  if (resetConversation) resetConversation(phone);
  await send(phone, '✅ Conversation memory cleared!');
}

async function handleInterests(phone, deps = {}) {
  const { getUserInterests } = deps;
  if (!getUserInterests) {
    return send(phone, 'Interests not available');
  }
  
  const interests = getUserInterests(phone);
  if (!interests || !interests.length) {
    return send(phone, 'No interests tracked yet. Search /vault to build your profile!');
  }
  
  const lines = ['🎯 *Your interests:*'];
  for (const [topic, count] of Object.entries(interests).slice(0, 10)) {
    lines.push('· ' + topic + ' (' + count + ')');
  }
  await send(phone, lines.join('\n'));
}

module.exports = {
  handleMemory,
  handleReset,
  handleInterests
};
