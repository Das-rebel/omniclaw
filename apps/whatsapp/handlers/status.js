/**
 * Status Handler - Check cloud endpoints health
 */
const { send, checkEndpoint } = require('./base');

async function handleStatus(phone) {
  const checks = await Promise.all([
    checkEndpoint('omniclaw'), checkEndpoint('vaultSearch'),
    checkEndpoint('twitterSync'), checkEndpoint('instagram'),
    checkEndpoint('story'), checkEndpoint('bookmarks'),
    checkEndpoint('tts'), checkEndpoint('alexa'),
    checkEndpoint('dashboard'),
    checkEndpoint('vaultPipeline'),
    checkEndpoint('vaultControl'),
    checkEndpoint('instatter'),
  ]);
  const healthy = checks.filter(c => c.ok).length;
  const total = checks.length;
  const statusIcon = healthy === total ? '🟢' : healthy > 0 ? '🟡' : '🔴';
  const lines = checks.map(c => (c.ok ? '✅' : '❌') + ' ' + c.name.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()));
  await send(phone, statusIcon + ' *OmniClaw Status* (' + healthy + '/' + total + ' healthy)\n\n' + lines.join('\n'));
}

module.exports = { handleStatus };
