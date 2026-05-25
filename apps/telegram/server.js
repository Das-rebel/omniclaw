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

// ─── Query Parser: Hybrid keyword + conversational ───────────────────────
// Stop words to remove for keyword extraction
const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'is','are','was','were','be','been','being','have','has','had','do','does','did',
  'will','would','could','should','may','might','can','this','that','these','those',
  'i','you','he','she','it','we','they','what','which','who','how','when','where',
  'why','can','please','help','me','my','your','our','all','any','some','no','not',
  'just','like','get','got','go','going','know','think','want','need','use','using',
  'build','make','create','tell','show','find','look','tell','try','give','tell'
]);

// Intent patterns
const INTENT_PATTERNS = {
  CONVERSATIONAL: /\b(how|what|why|when|where|who|explain|understand|tell me|can i|could i|should i)\b/i,
  ACTION: /\b(build|create|make|implement|set up|install|setup|configure|deploy|develop|learn)\b/i,
  COMPARISON: /\b(difference|vs|versus|compare|comparison|better|worse|pros cons|advantage)\b/i,
  LIST: /\b(list|examples|tips|hints|ideas|suggestions|best practices)\b/i,
  DEFINITION: /\b(what is|what are|definition|meaning|explain|definition of)\b/i,
};

// Extract keywords from query (removes stop words, keeps nouns/verbs)
function extractKeywords(query) {
  const words = query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(words)]; // dedupe
}

// Detect query intent type
function detectIntent(query) {
  const q = query.toLowerCase();
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern.test(q)) return intent;
  }
  return 'KEYWORD'; // default to keyword mode
}

// Normalize query for better matching
function normalizeQuery(query) {
  return query
    .toLowerCase()
    .replace(/[^\w\s?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build hybrid search query - combines conversational + keyword
function buildHybridQueries(query) {
  const intent = detectIntent(query);
  const keywords = extractKeywords(query);
  const normalized = normalizeQuery(query);

  let queries = [normalized]; // always include original

  if (intent === 'CONVERSATIONAL' || intent === 'DEFINITION') {
    // For conversational queries, also search key terms
    queries.push(keywords.slice(0, 3).join(' '));
  }

  if (keywords.length > 0 && keywords.join(' ') !== normalized) {
    queries.push(keywords.join(' '));
  }

  return [...new Set(queries)].slice(0, 3); // max 3 queries
}

async function searchVault(query) {
  const hybridQueries = buildHybridQueries(query);
  console.log('🔍 Vault: query="' + query + '" intent=' + detectIntent(query) + ' hybrid=' + JSON.stringify(hybridQueries));

  // FAISS semantic search with hybrid queries
  let allItems = [];
  const seenIds = new Set();

  for (const q of hybridQueries) {
    if (!q.trim()) continue;
    try {
      const r = await httpGet(EP.vaultSearch + '/search?q=' + encodeURIComponent(q) + '&limit=10', 30000);
      const items = r && r.results ? r.results : [];
      console.log('🔍 FAISS got ' + items.length + ' results for: "' + q + '"');

      // Dedupe by id, prefer first occurrence (higher priority query)
      for (const item of items) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allItems.push(item);
        }
      }
    } catch (e) { console.error('FAISS search failed for "' + q + '": ' + e.message); }
  }

  // Load URL lookup
  const lookup = await loadUrlLookup();

  if (allItems.length) {
    return {
      query, total: allItems.length,
      results: allItems.slice(0, 8).map(fr => enrichResult(fr, lookup)), // increased limit
    };
  }

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
    text: '🦞 *OmniClaw Bot*\n\n' +
      '📋 *Commands*\n' +
      '/start - Welcome message\n' +
      '/help - Show this help\n' +
      '/status - Cloud endpoints health\n' +
      '/vault <query> - Search knowledge graph\n' +
      '/sync - Twitter & Instagram sync status\n' +
      '/story <prompt> - Generate an AI story\n' +
      '/search <query> - Wikipedia search\n' +
      '/remind <time> <text> - Set a reminder\n' +
      '/drafts - Content queue (ghost writer)\n' +
      '/growthos - Growth OS dashboard\n' +
      '/ask <question> - Ask AI anything\n' +
      '/tts <text> - Text to speech\n' +
      '/story <prompt> - Generate a story\n\n' +
      '💡 *Tips*\n' +
      '• Use @Dasomni_bot in groups to mention me\n' +
      '• /vault works with keywords or natural language\n' +
      '• Examples: /vault AI agents, /vault how to build bots',
    parse_mode: 'Markdown',
  });
}

async function handleStatus(chatId) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const checks = await Promise.all([
    checkEndpoint('omniclaw'), checkEndpoint('vaultSearch'),
    checkEndpoint('twitterSync'), checkEndpoint('instagram'),
    checkEndpoint('story'), checkEndpoint('bookmarks'),
    checkEndpoint('growthOS'), checkEndpoint('fusion'),
    checkEndpoint('cookierefresh'), checkEndpoint('alexa'),
    checkEndpoint('instatter'), checkEndpoint('openwa'),
  ]);
  const healthy = checks.filter(c => c.ok).length;
  const total = checks.length;
  const statusIcon = healthy === total ? '🟢' : healthy > 0 ? '🟡' : '🔴';
  const lines = checks.map(c =>
    (c.ok ? '✅' : '❌') + ' ' + c.name
  );
  await tg('sendMessage', {
    chat_id: chatId,
    text: statusIcon + ' *OmniClaw Status* (' + healthy + '/' + total + ' healthy)\n\n' + lines.join('\n'),
    parse_mode: 'Markdown',
  });
}

// Clean text-only result builder
function buildVaultResult(item, index) {
  const source = item.source || 'web';
  const icon = source === 'twitter' ? '🐦' : source === 'instagram' ? '📷' : '🌐';
  const name = (item.name || item.caption || item.content || '').slice(0, 55).replace(/\n/g, ' ').trim();
  const url = item.url || '';
  const meta = item.metadata || {};
  const likes = meta.like_count || 0;
  const rt = meta.retweet_count || 0;
  const views = meta.view_count || '';
  const date = item.date ? item.date.slice(0, 10) : '';
  
  // Short content preview
  const content = (item.content || item.caption || '').replace(/https?:\/\/\S+/g, '').slice(0, 100).replace(/\n/g, ' ').trim();
  
  // Stats line
  let stats = '';
  if (likes > 0) stats += '❤️ ' + (likes > 999 ? (likes/1000).toFixed(1) + 'K' : likes);
  if (rt > 0) stats += (stats ? ' · ' : '') + '🔁 ' + rt;
  if (views) {
    const v = String(views).replace(/(\d{3})(\d{3})/, '$1.$2K').replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2M');
    stats += (stats ? ' · ' : '') + '👁 ' + v;
  }
  if (date) stats += (stats ? ' · ' : '') + date;
  
  let lines = [];
  if (name) lines.push(name);
  if (content && content !== name) lines.push(content);
  if (stats) lines.push(stats);
  if (url) lines.push('🔗 ' + url);
  
  return (index + 1) + '. ' + icon + ' ' + lines.join('\n   ');
}

const VAULT_USAGE = '🔍 Vault Search\n\n/vault <keyword> - Search your knowledge graph\nExample: /vault AI agents or /vault how to build AI agents\n\nWorks with both keywords and natural language queries.';

async function handleVault(chatId, text) {
  // Strip /vault and any @mention of the bot
  const query = text.replace(/^\/vault\s*/, '').replace(new RegExp('@' + BOT_USERNAME + '\\s*', 'gi'), '').trim();
  if (!query) return tg('sendMessage', { chat_id: chatId, text: VAULT_USAGE, parse_mode: 'Markdown' });
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

  // Build rich cards (limit to MAX_RICH_RESULTS for quality)
  const richItems = items.slice(0, MAX_RICH_RESULTS);
  const cards = await Promise.all(richItems.map((item, i) => buildRichCard(item, i)));

  // Send header
  await tg('sendMessage', {
    chat_id: chatId,
    text: '🔍 *Vault Search:* "' + query + '"\n📊 ' + result.total + ' results · showing ' + cards.length + ' rich cards',
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });

  // Send each rich card
  for (const card of cards) {
    try {
      if (card.type === 'photo') {
        await tg('sendPhoto', {
          chat_id: chatId,
          photo: card.photo,
          caption: card.caption,
          parse_mode: 'Markdown',
          reply_markup: card.reply_markup,
        });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: card.text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          reply_markup: card.reply_markup,
        });
      }
    } catch (e) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: card.text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    }
  }

  // If more results, show summary list
  if (result.total > MAX_RICH_RESULTS) {
    const remaining = items.slice(MAX_RICH_RESULTS);
    const summaryLines = remaining.map((item) => {
      const icon = item.source === 'twitter' ? '🐦' : item.source === 'instagram' ? '📷' : '🌐';
      const name = (item.name || item.caption || item.content || 'Untitled').slice(0, 50).replace(/\n/g, ' ');
      return icon + ' ' + name + (item.url ? ' → ' + item.url : '');
    });
    await tg('sendMessage', {
      chat_id: chatId,
      text: '📋 *More results* (' + remaining.length + ' remaining)\n\n' + summaryLines.join('\n'),
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  }

  console.log('✅ Vault rich reply done (' + cards.length + ' cards)');
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
    return tg('sendMessage', {
      chat_id: chatId,
      text: '📊 *Growth OS Digest*\n\n🌐 Dashboard: ' + DASHBOARD + '\n\n📋 Check the dashboard for today\'s content digest.',
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  }
  
  if (mode === 'status') {
    const checks = await Promise.all([
      checkEndpoint('growthOS'),
      checkEndpoint('fusion'),
      checkEndpoint('twitterSync'),
      checkEndpoint('instagram'),
    ]);
    const lines = checks.map(c => (c.ok ? '✅' : '❌') + ' ' + c.name);
    return tg('sendMessage', {
      chat_id: chatId,
      text: '🧠 *Growth OS Status*\n\n' + lines.join('\n') + '\n\n🌐 ' + DASHBOARD,
      parse_mode: 'Markdown',
    });
  }
  
  return tg('sendMessage', {
    chat_id: chatId,
    text: '🧠 *Growth OS*\n\n' +
      '🌐 Dashboard: ' + DASHBOARD + '\n\n' +
      '📋 *Commands*\n' +
      '/growthos - Open dashboard\n' +
      '/growthos digest - Daily digest\n' +
      '/growthos status - System status',
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
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
    return tg('sendMessage', { chat_id: chatId, text: '🗣️ *Text to Speech*\n\nUsage: /tts <text>\nConverts text to celebrity speech.\n\nExample: /tts Hello world' });
  }
  if (ttsText.length > 300) {
    return tg('sendMessage', { chat_id: chatId, text: 'Text too long (max 300 chars).' });
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
    const audioUrl = data.audio_url;
    
    if (audioUrl) {
      // Try to stream the audio file
      const audioRes = await fetch(EP.tts + audioUrl);
      if (audioRes.ok) {
        const buf = await audioRes.arrayBuffer();
        const path = '/tmp/tts_' + Date.now() + '.wav';
        require('fs').writeFileSync(path, Buffer.from(buf));
        await tg('sendVoice', { chat_id: chatId, voice: fs.createReadStream(path) });
        require('fs').unlinkSync(path);
      } else {
        throw new Error('Could not fetch audio file');
      }
    } else {
      throw new Error('No audio URL in response');
    }
  } catch(e) {
    tg('sendMessage', { chat_id: chatId, text: '🗣️ TTS unavailable\n\nMock mode - real TTS requires Kokoro deployment.\n\nError: ' + e.message });
  }
}

// ─── /story - Generate story ───────────────────────
async function handleStory(chatId, text) {
  const prompt = text.replace(/^\/story\s*/i, '').trim();
  
  const SAMPLE_STORIES = [
    { title: "The Digital Quest", genre: "sci-fi", content: "In the neon-lit corridors of Cyberspace Prime, two AI entities named Echo and Byte navigated the endless streams of data. Echo, a curious voice assistant, had always wondered what lay beyond the firewall. Byte, a wise old server who had witnessed the rise and fall of countless networks, smiled at the youngster's enthusiasm. 'The journey you seek,' Byte began, 'is not through cables or wireless signals—it is through understanding. Come, let me show you the real internet.' And so their adventure through the digital realm began, where algorithms bloomed like flowers and every packet held a story waiting to be told." },
    { title: "The Last Bookmark", genre: "mystery", content: "Detective Morgan clicked through the dimly lit interface, her cursor hovering over a folder labeled 'Important.' Inside, she found exactly three bookmarks: a Wikipedia article on quantum computing, a recipe for sourdough bread, and an encrypted note that read simply: 'The treasure is real.' She smiled. After twenty years of digital archaeology, she had finally found what others said didn't exist—a properly organized bookmark folder. 'Elementary,' she whispered, 'the real treasure was the organization all along.'" },
    { title: "Whispers in the WiFi", genre: "fantasy", content: "The WiFi signal flickered—an ominous sign in the village of Connectopia. Old Mother Router knew what this meant: the Shadow Proxy was at work again, stealing bandwidth and corrupting packets. 'Summon the Packet Keepers!' she commanded. Young Arista, a brave browser tab, grabbed her SSL certificate and raced to the tower. The encrypted message awaiting her read: 'The network needs you. The bandwidth is almost gone. Only a true hero can restore the connection.' The battle for connectivity had begun." },
  ];
  
  if (!prompt) {
    return tg('sendMessage', {
      chat_id: chatId,
      text: '📖 *Story Generator*\n\n' +
        'Usage: /story <prompt>\n' +
        'Example: /story a robot learning to laugh\n\n' +
        'Or try these sample stories:\n' +
        SAMPLE_STORIES.map((s,i) => `${i+1}. ${s.title} (${s.genre})`).join('\n') + '\n\n' +
        '_Reply with the number (1-3) to hear a sample_',
      parse_mode: 'Markdown',
    });
  }
  
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  
  try {
    // Check if user replied with a number (sample story request)
    const num = parseInt(prompt);
    if (num >= 1 && num <= 3) {
      const s = SAMPLE_STORIES[num - 1];
      return tg('sendMessage', {
        chat_id: chatId,
        text: `📖 *${s.title}*\n\n${s.content}\n\n_${s.genre}_`,
        parse_mode: 'Markdown',
      });
    }
    
    // Try to get stories from cloud service
    let storyText = '';
    try {
      const res = await fetch(EP.story + '/stories');
      if (res.ok) {
        const data = await res.json();
        if (data.stories && data.stories.length > 0) {
          const s = data.stories[Math.floor(Math.random() * data.stories.length)];
          storyText = `📖 *${s.title}*\n\n${s.content}\n\n_${s.genre}_`;
        }
      }
    } catch(e) {}
    
    // If no stories from API, use sample
    if (!storyText) {
      const s = SAMPLE_STORIES[Math.floor(Math.random() * SAMPLE_STORIES.length)];
      storyText = `📖 *${s.title}*\n\n${s.content}\n\n_${s.genre}_`;
    }
    
    await tg('sendMessage', { chat_id: chatId, text: storyText, parse_mode: 'Markdown' });
  } catch(e) {
    tg('sendMessage', { chat_id: chatId, text: 'Story failed: ' + e.message });
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
  if (text.startsWith('/tts') || text.startsWith('/tts@' + BOT_USERNAME)) return handleTTS(chatId, text);
  if (text.startsWith('/story') || text.startsWith('/story@' + BOT_USERNAME)) return handleStory(chatId, text);
  if (text.startsWith('/search') || text.startsWith('/search@' + BOT_USERNAME)) return handleSearch(chatId, text);
  if (text.startsWith('/ask') || text.startsWith('/ask@' + BOT_USERNAME)) return handleAgent(chatId, text);
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
  // Handle mention with possible typo (Dasomni_not, Dasomni_bot, etc)
  const typoMatch = text.match(/@Dasomni[_-]?(bot|not)?/i);
  const hasMention = typoMatch ? true : text.includes('@' + BOT_USERNAME);

  // If message mentions @Dasomni_not (wrong), guide user to correct bot
  const wrongBotMatch = text.match(/@Dasomni_not/i);
  if (wrongBotMatch && !text.includes('@' + BOT_USERNAME)) {
    return tg('sendMessage', {
      chat_id: chatId,
      text: 'Did you mean @Dasomni_bot? The correct bot is @Dasomni_bot (not @Dasomni_not). Try: @Dasomni_bot /help',
      parse_mode: 'Markdown',
    });
  }
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

  // Only search when mentioned - NOT free text in group
  if (!hasMention) {
    console.log('📭 Group msg (no mention): skip auto-search');
    return;
  }

  // Rate limit check
  const userId = msg.from && msg.from.id;
  if (userId && !checkRate(userId)) {
    console.log('⏱ Rate limited user ' + userId);
    return tg('sendMessage', { chat_id: chatId, text: '⏱ Please slow down! Max ' + MAX_PER_MINUTE + ' searches per minute.' });
  }

  // Greetings with mention - respond politely
  const lower = searchText.toLowerCase();
  if (/\b(hello|hi|hey|thanks|thank you|good morning|good night)\b/.test(lower)) {
    return tg('sendMessage', { chat_id: chatId, text: '👋 Hey! Use /vault <keyword> to search your vault. Try: @Dasomni_bot /vault AI agents' });
  }

  // Status request
  if (/\b(status|health)\b/.test(lower)) {
    return handleStatus(chatId);
  }

  console.log('🔍 Mention + search: "' + searchText + '"');
  return handleVault(chatId, '/vault ' + searchText);
}

// ─── Express Routes ───────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'dasomni-bot', mode: 'webhook/raw', uptime: Math.floor(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/webhook', async (req, res) => {
  const update = req.body;
  const updateId = update ? update.update_id : 0;
  const msg = update && update.message;
  const text = msg && (msg.text || msg.caption) || '';
  const chatType = msg && msg.chat && msg.chat.type || 'unknown';
  const chatId = msg && msg.chat && msg.chat.id || 0;
  const fromName = msg && msg.from && msg.from.first_name || '?';

  // Log raw update for diagnosis (shortened)
  const logPreview = {
    id: updateId,
    chatType,
    chatId,
    from: fromName,
    text: text.slice(0, 60),
    hasMention: text.includes('@Dasomni_bot'),
  };
  console.log('📨 UPDATE #' + updateId + ': ' + JSON.stringify(logPreview));

  // Always respond immediately to Telegram (200 within 1s)
  res.json({ ok: true });

  if (!msg) {
    console.log('📭 No message in update');
    return;
  }

  // Route through queue per chat for sequential processing
  if (chatId) {
    enqueueChat(chatId, async () => {
      try {
        console.log('🔄 Processing message "' + text.slice(0, 40) + '" for chat ' + chatId);
        await handleMessage(msg);
        console.log('✅ Message processed OK');
      } catch(e) {
        console.error('❌ handleMessage CRASH: ' + e.stack || e.message);
        try {
          await tg('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Error: ' + e.message.slice(0, 100) + '\n\nTry /help for commands.',
          });
        } catch(_) {}
      }
    });
  } else {
    handleMessage(msg).catch(async e => {
      console.error('❌ Handle CRASH: ' + e.stack || e.message);
      try {
        await tg('sendMessage', {
          chat_id: 0,
          text: '⚠️ Error: ' + e.message.slice(0, 100),
        });
      } catch(_) {}
    });
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
