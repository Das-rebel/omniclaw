#!/usr/bin/env node
/**
 * OmniClaw WhatsApp Bot - GreenAPI - Full Feature Parity with Telegram
 * Mirrors ALL Telegram bot features for WhatsApp.
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── GreenAPI Credentials ─────────────────────────────
const INSTANCE_ID = process.env.GREENAPI_INSTANCE || '7107630227';
const API_TOKEN = process.env.GREENAPI_TOKEN || 'f9e7484d874043239fc97bbe3cfcef23660f6dc83a504591ae';
const PORT = process.env.PORT || 8090;
const BOT_PHONE = process.env.BOT_PHONE || '919003349852';
const WA_API_KEY = process.env.WA_API_KEY || 'omniclaw-wa-secret';
const ADMIN_PHONES = ['919003349852'];

// ─── GreenAPI Wrapper ────────────────────────────────
const GreenAPI = require('./greenapi-wrapper');
const api = new GreenAPI(INSTANCE_ID, API_TOKEN);

// ─── Rate Limiting & Queue Management ─────────────────
const { checkRate, enqueue, MAX_PER_MINUTE } = require('./rate-limiter');

// ─── Free-text vault auto-search rate limiter ─────────
const freeTextCount = new Map(); // phone → [{time}]
const FREE_TEXT_LIMIT = 3; // max auto-searches per 60 seconds

// ─── GreenAPI Send Helpers ────────────────────────────
function normalizeChatId(phone) {
  return phone.includes('@') ? phone : `${phone}@c.us`;
}

async function waSend(phone, message) {
  return api.sendText(normalizeChatId(phone), message);
}

async function waSendButton(phone, message, buttons, footer) {
  return api.sendButtons(normalizeChatId(phone), message, buttons, footer);
}

async function waSendList(phone, message, buttonText, sections) {
  return api.sendList(normalizeChatId(phone), message, buttonText, sections);
}

// ─── Cloud Endpoints (full list = Telegram) ──────────
const EP = {
  vaultSearch: 'https://serve-vault-search-338789220059.asia-south1.run.app',
  twitterSync: 'https://twitter-sync-338789220059.asia-south1.run.app',
  instagram: 'https://instagram-sync-338789220059.asia-south1.run.app',
  bookmarks: 'https://bookmark-processor-338789220059.asia-south1.run.app',
  omniclaw: 'https://omniclaw-gcs-338789220059.asia-south1.run.app',
  tts: 'https://celebrity-tts-338789220059.asia-south1.run.app',
  story: 'https://story-narrator-338789220059.asia-south1.run.app',
  alexa: 'https://alexa-handler-338789220059.asia-south1.run.app',
  dashboard: 'https://fusion-dashboard-338789220059.asia-south1.run.app',
  vaultPipeline: 'https://vault-pipeline-338789220059.asia-south1.run.app',
  vaultControl: 'https://omniclaw-vault-control-338789220059.asia-south1.run.app',
  instatter: 'https://instatter-338789220059.asia-south1.run.app',
};

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

async function checkEndpoint(name) {
  try {
    const r = await httpGet(EP[name] + '/health', 6000);
    return { name, ok: true, status: r.status || r.service || 'healthy' };
  } catch (e) {
    return { name, ok: false, error: e.message.slice(0, 30) };
  }
}

// ─── Vault Search — imported from vault-search.js ─────
const { searchVault, buildVaultResult, extractKeywords, getVaultUrls } = require('./vault-search');

// ─── Vault Rankings (learning from usage) ────────────
const VAULT_RANKS_FILE = '/tmp/vault_ranks.json';
let vaultRanks = {};
try {
  if (fs.existsSync(VAULT_RANKS_FILE)) {
    vaultRanks = JSON.parse(fs.readFileSync(VAULT_RANKS_FILE, 'utf8'));
  }
} catch (e) {
  console.error('\u26a0\ufe0f Failed to load vault ranks:', e.message);
}

setInterval(() => {
  try {
    fs.writeFileSync(VAULT_RANKS_FILE, JSON.stringify(vaultRanks));
  } catch (e) {
    console.error('\u26a0\ufe0f Failed to save vault ranks:', e.message);
  }
}, 60000);

function trackVaultView(items) {
  for (const item of items) {
    if (item.id) vaultRanks[item.id] = (vaultRanks[item.id] || 0) + 1;
  }
}

// ─── Reminders (persistent JSON file) ────────────────
const REMINDERS_FILE = '/tmp/omniclaw_wa_reminders.json';
function loadReminders() {
  try { return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')); } catch { return []; }
}
function saveReminders(r) { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(r)); }

function parseReminderTime(input) {
  const now = new Date();
  const m = input.match(/^(\d+)\s*(m|min|mins?|h|hr|hrs?|d|days?)$/i);
  if (m) {
    const n = parseInt(m[1]), u = m[2][0].toLowerCase();
    const ms = u === 'm' ? n*60000 : u === 'h' ? n*3600000 : n*86400000;
    return new Date(now.getTime() + ms);
  }
  const iso = new Date(input);
  return isNaN(iso.getTime()) ? null : iso;
}

// ─── AI Agent Patterns ────────────────────────────────
const AGENT_PATTERNS = [
  { trigger: /\b(status|health|system)\b/i, response: '🟢 OmniClaw running. Try /status for full health check.' },
  { trigger: /\bhelp\b/i, response: '📋 /help for all commands\n/vault <query> - Search knowledge graph' },
  { trigger: /\b(hi|hello|hey)\b/i, response: '👋 Hi! OmniClaw here. Try /vault <query> to search your knowledge graph.' },
  { trigger: /\b(time|date|now)\b/i, response: '🕐 ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) },
  { trigger: /\b(twitter|instagram|sync)\b/i, response: '🐦📷 Social syncs active. Use /sync for status.' },
  { trigger: /\b(vault|search|bookmark)\b/i, response: '🔍 /vault <query> searches your knowledge graph.\nExample: /vault AI agents' },
];

function agentFallback(text) {
  for (const p of AGENT_PATTERNS) { if (p.trigger.test(text)) return p.response; }
  return '🤖 Ask me about anything!\n• /vault <query> - Search bookmarks\n• /status - System health\n• /help - All commands';
}

// ─── GCS SQLite for Drafts ────────────────────────────
let gcsDb = null, gcsDbLoaded = 0;
const GCS_DB_URL = 'https://storage.googleapis.com/growth-os-db-338789220059/growth_os.db';

async function loadSqliteFromGCS() {
  if (gcsDb && Date.now() - gcsDbLoaded < 300000) return gcsDb;
  try {
    let initSqlJs;
    try {
      initSqlJs = require('sql.js');
    } catch(e) {
      console.error('❌ sql.js not available:', e.message);
      return null;
    }
    const dbRes = await fetch(GCS_DB_URL + '?cachebust=' + Date.now());
    if (!dbRes.ok) throw new Error('GCS DB fetch failed: ' + dbRes.status);
    const dbBuf = await dbRes.arrayBuffer();
    const SQL = await initSqlJs();
    gcsDb = new SQL.Database(new Uint8Array(dbBuf));
    gcsDbLoaded = Date.now();
    return gcsDb;
  } catch (e) {
    console.error('❌ GCS SQLite load failed:', e.message);
    gcsDb = null;
    return null;
  }
}

async function getDraftsFromGCS(limit = 10) {
  const db = await loadSqliteFromGCS();
  if (!db) return [];
  try {
    const results = db.exec(
      "SELECT id, platform, draft_text, topic, status, generated_at FROM content_drafts ORDER BY generated_at DESC LIMIT " + limit
    );
    if (!results.length || !results[0].values.length) return [];
    const cols = results[0].columns;
    return results[0].values.map(row => { const d = {}; cols.forEach((c, i) => d[c] = row[i]); return d; });
  } catch (e) { return []; }
}

async function updateDraftStatusGCS(draftId, newStatus) {
  const db = await loadSqliteFromGCS();
  if (!db) return false;
  try {
    const now = new Date().toISOString();
    let sql = '';
    if (newStatus === 'approved') sql = `UPDATE content_drafts SET status='approved', approved_at='${now}', reviewed_at='${now}' WHERE id=${draftId}`;
    else if (newStatus === 'rejected') sql = `UPDATE content_drafts SET status='rejected', reviewed_at='${now}' WHERE id=${draftId}`;
    else if (newStatus === 'posted') sql = `UPDATE content_drafts SET status='posted', posted_at='${now}' WHERE id=${draftId}`;
    if (sql) db.run(sql);
    return true;
  } catch (e) { return false; }
}

// ═══════════════════════════════════════════════════════
//  COMMAND HANDLERS
// ═══════════════════════════════════════════════════════

async function handleStart(phone, fromName) {
  await waSend(phone, 'Hey ' + fromName + '! 🦞\n\nI\'m OmniClaw - your AI assistant on WhatsApp.\n\nType /help for commands!');
}

async function handleHelp(phone) {
  await waSend(phone,
    '🦞 *OmniClaw Bot on WhatsApp*\n\n' +
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
    '/tts <text> - Text to speech\n\n' +
    '💡 *Tips*\n' +
    '• /vault works with keywords or natural language\n' +
    '• Examples: /vault AI agents, /vault how to build bots'
  );
}

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
  await waSend(phone, statusIcon + ' *OmniClaw Status* (' + healthy + '/' + total + ' healthy)\n\n' + lines.join('\n'));
}

async function handleSync(phone) {
  const [tw, ig] = await Promise.all([checkEndpoint('twitterSync'), checkEndpoint('instagram')]);
  await waSend(phone,
    '🔄 *Sync Status*\n\n' +
    '🐦 Twitter: ' + (tw.ok ? '✅ healthy' : '❌ ' + (tw.error || 'down')) + '\n' +
    '📷 Instagram: ' + (ig.ok ? '✅ healthy' : '❌ ' + (ig.error || 'down'))
  );
}

async function handleVault(phone, text) {
  const query = text.replace(/^\/vault\s*/i, '').trim();
  if (!query) {
    return waSend(phone, '🔍 *Vault Search*\n\n/vault <keyword> - Search your knowledge graph\nExample: /vault AI agents\n\nWorks with both keywords and natural language.');
  }
  if (query.length < 2) return waSend(phone, 'Query too short. Try /vault <keyword>');

  // Get initial results
  let result = await searchVault(query);

  // ─── Tag Drill-Down (#7) ──
  if (result && result.isTagView) {
    const tags = result.tags || {};
    const sorted = Object.entries(tags).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return waSend(phone, '🏷 No tags found for "' + query + '".');
    const tagLines = ['🏷 *Tags in "' + result.query + '"*\n'];
    for (const [tag, count] of sorted.slice(0, 20)) {
      tagLines.push('· ' + tag + ' (' + count + ')');
    }
    return waSend(phone, tagLines.join('\n'));
  }

  let items = result && result.results ? result.results : [];
  
  // If few results, try broader/hybrid queries automatically
  if (items.length < 3) {
    const keywords = extractKeywords(query);
    if (keywords.length > 0) {
      const altResult = await searchVault(keywords.join(' '));
      const altItems = altResult && altResult.results ? altResult.results : [];
      const seenIds = new Set(items.map(i => i.id));
      for (const item of altItems) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          items.push(item);
        }
      }
      result.total = items.length;
      result.results = items;
    }
  }

  if (!items.length) {
    const broadSuggestions = ['tools', 'AI', 'training', 'learning', 'resources', 'github', 'paper', 'course', 'startup']
      .filter(s => !query.toLowerCase().includes(s));
    const keywords = extractKeywords(query);
    if (keywords.length > 1) {
      return waSend(phone, '❌ No results for "' + query + '".\n\nTry a broader keyword:\n🔹 /vault ' + keywords.slice(0, 2).join('\n🔹 /vault '));
    }
    return waSend(phone, '❌ No results for "' + query + '".\n\nTry searching related topics:\n🔹 /vault ' + broadSuggestions.slice(0, 3).join('\n🔹 /vault '));
  }

  // Filter out entity-only items (no URLs/content)
  const validItems = items.filter(item => (item.source || item.type) !== 'entity' && !!item.url);
  const entitySkipped = items.length - validItems.length;
  if (!validItems.length) {
    return waSend(phone, '❌ No content results for "' + query + '" (found ' + entitySkipped + ' entity names only).\nTry: /vault ' + query + ' tools');
  }
  items = validItems;
  
  // ─── Summary mode ──
  if (result.isSummary) {
    const summary = '*Vault Summary: "' + result.query + '"*\n\n' +
      items.slice(0, 5).map((item, i) => {
        const icon = (item.source || item.type || '').startsWith('twitter') ? '\u{1F426}' : '\u{1F4F7}';
        const name = (item.name || item.content || '').slice(0, 60).replace('\n', ' ');
        return icon + ' ' + name;
      }).join('\n') +
      '\n\n\u{1F4CA} ' + items.length + ' total results';
    return waSend(phone, summary);
  }
  
  let headerLine = '🔍 *Vault Search:* "' + result.query + '"\n📊 ' + result.total + ' results';
  if (result.after) headerLine += ' (since ' + result.after + ')';
  if (result.before) headerLine += ' (before ' + result.before + ')';
  headerLine += ' (' + validItems.length + ' with links' + (entitySkipped > 0 ? ', ' + entitySkipped + ' names hidden' : '') + ')';
  await waSend(phone, headerLine);

  console.log('📊 Vault: type=' + items[0].type + ' source=' + items[0].source + ' total=' + items.length);
  
  const BATCH_SIZE = 5;
  for (let i = 0; i < Math.min(items.length, 10); i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    console.log('   batch ' + i + '-' + (i+BATCH_SIZE) + ' types=' + batch.map(it => it.type || it.source).join(','));
    try {
      const batchText = batch.map((item, j) => {
        const r = buildVaultResult(item, i + j);
        return r;
      }).join('\n\n');
      await waSend(phone, batchText);
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error('❌ Vault batch error: ' + e.message);
      await waSend(phone, '⚠️ Error formatting results: ' + e.message.slice(0, 50));
    }
  }

  // Send URLs for link previews (WhatsApp auto-generates rich preview cards)
  const urls = getVaultUrls(items);
  for (const url of urls.slice(0, 3)) {
    try {
      await waSend(phone, '🔗 ' + url);
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error('URL preview send failed: ' + e.message);
    }
  }

  // Show source breakdown
  const sources = {};
  const displayNames = { 'twitter_tweet':'twitter', 'twitter_bookmark':'twitter', 'instagram_post':'instagram', 'instagram_reel':'instagram', 'bookmark':'bookmark' };
  const summaryIcons = { 'twitter':'🐦', 'instagram':'📷', 'bookmark':'🔖', 'web':'🌐' };
  for (const item of items.slice(0, 10)) {
    const raw = item.source || item.type || 'other';
    const s = displayNames[raw] || raw;
    sources[s] = (sources[s] || 0) + 1;
  }
  const sourceSummary = Object.entries(sources)
    .map(([k, v]) => (summaryIcons[k] || '🔗') + ' ' + k + ': ' + v)
    .join(' · ');
  if (sourceSummary) await waSend(phone, '📊 *Breakdown*: ' + sourceSummary);

  // ─── Related Searches (#5) ──
  const allEntities = [];
  for (const item of items.slice(0, 10)) {
    if (item.entities && Array.isArray(item.entities)) allEntities.push(...item.entities);
    if (item.metadata?.topic) allEntities.push(item.metadata.topic);
  }
  const queryKeywords = extractKeywords(query).map(k => k.toLowerCase());
  const suggestions = [...new Set(allEntities)]
    .filter(e => !queryKeywords.some(k => e.toLowerCase().includes(k)))
    .slice(0, 3);
  if (suggestions.length > 0) {
    await waSend(phone, '💡 Also try: ' + suggestions.map(s => '/vault ' + s).join(' · '));
  }

  // ─── OG Image Previews for top 3 results (#6) ──
  for (const item of items.slice(0, 3)) {
    if (!item.url) continue;
    try {
      const html = await fetch(item.url, { signal: AbortSignal.timeout(5000) }).then(r => r.text()).catch(() => '');
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      if (ogMatch && ogMatch[1]) {
        const imgUrl = ogMatch[1].startsWith('http') ? ogMatch[1] : new URL(ogMatch[1], item.url).href;
        const chatId = phone.includes('@') ? phone : phone + '@c.us';
        await api.sendFileByUrl(chatId, imgUrl, 'preview.jpg', item.name.slice(0, 100));
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      // silent — preview is optional
    }
  }

  // ─── Track vault views for learning rankings (#10) ──
  trackVaultView(items);

  if (result.total > 10) {
    await waSend(phone, '📋 +' + (result.total - 10) + ' more results. Try a more specific query: /vault ' + query + ' <keyword>');
  }

  // If few results, send interactive list + URL link previews
  if (items.length < 5) {
    const suggestions = ['AI', 'tools', 'software', 'github', 'tutorial', 'paper', 'research']
      .filter(s => !query.toLowerCase().includes(s))
      .slice(0, 3);
    if (suggestions.length > 0) {
      await waSend(phone, '💡 *Tip*: Try a broader search');
      for (const item of items.slice(0, 2)) {
        if (item.url && item.name && item.name !== item.url) {
          await waSend(phone, '🔗 _' + item.name + '_: ' + item.url);
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
  } else {
    await waSendList(phone,
      '📊 ' + result.total + ' results for "' + query + '"',
      'Navigation 🤖',
      [{
        title: 'Options',
        rows: [
          { rowId: 'more_' + query, title: 'Show more results', description: 'Next 5 results' },
          { rowId: 'refine_' + query, title: 'Refine search', description: 'Narrow down results' },
          { rowId: 'source_' + query, title: 'Show by source', description: 'Filter by platform' }
        ]
      }]
    );
  }
}

async function handleStory(phone, text) {
  const prompt = text.replace(/^\/story\s*/i, '').trim();
  const SAMPLE_STORIES = [
    { title: "The Digital Quest", genre: "sci-fi", content: "In the neon-lit corridors of Cyberspace Prime, two AI entities named Echo and Byte navigated the endless streams of data. Echo, a curious voice assistant, had always wondered what lay beyond the firewall. Byte, a wise old server who had witnessed the rise and fall of countless networks, smiled at the youngster's enthusiasm. 'The journey you seek,' Byte began, 'is not through cables or wireless signals—it is through understanding. Come, let me show you the real internet.' And so their adventure through the digital realm began, where algorithms bloomed like flowers and every packet held a story waiting to be told." },
    { title: "The Last Bookmark", genre: "mystery", content: "Detective Morgan clicked through the dimly lit interface, her cursor hovering over a folder labeled 'Important.' Inside, she found exactly three bookmarks: a Wikipedia article on quantum computing, a recipe for sourdough bread, and an encrypted note that read simply: 'The treasure is real.' She smiled. After twenty years of digital archaeology, she had finally found what others said didn't exist—a properly organized bookmark folder. 'Elementary,' she whispered, 'the real treasure was the organization all along.'" },
    { title: "Whispers in the WiFi", genre: "fantasy", content: "The WiFi signal flickered—an ominous sign in the village of Connectopia. Old Mother Router knew what this meant: the Shadow Proxy was at work again, stealing bandwidth and corrupting packets. 'Summon the Packet Keepers!' she commanded. Young Arista, a brave browser tab, grabbed her SSL certificate and raced to the tower. The encrypted message awaiting her read: 'The network needs you. The bandwidth is almost gone. Only a true hero can restore the connection.' The battle for connectivity had begun." },
  ];

  if (!prompt) {
    return waSend(phone,
      '📖 *Story Generator*\n\nUsage: /story <prompt>\nExample: /story a robot learning to laugh\n\nOr sample stories:\n' +
      SAMPLE_STORIES.map((s, i) => (i+1) + '. ' + s.title + ' (' + s.genre + ')').join('\n')
    );
  }

  const num = parseInt(prompt);
  if (num >= 1 && num <= 3) {
    const s = SAMPLE_STORIES[num - 1];
    return waSend(phone, '📖 *' + s.title + '*\n\n' + s.content + '\n\n_' + s.genre + '_');
  }

  let storyText = '';
  try {
    const res = await fetch(EP.story + '/stories');
    if (res.ok) { const data = await res.json(); if (data.stories && data.stories.length > 0) { const s = data.stories[Math.floor(Math.random() * data.stories.length)]; storyText = '📖 *' + s.title + '*\n\n' + s.content + '\n\n_' + s.genre + '_'; } }
  } catch (e) {}

  if (!storyText) { const s = SAMPLE_STORIES[Math.floor(Math.random() * SAMPLE_STORIES.length)]; storyText = '📖 *' + s.title + '*\n\n' + s.content + '\n\n_' + s.genre + '_'; }
  await waSend(phone, storyText);
}

async function handleSearch(phone, text) {
  const query = text.replace(/^\/search\s*/i, '').trim();
  if (!query) return waSend(phone, 'Usage: /search <query>\nWeb search (Wikipedia).');
  try {
    const res = await fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(query) + '&format=json&origin=*');
    const data = await res.json();
    const results = (data.query?.search || []).slice(0, 5);
    if (!results.length) return waSend(phone, 'No Wikipedia results for: ' + query);
    const lines = ['🔍 *Wikipedia*: ' + query + '\n'];
    for (const r of results) {
      const title = r.title || 'Result';
      const snippet = (r.snippet || '').replace(/<[^>]+>/g, '').slice(0, 100);
      lines.push('📌 *' + title + '*\n' + snippet + '\n🔗 https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')) + '\n');
    }
    await waSend(phone, lines.join('\n'));
  } catch (e) { await waSend(phone, 'Search failed: ' + e.message); }
}

async function handleRemind(phone, text) {
  const raw = text.replace(/^\/remind\s*/i, '').trim();
  const spaceIdx = raw.search(/\s/);
  if (spaceIdx < 0) return waSend(phone, 'Usage: /remind <time> <text>\nExample: /remind 5m laundry');

  const timeStr = raw.slice(0, spaceIdx);
  const reminderText = raw.slice(spaceIdx + 1);
  const when = parseReminderTime(timeStr);
  if (!when) return waSend(phone, 'Could not parse time: ' + timeStr);
  if (when <= new Date()) return waSend(phone, 'Time must be in the future.');

  const reminders = loadReminders();
  reminders.push({ id: crypto.randomUUID(), phone, text: reminderText, timestamp: when.toISOString() });
  saveReminders(reminders);

  const diff = when - new Date();
  const mins = Math.round(diff / 60000);
  const msg = mins < 60 ? mins + ' min' : mins < 1440 ? Math.round(mins/60) + ' hr' : Math.round(mins/1440) + ' day';
  await waSend(phone, '⏰ Reminder set for ' + msg + ': ' + reminderText);

  setTimeout(async () => { await waSend(phone, '🔔 *Reminder:* ' + reminderText); }, diff);
}

async function checkReminders(phone) {
  const reminders = loadReminders();
  const now = Date.now();
  const due = reminders.filter(r => new Date(r.timestamp).getTime() <= now && r.phone === phone);
  const remaining = reminders.filter(r => !(new Date(r.timestamp).getTime() <= now && r.phone === phone));
  if (due.length > 0) saveReminders(remaining);
  for (const r of due) { await waSend(phone, '🔔 Reminder: ' + r.text); }
}

async function handleDrafts(phone) {
  let drafts = [];
  try { drafts = await getDraftsFromGCS(10); }
  catch (e) {
    return waSend(phone, '📝 *Content Queue*\n\n⚠️ Could not load drafts (database unavailable).\nCheck the GrowthOS dashboard for drafts:\n🌐 ' + EP.dashboard);
  }
  if (!drafts || !drafts.length) {
    return waSend(phone, '📝 *Content Queue*\n\n📭 No drafts found in the database.\n\nCheck the dashboard to create new drafts:\n🌐 ' + EP.dashboard);
  }

  const lines = ['📝 *Content Queue* (' + drafts.length + ' drafts)\n'];
  for (const d of drafts) {
    const icon = d.platform === 'linkedin' ? '🔗' : '🐦';
    const status = d.status === 'draft' ? '⬜' : d.status === 'reviewed' ? '👀' : d.status === 'approved' ? '✅' : d.status === 'posted' ? '📤' : '❌';
    const topic = d.topic || 'general';
    const preview = (d.draft_text || '').slice(0, 60).replace(/\n/g, ' ').replace(/[#*_]/g, '');
    const date = d.generated_at ? d.generated_at.slice(0, 10) : 'n/a';
    lines.push(icon + ' ' + status + ' *' + (d.platform?.toUpperCase() || '?') + '* | ' + topic);
    lines.push('   ' + preview + '...');
    lines.push('   ID:' + d.id + ' · ' + date);
    lines.push('');
  }
  
  await waSend(phone, lines.join('\n'));
  
  const firstDraft = drafts[0];
  if (firstDraft) {
    await waSendButton(phone,
      'Quick action on draft #' + firstDraft.id + ' ("' + (firstDraft.topic || 'general') + '"):',
      [
        { id: 'approve_' + firstDraft.id, text: '✅ Approve #' + firstDraft.id },
        { id: 'reject_' + firstDraft.id, text: '❌ Reject #' + firstDraft.id },
        { id: 'posted_' + firstDraft.id, text: '📤 Posted #' + firstDraft.id }
      ],
      'Draft #' + firstDraft.id
    );
  }
}

async function handleGrowthOS(phone, text) {
  const DASHBOARD = EP.dashboard;
  const mode = text.replace(/^\/growthos\s*/i, '').trim().toLowerCase();

  if (mode === 'digest') {
    return waSend(phone, '📊 *Growth OS Digest*\n\n🌐 Dashboard: ' + DASHBOARD + '\n\nCheck the dashboard for today\'s content digest.');
  }
  if (mode === 'status') {
    const checks = await Promise.all([checkEndpoint('vaultSearch'), checkEndpoint('story')]);
    const lines = checks.map(c => (c.ok ? '✅' : '❌') + ' ' + c.name);
    return waSend(phone, '🧠 *Growth OS Status*\n\n' + lines.join('\n') + '\n\n🌐 ' + DASHBOARD);
  }

  return waSend(phone,
    '🧠 *Growth OS*\n\n🌐 Dashboard: ' + DASHBOARD + '\n\n' +
    '📋 *Commands*\n/growthos - Open dashboard\n/growthos digest - Daily digest\n/growthos status - System status'
  );
}

async function handleTTS(phone, text) {
  const ttsText = text.replace(/^\/tts\s*/i, '').trim();
  if (!ttsText) return waSend(phone, '🗣️ *Text to Speech*\n\nUsage: /tts <text>\nConverts text to celebrity speech.\n\nExample: /tts Hello world');
  if (ttsText.length > 300) return waSend(phone, 'Text too long (max 300 chars).');
  try {
    const res = await fetch(EP.tts + '/synthesize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ttsText, celebrity: 'morgan_freeman', language: 'en' }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.audio_url) await waSend(phone, '🎤 TTS generated! Audio URL: ' + EP.tts + data.audio_url);
      else await waSend(phone, '🎤 TTS generated but no audio URL returned.');
    } else throw new Error('TTS endpoint error');
  } catch (e) { await waSend(phone, '🗣️ TTS unavailable: ' + e.message); }
}

async function handleAgent(phone, text) {
  const query = text.replace(/^\/(ask|agent)\s*/i, '').trim();
  if (!query) return waSend(phone, 'Usage: /ask <question>\nAI agent (keyword mode).');
  await waSend(phone, agentFallback(query));
}

// ═══════════════════════════════════════════════════════
//  MESSAGE ROUTER
// ═══════════════════════════════════════════════════════

async function handleIncomingMessage(senderPhone, senderName, messageText, chatIdOverride) {
  let text = (messageText || '').trim();
  text = text.replace(new RegExp('@' + BOT_PHONE + '\\s*', 'gi'), '').trim();
  text = text.replace(/@omniclaw\\s*/gi, '').trim();
  text = text.replace(/@\\d+\\s*/g, '').trim();

  const phone = chatIdOverride || senderPhone;
  const fromName = senderName || 'there';
  if (!text || !phone) return;

  console.log('📨 WA from ' + fromName + ' (' + phone + '): cleaned="' + text.slice(0, 60) + '"');

  if (!checkRate(phone)) return waSend(phone, '⏱ Please slow down! Max ' + MAX_PER_MINUTE + ' requests per minute.');

  // ─── Group admin check - block sensitive commands for non-admins in groups
  const isGroup = phone && phone.includes('@g.us');
  const blockedCommands = ['/drafts', '/growthos', '/remind', '/story', '/tts'];
  if (isGroup && !ADMIN_PHONES.includes(senderPhone)) {
    for (const cmd of blockedCommands) {
      if (text.startsWith(cmd)) {
        return waSend(phone, '⛔ Only the bot admin can use this in groups.');
      }
    }
  }

  // ─── Commands ──
  if (text === '/start') return handleStart(phone, fromName);
  if (text === '/help') return handleHelp(phone);
  if (text.startsWith('/status')) return handleStatus(phone);
  if (text.startsWith('/vault')) return handleVault(phone, text);
  if (text.startsWith('/sync')) return handleSync(phone);
  if (text.startsWith('/story')) return handleStory(phone, text);
  if (text.startsWith('/search')) return handleSearch(phone, text);
  if (text.startsWith('/remind')) return handleRemind(phone, text);
  if (text.startsWith('/drafts')) return handleDrafts(phone);
  if (text.startsWith('/growthos')) return handleGrowthOS(phone, text);
  if (text.startsWith('/ask') || text.startsWith('/agent')) return handleAgent(phone, text);
  if (text.startsWith('/tts')) return handleTTS(phone, text);

  // ─── Draft management ──
  const approveMatch = text.match(/^approve\s+(\d+)/i);
  const rejectMatch = text.match(/^reject\s+(\d+)/i);
  const postedMatch = text.match(/^posted\s+(\d+)/i);

  if (approveMatch) {
    const draftId = parseInt(approveMatch[1]);
    try { const ok = await updateDraftStatusGCS(draftId, 'approved'); await waSend(phone, ok ? '✅ Draft ' + draftId + ' approved! Post it and reply `posted ' + draftId + '`' : '❌ Could not approve draft ' + draftId); }
    catch (e) { await waSend(phone, '⚠️ Error approving draft ' + draftId); }
    return;
  }
  if (rejectMatch) {
    const draftId = parseInt(rejectMatch[1]);
    try { const ok = await updateDraftStatusGCS(draftId, 'rejected'); await waSend(phone, ok ? '❌ Draft ' + draftId + ' rejected.' : '❌ Could not reject draft ' + draftId); }
    catch (e) { await waSend(phone, '⚠️ Error rejecting draft ' + draftId); }
    return;
  }
  if (postedMatch) {
    const draftId = parseInt(postedMatch[1]);
    try { const ok = await updateDraftStatusGCS(draftId, 'posted'); await waSend(phone, ok ? '📤 Draft ' + draftId + ' marked as posted! 🎉' : '❌ Could not update draft ' + draftId); }
    catch (e) { await waSend(phone, '⚠️ Error marking draft ' + draftId); }
    return;
  }

  if (text.startsWith('/')) return;

  // ─── Free text → Greeting detection or vault search ──
  const lower = text.toLowerCase();
  if (/\b(hello|hi|hey|thanks|thank you|good morning|good night)\b/.test(lower)) {
    return waSend(phone, '👋 Hey! Use /vault <keyword> to search your vault. Try: /vault AI agents');
  }
  if (/\b(status|health)\b/.test(lower)) return handleStatus(phone);

  // ─── Auto vault search for any free text ──
  const now = Date.now();
  const userFreeText = freeTextCount.get(phone) || [];
  const recentFreeText = userFreeText.filter(t => now - t < 60000);
  if (recentFreeText.length >= FREE_TEXT_LIMIT) {
    return waSend(phone, '⏱ Please slow down! Use /vault <keyword> directly for faster results. (' + FREE_TEXT_LIMIT + ' free-text searches/min max)');
  }
  recentFreeText.push(now);
  freeTextCount.set(phone, recentFreeText);

  await waSend(phone, '🔍 Searching vault for: "' + text + '"...');
  await handleVault(phone, '/vault ' + text);
}

// ═══════════════════════════════════════════════════════
//  EXPRESS SETUP
// ═══════════════════════════════════════════════════════

const app = express();
app.use(express.json({ limit: '10mb' }));

// ═══════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════

app.get('/', (_req, res) => res.json({
  status: 'ok', service: 'omniclaw-whatsapp', instance: INSTANCE_ID, phone: BOT_PHONE,
  uptime: Math.floor(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
}));

app.get('/health', (_req, res) => res.json({ status: 'ok', instance: INSTANCE_ID }));

// Webhook endpoint for GreenAPI
app.post('/webhook', async (req, res) => {
  res.json({ ok: true });
  const body = req.body;
  if (body && body.typeWebhook === 'incomingMessageReceived') {
    const senderData = body.senderData || {};
    const sender = senderData.sender || '';
    const chatId = senderData.chatId || sender;
    const isGroup = chatId.includes('@g.us');
    const senderPhone = isGroup ? sender.replace('@c.us', '').replace('@s.whatsapp.net', '') : chatId.replace('@c.us', '').replace('@g.us', '');
    const senderName = senderData.senderName || senderData.chatName || 'there';
    const messageData = body.messageData || {};
    let messageText = '';
    if (messageData.textMessageData?.textMessage) messageText = messageData.textMessageData.textMessage;
    else if (messageData.extendedTextMessageData?.text) messageText = messageData.extendedTextMessageData.text;

    if (senderPhone && !senderPhone.includes(BOT_PHONE) && messageText) {
      const chatForResponse = isGroup ? chatId : null;
      enqueue(chatForResponse || senderPhone, () => handleIncomingMessage(senderPhone, senderName, messageText, chatForResponse))
        .catch(e => console.error('❌ Queue error: ' + e.message));
    }
  }
});

// Send endpoint - requires API key
app.post('/send', express.json(), async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== WA_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

  const result = await waSend(phone, message);
  enqueue(phone, () => handleIncomingMessage(phone, 'you', message)).catch(e => console.error('❌ send error:', e.message));

  res.json({ success: true, messageId: result?.idMessage });
});

// ═══════════════════════════════════════════════════════
//  BACKGROUND REMINDER CHECKER
// ═══════════════════════════════════════════════════════

setInterval(() => {
  try {
    const reminders = loadReminders();
    const now = Date.now();
    const due = reminders.filter(r => new Date(r.timestamp).getTime() <= now);
    const remaining = reminders.filter(r => new Date(r.timestamp).getTime() > now);
    if (due.length > 0) {
      saveReminders(remaining);
      due.forEach(r => waSend(r.phone, '🔔 *Reminder:* ' + r.text).catch(e => {}));
      console.log('⏰ Reminder check: ' + due.length + ' fired');
    }
  } catch(e) { console.error('❌ Reminder interval error:', e.message); }
}, 30000);

// ─── Free-text rate limiter cleanup ────────────────────
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [phone, times] of freeTextCount.entries()) {
    const recent = times.filter(t => t > cutoff);
    if (recent.length === 0) freeTextCount.delete(phone);
    else freeTextCount.set(phone, recent);
  }
}, 120000);

// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 OmniClaw WhatsApp Bot on port ' + PORT);
  console.log('📱 Instance: ' + INSTANCE_ID + ' | Phone: ' + BOT_PHONE);
  console.log('📡 Waiting for webhook messages from GreenAPI...');
});

console.log('⚡ WhatsApp Bot starting...');
