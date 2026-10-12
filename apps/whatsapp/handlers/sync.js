/**
 * Sync Handler - Twitter & Instagram sync status
 */
const { send, checkEndpoint } = require('./base');

async function handleSync(phone) {
  const [tw, ig] = await Promise.all([checkEndpoint('twitterSync'), checkEndpoint('instagram')]);
  await send(phone,
    '🔄 *Sync Status*\n\n' +
    '🐦 Twitter: ' + (tw.ok ? '✅ healthy' : '❌ ' + (tw.error || 'down')) + '\n' +
    '📷 Instagram: ' + (ig.ok ? '✅ healthy' : '❌ ' + (ig.error || 'down'))
  );
}

module.exports = { handleSync };
