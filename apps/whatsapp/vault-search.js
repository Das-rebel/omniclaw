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

// ─── Vault Stats Cache ──────────────────────────────────
let vaultStatsCache = null;
let vaultStatsTime = 0;

async function getVaultStats() {
  if (vaultStatsCache && Date.now() - vaultStatsTime < 600000) return vaultStatsCache;
  try {
    const data = await httpGet(VAULT_SEARCH_URL + '/stats', 10000);
    vaultStatsCache = data;
    vaultStatsTime = Date.now();
    return data;
  } catch (e) {
    return vaultStatsCache || { total: 0 };
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

// ─── URL Extraction ──────────────────────────────────────

function getVaultUrls(items) {
  return items.slice(0, 10).map(i => i.url).filter(Boolean);
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
  // -- Parse special flags before building queries --
  const isSummary = /\s*--summary\s*$/i.test(query);
  let cleanQuery = isSummary ? query.replace(/\s*--summary\s*$/i, '').trim() : query;

  let isTagView = false;
  let afterDate = null;
  let beforeDate = null;
  let filteredBy = null;

  if (/\s*--twitter\b/i.test(cleanQuery)) {
    filteredBy = 'twitter';
    cleanQuery = cleanQuery.replace(/\s*--twitter\b/gi, '').trim();
  } else if (/\s*--instagram\b/i.test(cleanQuery)) {
    filteredBy = 'instagram';
    cleanQuery = cleanQuery.replace(/\s*--instagram\b/gi, '').trim();
  }

  if (/--tags\b/.test(cleanQuery)) {
    isTagView = true;
    cleanQuery = cleanQuery.replace(/--tags\b/g, '').replace(/\s+/g, ' ').trim();
  }

  const afterMatch = cleanQuery.match(/--after\s+(\d{4}-\d{2}-\d{2})/);
  if (afterMatch) {
    afterDate = new Date(afterMatch[1] + 'T00:00:00Z');
    cleanQuery = cleanQuery.replace(afterMatch[0], '').replace(/\s+/g, ' ').trim();
  }

  const beforeMatch = cleanQuery.match(/--before\s+(\d{4}-\d{2}-\d{2})/);
  if (beforeMatch) {
    beforeDate = new Date(beforeMatch[1] + 'T23:59:59Z');
    cleanQuery = cleanQuery.replace(beforeMatch[0], '').replace(/\s+/g, ' ').trim();
  }

  if (!cleanQuery.trim()) {
    if (isTagView) return { query: '', total: 0, tags: {}, isTagView: true };
    const base = { query: '', total: 0, results: [], isSummary: false };
    if (afterDate) base.after = afterDate.toISOString().slice(0, 10);
    if (beforeDate) base.before = beforeDate.toISOString().slice(0, 10);
    return base;
  }

  const hybridQueries = buildHybridQueries(cleanQuery);
  let allItems = [];
  const seenIds = new Set();

  for (const q of hybridQueries) {
    if (!q.trim()) continue;
    try {
      const r = await httpGet(VAULT_SEARCH_URL + '/search?q=' + encodeURIComponent(q) + '&limit=20', 30000);
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
    let enriched = allItems.map(fr => enrichResult(fr, lookup));

    // Filter by date range if specified
    if (afterDate) {
      enriched = enriched.filter(item => {
        const ts = item.timestamp ? new Date(item.timestamp) : null;
        return ts && ts >= afterDate;
      });
    }
    if (beforeDate) {
      enriched = enriched.filter(item => {
        const ts = item.timestamp ? new Date(item.timestamp) : null;
        return ts && ts <= beforeDate;
      });
    }

    // Tag drill-down: aggregate entities/topics across ALL results
    if (isTagView) {
      const aggregatedTags = {};
      for (const item of enriched) {
        if (item.entities && Array.isArray(item.entities)) {
          for (const e of item.entities) {
            const key = typeof e === 'string' ? e : (e.name || e);
            if (key) aggregatedTags[key] = (aggregatedTags[key] || 0) + 1;
          }
        }
        if (item.metadata?.topic) {
          aggregatedTags[item.metadata.topic] = (aggregatedTags[item.metadata.topic] || 0) + 1;
        }
        if (item.metadata?.vlTags) {
          for (const t of item.metadata.vlTags) {
            if (t) aggregatedTags[t] = (aggregatedTags[t] || 0) + 1;
          }
        }
      }
      return { query: cleanQuery, total: enriched.length, tags: aggregatedTags, isTagView: true };
    }

    // URL Dedup: remove items with duplicate URLs
    const seenUrls = new Set();
    enriched = enriched.filter(item => {
      if (!item.url) return true;
      if (seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    });

    // Source filter: apply --twitter or --instagram flag
    if (filteredBy) {
      enriched = enriched.filter(item => {
        const rawSource = item.source || item.type || '';
        if (rawSource.startsWith(filteredBy)) return true;
        if (filteredBy === 'twitter' && item.id && item.id.startsWith('tw_')) return true;
        if (filteredBy === 'instagram' && item.id && item.id.startsWith('ig_')) return true;
        return false;
      });
    }

    const base = {
      query: cleanQuery,
      total: enriched.length,
      results: enriched.slice(0, 12),
      isSummary: isSummary && cleanQuery.length > 0,
    };
    if (afterDate) base.after = afterDate.toISOString().slice(0, 10);
    if (beforeDate) base.before = beforeDate.toISOString().slice(0, 10);
    if (filteredBy) base.filteredBy = filteredBy;
    return base;
  }

  const base = { query: cleanQuery, total: 0, results: [], isSummary: isSummary && cleanQuery.length > 0 };
  if (afterDate) base.after = afterDate.toISOString().slice(0, 10);
  if (beforeDate) base.before = beforeDate.toISOString().slice(0, 10);
  if (filteredBy) base.filteredBy = filteredBy;
  return base;
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
  const tags = item.hashtags || item.tags || item.metadata?.tags || item.vlTags || item.metadata?.vlTags || [];
  const entities = item.entities || [];
  const allTags = [...tags, ...entities].slice(0, 5);
  if (allTags.length > 0) lines.push('🏷 ' + allTags.join(' · '));

  // Location
  const loc = item.metadata?.location || item.location || '';
  if (loc && loc.length < 50) lines.push('📍 ' + loc);

  if (url) lines.push('\u{1F517} ' + url);
  return (index + 1) + '. ' + icon + ' ' + lines.join('\n   ');
}

module.exports = { searchVault, buildVaultResult, extractKeywords, getVaultUrls, getVaultStats };
