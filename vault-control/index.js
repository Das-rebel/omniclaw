const express = require('express');
const { Storage } = require('@google-cloud/storage');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const PASSWORD = process.env.CONTROL_PASSWORD || 'omniclaw';
const PROJECT = 'omniclaw-personal-assistant';
const BUCKET = 'omniclaw-knowledge-graph';

const storage = new Storage({ projectId: PROJECT });
const bucket = storage.bucket(BUCKET);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function auth(req, res, next) {
  const pass = req.headers['x-password'] || req.query.password;
  if (pass === PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Helper to make HTTP calls to Cloud Functions
function callCF(url, method, data) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;
      const body = JSON.stringify(data || {});
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const req = client.request(options, (res) => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch { resolve({ raw: d.substring(0, 200) }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

// ============ AUTH ============

app.post('/api/login', (req, res) => {
  const pass = req.body?.password || req.query?.password;
  if (pass === PASSWORD) {
    res.json({ success: true, token: PASSWORD });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

app.get('/api/login', (req, res) => {
  const pass = req.query?.password;
  if (pass === PASSWORD) {
    res.json({ success: true, token: PASSWORD });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

app.get('/api/verify', auth, (req, res) => {
  res.json({ success: true });
});

// ============ VAULT SEARCH (server-side) ============

const FILE_INDEX = {
  twitter:    'vault/twitter_bookmarks_automated.json',
  instagram:  'vault/instagram_scrape.json',
  browser:    'vault/bookmarks_automated.json'
};

// In-memory cache for search index (refreshed every 5 min)
let searchCache = { timestamp: 0, data: [] };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getSearchIndex() {
  const now = Date.now();
  if (searchCache.data.length > 0 && (now - searchCache.timestamp) < CACHE_TTL) {
    return searchCache.data;
  }
  // Load all vault sources
  const files = Object.values(FILE_INDEX);
  const results = await Promise.all(files.map(async (f) => {
    try {
      const [content] = await bucket.file(f).download();
      return { file: f, data: JSON.parse(content.toString()) };
    } catch { return { file: f, data: [] }; }
  }));

  const index = [];
  for (const { file, data } of results) {
    const source = file.replace('vault/', '').replace('_automated.json', '').replace('.json', '');
    const items = Array.isArray(data) ? data : (data.bookmarks || data.posts || []);
    for (const item of items) {
      const url = item.url || item.permalink || item.link || item.uri || '';
      const text = item.text || item.caption || item.description || item.title || '';
      const author = item.author || item.author_name || item.user?.username || '';
      index.push({ url, text: text.substring(0, 500), author, source, id: item.id || item.shortcode || '' });
    }
  }
  searchCache = { timestamp: now, data: index };
  return index;
}

app.get('/api/vault/search', auth, async (req, res) => {
  const { q = '', source = 'all', limit = 50 } = req.query;
  try {
    const index = await getSearchIndex();
    const query = q.toLowerCase().trim();
    let results = index;
    if (source !== 'all') {
      results = results.filter(item => item.source === source);
    }
    if (query.length >= 2) {
      results = results.filter(item =>
        item.url.toLowerCase().includes(query) ||
        item.text.toLowerCase().includes(query) ||
        item.author.toLowerCase().includes(query)
      );
    }
    results = results.slice(0, Number(limit));
    res.json({ total: results.length, query, source, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Preload search index (for background warming)
app.get('/api/vault/search/preload', auth, async (req, res) => {
  try {
    const index = await getSearchIndex();
    res.json({ success: true, count: index.length, cached: Date.now() - searchCache.timestamp < CACHE_TTL });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ API ROUTES ============

// Vault status
app.get('/api/vault/status', auth, async (req, res) => {
  const files = [
    { key: 'vault/twitter_bookmarks_automated.json', type: 'array' },
    { key: 'vault/instagram_scrape.json', type: 'posts' },
    { key: 'vault/bookmarks_automated.json', type: 'bookmarks' },
    { key: 'vault/browser_bookmarks.json', type: 'posts' },
    { key: 'vault/latest_sync_summary.json', type: 'summary' },
    { key: 'unified_knowledge_graph.json', type: 'nodes' }
  ];
  const result = {};
  for (const f of files) {
    try {
      const [meta] = await bucket.file(f.key).getMetadata();
      const [content] = await bucket.file(f.key).download();
      let data = JSON.parse(content.toString());
      let count = 0;
      if (f.type === 'array') {
        count = Array.isArray(data) ? data.length : (data.count || 0);
      } else if (f.type === 'posts') {
        count = data.posts?.length || data.count || 0;
      } else if (f.type === 'bookmarks') {
        count = data.bookmarks?.length || data.totalCount || data.count || 0;
      } else if (f.type === 'nodes') {
        count = data.nodes?.length || 0;
      } else if (f.type === 'summary') {
        result[f.key] = data;
        continue;
      }
      result[f.key] = { count, updated: meta.updated, size: parseInt(meta.size) };
    } catch (e) {
      result[f.key] = { error: e.message };
    }
  }
  res.json(result);
});

// Browse vault data
app.get('/api/vault/browse', auth, async (req, res) => {
  const { file = 'vault/twitter_bookmarks_automated.json', limit = 5, offset = 0 } = req.query;
  try {
    const [content] = await bucket.file(file).download();
    let data = JSON.parse(content.toString());
    if (Array.isArray(data)) {
      // ok
    } else if (data.posts) {
      data = data.posts;
    } else if (data.bookmarks) {
      data = data.bookmarks;
    } else if (data.nodes) {
      data = data.nodes;
    } else {
      data = Object.values(data).filter(v => v !== null && typeof v === 'object');
    }
    if (!Array.isArray(data)) {
      return res.status(500).json({ error: 'Cannot parse data as array' });
    }
    const total = data.length;
    const page = data.slice(Number(offset), Number(offset) + Number(limit));
    res.json({ total, offset: Number(offset), limit: Number(limit), data: page });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List available vault files
app.get('/api/vault/files', auth, async (req, res) => {
  try {
    const [files] = await bucket.getFiles({ prefix: 'vault/' });
    res.json(files.map(f => ({ name: f.name, size: f.metadata.size, updated: f.metadata.updated })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync history
app.get('/api/vault/history', auth, async (req, res) => {
  try {
    const summary = await bucket.file('vault/latest_sync_summary.json').download().then(([c]) => JSON.parse(c.toString())).catch(() => ({}));
    res.json([summary]);
  } catch (e) {
    res.json([]);
  }
});

// ============ SYNC TRIGGERS ============

app.post('/api/sync/twitter', auth, async (req, res) => {
  try {
    const result = await callCF('https://vault-pipeline-338789220059.asia-south1.run.app/api/sync/twitter', 'POST', {});
    res.json({ success: true, message: 'Twitter sync triggered', result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/sync/instagram', auth, async (req, res) => {
  try {
    const result = await callCF('https://vault-pipeline-338789220059.asia-south1.run.app/api/sync/instagram', 'POST', { force_refresh: true });
    res.json({ success: true, message: 'Instagram sync triggered', result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/sync/bookmarks', auth, async (req, res) => {
  try {
    const result = await callCF('https://vault-pipeline-338789220059.asia-south1.run.app/api/sync/instagram', 'POST', { force_refresh: true });
    res.json({ success: true, message: 'Bookmark sync triggered', result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/sync/all', auth, async (req, res) => {
  const results = await Promise.allSettled([
    callCF('https://vault-pipeline-338789220059.asia-south1.run.app/api/sync/twitter', 'POST', {}),
    callCF('https://vault-pipeline-338789220059.asia-south1.run.app/api/sync/instagram', 'POST', { force_refresh: true }),
    callCF('https://vault-pipeline-338789220059.asia-south1.run.app/api/sync/instagram', 'POST', { force_refresh: true })
  ]);
  res.json({
    success: true,
    message: 'All syncs triggered',
    twitter: results[0].status,
    instagram: results[1].status,
    bookmarks: results[2].status
  });
});

// ============ CLOUD FUNCTIONS STATUS ============
app.get('/api/functions/status', auth, async (req, res) => {
  const functions = [
    { name: 'vault-pipeline', region: 'asia-south1', state: 'ACTIVE', url: 'https://vault-pipeline-338789220059.asia-south1.run.app' },
    { name: 'omniclaw-vault-search', region: 'asia-south1', state: 'ACTIVE', url: 'https://omniclaw-vault-search-338789220059.asia-south1.run.app' },
    { name: 'serve-vault-search', region: 'asia-south1', state: 'ACTIVE', url: 'https://serve-vault-search-338789220059.asia-south1.run.app' }
  ];
  res.json(functions);
});

// ============ SCHEDULERS STATUS ============
app.get('/api/schedulers/status', auth, async (req, res) => {
  const schedulers = [
    { name: 'instagram-vault-daily', schedule: '0 10 * * *', state: 'ENABLED', uri: 'instagram-vault-scheduler' },
    { name: 'bookmark-processing-daily', schedule: '30 10 * * *', state: 'ENABLED', uri: 'bookmark-vault-scheduler' },
    { name: 'twitter-sync-daily', schedule: '0 3 * * *', state: 'ENABLED', uri: 'twitter-sync' }
  ];
  res.json(schedulers);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'omniclaw-vault-control' });
});

app.listen(PORT, () => {
  console.log('OmniClaw Vault Control Center running on port ' + PORT);
});
