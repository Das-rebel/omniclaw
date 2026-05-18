#!/usr/bin/env node
/**
 * OmniClaw Telegram Bot - Manual webhook (no Telegraf, no node-telegram-bot-api)
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

// ─── Rate Limiting & Queue Management ─────────────────
const chatQueues = new Map();       // chatId -> Promise chain (sequential per chat)
const userRateLimit = new Map();    // userId -> { count, resetAt }
const MAX_CONCURRENT_SEARCHES = 5;  // Max parallel vault searches
const MAX_PER_MINUTE = 10;          // Max per-user requests per minute
let activeSearches = 0;             // Current concurrent search count

function checkRate(userId) {
  const now = Date.now();
  const entry = userRateLimit.get(userId);
  if (!entry || now > entry.resetAt) {
    userRateLimit.set(userId, { count: 1, resetAt: now + 60000 });
    return true;
  }
  entry.count++;
  if (entry.count > MAX_PER_MINUTE) return false;
  return true;
}

function enqueueChat(chatId, fn) {
  // Chain promises per chat for sequential processing
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(async () => {
    // Wait for a concurrency slot (true loop with async/await)
    while (activeSearches >= MAX_CONCURRENT_SEARCHES) {
      await new Promise(r => setTimeout(r, 500));
    }
    activeSearches++;
    try {
      return await fn();
    } finally {
      activeSearches--;
    }
  }).catch(e => console.error('❌ Queue error: ' + e.message));
  chatQueues.set(chatId, next);
  return next;
}

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
    for (const k of Object.keys(lookup)) {
      if (fid.includes(k) || k.includes(fid)) { meta = lookup[k]; break; }
    }
  }
  const vlTags = fr.vlTags || [];
  return {
    // Basic fields
    name: (fr.name || 'Untitled').replace(/\n/g, ' ').trim().slice(0, 60),
    url: fr.url || meta?.url || '',
    source: fr.source || meta?.source || (fid.startsWith('tw_') ? 'twitter' : fid.startsWith('ig_') ? 'instagram' : 'unknown'),
    date: fr.date || meta?.date || '',
    caption: (fr.caption || '').replace(/\n/g, ' ').trim().slice(0, 120),
    score: fr.score,
    // Rich formatting fields
    vlTags: vlTags,  // Keep vlTags name for handleVault compatibility
    tags: vlTags,     // Also expose as tags
    location: fr.location || meta?.location || '',
    colabSummary: fr.colabSummary || '',
    aestheticScore: fr.aestheticScore || meta?.aestheticScore || 0,
    vlStyle: fr.vlStyle || '',
    vlMood: fr.vlMood || '',
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
    text: 'Hey ' + fromName + '! 🦞\n\nI\'m OmniClaw - your AI assistant.\n\nType /help for commands!',
  });
  console.log(r.ok ? '✅ Replied /start' : '❌ Reply failed: ' + JSON.stringify(r));
}

async function handleHelp(chatId) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: '🦞 OmniClaw Bot\n\n/start - Welcome\n/help - This message\n/status - Cloud endpoints health\n/vault <query> - Search knowledge graph\n/sync - Twitter & Instagram sync status\n/story <prompt> - Generate a story\n/search <query> - Wikipedia search\n/remind <time> <text> - Set reminder\n/drafts - Content queue (ghost writer)',
  });
}

async function handleStatus(chatId) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const checks = await Promise.all([
    checkEndpoint('omniclaw'), checkEndpoint('vaultSearch'),
    checkEndpoint('twitterSync'), checkEndpoint('instagram'),
    checkEndpoint('story'), checkEndpoint('bookmarks'),
  ]);
  const lines = checks.map(c =>
    (c.ok ? '✅' : '❌') + ' ' + c.name + ': ' + (c.ok ? c.status : c.error)
  );
  await tg('sendMessage', { chat_id: chatId, text: '🟢 OmniClaw System Status\n\n' + lines.join('\n') });
}

async function handleVault(chatId, text) {
  // Strip /vault and any @mention of the bot
  const query = text.replace(/^\/vault\s*/, '').replace(new RegExp('@' + BOT_USERNAME + '\s*', 'gi'), '').trim();
  if (!query) return tg('sendMessage', { chat_id: chatId, text: 'Usage: /vault <search query>' });
  if (query.length < 2) return tg('sendMessage', { chat_id: chatId, text: 'Query too short. Try /vault <keyword>' });

  console.log('🔍 Searching vault for: "' + query + '"');
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const result = await searchVault(query);
  console.log('🔍 Vault got ' + (result ? result.total : 0) + ' results for: "' + query + '"');
  const items = result && result.results ? result.results : [];
  if (!items.length) {
    console.log('📤 Vault: No results for "' + query + '" - sending reply');
    return tg('sendMessage', { chat_id: chatId, text: 'No results for "' + query + '". Try a different keyword.' });
  }

  const lines = ['🔍 Vault: "' + query + '" (' + result.total + ' results)\n'];
  for (const item of items) {
    const srcIcon = item.source === 'twitter' ? '🐦' : item.source === 'instagram' ? '📷' : '🌐';
    const srcLabel = item.source === 'twitter' ? 'Twitter' : item.source === 'instagram' ? 'Instagram' : 'Web';
    const name = (item.name || 'Untitled').slice(0, 55);
    const url = item.url || '';
    const caption = item.caption || '';
    const tags = item.vlTags || item.tags || [];
    const location = item.location || '';
    const colabSummary = item.colabSummary || '';
    const aestheticScore = item.aestheticScore || 0;
    const vlStyle = item.vlStyle || '';
    const vlMood = item.vlMood || '';
    const date = item.date || '';

    lines.push(srcIcon + ' ' + name);

    // Aesthetic score for Instagram
    if (item.source === 'instagram' && aestheticScore > 0) {
      lines.push('   ' + '⭐'.repeat(Math.min(Number(aestheticScore), 5)));
    }

    // Caption snippet
    if (caption) lines.push('   "' + caption.slice(0, 100) + '..."');

    // Location
    if (location) lines.push('   📍 ' + location);

    // Source, date, URL
    const meta = [srcLabel];
    if (date) meta.push('📅 ' + date.slice(0, 10));
    if (url) meta.push('🔗 ' + url);
    lines.push('   ' + meta.join(' | '));

    // Tags
    if (tags.length > 0) lines.push('   🏷 ' + tags.slice(0, 4).join(', '));

    // Style and mood
    if (vlStyle || vlMood) {
      const styleParts = [];
      if (vlStyle) styleParts.push('🎨 ' + vlStyle);
      if (vlMood) styleParts.push('💭 ' + vlMood);
      lines.push('   ' + styleParts.join(' | '));
    }

    // AI summary
    if (colabSummary) lines.push('   💡 ' + colabSummary.slice(0, 80));

    lines.push('');
  }

  console.log('📤 Sending vault reply to ' + chatId + ': ' + lines.join('\n').slice(0, 100) + '...');
  
  // Split into chunks if exceeds Telegram's 4096 char limit
  const fullText = lines.join('\n');
  const MAX_LEN = 4000;  // Buffer below 4096 limit
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > MAX_LEN) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  
  for (let i = 0; i < chunks.length; i++) {
    const r = await tg('sendMessage', { chat_id: chatId, text: chunks[i], disable_web_page_preview: true });
    if (r.ok) {
      console.log('✅ Vault reply part ' + (i+1) + '/' + chunks.length + ' sent');
    } else {
      console.error('❌ Vault reply part ' + (i+1) + ' failed: ' + JSON.stringify(r));
    }
  }
  console.log('✅ Vault reply done (' + chunks.length + ' message' + (chunks.length > 1 ? 's' : '') + ')');
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
  const DASHBOARD = 'https://fusion-dashboard-338789220059.asia-south1.run.app';
  const mode = text.replace(/^\/growthos\s*/i, '').trim().toLowerCase();
  if (mode === 'digest') {
    return tg('sendMessage', { chat_id: chatId, text: '📊 *Growth OS Digest*\n\n🌐 ' + DASHBOARD, parse_mode: 'Markdown', disable_web_page_preview: true });
  }
  return tg('sendMessage', { chat_id: chatId, text: '🧠 *Growth OS*\n\n🌐 ' + DASHBOARD + '\n\n/growthos digest - Daily digest', parse_mode: 'Markdown', disable_web_page_preview: true });
}

const initSqlJs = require('sql.js').default;
let sqlitedb = null;  // In-memory SQLite loaded from GCS
let sqlitedbLoaded = 0;

// ─── GCS SQLite helpers for content drafts ─────────────
const GCS_DB_URL = 'https://storage.googleapis.com/growth-os-db-338789220059/growth_os.db';
const SQL_WASM_URL = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-wasm.wasm';

async function loadSqliteFromGCS() {
  // Cache for 5 minutes
  if (sqlitedb && Date.now() - sqlitedbLoaded < 300000) return sqlitedb;
  try {
    // Step 1: Fetch the sql.js wasm binary from CDN
    const wasmRes = await fetch(SQL_WASM_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!wasmRes.ok) throw new Error('WASM fetch failed: ' + wasmRes.status);
    const wasmBuf = await wasmRes.arrayBuffer();

    // Step 2: Initialize sql.js with the wasm binary
    const SQL = await initSqlJs({ wasmBinary: new Uint8Array(wasmBuf) });

    // Step 3: Fetch the SQLite DB file from GCS
    const dbRes = await fetch(GCS_DB_URL + '?cachebust=' + Date.now(), {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!dbRes.ok) throw new Error('GCS DB fetch failed: ' + dbRes.status);
    const dbBuf = await dbRes.arrayBuffer();

    // Step 4: Open the DB
    sqlitedb = new SQL.Database(new Uint8Array(dbBuf));
    sqlitedbLoaded = Date.now();
    console.log('📝 SQLite loaded from GCS, size: ' + Math.round(dbBuf.byteLength / 1024) + 'KB');
    return sqlitedb;
  } catch(e) {
    console.error('❌ GCS SQLite load failed: ' + e.message);
    sqlitedb = null;
    return null;
  }
}

async function getDraftsFromGCS(limit = 10) {
  const db = await loadSqliteFromGCS();
  if (!db) return [];
  try {
    const results = db.exec(
      "SELECT id, platform, draft_text, topic, signal_sources, vault_context, status, generated_at, reviewed_at, approved_at, posted_at " +
      "FROM content_drafts ORDER BY generated_at DESC LIMIT " + limit
    );
    if (!results.length || !results[0].values.length) return [];
    const cols = results[0].columns;
    return results[0].values.map(row => {
      const d = {};
      cols.forEach((c, i) => d[c] = row[i]);
      try { d.signal_sources = JSON.parse(d.signal_sources || '[]'); } catch {}
      try { d.vault_context = JSON.parse(d.vault_context || '{}'); } catch {}
      return d;
    });
  } catch(e) {
    console.error('❌ SQLite query error: ' + e.message);
    return [];
  }
}

async function updateDraftStatusGCS(draftId, newStatus) {
  const db = await loadSqliteFromGCS();
  if (!db) return false;
  try {
    const now = new Date().toISOString();
    let sql = '';
    if (newStatus === 'approved') {
      sql = `UPDATE content_drafts SET status='${newStatus}', approved_at='${now}', reviewed_at='${now}' WHERE id=${draftId}`;
    } else if (newStatus === 'rejected') {
      sql = `UPDATE content_drafts SET status='${newStatus}', reviewed_at='${now}' WHERE id=${draftId}`;
    } else if (newStatus === 'posted') {
      sql = `UPDATE content_drafts SET status='${newStatus}', posted_at='${now}' WHERE id=${draftId}`;
    }
    if (sql) db.run(sql);
    return true;
  } catch(e) {
    console.error('❌ SQLite update error: ' + e.message);
    return false;
  }
}

// ─── /drafts - Content queue for ghost writer ──────
async function handleDrafts(chatId) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  // Wrap in try-catch so crash doesn't silent-fail
  let drafts = [];
  try {
    drafts = await getDraftsFromGCS(10);
  } catch(e) {
    console.error('❌ handleDrafts crash: ' + e.message);
    return tg('sendMessage', {
      chat_id: chatId,
      text: '📝 *Content Queue*\n\n⚠️ Could not load drafts from GCS. Try again in a few minutes.\n\nDashboard: https://fusion-dashboard-338789220059.asia-south1.run.app',
      parse_mode: 'Markdown'
    });
  }

  const lines = ['📝 *Content Queue* (`' + drafts.length + '` drafts)\n'];
  for (const d of drafts) {
    const icon = d.platform === 'linkedin' ? '🔗' : '🐦';
    const status = d.status === 'draft' ? '⬜' : d.status === 'reviewed' ? '👀' : d.status === 'approved' ? '✅' : d.status === 'posted' ? '📤' : '❌';
    const topic = d.topic || 'general';
    const preview = (d.draft_text || '').slice(0, 70).replace(/\n/g, ' ').replace(/[#*_]/g, '');
    const date = d.generated_at ? d.generated_at.slice(0, 10) : 'n/a';
    lines.push(`${icon} ${status} *${d.platform?.toUpperCase() || '?'}* | ${topic}`);
    lines.push(`   ${preview}...`);
    lines.push(`   ID:${d.id} · ${date}`);
    lines.push('');
  }

  lines.push('\n*Reply with:* `approve <id>` · `reject <id>` · `posted <id>`');
  
  await tg('sendMessage', {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
}
app.get('/growthos', async (_req, res) => {
  res.json({
    status: 'ok',
    dashboard_url: GROWTH_OS_CLOUD,
    message: 'Growth OS is running on cloud. Access the dashboard at the URL above.',
  });
});

app.get('/growthos/signals', async (_req, res) => {
  res.json({
    signals_url: GROWTH_OS_CLOUD,
    message: 'View signals on the Growth OS dashboard at ' + GROWTH_OS_CLOUD,
  });
});

app.get('/growthos/digest', async (_req, res) => {
  res.json({
    digest_url: GROWTH_OS_CLOUD,
    message: 'View the daily digest on the Growth OS dashboard at ' + GROWTH_OS_CLOUD,
  });
});

app.post('/growthos/run', async (_req, res) => {
  res.json({
    ok: true,
    message: 'Growth OS pipeline runs on cloud deployment at ' + GROWTH_OS_CLOUD,
    dashboard_url: GROWTH_OS_CLOUD,
  });
});

app.get('/growthos-status', async (_req, res) => {
  res.json({
    dashboard_url: GROWTH_OS_CLOUD,
    message: 'Growth OS cloud deployment at ' + GROWTH_OS_CLOUD,
  });
});

// ─── /tts - Text to speech ─────────────────────────
async function handleTTS(chatId, text) {
  const ttsText = text.replace(/^\/tts\s*/i, '').trim();
  if (!ttsText) {
    return tg('sendMessage', { chat_id: chatId, text: 'Usage: /tts <text>\nConverts text to celebrity speech.' });
  }
  if (ttsText.length > 500) {
    return tg('sendMessage', { chat_id: chatId, text: 'Text too long (max 500 chars).' });
  }
  await tg('sendChatAction', { chat_id: chatId, action: 'record_audio' });
  try {
    const res = await fetch(EP.tts + '/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ttsText, celebrity: 'morgan_freeman', language: 'en' }),
    });
    if (!res.ok) throw new Error('TTS endpoint error');
    const data = await res.json();
    const audioBase64 = data.audio || data.result || data.data || '';
    if (!audioBase64) throw new Error('No audio in response');
    const buf = Buffer.from(audioBase64, 'base64');
    const path = '/tmp/tts_' + Date.now() + '.wav';
    require('fs').writeFileSync(path, buf);
    await tg('sendVoice', { chat_id: chatId, voice: fs.createReadStream(path) });
    require('fs').unlinkSync(path);
  } catch(e) {
    tg('sendMessage', { chat_id: chatId, text: 'TTS failed: ' + e.message });
  }
}

// ─── /story - Generate story ───────────────────────
async function handleStory(chatId, text) {
  const prompt = text.replace(/^\/story\s*/i, '').trim();
  if (!prompt) {
    return tg('sendMessage', { chat_id: chatId, text: 'Usage: /story <prompt>\nGenerates a short story.' });
  }
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const res = await fetch(EP.story + '/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, language: 'en' }),
    });
    if (!res.ok) throw new Error('Story endpoint error');
    const data = await res.json();
    const story = data.story || data.content || data.text || data.title + '\n\n' + data.body || JSON.stringify(data);
    const truncated = story.slice(0, 4000);
    await tg('sendMessage', { chat_id: chatId, text: '📖 *Story Generator*\n\n' + truncated, parse_mode: 'Markdown' });
  } catch(e) {
    tg('sendMessage', { chat_id: chatId, text: 'Story generation failed: ' + e.message });
  }
}

// ─── /search - Web search via Wikipedia ────────
async function handleSearch(chatId, text) {
  const query = text.replace(/^\/search\s*/i, '').trim();
  if (!query) {
    return tg('sendMessage', { chat_id: chatId, text: 'Usage: /search <query>\nWeb search (Wikipedia).' });
  }
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(query) + '&format=json&origin=*';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Wikipedia fetch failed');
    const data = await res.json();
    const results = (data.query?.search || []).slice(0, 5);
    if (!results.length) return tg('sendMessage', { chat_id: chatId, text: 'No Wikipedia results for: ' + query });
    const lines = ['🔍 *Wikipedia*: ' + query + '\n'];
    for (const r of results) {
      const title = r.title || 'Result';
      const snippet = (r.snippet || '').replace(/<[^>]+>/g, '').slice(0, 100);
      lines.push('📌 *' + title + '*\n' + snippet + '\n🔗 https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')) + '\n');
    }
    await tg('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch(e) {
    tg('sendMessage', { chat_id: chatId, text: 'Search failed: ' + e.message });
  }
}

// ─── /ask - AI agent (keyword fallback) ─────────
const AGENT_PATTERNS = [
  { trigger: /\b(status|health|system)\b/i, response: '🟢 OmniClaw running. Try /status for full health check.' },
  { trigger: /\bhelp\b/i, response: '📋 /help for all commands\n/vault <query> - Search knowledge graph' },
  { trigger: /\b(hi|hello|hey)\b/i, response: '👋 Hi! OmniClaw here. Try /vault <query> to search your knowledge graph.' },
  { trigger: /\b(time|date|now)\b/i, response: '🕐 ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) },
  { trigger: /\b(twitter|instagram|sync)\b/i, response: '🐦📷 Social syncs active. Use /sync for status.' },
  { trigger: /\b(vault|search|bookmark)\b/i, response: '🔍 /vault <query> searches your knowledge graph.\nExample: /vault AI agents' },
];
function agentFallback(text) {
  for (const p of AGENT_PATTERNS) if (p.trigger.test(text)) return p.response;
  return '🤖 Ask me about anything!\n• /vault <query> - Search bookmarks\n• /status - System health\n• /help - All commands';
}
async function handleAgent(chatId, text) {
  const query = text.replace(/^\/(ask|agent)\s*/i, '').trim();
  if (!query) return tg('sendMessage', { chat_id: chatId, text: 'Usage: /ask <question>\nAI agent (keyword mode).' });
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  await tg('sendMessage', { chat_id: chatId, text: agentFallback(query) });
}

// ─── /remind - Reminder ─────────────────────────
const REMINDERS_FILE = '/tmp/omniclaw_reminders.json';
function loadReminders() {
  try { return JSON.parse(require('fs').readFileSync(REMINDERS_FILE, 'utf8')); }
  catch { return []; }
}
function saveReminders(r) {
  require('fs').writeFileSync(REMINDERS_FILE, JSON.stringify(r));
}
function parseReminderTime(input) {
  const now = new Date();
  const m = input.match(/^(\d+)\s*(m|min|mins?|h|hr|hrs?|d|days?)$/i);
  if (m) {
    const n = parseInt(m[1]);
    const u = m[2][0].toLowerCase();
    const ms = u === 'm' ? n*60000 : u === 'h' ? n*3600000 : n*86400000;
    return new Date(now.getTime() + ms);
  }
  const iso = new Date(input);
  return isNaN(iso.getTime()) ? null : iso;
}
async function handleRemind(chatId, text) {
  const raw = text.replace(/^\/remind\s*/i, '').trim();
  const spaceIdx = raw.search(/\s/);
  if (spaceIdx < 0) {
    return tg('sendMessage', { chat_id: chatId, text: 'Usage: /remind <time> <text>\nExample: /remind 5m laundry' });
  }
  const timeStr = raw.slice(0, spaceIdx);
  const reminderText = raw.slice(spaceIdx + 1);
  const when = parseReminderTime(timeStr);
  if (!when) {
    return tg('sendMessage', { chat_id: chatId, text: 'Could not parse time: ' + timeStr });
  }
  if (when <= new Date()) {
    return tg('sendMessage', { chat_id: chatId, text: 'Time must be in the future.' });
  }
  const reminders = loadReminders();
  reminders.push({ id: require('crypto').randomUUID(), chat_id: chatId, text: reminderText, timestamp: when.toISOString() });
  saveReminders(reminders);
  const diff = when - new Date();
  const mins = Math.round(diff / 60000);
  const msg = mins < 60 ? mins + ' min' : mins < 1440 ? Math.round(mins/60) + ' hr' : Math.round(mins/1440) + ' day';
  await tg('sendMessage', { chat_id: chatId, text: 'Reminder set for ' + msg + ': ' + reminderText });
}

// Check due reminders on each message
async function checkReminders(chatId) {
  const reminders = loadReminders();
  const now = Date.now();
  const due = reminders.filter(r => new Date(r.timestamp).getTime() <= now && r.chat_id === chatId);
  const remaining = reminders.filter(r => !(new Date(r.timestamp).getTime() <= now && r.chat_id === chatId));
  if (due.length > 0) saveReminders(remaining);
  for (const r of due) {
    await tg('sendMessage', { chat_id: r.chat_id, text: '🔔 Reminder: ' + r.text });
  }
}

// ─── Message router ───────────────────────────────────
async function handleMessage(msg) {
  // DEBUG: log raw update to diagnose empty text issue
  console.log('📨 RAW msg fields:', JSON.stringify({
    text: msg && msg.text,
    caption: msg && msg.caption,
    content_type: msg && msg.content_type,
    chat_type: msg && msg.chat && msg.chat.type,
    chat_title: msg && msg.chat && msg.chat.title,
    entities: msg && msg.entities,
    has_mention: msg && msg.text && msg.text.includes('@Dasomni_bot')
  }).slice(0, 500));

  const text = (msg && (msg.text || msg.caption)) || '';
  const chatId = msg && msg.chat && msg.chat.id;
  const fromName = (msg && msg.from && msg.from.first_name) || 'there';

  if (!chatId) return;

  // Check for due reminders (async, non-blocking)
  checkReminders(chatId).catch(() => {});

  // Commands
  if (text === '/start' || text === '/start@' + BOT_USERNAME) return handleStart(chatId, fromName);
  if (text === '/help' || text === '/help@' + BOT_USERNAME) return handleHelp(chatId);
  if (text.startsWith('/status') || text.startsWith('/status@' + BOT_USERNAME)) return handleStatus(chatId);
  if (text.startsWith('/vault') || text.startsWith('/vault@' + BOT_USERNAME)) return handleVault(chatId, text);
  if (text.startsWith('/sync') || text.startsWith('/sync@' + BOT_USERNAME)) return handleSync(chatId);
  if (text.startsWith('/growthos') || text.startsWith('/growthos@' + BOT_USERNAME)) return handleGrowthOS(chatId, text);
  if (text.startsWith('/drafts') || text.startsWith('/drafts@' + BOT_USERNAME)) return handleDrafts(chatId);
//   if (text.startsWith('/tts') || text.startsWith('/tts@' + BOT_USERNAME)) return handleTTS(chatId, text);
  if (text.startsWith('/story') || text.startsWith('/story@' + BOT_USERNAME)) return handleStory(chatId, text);
  if (text.startsWith('/search') || text.startsWith('/search@' + BOT_USERNAME)) return handleSearch(chatId, text);
//   if (text.startsWith('/ask') || text.startsWith('/ask@' + BOT_USERNAME)) return handleAgent(chatId, text);
  if (text.startsWith('/remind') || text.startsWith('/remind@' + BOT_USERNAME)) return handleRemind(chatId, text);

  // ── Approve / Reject / Posted ──
  const approveMatch = text.match(/^approve\s+(\d+)/i);
  const rejectMatch = text.match(/^reject\s+(\d+)/i);
  const postedMatch = text.match(/^posted\s+(\d+)/i);

  if (approveMatch) {
    const draftId = parseInt(approveMatch[1]);
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    try {
      const ok = await updateDraftStatusGCS(draftId, 'approved');
      await tg('sendMessage', { chat_id: chatId, text: ok ? `✅ Draft ${draftId} approved! Post it and reply \`posted ${draftId}\`` : `❌ Could not approve draft ${draftId}.` });
    } catch(e) {
      await tg('sendMessage', { chat_id: chatId, text: `⚠️ Error approving draft ${draftId}: ${e.message}` });
    }
    return;
  }
  if (rejectMatch) {
    const draftId = parseInt(rejectMatch[1]);
    try {
      const ok = await updateDraftStatusGCS(draftId, 'rejected');
      await tg('sendMessage', { chat_id: chatId, text: ok ? `❌ Draft ${draftId} rejected.` : `❌ Could not reject draft ${draftId}.` });
    } catch(e) {
      await tg('sendMessage', { chat_id: chatId, text: `⚠️ Error rejecting draft ${draftId}: ${e.message}` });
    }
    return;
  }
  if (postedMatch) {
    const draftId = parseInt(postedMatch[1]);
    try {
      const ok = await updateDraftStatusGCS(draftId, 'posted');
      await tg('sendMessage', { chat_id: chatId, text: ok ? `📤 Draft ${draftId} marked as posted! 🎉` : `❌ Could not update draft ${draftId}.` });
    } catch(e) {
      await tg('sendMessage', { chat_id: chatId, text: `⚠️ Error marking draft ${draftId} as posted: ${e.message}` });
    }
    return;
  }

  // Skip other /commands
  if (text.startsWith('/')) return;

  // Group: respond to mentions OR slash commands OR free text
  const chatType = msg.chat && msg.chat.type;
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const hasMention = text.includes('@' + BOT_USERNAME);
  const isCommand = text.startsWith('/');

  // In groups: respond to mentions OR commands OR free text (if enabled)
  if (isGroup && !hasMention && !isCommand) {
    // Free text in group without mention - skip (don't auto-search)
    console.log('📨 Group chat (no mention): "' + text.slice(0, 50) + '" textEmpty=' + (text === '') + ' isGroup=' + isGroup + ' hasMention=' + hasMention);
    return;
  }

  // Strip @mention from text for cleaner search queries
  let searchText = text;
  if (hasMention) {
    searchText = text.replace(new RegExp('@' + BOT_USERNAME + '\\s*', 'gi'), '').trim();
    console.log('📨 Mention detected: "' + searchText.slice(0, 50) + '"');
  }

  // Auto-search: any non-command text = vault search
  const lower = searchText.toLowerCase();
  if (!searchText || /\b(hello|hi|hey|thanks|thank you|good morning|good night)\b/.test(lower)) {
    return tg('sendMessage', { chat_id: chatId, text: '👋 Hey! Try sending a keyword to search your vault, or /help for commands.' });
  }
  if (/\b(status|health)\b/.test(lower)) {
    return tg('sendMessage', { chat_id: chatId, text: 'Use /status for health check 🟢' });
  }

  // Rate limit check
  const userId = msg.from && msg.from.id;
  if (userId && !checkRate(userId)) {
    console.log('⏱ Rate limited user ' + userId);
    return tg('sendMessage', { chat_id: chatId, text: '⏱ Please slow down! Max ' + MAX_PER_MINUTE + ' searches per minute.' });
  }

  // Already inside chat queue from webhook - just execute directly
  console.log('🔍 Auto-search executing: "' + searchText + '" (active searches: ' + activeSearches + ')');
  return handleVault(chatId, '/vault ' + searchText);
}

// ─── Express Routes ───────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'dasomni-bot', mode: 'webhook/raw', uptime: Math.floor(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/webhook', async (req, res) => {
  const update = req.body;
  const updateId = update ? update.update_id : 0;
  const text = update && update.message && update.message.text || '';

  console.log('📨 #' + updateId + ' text="' + text.slice(0, 80) + '"');

  // Always respond immediately to Telegram (200 within 1s)
  res.json({ ok: true });

  if (update && update.message) {
    // Route through queue per chat for sequential processing
    const chatId = update.message.chat && update.message.chat.id;
    if (chatId) {
      enqueueChat(chatId, () => handleMessage(update.message)).catch(e =>
        console.error('❌ Queue handle error: ' + e.message)
      );
    } else {
      handleMessage(update.message).catch(e => console.error('❌ Handle error: ' + e.message));
    }
  }
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

  // No webhook - we're using POLLING to bypass the broken GCS tunnel.
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
      // DEBUG: Log offset before each poll
      console.log('📡 Polling offset=' + offset + '...');
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
            const chatId = update.message.chat && update.message.chat.id;
            if (chatId) {
              enqueueChat(chatId, () => handleMessage(update.message)).catch(e =>
                console.error('❌ Poll handle error: ' + e.message)
              );
            } else {
              handleMessage(update.message).catch(e =>
                console.error('❌ Poll handle error: ' + e.message)
              );
            }
          }
          if (update.edited_message) {
            const chatId = update.edited_message.chat && update.edited_message.chat.id;
            if (chatId) {
              enqueueChat(chatId, () => handleMessage(update.edited_message)).catch(e =>
                console.error('❌ Edited msg error: ' + e.message)
              );
            } else {
              handleMessage(update.edited_message).catch(e =>
                console.error('❌ Edited msg error: ' + e.message)
              );
            }
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
