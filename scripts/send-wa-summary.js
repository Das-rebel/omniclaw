#!/usr/bin/env node
/**
 * One-shot WhatsApp message sender — OpenWA REST API
 * Usage: node send-wa-summary.js <jid> <message>
 *       echo "msg" | node send-wa-summary.js <jid> -
 */
const http = require('http');
const https = require('https');
const fs = require('fs');

const CONFIG = {
  OPENWA_URL: process.env.OPENWA_URL || 'http://localhost:2785',
  OPENWA_KEY: process.env.OPENWA_KEY || 'dev-admin-key',
  SESSION_ID: process.env.OPENWA_SESSION_ID || '',
};

function openwaReq(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.OPENWA_URL + endpoint);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': CONFIG.OPENWA_KEY },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } }); });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getActiveSession() {
  if (CONFIG.SESSION_ID) return CONFIG.SESSION_ID;
  try {
    const sessions = await openwaReq('GET', '/api/sessions');
    if (Array.isArray(sessions)) {
      const active = sessions.find(s => s.status === 'ready');
      if (active) { CONFIG.SESSION_ID = active.id; return active.id; }
    }
  } catch {}
  return null;
}

async function sendText(chatId, text) {
  const sid = await getActiveSession();
  if (!sid) throw new Error('No active WA session');
  await openwaReq('POST', `/api/sessions/${sid}/messages/send-text`, { chatId, text });
  console.log(`[OpenWA] Sent to ${chatId}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.error('Usage: node send-wa-summary.js <jid> <msg>'); process.exit(1); }
  const jid = args[0];
  let message;
  if (args[1] === '-') message = fs.readFileSync(0, 'utf8').trim();
  else message = args.slice(1).join(' ');
  if (!message) { console.error('No message'); process.exit(1); }
  try { await sendText(jid, message); }
  catch (e) {
    console.error('[OpenWA] Failed:', e.message);
    const outboxDir = '/tmp/omniclaw_openwa/outbox';
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(`${outboxDir}/fallback-${Date.now()}.msg`, `${jid}\n${message}`);
    console.error(`[Fallback] Queued to outbox`);
    process.exit(1);
  }
}
main();
