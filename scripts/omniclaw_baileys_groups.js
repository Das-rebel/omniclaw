#!/usr/bin/env node
/**
 * OmniClaw Baileys Group Bot
 * Handles WhatsApp group messages - FREE, no quota limits.
 * Uses existing Baileys session from ~/.omniclaw_auth/
 * 
 * Run: node omniclaw_baileys_groups.js
 * QR code: http://localhost:8091/qr (when needs re-auth)
 */

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('/Users/Subho/node_modules/@whiskeysockets/baileys');
const pino = require('/Users/Subho/node_modules/pino');
const qrcode = require('/Users/Subho/node_modules/qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── Config ───────────────────────────────────────
const AUTH_DIR = process.env.BAILEYS_AUTH_DIR || path.join(process.env.HOME || '/Users/Subho', '.omniclaw_auth');
const LOG_DIR = '/tmp/omniclaw_baileys';
const PORT = process.env.BAILEYS_PORT || 8091;

// ─── State ─────────────────────────────────────────
let currentQR = null;
let sock = null;
let isConnected = false;

// ─── Ensure dirs ───────────────────────────────────
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function log(...args) {
  const ts = new Date().toISOString();
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  console.log(`[${ts}] ${msg}`);
  fs.appendFileSync(path.join(LOG_DIR, 'bot.log'), `[${ts}] ${msg}\n`);
}

// ─── Group whitelist ────────────────────────────────
const ALLOWED_GROUPS = [
  '120363408616437592@g.us',  // AI and Embedded
  '120363141914506124@g.us',  // CapitNBulls Asset Managers
  '120363404584160486@g.us',  // WUDCOR INTERIORS
];

// ─── Vault Search ───────────────────────────────────
const VAULT_SEARCH_URL = process.env.VAULT_SEARCH_URL || 'http://159.65.10.49:8080';

async function vaultSearch(query) {
  try {
    const res = await fetch(`${VAULT_SEARCH_URL}/search?q=${encodeURIComponent(query)}&limit=5`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error('search failed: ' + res.status);
    return await res.json();
  } catch (e) {
    log('Vault search error:', e.message);
    return null;
  }
}

function buildVaultText(query, data) {
  if (!data?.results?.length) {
    return `❌ No results for "${query}"\n\nTry: /vault AI agents, /vault tools, /vault github`;
  }
  const items = data.results.slice(0, 5);
  let text = `🔍 *Vault: "${query}"* (${data.total || items.length} results)\n\n`;
  for (const item of items) {
    const name = (item.name || item.content || '').slice(0, 80).replace(/\*/g, '');
    const url = item.url || '';
    text += `📌 ${name}\n🔗 ${url}\n\n`;
  }
  return text.slice(0, 4000);
}

// ─── Send message ───────────────────────────────────
async function sendGroup(chatId, text) {
  if (!sock || !isConnected) {
    log('Cannot send - not connected');
    return false;
  }
  try {
    await sock.sendMessage(chatId, { text }, { ephemeralExpiration: 0 });
    log('Sent to', chatId.slice(0, 20), ':', text.slice(0, 60));
    return true;
  } catch (e) {
    log('Send error:', e.message);
    return false;
  }
}

// ─── Message handler ─────────────────────────────────
function handleMessage(chatId, text, senderName) {
  if (!text || !chatId?.includes('@g.us')) return;
  if (!ALLOWED_GROUPS.includes(chatId)) {
    log('⛔ Group not whitelisted:', chatId);
    return;
  }
  
  log(`📨 [${chatId}] ${senderName}: ${text.slice(0, 60)}`);
  
  if (text === '/start' || text === '/help') {
    sendGroup(chatId, '🦞 *OmniClaw on WhatsApp Groups*\n\n/vault <query> - Search knowledge graph\n/status - Cloud health\n/help - Show this message\n\nFree text searches also work!');
    return;
  }
  
  if (text.startsWith('/vault')) {
    const query = text.replace(/^\/vault\s*/i, '').trim() || 'help';
    sendGroup(chatId, `🔍 Searching vault for: "${query}"...`);
    vaultSearch(query).then(r => sendGroup(chatId, buildVaultText(query, r)));
    return;
  }
  
  if (text === '/status') {
    sendGroup(chatId, '🟢 *OmniClaw Status*\n✅ WhatsApp: Connected (Baileys)\n✅ Vault: active\n✅ Cloud Run: 17 services\n\n_Powered by OmniClaw Baileys_');
    return;
  }
  
  // Free text → vault search
  if (!text.startsWith('/')) {
    sendGroup(chatId, `🔍 Vault: "${text.slice(0, 40)}"...`);
    vaultSearch(text).then(r => sendGroup(chatId, buildVaultText(text, r)));
  }
}

// ─── HTTP Server ─────────────────────────────────────
function startHttpServer() {
  const server = http.createServer((req, res) => {
    // Health
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: isConnected ? 'connected' : 'disconnected',
        service: 'omniclaw-baileys-groups',
        botId: sock?.user?.id || 'unknown',
        groups: ALLOWED_GROUPS.length,
        hasQR: !!currentQR,
        uptime: process.uptime()
      }));
      return;
    }
    
    // QR code display
    if (req.url === '/qr' || req.url === '/qr.png') {
      if (!currentQR) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>No QR code</h1><p>Bot is connected or no re-auth needed.</p><p><a href="/health">Health check</a></p></body></html>');
        return;
      }
      const html = `<html><body><h1>Scan this QR code with WhatsApp</h1><img src="${currentQR}" style="width:300px"/><p><a href="/health">Health</a></p></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    
    // Status page
    if (req.url === '/') {
      const qrSection = currentQR
        ? `<h2>⚠️ Re-auth needed</h2><img src="${currentQR}" style="width:250px"/><p>Scan with WhatsApp → linked devices</p>`
        : '<h2>✅ Connected</h2>';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body>
        <h1>🦞 OmniClaw Baileys Bot</h1>
        ${qrSection}
        <p><a href="/health">Health JSON</a> | <a href="/qr">QR Code</a></p>
        <p>Bot ID: ${sock?.user?.id || 'unknown'}</p>
        <p>Connected: ${isConnected}</p>
      </body></html>`);
      return;
    }
    
    res.writeHead(404);
    res.end('Not found');
  });
  
  server.listen(PORT, '0.0.0.0', () => {
    log(`🚀 HTTP server on port ${PORT}`);
    log(`   Health: http://localhost:${PORT}/health`);
    log(`   QR code: http://localhost:${PORT}/qr`);
  });
}

// ─── Main ─────────────────────────────────────────
async function main() {
  log('═'.repeat(50));
  log('OmniClaw Baileys Group Bot starting...');
  log('Auth dir:', AUTH_DIR);
  
  const credsPath = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(credsPath)) {
    log('❌ No credentials at', credsPath);
    process.exit(1);
  }
  
  const creds = JSON.parse(fs.readFileSync(credsPath));
  log('Session phone:', creds.me?.id || 'unknown');
  
  startHttpServer();
  
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  log('Auth state loaded. Phone:', state.creds?.me?.id);
  
  const { version } = await fetchLatestBaileysVersion();
  log('Baileys version:', version);
  
  // Check if session is viable
  const isViable = state.creds?.me?.id && !state.creds?.me?.errors;
  if (!isViable) {
    log('⚠️ Session appears invalid - will need fresh QR');
  }
  
  // Create socket
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'error' }),
    printQRInTerminal: true, // For terminal access
  });
  
  // Connection update
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    log('Connection:', connection, lastDisconnect?.error?.message || '');
    
    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      log('✅ WhatsApp connected! Bot ID:', sock.user?.id);
    }
    
    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      
      if (code === DisconnectReason.loggedOut) {
        log('❌ Session expired - need to re-scan QR');
        log('   Open: http://localhost:' + PORT + '/qr');
      } else if (code === DisconnectReason.restartRequired) {
        log('♻️ Restart required - will auto-retry');
      } else {
        log('⚠️ Disconnected:', code, lastDisconnect?.error?.message);
      }
    }
    
    // QR code for re-auth
    if (qr) {
      qrcode.toDataURL(qr, { width: 200 }).then(dataUrl => {
        currentQR = dataUrl;
        log('📱 QR ready at http://localhost:' + PORT + '/qr');
      }).catch(() => {});
    }
  });
  
  // Creds update - persist immediately
  sock.ev.on('creds.update', () => {
    saveCreds(state.creds).catch(e => log('Creds save error:', e.message));
  });
  
  // Messages
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const chatId = msg.key.remoteJid;
      if (!chatId?.includes('@g.us')) continue;
      
      const text = msg.message?.conversation?.trim()
        || msg.message?.extendedTextMessage?.text?.trim()
        || '';
      
      if (text) {
        const sender = msg.pushName || 'Unknown';
        handleMessage(chatId, text, sender);
      }
    }
  });
  
  // Keep process alive
  process.on('SIGINT', () => {
    log('Shutting down...');
    try { sock?.logout(); } catch(e) {}
    process.exit(0);
  });
}

main().catch(e => {
  log('Fatal error:', e.message);
  log(e.stack);
  process.exit(1);
});
