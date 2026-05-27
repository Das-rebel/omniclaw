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

// Load schedules from GCS at startup
setTimeout(async () => {
  try {
    const scheds = await gcsReadJSON('schedules/wa_schedules.json');
    if (scheds && Array.isArray(scheds) && scheds.length > 0) {
      fs.writeFileSync('/tmp/omniclaw_wa_schedules.json', JSON.stringify(scheds));
      console.log('☁️ Loaded ' + scheds.length + ' schedules from GCS');
    }
    const teams = await gcsReadJSON('schedules/wa_teams.json');
    if (teams && Array.isArray(teams) && teams.length > 0) {
      fs.writeFileSync('/tmp/omniclaw_wa_teams.json', JSON.stringify(teams));
      console.log('☁️ Loaded ' + teams.length + ' teams from GCS');
    }
  } catch (e) {
    console.error('❌ Schedule/team load error:', e.message);
  }
}, 5000);

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
function saveReminders(r) {
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(r));
  gcsWriteJSON('reminders/wa_reminders.json', r).catch(() => {});
}
setTimeout(async () => {
  const gcs = await gcsReadJSON('reminders/wa_reminders.json');
  if (gcs && Array.isArray(gcs) && gcs.length > 0) {
    saveReminders(gcs);
    console.log('☁️ Loaded ' + gcs.length + ' reminders from GCS');
  }
}, 3000);

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

// ─── Multi-turn Conversation Memory ────────────────────
const conversationMemory = new Map();
const MAX_HISTORY = 6;

function addToMemory(phone, role, content) {
  if (!conversationMemory.has(phone)) conversationMemory.set(phone, []);
  const hist = conversationMemory.get(phone);
  hist.push({ role, content, ts: Date.now() });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
}

function getMemoryContext(phone) {
  const hist = conversationMemory.get(phone) || [];
  return hist.map(h => (h.role === 'user' ? 'User: ' : 'Assistant: ') + h.content.slice(0, 200)).join('\n');
}

// ─── GCS Storage ───────────────────────────────────────
const GCS_BUCKET = 'growth-os-db-338789220059';
const GCS_BASE = 'https://storage.googleapis.com/' + GCS_BUCKET;

async function gcsFetch(method, path, body) {
  const isWrite = method === 'POST' || method === 'PUT';
  
  // Get auth token from metadata server (Cloud Run) or fallback to none
  let token = '';
  try {
    const tr = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
    if (tr.ok) {
      const t = await tr.json();
      token = t.access_token;
      console.log('🔑 Got token: ' + (token ? token.slice(0,10) + '...' : 'empty'));
    } else {
      console.error('❌ Metadata status: ' + tr.status);
    }
  } catch (e) {
    console.error('❌ Metadata err: ' + e.message);
  }
  
  // Use XML API for reads, simple PUT for writes
  const url = isWrite
    ? 'https://storage.googleapis.com/' + GCS_BUCKET + '/' + path
    : GCS_BASE + '/' + path;
  
  const opts = { method: isWrite ? 'PUT' : 'GET', headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  
  if (body !== undefined) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  
  const res = await fetch(url, opts);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('GCS ' + res.status + ': ' + errText.slice(0, 100));
  }
  return res;
}

async function gcsReadJSON(path) {
  try {
    const r = await gcsFetch('GET', path);
    return await r.json();
  } catch { return null; }
}

async function gcsWriteJSON(path, data) {
  try {
    await gcsFetch('POST', path, data);
    console.log('☁️ GCS written: ' + path);
    return true;
  } catch (e) {
    console.error('❌ GCS write error ' + path + ': ' + e.message);
    return false;
  }
}

// ─── Cross-Platform Context Sync ───────────────────────
async function syncContextToGCS(phone, history) {
  await gcsWriteJSON('context/' + phone.replace(/[^\w]/g, '_') + '.json', { phone, history, updated: new Date().toISOString() });
}

async function syncContextFromGCS(phone) {
  const data = await gcsReadJSON('context/' + phone.replace(/[^\w]/g, '_') + '.json');
  if (data && data.history) {
    const existing = conversationMemory.get(phone) || [];
    const merged = [...data.history, ...existing].sort((a,b) => (a.ts||0) - (b.ts||0)).slice(-MAX_HISTORY);
    conversationMemory.set(phone, merged);
  }
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
    '/digest <topic> - AI-generated vault digest\n' +
    '/prompts - Prompt tracker stats\n' +
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
      // Try combined keywords first
      const combined = keywords.join(' ');
      const altResult = await searchVault(combined);
      let altItems = altResult && altResult.results ? altResult.results : [];
      
      // If combined fails, try each keyword individually
      if (altItems.length === 0 && keywords.length > 1) {
        for (const kw of keywords) {
          const kwRes = await searchVault(kw);
          const kwItems = kwRes && kwRes.results ? kwRes.results : [];
          altItems.push(...kwItems);
        }
      }
      
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
    // If it looks like a question, route to AI even with no vault results
    const isQuestion = /^(find|suggest|recommend|what|how|why|best|ideas|give me|tell me|list|top|create|generate)(\s|$)/i.test(query);
    if (isQuestion) {
      return handleAgent(phone, '/ask ' + query);
    }
    const broadSuggestions = ['tools', 'AI', 'training', 'learning', 'resources', 'github', 'paper', 'course', 'startup']
      .filter(s => !query.toLowerCase().includes(s));
    const keywords = extractKeywords(query);
    if (keywords.length > 1) {
      return waSend(phone, '❌ No results for "' + query + '".\n\nTry a broader keyword:\n🔹 /vault ' + keywords.slice(0, 2).join('\n🔹 /vault '));
    }
    return waSend(phone, '❌ No results for "' + query + '".\n\nTry searching related topics:\n🔹 /vault ' + broadSuggestions.slice(0, 3).join('\n🔹 /vault '));
  }

  // ── Conversational question detection ──
  // Queries like "find best 10 ideas for omniclaw" → use LLM to synthesize vault results
  const isQuestion = /^(find|suggest|recommend|what|how|why|best|ideas|give me|tell me|list|top|create|generate)(\s|$)/i.test(query);
  
  // Filter out entity-only items (no URLs/content)
  const validItems = items.filter(item => (item.source || item.type) !== 'entity' && !!item.url);
  const entitySkipped = items.length - validItems.length;
  if (!validItems.length) {
    return waSend(phone, '❌ No content results for "' + query + '" (found ' + entitySkipped + ' entity names only).\nTry: /vault ' + query + ' tools');
  }
  items = validItems;
  
  // ── Conversational question: pass vault context to RAG handler ──
  if (isQuestion) {
    if (validItems.length > 0) {
      return handleAgentWithContext(phone, query, validItems);
    }
    // Question but no vault content - route to AI with empty context
    return handleAgent(phone, '/ask ' + query);
  }

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

// ─── #4: Vault Digest with Topic Clustering ────────────
// Searches vault, groups by topic, generates a curated post

async function handleDigest(phone, text) {
  const topic = text.replace(/^\/digest\s*/i, '').trim() || 'latest';
  await waSend(phone, '📖 Scanning vault for "' + topic.slice(0, 40) + '"...');
  
  try {
    // 1. Search vault for relevant content
    const result = await searchVault(topic);
    let items = (result && result.results || []).filter(i => (i.source || i.type) !== 'entity' && !!i.content);
    
    // 2. If few results, try broader search across topics
    if (items.length < 4) {
      const broad = await searchVault('interesting tools ai code project');
      const broadItems = (broad && broad.results || []).filter(i => (i.source || i.type) !== 'entity' && !!i.content);
      const seen = new Set(items.map(i => i.id || i.url));
      for (const bi of broadItems) {
        if (!seen.has(bi.id || bi.url)) { items.push(bi); seen.add(bi.id || bi.url); }
      }
    }
    
    if (!items.length) {
      return waSend(phone, '📭 No vault content found for "' + topic + '".');
    }
    
    // 3. Cluster items by topic for variety
    items = items.slice(0, 10);
    const topics = {};
    for (const item of items) {
      const t = item.topic || item.type || 'misc';
      if (!topics[t]) topics[t] = [];
      topics[t].push(item);
    }
    
    // Pick top items from each cluster
    const pick = [];
    for (const [t, clusterItems] of Object.entries(topics)) {
      pick.push(...clusterItems.slice(0, 3));
      if (pick.length >= 8) break;
    }
    const finalItems = pick.slice(0, 8);
    
    // 4. Build vault content summary
    const vaultContent = finalItems.map((item, i) => {
      const src = (item.source || item.type || '').replace('_', ' ');
      const content = (item.content || '').replace(/https?:\/\/\S+/g, '').slice(0, 250).replace(/\n/g, ' ').trim();
      return '[' + (i+1) + '] (' + src + ') ' + content;
    }).join('\n\n');
    
    // 5. Build topic summary
    const topicLines = Object.entries(topics).map(([t, c]) => t + ': ' + c.length + ' items').join(' · ');
    
    // 6. Generate digest via NVIDIA
    const systemMsg = 'You are a content curator. Given a set of vault bookmarks, generate a social media post (LinkedIn/Twitter style) that synthesizes the key insights. Start with a hook. Use **bold** for emphasis. Under 2000 chars. Do not mention the vault.';
    const userMsg = 'Topic: "' + topic + '"\n\n' + vaultContent + '\n\nWrite a digest post synthesizing the most interesting insights.';
    
    const answer = await callNvidia(systemMsg, topic, userMsg, 45000) || await callGroq(systemMsg, topic, userMsg, 25000);
    
    if (answer) {
      await waSend(phone, '📝 *Digest: ' + topic.slice(0, 30) + '*\n\n' + answer.slice(0, 3500));
      await waSend(phone, '📊 ' + finalItems.length + ' bookmarks from ' + Object.keys(topics).length + ' topics: ' + topicLines);
    } else {
      await waSend(phone, 'Could not generate digest right now.');
    }
  } catch (e) {
    console.error('❌ Digest error:', e.message);
    await waSend(phone, 'Digest failed. Try again later.');
  }
}

// ─── #4b: Unified Multi-Source Query (Gooseworks) ────
async function aggregateSources(topic) {
  console.log('🌐 Aggregating sources for: ' + topic);
  const encoded = encodeURIComponent(topic);
  const sources = [
    { name: 'Vault', url: EP.vaultSearch + '/search?q=' + encoded + '&limit=5', icon: '📚' },
    { name: 'Twitter', url: EP.twitterSync + '/search?q=' + encoded + '&limit=3', icon: '🐦' },
    { name: 'Instagram', url: EP.instagram + '/search?q=' + encoded + '&limit=3', icon: '📷' },
    { name: 'Bookmarks', url: EP.bookmarks + '/search?q=' + encoded + '&limit=3', icon: '🔖' }
  ];
  const settled = await Promise.allSettled(sources.map(s => httpGet(s.url, 8000)));
  const seen = new Set();
  return sources.map((s, i) => {
    const items = (settled[i].status === 'fulfilled' && settled[i].value?.results) ? settled[i].value.results : [];
    const deduped = items.filter((it) => {
      const key = it.url || it.id || '';
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...s, items: deduped.slice(0, 3), count: deduped.length };
  });
}

async function handleMulti(phone, text) {
  const topic = text.replace(/^\/multi\s*/i, '').trim();
  if (!topic) return waSend(phone, 'Usage: /multi <topic>\n\nSearches vault, Twitter, Instagram, and bookmarks at once.');
  await waSend(phone, '🌐 Searching all sources for "' + topic.slice(0, 40) + '"...');
  try {
    const sources = await aggregateSources(topic);
    let msg = '🌐 *Multi-Source Results: ' + topic + '*\n';
    let total = 0;
    for (const s of sources) {
      if (s.count > 0) {
        msg += '\n' + s.icon + ' *' + s.name + '* (' + s.count + ')';
        for (const it of s.items) {
          const title = (it.name || it.content || '').slice(0, 80).replace(/\n/g, ' ');
          msg += '\n• ' + title + (it.url ? '\n  ' + it.url : '');
        }
        total += s.count;
      }
    }
    if (total === 0) msg += '\n\nNo results found in any source.';
    else msg += '\n\n_' + total + ' total items across ' + sources.filter(s => s.count > 0).length + ' sources._';
    await waSend(phone, msg.slice(0, 4000));
  } catch (e) {
    await waSend(phone, '❌ Multi-source search failed: ' + e.message.slice(0, 80));
  }
}

// ─── #9: Self-Modifying Prompt System ─────────────────
// Stores prompt versions in GCS, auto-adjusts based on quality
const PROMPT_VERSION = 4;
let promptConfig = { version: PROMPT_VERSION, temperature: 0.5, maxTokens: 2000, style: 'direct', good: 0, bad: 0, failurePatterns: [], topicStats: {} };

async function loadPromptConfig() {
  const gcs = await gcsReadJSON('prompts/config_v' + PROMPT_VERSION + '.json');
  if (gcs && gcs.version) {
    promptConfig = { ...promptConfig, ...gcs };
    console.log('📋 Loaded prompt config v' + PROMPT_VERSION + ' (temp=' + promptConfig.temperature + ', style=' + promptConfig.style + ')');
  }
}
loadPromptConfig();

async function savePromptConfig() {
  promptConfig.updated = new Date().toISOString();
  await gcsWriteJSON('prompts/config_v' + PROMPT_VERSION + '.json', promptConfig);
}

async function trackPromptQuality(phone, query, answerGiven, userReplied) {
  if (userReplied === true) promptConfig.good++;
  else if (answerGiven === false) promptConfig.bad++;
  
  // ── Failure pattern tracking ──
  const isFailure = answerGiven === false || userReplied === false;
  if (isFailure && query) {
    const topic = (query.split(' ').slice(0, 3).join(' ') || 'general').slice(0, 40);
    const issue = answerGiven === false ? 'no_answer' : 'no_reply';
    promptConfig.failurePatterns.push({ query: query.slice(0, 80), topic, issue, timestamp: new Date().toISOString() });
    if (promptConfig.failurePatterns.length > 100) promptConfig.failurePatterns = promptConfig.failurePatterns.slice(-100);
    
    if (!promptConfig.topicStats[topic]) promptConfig.topicStats[topic] = { good: 0, bad: 0 };
    promptConfig.topicStats[topic].bad++;
  } else if (query) {
    const topic = (query.split(' ').slice(0, 3).join(' ') || 'general').slice(0, 40);
    if (!promptConfig.topicStats[topic]) promptConfig.topicStats[topic] = { good: 0, bad: 0 };
    promptConfig.topicStats[topic].good++;
  }
  
  const total = promptConfig.good + promptConfig.bad;
  if (total >= 5) {
    const rate = promptConfig.good / total;
    console.log('📊 Prompt quality: ' + (rate * 100).toFixed(0) + '% (' + promptConfig.good + '/' + total + '), failures: ' + promptConfig.failurePatterns.length);
    
    // Auto-adjust: if quality < 50%, tweak temperature
    if (rate < 0.5 && promptConfig.temperature > 0.3) {
      promptConfig.temperature = Math.max(0.2, promptConfig.temperature - 0.1);
      promptConfig.style = 'precise';
      promptConfig.good = 0; promptConfig.bad = 0;
      await savePromptConfig();
      console.log('📋 Auto-adjusted prompt: temp=' + promptConfig.temperature + ', style=' + promptConfig.style);
    }
  }
  
  // Persist every 3 calls
  if (total % 3 === 0) await savePromptConfig();
}

async function handlePromptStats(phone) {
  const total = promptConfig.good + promptConfig.bad;
  const rate = total > 0 ? (promptConfig.good / total * 100).toFixed(0) + '%' : 'N/A';
  
  // Build failure patterns summary
  let failureSummary = '';
  if (promptConfig.failurePatterns.length > 0) {
    const grouped = {};
    for (const fp of promptConfig.failurePatterns) {
      const key = fp.issue + ':' + fp.topic;
      grouped[key] = (grouped[key] || 0) + 1;
    }
    const topFailures = Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, 5);
    failureSummary = '\n\n⚠️ *Failure Patterns* (' + promptConfig.failurePatterns.length + ' total)\n';
    for (const [key, count] of topFailures) {
      const [issue, topic] = key.split(':');
      failureSummary += '• "' + topic + '" → ' + issue + ' (' + count + 'x)\n';
    }
  }
  
  // Build topic stats summary
  let topicSummary = '';
  const topics = Object.entries(promptConfig.topicStats || {}).sort((a, b) => (b[1].good + b[1].bad) - (a[1].good + a[1].bad)).slice(0, 8);
  if (topics.length > 0) {
    topicSummary = '\n\n📈 *By Topic*\n';
    for (const [t, s] of topics) {
      const tRate = (s.good + s.bad) > 0 ? (s.good / (s.good + s.bad) * 100).toFixed(0) + '%' : 'N/A';
      const warn = (s.good + s.bad) >= 3 && (s.good / (s.good + s.bad)) < 0.5 ? ' ⚠️' : '';
      topicSummary += '• ' + t.slice(0, 25) + ': ✅ ' + s.good + ' ❌ ' + s.bad + ' (' + tRate + ')' + warn + '\n';
    }
  }
  
  await waSend(phone, '📊 *Prompt Config v' + PROMPT_VERSION + '*\n' +
    '🌡️ Temperature: ' + promptConfig.temperature + '\n' +
    '🎨 Style: ' + promptConfig.style + '\n' +
    '✅ Good: ' + promptConfig.good + '\n' +
    '❌ Bad: ' + promptConfig.bad + '\n' +
    '📈 Success rate: ' + rate +
    failureSummary + topicSummary +
    '📈 Rate: ' + rate + '\n' +
    '🔄 Auto-adjust: ' + (total >= 5 ? 'active' : 'needs ' + (5 - total) + ' more'));
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
  
  // Also check schedules
  try {
    const scheds = JSON.parse(fs.readFileSync('/tmp/omniclaw_wa_schedules.json', 'utf8') || '[]');
    for (const s of scheds) {
      if (!s.enabled || s.phone !== phone) continue;
      const nowDate = new Date();
      const nextRun = s.nextRun ? new Date(s.nextRun) : null;
      if (!nextRun || nextRun <= nowDate) {
        console.log('⏰ Running scheduled: ' + s.task + ' - ' + (s.params?.topic || ''));
        if (s.task === 'digest' && s.params?.topic) {
          // Don't await — fire and forget
          handleDigest(phone, '/digest ' + s.params.topic).catch(e => console.error('❌ Schedule digest failed:', e.message));
        } else if (s.task === 'ask' && s.params?.query) {
          handleAgent(phone, '/ask ' + s.params.query).catch(e => console.error('❌ Schedule ask failed:', e.message));
        }
        // Update next run
        if (s.interval === 'daily') {
          const next = new Date(nowDate);
          next.setDate(next.getDate() + 1);
          next.setHours(parseInt(s.time?.split(':')[0] || 9), parseInt(s.time?.split(':')[1] || 0), 0, 0);
          s.nextRun = next.toISOString();
          s.lastRun = nowDate.toISOString();
        }
      }
    }
    fs.writeFileSync('/tmp/omniclaw_wa_schedules.json', JSON.stringify(scheds));
  } catch { /* schedule check is best-effort */ }
}

// ─── Cabinet: Scheduled Agent Tasks ───────────────────
async function handleSchedule(phone, text) {
  const parts = text.replace(/^\/schedule\s*/i, '').trim().split(/\s+/);
  const action = parts[0]?.toLowerCase();
  
  if (!action) return waSend(phone, '📅 *Schedule Commands*\n/schedule list - Show all schedules\n/schedule add <interval> <task> - Add schedule (e.g. "daily 9am digest AI agents")\n/schedule remove <id> - Remove schedule\n/schedule run <id> - Run schedule now');
  
  try {
    let scheds = [];
    try { scheds = JSON.parse(fs.readFileSync('/tmp/omniclaw_wa_schedules.json', 'utf8') || '[]'); } catch {}
    
    if (action === 'list') {
      if (scheds.length === 0) return waSend(phone, '📅 No schedules set. Use `/schedule add` to create one.');
      let msg = '📅 *Schedules* (' + scheds.length + ')\n';
      for (const s of scheds) {
        const icon = s.enabled ? '🟢' : '🔴';
        const next = s.nextRun ? new Date(s.nextRun).toLocaleString('en-IN') : '—';
        msg += '\n' + icon + ' *' + s.id.slice(0, 6) + '* — ' + s.task + ' ' + (s.params?.topic || '') + '\n   Next: ' + next;
      }
      return waSend(phone, msg.slice(0, 4000));
    }
    
    if (action === 'add') {
      const rest = parts.slice(1).join(' ');
      const intervalMatch = rest.match(/^(daily|hourly|weekly)\s+(\d{1,2})(?::(\d{2}))?\s*/i);
      if (!intervalMatch) return waSend(phone, 'Usage: /schedule add daily 9am "digest AI agents"');
      const interval = intervalMatch[1].toLowerCase();
      const hour = parseInt(intervalMatch[2]);
      const min = parseInt(intervalMatch[3] || '0');
      const taskStr = rest.replace(intervalMatch[0], '').replace(/^["']|["']$/g, '').trim();
      const taskMatch = taskStr.match(/^(digest|ask)\s+(.+)/i);
      if (!taskMatch) return waSend(phone, 'Task must start with "digest" or "ask": /schedule add daily 9am "digest AI agents"');
      const task = taskMatch[1].toLowerCase();
      const params = task === 'digest' ? { topic: taskMatch[2] } : { query: taskMatch[2] };
      const now = new Date();
      const next = new Date(now);
      next.setHours(hour, min, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      const id = crypto.randomUUID().slice(0, 8);
      scheds.push({ id, phone, interval, time: hour + ':' + String(min).padStart(2, '0'), task, params, nextRun: next.toISOString(), lastRun: null, enabled: true });
      fs.writeFileSync('/tmp/omniclaw_wa_schedules.json', JSON.stringify(scheds));
      gcsWriteJSON('schedules/wa_schedules.json', scheds).catch(() => {});
      return waSend(phone, '✅ Schedule set: ' + interval + ' at ' + hour + ':' + String(min).padStart(2, '0') + ' — ' + task + ' ' + (params.topic || params.query));
    }
    
    if (action === 'remove' && parts[1]) {
      const before = scheds.length;
      scheds = scheds.filter(s => s.id !== parts[1]);
      if (scheds.length === before) return waSend(phone, '❌ Schedule not found: ' + parts[1]);
      fs.writeFileSync('/tmp/omniclaw_wa_schedules.json', JSON.stringify(scheds));
      gcsWriteJSON('schedules/wa_schedules.json', scheds).catch(() => {});
      return waSend(phone, '🗑️ Removed schedule: ' + parts[1]);
    }
    
    if (action === 'run' && parts[1]) {
      const s = scheds.find(x => x.id === parts[1]);
      if (!s) return waSend(phone, '❌ Schedule not found: ' + parts[1]);
      s.lastRun = new Date().toISOString();
      fs.writeFileSync('/tmp/omniclaw_wa_schedules.json', JSON.stringify(scheds));
      if (s.task === 'digest') return handleDigest(phone, '/digest ' + (s.params?.topic || ''));
      if (s.task === 'ask') return handleAgent(phone, '/ask ' + (s.params?.query || ''));
      return waSend(phone, '❌ Unknown task: ' + s.task);
    }
    
    return waSend(phone, 'Unknown action: ' + action + '. Try: list, add, remove, run');
  } catch (e) {
    return waSend(phone, '❌ Schedule error: ' + e.message.slice(0, 100));
  }
}

// ─── Cabinet: Agent Teams ──────────────────────────────
const TEAMS_FILE = '/tmp/omniclaw_wa_teams.json';

async function handleTeam(phone, text) {
  const parts = text.replace(/^\/team\s*/i, '').trim().split(/\s+/);
  const action = parts[0]?.toLowerCase();
  
  if (!action) return waSend(phone, '👥 *Team Commands*\n/team create <name> - Create a team\n/team list - List teams\n/team run <name> <goal> - Run a team on a goal');
  
  try {
    let teams = [];
    try { teams = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8') || '[]'); } catch {}
    
    if (action === 'create') {
      const name = parts.slice(1).join(' ');
      if (!name) return waSend(phone, 'Usage: /team create <team name>');
      teams.push({
        id: crypto.randomUUID().slice(0, 8),
        name,
        phone,
        agents: [
          { role: 'researcher', prompt: 'Search vault and sources for relevant information about the goal' },
          { role: 'analyst', prompt: 'Analyze the research findings and identify key patterns and insights' },
          { role: 'writer', prompt: 'Write a concise summary synthesizing the analysis into actionable insights' }
        ],
        created: new Date().toISOString()
      });
      fs.writeFileSync(TEAMS_FILE, JSON.stringify(teams));
      gcsWriteJSON('schedules/wa_teams.json', teams).catch(() => {});
      return waSend(phone, '✅ Team "' + name + '" created with 3 agents: researcher → analyst → writer');
    }
    
    if (action === 'list') {
      if (teams.length === 0) return waSend(phone, '👥 No teams. Use `/team create <name>` to create one.');
      let msg = '👥 *Teams*\n';
      for (const t of teams) {
        msg += '\n• *' + t.name + '* (' + t.agents.length + ' agents: ' + t.agents.map((a) => a.role).join(' → ') + ')';
      }
      return waSend(phone, msg.slice(0, 4000));
    }
    
    if (action === 'run') {
      const teamName = parts.slice(1, parts.indexOf('run') > 1 ? parts.indexOf('run') + 1 : undefined).join(' ');
      // Actually use everything after the team name as the goal
      const goalStart = text.indexOf(action + ' run ') + (action + ' run ').length;
      const afterCmd = text.slice(goalStart).trim();
      const spaceIdx = afterCmd.search(/\s/);
      const name = spaceIdx > 0 ? afterCmd.slice(0, spaceIdx).trim() : afterCmd.trim();
      const goal = spaceIdx > 0 ? afterCmd.slice(spaceIdx + 1).trim() : '';
      
      const team = teams.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (!team) return waSend(phone, '❌ Team "' + name + '" not found. Use /team list to see teams.');
      if (!goal) return waSend(phone, 'Usage: /team run <name> <goal>\nExample: /team run research "find latest AI agent frameworks"');
      
      await waSend(phone, '👥 Running team "' + team.name + '" on: ' + goal);
      let pipeline = '';
      let prevOutput = '';
      for (const agent of team.agents) {
        await waSend(phone, '⚙️ ' + agent.role + ' working...');
        const agentPrompt = 'You are a ' + agent.role + ' agent in the OmniClaw team. Goal: ' + goal + '.\n\n' + agent.prompt + '.\n\nPrevious output:\n' + (prevOutput || '(first agent)') + '.\n\nProvide your analysis.';
        const result = await callNvidia(agentPrompt, '', '', 30000) || await callGroq(agentPrompt, '', '', 25000) || '(agent output unavailable)';
        prevOutput = result;
        pipeline += '\n\n*' + agent.role + '*\n' + result.slice(0, 500);
      }
      await waSend(phone, '✅ *Team "' + team.name + '" Results*\n' + pipeline.slice(0, 4000));
      return;
    }
    
    return waSend(phone, 'Unknown action: ' + action + '. Try: create, list, run');
  } catch (e) {
    return waSend(phone, '❌ Team error: ' + e.message.slice(0, 100));
  }
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

async function callNvidia(systemMsg, query, vaultContext, timeoutMs) {
  const NV_API = process.env.NV_API_KEY || '';
  if (!NV_API) {
    console.error('❌ NV_API_KEY not set');
    return null;
  }
  
  const timeout = timeoutMs || 45000;
  console.log('🔵 Fetching NVIDIA (timeout=' + timeout + 'ms)...');
  let res;
  try {
    res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + NV_API },
      body: JSON.stringify({
        model: 'meta/llama-3.3-70b-instruct',
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: vaultContext + '\n\nQuestion: ' + query }
        ],
        max_tokens: 2000,
        temperature: promptConfig.temperature || 0.5
      }),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (e) {
    console.error('❌ NVIDIA fetch error (' + timeout + 'ms):', e.message);
    return null;
  }
  
  console.log('🔵 NVIDIA status:', res.status);
  if (!res.ok) {
    const errText = await res.text();
    console.error('❌ NVIDIA HTTP ' + res.status + ':', errText.slice(0, 100));
    return null;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || null;
  console.log('🔵 NVIDIA content length:', content ? content.length : 0);
  return content;
}

async function callGroq(systemMsg, query, vaultContext, timeoutMs) {
  const GROQ_API = process.env.GROQ_API_KEY || '';
  if (!GROQ_API) {
    console.error('❌ GROQ_API_KEY not set');
    return null;
  }
  
  const timeout = timeoutMs || 25000;
  console.log('🟡 Fetching Groq (timeout=' + timeout + 'ms)...');
  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_API },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: vaultContext + '\n\nQuestion: ' + query }
        ],
        max_tokens: 2000,
        temperature: 0.5
      }),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (e) {
    console.error('❌ Groq fetch error (' + timeout + 'ms):', e.message);
    return null;
  }
  
  console.log('🟡 Groq status:', res.status);
  if (!res.ok) {
    const errText = await res.text();
    console.error('❌ Groq HTTP ' + res.status + ':', errText.slice(0, 100));
    return null;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || null;
  console.log('🟡 Groq content length:', content ? content.length : 0);
  return content;
}

// ─── #3a: Parallel Multi-LLM Ensemble ─────────────────
async function callMultipleLLMs(systemMsg, query, vaultContext) {
  console.log('🤖 Running ensemble (NVIDIA + Groq in parallel)...');
  const [nv, gr] = await Promise.allSettled([
    callNvidia(systemMsg, query, vaultContext, 30000),
    callGroq(systemMsg, query, vaultContext, 25000)
  ]);
  const nvidia = nv.status === 'fulfilled' ? nv.value : null;
  const groq = gr.status === 'fulfilled' ? gr.value : null;
  return { nvidia, groq };
}

function mergeResults(results) {
  const { nvidia, groq } = results;
  if (!nvidia && !groq) return { best: null, from: 'none' };
  if (!nvidia) return { best: groq, from: 'Groq' };
  if (!groq) return { best: nvidia, from: 'NVIDIA' };
  // Pick the longer/more detailed response
  if (nvidia.length >= groq.length) return { best: nvidia, from: 'NVIDIA' };
  return { best: groq, from: 'Groq' };
}

async function handleEnsemble(phone, text) {
  const query = text.replace(/^\/ensemble\s*/i, '').trim();
  if (!query) return waSend(phone, 'Usage: /ensemble <question>\n\nRuns NVIDIA + Groq in parallel and picks the best answer.');
  await waSend(phone, '🤖 Running ensemble for: "' + query.slice(0, 60) + '"...');
  const results = await callMultipleLLMs('You are OmniClaw AI. Answer directly and specifically.', query, '');
  const { best, from } = mergeResults(results);
  if (!best) return waSend(phone, '❌ Both models failed. Try again later.');
  const other = from === 'NVIDIA' ? 'Groq' : 'NVIDIA';
  await waSend(phone, '🤖 *Ensemble Answer*\n\n' + best.slice(0, 3500) + '\n\n_ℹ️ Picked from ' + from + ' (also checked ' + other + ')_');
}

// ─── #3: Hyperagent Multi-Model Router ─────────────────
// Routes queries to optimal model + prompt based on type
const ROUTE_PROFILES = {
  fast: { model: 'nvidia', timeout: 15000, temp: 0.3, desc: 'simple query (fast)' },
  creative: { model: 'nvidia', timeout: 45000, temp: 0.7, desc: 'creative task' },
  deep: { model: 'nvidia', timeout: 45000, temp: 0.5, desc: 'deep analysis' },
  code: { model: 'nvidia', timeout: 45000, temp: 0.3, desc: 'code/technical' }
};

const ROUTE_PATTERNS = [
  { rx: /\b(debug|error|bug|fix|issue|exception|crash|fail|broken)\b/i, route: 'code' },
  { rx: /\b(code|function|api|endpoint|syntax|npm|import|require|class|implement)\b/i, route: 'code' },
  { rx: /\b(story|write|create|generate|poem|tweet|post|article|content|draft|digest|compose)\b/i, route: 'creative' },
  { rx: /\b(architecture|design|pattern|database|cache|queue|latency|throughput|scal|deploy|infra|optimize|refactor)\b/i, route: 'deep' },
  { rx: /\b(compare|analyze|evaluate|difference|pros|cons|tradeoff|vs\b)/i, route: 'deep' },
];

function hyperagentRoute(query) {
  const length = query.split(' ').length;
  for (const p of ROUTE_PATTERNS) {
    if (p.rx.test(query)) return ROUTE_PROFILES[p.route];
  }
  if (length > 20) return ROUTE_PROFILES.deep;
  return ROUTE_PROFILES.fast;
}

async function askLLM(systemMsg, query, vaultContext) {
  const route = hyperagentRoute(query);
  
  // Build route-specific system message
  let routedMsg = systemMsg;
  if (route.temp === 0.7) routedMsg = systemMsg + ' Be creative and engaging.';
  else if (route.temp === 0.3) routedMsg = systemMsg + ' Be precise, factual, and specific.';
  
  console.log('🔀 Hyperagent: ' + route.desc + ' (timeout=' + route.timeout + 'ms, temp=' + route.temp + ')');
  
  const nvidiaResult = await callNvidia(routedMsg, query, vaultContext, route.timeout);
  if (nvidiaResult) return nvidiaResult;
  
  return await callGroq(systemMsg, query, vaultContext, 25000);
}

async function buildVaultContext(items) {
  const validItems = items.filter(item => (item.source || item.type) !== 'entity' && !!item.content);
  if (!validItems.length) return '(No relevant bookmarks found in vault.)';
  
  return validItems.slice(0, 8).map((item, i) => {
    const src = (item.source || item.type || '').replace('_', ' ');
    const content = (item.content || '').replace(/https?:\/\/\S+/g, '').slice(0, 300).replace(/\n/g, ' ').trim();
    const url = item.url || '';
    return '[' + (i+1) + '] ' + content + '\n   URL: ' + url + '\n   Source: ' + src;
  }).join('\n\n');
}

// Decide whether query needs vault or pure AI knowledge
function shouldUseVault(query) {
  // Questions about OmniClaw itself -> skip vault (vault has no OmniClaw-specific content)
  const omniclawSelfRef = /\b(omniclaw|my project|the bot|how can we|how do i|our project|this project)\b/i.test(query);
  if (omniclawSelfRef) return false;
  
  // Pure conversational questions -> skip vault
  const pureQuestion = /^(what|how|why|can you|tell me|explain|describe|write|create|generate|give me)\b/i.test(query);
  if (pureQuestion && query.split(' ').length <= 6) return false;
  
  // Everything else -> try vault
  return true;
}

async function handleAgent(phone, text) {
  const query = text.replace(/^\/(ask|agent)\s*/i, '').trim();
  if (!query) return waSend(phone, 'Usage: /ask <question>\n\nI generate AI-powered answers with optional vault context.');
  
  // Step 1: Load cross-platform context
  await syncContextFromGCS(phone);
  
  // Step 2: Detect if vault is relevant
  let vaultContext = '';
  let useVault = shouldUseVault(query);
  
  if (useVault) {
    await waSend(phone, '🔍 Searching vault: "' + query.slice(0, 60) + '"...');
    try {
      const result = await searchVault(query);
      const items = result && result.results ? result.results : [];
      const relevant = items.filter(i => (i.source || i.type) !== 'entity' && !!i.content);
      if (relevant.length > 0) {
        vaultContext = await buildVaultContext(relevant);
        const count = vaultContext.match(/\[\d+\]/g)?.length || 0;
        if (count > 0) await waSend(phone, '📚 Found ' + count + ' bookmarks as context.');
      }
    } catch (e) { console.error('❌ Vault search error:', e.message); }
  }
  
  if (!vaultContext) vaultContext = '(No vault context - answering from AI knowledge.)';
  
  // Step 3: Build system prompt with conversation memory
  const hasVaultContent = vaultContext.includes('[');
  const convContext = getMemoryContext(phone);
  const systemMsg = hasVaultContent
    ? "You are OmniClaw AI. The vault bookmarks below ARE relevant. For each bookmark you reference, include its source URL on a new line. Format: [N] idea...\\n🔗 <url>. Use **bold** for emphasis."
    : "You are OmniClaw AI - direct, specific. OmniClaw ALREADY has: Telegram bot, WhatsApp bot, Alexa skill, web dashboard, LLM integration, FAISS vault search, persistent memory, TTS, story generation, Growth OS dashboards, TreeQuest multi-agent ensemble, autonomous research loops, social ingestion, Redis, GCS. All on Cloud Run.\\n\\nDo NOT suggest things it already has. Suggest what it does NOT have yet. Format: numbered list with **bold title** + 1 sentence. Direct, no fluff.";
  
  const userMsg = (convContext ? 'Recent conversation:\n' + convContext + '\n\n' : '') + vaultContext;
  
  // Step 4: Call LLM with memory
  console.log('🤖 Asking LLM (vault=' + hasVaultContent + ', memory=' + !!convContext + ')...');
  try {
    const answer = await askLLM(systemMsg, query, userMsg);
    if (answer) {
      await waSend(phone, '🤖 *Answer*\n\n' + answer.slice(0, 3500));
      addToMemory(phone, 'user', query);
      addToMemory(phone, 'assistant', answer.slice(0, 500));
      syncContextToGCS(phone, conversationMemory.get(phone) || []);
      trackPromptQuality(phone, query, true, false);
      console.log('📨 Answer sent (NVIDIA)');
    } else {
      trackPromptQuality(phone, query, false, false);
      await waSend(phone, '🤖 Could not generate answer. Try rephrasing.');
    }
  } catch (e) {
    console.error('❌ LLM error:', e.message);
    await waSend(phone, '🤖 Could not generate answer right now.');
  }
}

// Check if vault items are semantically relevant to the query
function isVaultRelevant(query, items) {
  if (!items || items.length === 0) return false;
  // Extract meaningful topic keywords (skip stop words + generic verbs/nouns)
  const skip = ['this','that','with','from','have','been','more','what','how','why','find','best','make','our','can','the','and','for','are','not','ideas','better','out','get','some','them','their','about','than','into','over','also','just','like','very','much','will','your','some','thing'];
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !skip.includes(w));
  if (queryWords.length === 0) return false; // No meaningful keywords = not relevant
  
  // Check if any item content contains query keywords
  const itemText = items.map(i => ((i.content || '') + ' ' + (i.name || '')).toLowerCase()).join(' ');
  const matchCount = queryWords.filter(w => itemText.includes(w)).length;
  const relevance = matchCount / queryWords.length;
  console.log('🔍 Vault relevance: ' + (relevance * 100).toFixed(0) + '% (' + matchCount + '/' + queryWords.length + ' keywords: ' + queryWords.join(',') + ')');
  return relevance >= 0.5; // Need 50%+ keyword overlap to be relevant
}

async function handleAgentWithContext(phone, query, vaultItems) {
  const vaultRelevant = isVaultRelevant(query, vaultItems);
  const vaultContext = await buildVaultContext(vaultItems);
  const count = vaultContext.match(/\[\d+\]/g)?.length || 0;
  
  const hasVaultContent = vaultRelevant && count > 0;
  
  if (hasVaultContent) {
    await waSend(phone, '📚 Found ' + count + ' relevant vault bookmarks. Generating answer...');
  }
  
  await syncContextFromGCS(phone);
  const convContext = getMemoryContext(phone);
  const userMsg = (convContext ? 'Recent conversation:\n' + convContext + '\n\n' : '') + vaultContext;
  
  const systemMsg = hasVaultContent
    ? "You are OmniClaw AI. The vault bookmarks below ARE relevant. For each bookmark you reference, include its source URL on its own line. Format: [N] idea...\\n🔗 <url>. Use **bold** for emphasis."
    : "You are OmniClaw AI - direct, specific. OmniClaw ALREADY has: Telegram bot, WhatsApp bot, Alexa skill, web dashboard, LLM integration, FAISS vault search, persistent memory, TTS, story generation, Growth OS dashboards, TreeQuest multi-agent ensemble, autonomous research loops, social ingestion, Redis, GCS. All on Cloud Run.\\n\\nDo NOT suggest things it already has. Suggest what it does NOT have yet. Format: numbered list with **bold title** + 1 sentence. Direct, no fluff.";
  
  console.log('🤖 Asking LLM (vault=' + hasVaultContent + ', memory=' + !!convContext + ')...');
  try {
    const answer = await askLLM(systemMsg, query, userMsg);
    if (answer) {
      await waSend(phone, '🤖 *Answer*\n\n' + answer.slice(0, 3500));
      addToMemory(phone, 'user', query);
      addToMemory(phone, 'assistant', answer.slice(0, 500));
      syncContextToGCS(phone, conversationMemory.get(phone) || []);
      trackPromptQuality(phone, query, true, false);
    } else {
      trackPromptQuality(phone, query, false, false);
      await waSend(phone, 'Could not generate answer right now.');
    }
  } catch (e) {
    console.error('❌ LLM error:', e.message);
    await waSend(phone, '⚠️ AI temporarily unavailable.');
  }
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
  if (text.startsWith('/digest')) return handleDigest(phone, text);
  if (text.startsWith('/prompts')) return handlePromptStats(phone);
  if (text.startsWith('/ask') || text.startsWith('/agent')) return handleAgent(phone, text);
  if (text.startsWith('/tts')) return handleTTS(phone, text);
  if (text.startsWith('/multi')) return handleMulti(phone, text);
  if (text.startsWith('/ensemble')) return handleEnsemble(phone, text);
  if (text.startsWith('/schedule')) return handleSchedule(phone, text);
  if (text.startsWith('/team')) return handleTeam(phone, text);

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
  // Store user message in multi-turn memory
  addToMemory(phone, 'user', text);

  const lower = text.toLowerCase();
  if (/\b(hello|hi|hey|thanks|thank you|good morning|good night)\b/.test(lower)) {
    return waSend(phone, "\U0001f44b Hey! Use /vault <keyword> to search your vault. Try: /vault AI agents");
  }
  if (/\b(status|health)\b/.test(lower)) return handleStatus(phone);

  // Smart free text routing: question -> AI, search -> vault
  const isQuestion = /^(what |how |why |can you|tell me|explain|describe|write |create|generate|give me|find |suggest|recommend|best |ideas|list |top )/i.test(text);
  
  const now = Date.now();
  const userFreeText = freeTextCount.get(phone) || [];
  const recentFreeText = userFreeText.filter(t => now - t < 60000);
  if (recentFreeText.length >= FREE_TEXT_LIMIT) {
    return waSend(phone, '⏱ Please slow down! (' + FREE_TEXT_LIMIT + ' free-text/min max)');
  }
  recentFreeText.push(now);
  freeTextCount.set(phone, recentFreeText);

  if (isQuestion) {
    return handleAgent(phone, '/ask ' + text);
  }

  await waSend(phone, '🔍 Searching vault for: "' + text.slice(0, 60) + '"...');
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
