#!/usr/bin/env node
/**
 * OmniClaw Direct WhatsApp Bridge — OpenWA REST API
 * Polls OpenWA for messages, sends AI responses via REST API
 * Run: node scripts/omniclaw_direct_whatsapp.js
 */

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  OPENWA_URL: process.env.OPENWA_URL || 'http://localhost:2785',
  OPENWA_KEY: process.env.OPENWA_KEY || 'dev-admin-key',
  SESSION_ID: process.env.OPENWA_SESSION_ID || '',
  POLL_INTERVAL_MS: 5000,
  LOG_FILE: '/tmp/omniclaw_openwa/bot.log',
  AGENT_TIMEOUT: 60000,
};

const OUTBOX_DIR = '/tmp/omniclaw_openwa/outbox';
const LOG_FILE = '/tmp/omniclaw_openwa/bot.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

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
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
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
      if (active) { CONFIG.SESSION_ID = active.id; log(`📱 Session: ${active.name}`); return active.id; }
    }
  } catch {}
  return null;
}

async function sendText(chatId, text) {
  const sid = await getActiveSession();
  if (!sid) throw new Error('No active WA session');
  await openwaReq('POST', `/api/sessions/${sid}/messages/send-text`, { chatId, text });
  log(`✅ Sent: ${text.slice(0, 50)}`);
}

async function getMessages(limit = 50) {
  const sid = await getActiveSession();
  if (!sid) return [];
  try {
    const msgs = await openwaReq('GET', `/api/sessions/${sid}/messages?limit=${limit}`);
    return Array.isArray(msgs) ? msgs : [];
  } catch { return []; }
}

async function sendAgentResponse(sender, message) {
  return new Promise(resolve => {
    log(`🤖 Agent for: ${message.slice(0, 50)}`);
    const proc = spawn('openclaw', ['agent', '--local', '--agent', 'main',
      '--message', `WhatsApp msg from ${sender}: "${message}". Brief helpful response.`],
      { env: { ...process.env } });
    let stdout = '';
    proc.stdout.on('data', d => stdout += d.toString());
    const timer = setTimeout(() => { proc.kill(); resolve('Took too long.'); }, CONFIG.AGENT_TIMEOUT);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        const lines = stdout.split('\n').filter(l => l.trim() && !l.startsWith('│') && !l.startsWith('◇')).join('\n');
        resolve(lines.slice(0, 500) || 'Got it!');
      } else resolve('Sorry, trouble.');
    });
  });
}

const processedIds = new Set();

async function pollAndProcess() {
  const sid = await getActiveSession();
  if (!sid) { log('⏳ No session'); return false; }
  const msgs = await getMessages(20);
  const newMsgs = msgs.filter(m => m.direction === 'incoming' && !processedIds.has(m.id)).reverse();
  for (const msg of newMsgs) {
    processedIds.add(msg.id);
    const text = msg.body || '';
    if (!text.trim()) continue;
    const sender = (msg.from || '').replace('@s.whatsapp.net', '').replace('@c.us', '');
    log(`📩 ${sender}: ${text}`);
    try {
      const resp = await sendAgentResponse(sender, text);
      await sendText(msg.chatId || msg.from, resp);
    } catch (e) { log(`❌ ${e.message}`); }
  }
  return true;
}

async function flushOutbox() {
  if (!fs.existsSync(OUTBOX_DIR)) { fs.mkdirSync(OUTBOX_DIR, { recursive: true }); return; }
  const sentDir = path.join(OUTBOX_DIR, 'sent');
  if (!fs.existsSync(sentDir)) fs.mkdirSync(sentDir, { recursive: true });
  const files = fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.msg'));
  if (!files.length) return;
  log(`📬 Flush ${files.length} outbox msg(s)`);
  for (const file of files) {
    const fp = path.join(OUTBOX_DIR, file);
    try {
      const raw = fs.readFileSync(fp, 'utf8').trim();
      if (!raw) { fs.unlinkSync(fp); continue; }
      let jid, msg;
      try { const p = JSON.parse(raw); if (p.jid && p.message) { jid = p.jid; msg = p.message; } } catch {}
      if (!jid) { const lines = raw.split('\n'); if (lines.length >= 2) { jid = lines[0].trim(); msg = lines.slice(1).join('\n').trim(); } }
      if (!jid || !msg) { fs.renameSync(fp, path.join(sentDir, file + '.malformed')); continue; }
      const sid = await getActiveSession();
      if (sid) { await sendText(jid, msg); fs.renameSync(fp, path.join(sentDir, file)); }
    } catch (e) { log(`❌ Outbox error: ${e.message}`); }
  }
}

let pollCount = 0;
async function main() {
  log('🚀 OmniClaw OpenWA Bridge Starting');
  const sid = await getActiveSession();
  log(sid ? `✅ Session: ${sid}` : '⏳ No session');

  const loop = async () => {
    try {
      const ok = await pollAndProcess();
      if (ok) await flushOutbox();
    } catch (e) { log(`❌ ${e.message}`); }
    pollCount++;
    setTimeout(loop, CONFIG.POLL_INTERVAL_MS);
  };
  loop();
  setInterval(() => log(`💓 ${pollCount} polls`), 60000);
  process.on('SIGINT', () => { log('👋 Bye'); process.exit(0); });
}
main().catch(console.error);
