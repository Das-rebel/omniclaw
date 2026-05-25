#!/usr/bin/env node
/**
 * vault-search.js — Vault search module for OmniClaw WhatsApp Bot.
 *
 * Exports:
 *   searchVault(query)      — hybrid query building, FAISS HTTP calls, URL lookup enrichment
 *   buildVaultResult(item, index) — formats individual results (Twitter, Instagram, entity, bookmark)
 *   extractKeywords(query)  — stop word filtering
 */

// ─── Internal HTTP utility (mirrors server.js httpGet) ──
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

// ─── Endpoints ──────────────────────────────────────────
const VAULT_SEARCH_URL = 'https://serve-vault-search-338789220059.asia-south1.run.app';
const LOOKUP_URL = 'https://storage.googleapis.com/omniclaw-knowledge-graph/vault/vault_url_lookup.json';

// ─── Constants ──────────────────────────────────────────
const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'is','are','was','were','be','been','being','have','has','had','do','does','did',
  'will','would','could','should','may','might','can','this','that','these','those',
  'i','you','he','she','it','we','they','what','which','who','how','when','where',
  'why','can','please','help','me','my','your','our','all','any','some','no','not',
  'just','like','get','got','go','going','know','think','want','need','use','using',
  'build','make','create','tell','show','find','look','tell','try','give','tell'
]);

const INTENT_PATTERNS = {
  CONVERSATIONAL: /\b(how|what|why|when|where|who|explain|understand|tell me|can i|could i|should i)\b/i,
  ACTION: /\b(build|create|make|implement|set up|install|setup|configure|deploy|develop|learn)\b/i,
  COMPARISON: /\b(difference|vs|versus|compare|comparison|better|worse|pros cons|advantage)\b/i,
  LIST: /\b(list|examples|tips|hints|ideas|suggestions|best practices)\b/i,
  DEFINITION: /\b(what is|what are|definition|meaning|explain|definition of)\b/i,
};

// ─── URL Lookup Cache ───────────────────────────────────
let urlLookup = null;
let urlLookupTime = 0;

async function loadUrlLookup() {
  if (urlLookup && Date.now() - urlLookupTime < 600000) return urlLookup;
  try {
    const data = await httpGet(LOOKUP_URL, 30000);
    urlLookup = data;
    urlLookupTime = Date.now();
    console.log('[vault-search] URL lookup loaded: ' + Object.keys(data || {}).length + ' keys');
    return urlLookup;
  } catch (e) {
    return urlLookup || {};
  }
}

// Preload lookup on startup
setTimeout(() => loadUrlLookup(), 3000);

// ─── Query Utilities ────────────────────────────────────

function extractKeywords(query) {
  const words = query.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

function detectIntent(query) {
  const q = query.toLowerCase();
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern.test(q)) return intent;
  }
  return 'KEYWORD';
}

function normalizeQuery(query) {
  return query.toLowerCase().replace(/[^\w\s?]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildHybridQueries(query) {
  const keywords = extractKeywords(query);
  const normalized = normalizeQuery(query);
  let queries = [normalized];
  const intent = detectIntent(query);
  if ((intent === 'CONVERSATIONAL' || intent === 'DEFINITION') && keywords.length > 0) queries.push(keywords.slice(0, 3).join(' '));
  if (keywords.length > 0 && keywords.join(' ') !== normalized) queries.push(keywords.join(' '));
  return [...new Set(queries)].slice(0, 3);
}

// ─── URL Enrichment ─────────────────────────────────────

function enrichResult(fr, lookup) {
  const fid = fr.id || '';
  let meta = lookup[fid];
  if (!meta) {
    const parts = fid.split('_');
    meta = lookup[parts[parts.length - 1]];
  }
  if (!meta) {
    for (const k of Object.keys(lookup)) {
      if (fid.includes(k) || k.includes(fid)) { meta = lookup[k]; break; }
    }
  }
  return {
    ...fr,
    url: fr.url || meta?.url || '',
    source: fr.source || meta?.source || (
      fid.startsWith('tw_') ? 'twitter'
        : fid.startsWith('ig_') ? 'instagram'
        : fid.startsWith('entity_') ? 'entity'
        : fid.startsWith('bm_') ? 'bookmark'
        : 'web'
    ),
    date: fr.date || meta?.date || '',
    caption: (fr.caption || '').replace(/\n/g, ' ').trim().slice(0, 120),
    score: fr.score,
    tags: fr.vlTags || [],
    location: fr.location || meta?.location || '',
    colabSummary: fr.colabSummary || '',
    aestheticScore: fr.aestheticScore || meta?.aestheticScore || 0,
    vlStyle: fr.vlStyle || '',
    vlMood: fr.vlMood || '',
  };
}

// ─── Search ─────────────────────────────────────────────

async function searchVault(query) {
  const hybridQueries = buildHybridQueries(query);
  let allItems = [];
  const seenIds = new Set();

  for (const q of hybridQueries) {
    if (!q.trim()) continue;
    try {
      const r = await httpGet(VAULT_SEARCH_URL + '/search?q=' + encodeURIComponent(q) + '&limit=10', 30000);
      const items = r && r.results ? r.results : [];
      for (const item of items) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allItems.push(item);
        }
      }
    } catch (e) {
      // silently skip failed query variant
    }
  }

  const lookup = await loadUrlLookup();
  if (allItems.length) {
    return {
      query,
      total: allItems.length,
      results: allItems.slice(0, 12).map(fr => enrichResult(fr, lookup)),
    };
  }
  return { query, total: 0, results: [] };
}

// ─── Result Formatting ──────────────────────────────────

function buildVaultResult(item, index) {
  const rawSource = item.source || item.type || 'web';
  const isTwitter = rawSource.startsWith('twitter');
  const iconMap = {
    'twitter': '\u{1F426}', 'twitter_tweet': '\u{1F426}', 'twitter_bookmark': '\u{1F426}',
    'instagram': '\u{1F4F7}', 'instagram_post': '\u{1F4F7}', 'instagram_reel': '\u{1F4F7}',
    'entity': '\u{1F3F7}\uFE0F', 'bookmark': '\u{1F516}', 'web': '\u{1F310}'
  };
  const icon = iconMap[rawSource] || '\u{1F517}';
  const url = item.url || '';
  const date = item.date ? item.date.slice(0, 10) : (item.timestamp ? item.timestamp.slice(0, 10) : '');

  // Entity items filtered earlier, but skip if one sneaks through
  if (rawSource === 'entity' || item.type === 'entity') return '';

  // Twitter: show tweet content as title, not @handle
  if (isTwitter) {
    const handle = (item.name || '').replace(/^@/, '') || 'twitter';
    const rawContent = item.content || '';
    // First sentence/line as title (word-boundary truncation at ~50)
    const firstLine = rawContent.split(/\n/)[0].replace(/https?:\/\/\S+/g, '').trim();
    const title = firstLine.length > 52 ? firstLine.slice(0, 50).replace(/\s+\S*$/, '') + '...' : firstLine;
    const titleFinal = title || (item.name || 'Tweet');
    // Rest of tweet after the first line
    const body = rawContent.slice(firstLine.length).replace(/https?:\/\/\S+/g, '').slice(0, 100).replace(/\n/g, ' ').trim();

    const lines = ['*' + titleFinal + '*'];
    if (body) lines.push(body);
    lines.push('\u{1F426} ' + handle);
    if (date) lines.push('\u{1F4C5} ' + date);
    if (url) lines.push('\u{1F517} ' + url);
    return (index + 1) + '. ' + icon + ' ' + lines.join('\n   ');
  }

  // Regular items (Instagram, bookmarks)
  const rawName = item.name || item.caption || item.content || '';
  const name = rawName.slice(0, 55).replace(/\n/g, ' ').trim() || '\u{1F5BC}\uFE0F';
  const content = (item.content || item.caption || '').replace(/https?:\/\/\S+/g, '').slice(0, 120).replace(/\n/g, ' ').trim();
  const meta = item.metadata || {};
  const likes = meta.like_count || 0;
  const rt = meta.retweet_count || 0;
  const views = meta.view_count || '';

  const lines = [];
  // Show name as title; skip content if it's the same as name (no redundancy)
  const contentIsSame = content && (name.startsWith(content) || content.startsWith(name) || name === content);
  if (name) lines.push('*' + name + '*');
  if (content && !contentIsSame) lines.push(content);

  // Stats line
  let stats = '';
  if (likes > 0) stats += '\u2764\uFE0F ' + (likes > 999 ? (likes / 1000).toFixed(1) + 'K' : likes);
  if (rt > 0) stats += (stats ? ' \u00B7 ' : '') + '\u{1F501} ' + rt;
  if (views) {
    const v = String(views).replace(/(\d{3})(\d{3})/, '$1.$2K').replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2M');
    stats += (stats ? ' \u00B7 ' : '') + '\u{1F441} ' + v;
  }
  if (date) stats += (stats ? ' \u00B7 ' : '') + '\u{1F4C5} ' + date;
  if (stats) lines.push(stats);

  // Tags + entities
  const tags = item.tags || item.vlTags || item.metadata?.vlTags || [];
  const entities = item.entities || [];
  const allTags = [...tags, ...entities].slice(0, 4);
  if (allTags.length > 0) lines.push('\u{1F3F7} ' + allTags.join(' \u00B7 '));

  if (url) lines.push('\u{1F517} ' + url);
  return (index + 1) + '. ' + icon + ' ' + lines.join('\n   ');
}

module.exports = { searchVault, buildVaultResult, extractKeywords };
