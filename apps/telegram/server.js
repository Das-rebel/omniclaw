#!/usr/bin/env node
/**
 * OmniClaw Telegram Bot — Manual webhook (no Telegraf, no node-telegram-bot-api)
 * Uses raw Express + fetch to Telegram API.
 * This eliminates ALL library webhook conflicts.
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 8080;
const WEBHOOK_SECRET = 'oc_' + crypto.randomBytes(8).toString('hex');
const BOT_USERNAME = 'Dasomni_bot';
const WEBHOOK_URL = 'https://dasomni-bot-338789220059.asia-south1.run.app/webhook';

if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN required'); process.exit(1); }

const app = express();
app.use(express.json());

const TG_API = 'https://api.telegram.org/bot' + TOKEN;

// ─── Telegram API helpers ─────────────────────────────
async function tg(method, params = {}) {
  try {
    const res = await fetch(TG_API + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) console.error('❌ TG API error: ' + method + ' → ' + JSON.stringify(data));
    return data;
  } catch (e) {
    console.error('❌ TG fetch error: ' + method + ' → ' + e.message);
    return { ok: false, error: e.message };
  }
}

async function httpGet(url, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await res.text();
    clearTimeout(timer);
    try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
  }
}

// ─── Cloud Endpoints ──────────────────────────────────
const EP = {
  vaultSearch: 'https://serve-vault-search-338789220059.asia-south1.run.app',
  twitterSync: 'https://twitter-sync-338789220059.asia-south1.run.app',
  instagram: 'https://instagram-sync-338789220059.asia-south1.run.app',
  bookmarks: 'https://bookmark-processor-338789220059.asia-south1.run.app',
  omniclaw: 'https://omniclaw-gcs-338789220059.asia-south1.run.app',
  tts: 'https://celebrity-tts-338789220059.asia-south1.run.app',
  story: 'https://story-narrator-338789220059.asia-south1.run.app',
  alexa: 'https://alexa-handler-338789220059.asia-south1.run.app',
};

async function checkEndpoint(name) {
  try {
    const r = await httpGet(EP[name] + '/health', 8000);
    return { name, ok: true, status: r.status || r.service || 'healthy' };
  } catch (e) {
    return { name, ok: false, error: e.message };
  }
}

// ─── Vault search with lightweight URL lookup ────────
let urlLookup = null, urlLookupTime = 0;
const LOOKUP_URL = 'https://storage.googleapis.com/omniclaw-knowledge-graph/vault/vault_url_lookup.json';

async function loadUrlLookup() {
  if (urlLookup && Date.now() - urlLookupTime < 600000) return urlLookup;
  try {
    const data = await httpGet(LOOKUP_URL, 30000);
    urlLookup = data;
    urlLookupTime = Date.now();
    const keys = Object.keys(data || {}).length;
    console.log('📚 URL lookup loaded: ' + keys + ' keys (' + Math.round(JSON.stringify(data).length / 1024) + 'KB)');
    return urlLookup;
  } catch (e) {
    console.error('URL lookup failed: ' + e.message + ' (will retry next request)');
    return urlLookup || {};
  }
}

// Pre-load at startup (fire and forget)
setTimeout(() => loadUrlLookup(), 3000);

function enrichResult(fr, lookup) {
  const fid = fr.id || '';
  // Try exact match first, then by source_id suffix
  let meta = lookup[fid];
  if (!meta) {
    const parts = fid.split('_');
    const suffix = parts[parts.length - 1];
    meta = lookup[suffix];
  }
  if (!meta) {
    // Try matching on any source_id containing parts of the id
    for (const k of Object.keys(lookup)) {
      if (fid.includes(k) || k.includes(fid)) { meta = lookup[k]; break; }
    }
  }
  const tags = fr.vlTags || [];
  return {
    name: (fr.name || 'Untitled').replace(/\n/g, ' ').trim().slice(0, 60),
    url: meta ? meta.url : '',
    source: meta ? meta.source : (fid.startsWith('tw_') ? 'twitter' : fid.startsWith('ig_') ? 'instagram' : 'unknown'),
    date: meta ? meta.date : '',
    caption: (fr.caption || '').replace(/\n/g, ' ').trim().slice(0, 120),
    score: fr.score,
    tags: tags.slice(0, 5),
  };
}

async function searchVault(query) {
  // 1. FAISS semantic search
  let faissItems = [];
  try {
    const r = await httpGet(EP.vaultSearch + '/search?q=' + encodeURIComponent(query) + '&limit=10', 30000);
    faissItems = r && r.results ? r.results : [];
    console.log('🔍 FAISS got ' + faissItems.length + ' results for: "' + query + '"');
  } catch (e) { console.error('FAISS search failed: ' + e.message); }

  // 2. Load URL lookup (3.4MB, cached for 10 min)
  const lookup = await loadUrlLookup();

  if (faissItems.length) {
    return {
      query, total: faissItems.length,
      results: faissItems.slice(0, 5).map(fr => enrichResult(fr, lookup)),
    };
  }

  // 3. Fallback: if FAISS failed, no results
  return { query, total: 0, results: [] };
}

// ─── Command handlers ─────────────────────────────────
async function handleStart(chatId, fromName) {
  console.log('👋 /start from ' + fromName + ' chat=' + chatId);
  const r = await tg('sendMessage', {
    chat_id: chatId,
    text: 'Hey ' + fromName + '! 🦞\n\nI\'m OmniClaw — your AI assistant.\n\nType /help for commands!',
  });
  console.log(r.ok ? '✅ Replied /start' : '❌ Reply failed: ' + JSON.stringify(r));
}

async function handleHelp(chatId) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: '🦞 OmniClaw Bot\n\n/start — Welcome\n/help — This message\n/status — Cloud endpoints health\n/vault <query> — Search knowledge graph\n/sync — Twitter & Instagram sync status',
  });
}

async function handleStatus(chatId) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const checks = await Promise.all([
    checkEndpoint('omniclaw'), checkEndpoint('vaultSearch'),
    checkEndpoint('twitterSync'), checkEndpoint('instagram'),
    checkEndpoint('tts'), checkEndpoint('story'),
    checkEndpoint('alexa'), checkEndpoint('bookmarks'),
  ]);
  const lines = checks.map(c =>
    (c.ok ? '✅' : '❌') + ' ' + c.name + ': ' + (c.ok ? c.status : c.error)
  );
  await tg('sendMessage', { chat_id: chatId, text: '🟢 OmniClaw System Status\n\n' + lines.join('\n') });
}

async function handleVault(chatId, text) {
  const query = text.replace(/^\/vault\s*/, '').trim();
  if (!query) return tg('sendMessage', { chat_id: chatId, text: 'Usage: /vault <search query>' });

  console.log('🔍 Searching vault for: "' + query + '"');
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const result = await searchVault(query);
  console.log('🔍 Vault got ' + (result ? result.total : 0) + ' results for: "' + query + '"');
  const items = result && result.results ? result.results : [];
  if (!items.length) return tg('sendMessage', { chat_id: chatId, text: 'No results for "' + query + '".' });

  const lines = ['🔍 Vault: "' + query + '" (' + result.total + ' results)\n'];
  for (const item of items) {
    const srcIcon = item.source === 'twitter' ? '🐦' : item.source === 'instagram' ? '📷' : '🌐';
    const srcLabel = item.source === 'twitter' ? 'Twitter' : item.source === 'instagram' ? 'Instagram' : 'Web';
    const name = (item.name || 'Untitled').slice(0, 50);
    const date = item.date ? item.date.slice(0, 10) : '';
    const tags = (item.tags || []).slice(0, 4).join(', ');

    lines.push(srcIcon + ' ' + name);
    if (item.url) lines.push('🔗 ' + item.url);
    const meta = [srcLabel];
    if (date) meta.push('📅 ' + date);
    if (tags) meta.push('🏷 ' + tags);
    lines.push(meta.join(' | '));
    if (item.caption) lines.push('"' + item.caption.slice(0, 100) + '…"');
    lines.push('');
  }

  console.log('📤 Sending vault reply to ' + chatId + ': ' + lines.join('\n').slice(0, 100) + '...');
  await tg('sendMessage', { chat_id: chatId, text: lines.join('\n'), disable_web_page_preview: true });
  console.log('✅ Vault reply sent');
}

async function handleSync(chatId) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const [tw, ig] = await Promise.all([checkEndpoint('twitterSync'), checkEndpoint('instagram')]);
  await tg('sendMessage', {
    chat_id: chatId,
    text: '🔄 Sync Status\n\n🐦 Twitter: ' + (tw.ok ? '✅ healthy' : '❌ ' + tw.error) + '\n📷 Instagram: ' + (ig.ok ? '✅ healthy' : '❌ ' + ig.error),
  });
}

async function handleGrowthOS(chatId, text) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  const fs = require('fs');

  // Determine mode
  const mode = text.replace(/^\/growthos\s*/i, '').trim().toLowerCase();

  if (mode === 'run') {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    await tg('sendMessage', { chat_id: chatId, text: '🧠 Running Growth OS pipeline...\n\nUse /growthos digest for a quick status.' });
    const { stdout, stderr } = await execAsync(
      'cd /Users/Subho/growth-workflow-os && python3 run_pipeline.py 2>&1',
      { timeout: 300000 }
    );
    const match = stdout.match(/stored (\d+) signals/);
    const count = match ? match[1] : '?';
    await tg('sendMessage', { chat_id: chatId, text: '✅ Pipeline done! Stored ' + count + ' signals.\n\n🌐 http://localhost:8501' });
    return;
  }

  if (mode === 'digest') {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    const { stdout } = await execAsync(
      'cd /Users/Subho/growth-workflow-os && timeout 90 python3 run_digest.py 2>&1',
      { timeout: 120000 }
    );
    // Parse summary
    const topMatch = stdout.match(/\*\*(Today\'s Top Signal|today\'s signal)\*\*[\s\S]{0,300}/i);
    const topSignal = topMatch ? topMatch[0].slice(0, 200) : '';
    await tg('sendMessage', {
      chat_id: chatId,
      text: '📊 *Growth OS Daily Digest*\n\n' + (topSignal || 'Run /growthos run for full pipeline.') + '\n\n🌐 http://localhost:8501',
      disable_web_page_preview: true,
    });
    return;
  }

  // Default: status summary
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const { stdout: dryRun } = await execAsync(
    'cd /Users/Subho/growth-workflow-os && python3 run_daily.py --dry-run 2>&1',
    { timeout: 60000 }
  );
  const sigMatch = dryRun.match(/(?:TOTAL|total)\s+(\d+)\s+signals/);
  const signalCount = sigMatch ? sigMatch[1] : '?';

  const memoDir = '/Users/Subho/growth-workflow-os/operating_memos/output';
  let memoStatus = 'No memo';
  if (fs.existsSync(memoDir)) {
    const files = fs.readdirSync(memoDir).filter(f => f.startsWith('weekly_memo_') || f.startsWith('daily_digest_')).sort().reverse();
    if (files.length > 0) {
      const stat = fs.statSync(memoDir + '/' + files[0]);
      memoStatus = files[0].replace('weekly_memo_', '').replace('daily_digest_', '').replace('.md', '') + ' (' + Math.round(stat.size / 1024) + 'KB)';
    }
  }

  const dbPath = '/Users/Subho/growth-workflow-os/strategic_memory/growth_os.db';
  let totalDb = '?';
  if (fs.existsSync(dbPath)) {
    const { stdout: sqliteOut } = await execAsync('sqlite3 ' + dbPath + ' "SELECT COUNT(*) FROM signals"');
    totalDb = sqliteOut.trim();
  }

  await tg('sendMessage', {
    chat_id: chatId,
    text: '🧠 *Growth OS Status*\n\n' +
      '📡 Last run: *' + signalCount + '* signals\n' +
      '💾 DB total: *' + totalDb + '* signals\n' +
      '📝 Latest memo: *' + memoStatus + '*\n' +
      '🌐 Dashboard: http://localhost:8501\n\n' +
      '/growthos run — Full pipeline\n' +
      '/growthos digest — Daily digest\n' +
      '/growthos signals — Latest signals',
    disable_web_page_preview: true,
  });
}

// ─── Message router ───────────────────────────────────
async function handleMessage(msg) {
  const text = (msg && msg.text) || '';
  const chatId = msg && msg.chat && msg.chat.id;
  const fromName = (msg && msg.from && msg.from.first_name) || 'there';

  if (!chatId) return;

  // Commands
  if (text === '/start' || text === '/start@' + BOT_USERNAME) return handleStart(chatId, fromName);
  if (text === '/help' || text === '/help@' + BOT_USERNAME) return handleHelp(chatId);
  if (text.startsWith('/status') || text.startsWith('/status@' + BOT_USERNAME)) return handleStatus(chatId);
  if (text.startsWith('/vault') || text.startsWith('/vault@' + BOT_USERNAME)) return handleVault(chatId, text);
  if (text.startsWith('/sync') || text.startsWith('/sync@' + BOT_USERNAME)) return handleSync(chatId);
  if (text.startsWith('/growthos') || text.startsWith('/growthos@' + BOT_USERNAME)) return handleGrowthOS(chatId, text);

  // Skip other /commands
  if (text.startsWith('/')) return;

  // Group: only respond to mentions
  const chatType = msg.chat && msg.chat.type;
  if (chatType === 'group' || chatType === 'supergroup') {
    if (!text.includes('@' + BOT_USERNAME)) return;
  }

  // Auto-search: any non-command text = vault search
  const lower = text.toLowerCase();
  if (/\b(hello|hi|hey)\b/.test(lower)) {
    return tg('sendMessage', { chat_id: chatId, text: '👋 Hey! Just type anything to search your vault, or /help for commands.' });
  }
  if (/\b(status|health)\b/.test(lower)) {
    return tg('sendMessage', { chat_id: chatId, text: 'Use /status for health check 🟢' });
  }

  // Everything else = vault search automatically
  console.log('🔍 Auto-search: "' + text + '"');
  return handleVault(chatId, '/vault ' + text);
}

// ─── Express Routes ───────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'dasomni-bot', mode: 'webhook/raw', uptime: Math.floor(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/webhook', async (req, res) => {
  const update = req.body;
  const updateId = update ? update.update_id : 0;
  const text = update && update.message && update.message.text || '';

  console.log('📨 #' + updateId + ' text="' + text + '"');

  if (update && update.message) {
    handleMessage(update.message).catch(e => console.error('❌ Handle error: ' + e.message));
  }

  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────
(async () => {
  // Get bot info
  const me = await tg('getMe');
  if (me.ok) {
    console.log('🤖 @' + me.result.username + ' (' + me.result.first_name + ')');
  } else {
    console.error('getMe failed: ' + JSON.stringify(me));
  }

  // No webhook — we're using POLLING to bypass the broken GCS tunnel.
  // Delete webhook so pending updates accumulate for polling.
  const del = await tg('deleteWebhook', { drop_pending_updates: false });
  console.log('🗑 Deleted webhook (using polling): ' + (del.ok ? '✅' : del.description));
  await new Promise(r => setTimeout(r, 1000));

  app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 OmniClaw bot on port ' + PORT);
  });

  // ── POLLING LOOP (instead of webhook) ─────────────────────────────────────────
  // Telegram is in webhook mode on GCS, so we poll directly from here.
  // This bypasses the GCS webhook entirely.
  let offset = 0;
  let pollingActive = true;

  async function poll() {
    if (!pollingActive) return;
    try {
      const res = await fetch(TG_API + '/getUpdates?offset=' + offset + '&timeout=5', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) { await new Promise(r => setTimeout(r, 5000)); return poll(); }
      const data = await res.json();
      if (data.ok && data.result && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message) {
            handleMessage(update.message).catch(e =>
              console.error('❌ Handle error: ' + e.message)
            );
          }
          if (update.edited_message) {
            handleMessage(update.edited_message).catch(e =>
              console.error('❌ Edited msg error: ' + e.message)
            );
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError' || e.message === 'timeout') {
        // Normal polling timeout, just retry
      } else {
        console.error('❌ Poll error: ' + e.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (pollingActive) setTimeout(poll, 500);
  }

  // Start polling after 3 seconds (let bot init complete first)
  setTimeout(poll, 3000);
  console.log('📡 Polling Telegram for updates (bypassing GCS webhook)...');
})();
