/**
 * OmniClaw Daily Health & Automated Test System
 * 
 * Checks actual data freshness and functionality, not just HTTP endpoints.
 * Event-triggered functions are checked via their output data, not direct HTTP calls.
 * 
 * Usage:
 *   node daily-health.js                    # Run all checks, print to console
 *   node daily-health.js --notify          # Run checks + send WhatsApp message
 *   node daily-health.js --json           # Output JSON format
 *   node daily-health.js --server         # Start health API server
 */

const { Storage } = require('@google-cloud/storage');

// ─── CONFIG ───────────────────────────────────────────────────────────────

const CONFIG = {
  GCS_BUCKET: 'omniclaw-knowledge-graph',
  GCS_PROJECT: 'omniclaw-personal-assistant',
  
  VAULT_URL: 'https://omniclaw-vault-control-338789220059.us-central1.run.app',
  VAULT_PASSWORD: process.env.VAULT_PASSWORD || 'omniclaw2026',
  
  WA_OUTBOX: '/tmp/omniclaw_openwa/outbox',
  WA_DM_JID: '919003349852@s.whatsapp.net',
  
  // Thresholds
  STALE_HOURS: 48,
  CRITICAL_HOURS: 72,
  MIN_BOOKMARKS: 50,
  MIN_KG_NODES: 500,
};

// ─── STORAGE CLIENT ───────────────────────────────────────────────────────

const storage = new Storage({ projectId: CONFIG.GCS_PROJECT });
const bucket = storage.bucket(CONFIG.GCS_BUCKET);

// ─── GCS HELPERS ─────────────────────────────────────────────────────────

async function gcsGetJSON(filePath) {
  try {
    const [contents] = await bucket.file(filePath).download();
    return JSON.parse(contents.toString());
  } catch (e) {
    return null;
  }
}

async function gcsGetMeta(filePath) {
  try {
    const [meta] = await bucket.file(filePath).getMetadata();
    return {
      exists: true,
      updated: new Date(meta.updated),
      size: parseInt(meta.size, 10),
    };
  } catch (e) {
    return { exists: false, updated: null, size: 0 };
  }
}

async function gcsCountItems(filePath) {
  const data = await gcsGetJSON(filePath);
  if (!data) return 0;
  if (Array.isArray(data)) return data.length;
  if (data.nodes) return data.nodes.length;
  if (data.bookmarks) return data.bookmarks.length;
  if (data.posts) return data.posts.length;
  return Object.keys(data).length;
}

// ─── VAULT CHECKS ──────────────────────────────────────────────────────

async function checkVaultSource(name, filePath) {
  const meta = await gcsGetMeta(filePath);
  if (!meta.exists) {
    return { name, file: filePath, healthy: false, status: 'MISSING', items: 0, hoursAgo: null };
  }
  
  const items = await gcsCountItems(filePath);
  const hoursAgo = meta.updated 
    ? Math.round((Date.now() - meta.updated.getTime()) / 3600000 * 10) / 10
    : null;
  
  const isStale = hoursAgo !== null && hoursAgo > CONFIG.STALE_HOURS;
  const isCritical = hoursAgo !== null && hoursAgo > CONFIG.CRITICAL_HOURS;
  const isLowVolume = items < CONFIG.MIN_BOOKMARKS && name !== 'Browser Bookmarks';
  
  return {
    name,
    file: filePath,
    healthy: !isCritical,
    status: isCritical ? 'CRITICAL' : isStale ? 'STALE' : 'FRESH',
    items,
    hoursAgo,
    isLowVolume,
    updated: meta.updated?.toISOString() || null,
  };
}

// ─── VAULT CONTROL CHECKS ────────────────────────────────────────────────

const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

function httpGet(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function curlGet(url, timeout = 10000) {
  try {
    const result = execSync(
      `curl -s -m ${Math.round(timeout/1000)} -w "\\n%{http_code}" "${url.replace(/"/g, '\\"')}"`,
      { timeout: timeout + 2000 }
    ).toString();
    const parts = result.trim().split('\n');
    const body = parts.slice(0, -1).join('\n');
    const status = parseInt(parts[parts.length - 1], 10);
    return { status, body };
  } catch (e) {
    return { status: 0, body: '', error: e.message };
  }
}

async function checkVaultControl() {
  const statusUrl = `${CONFIG.VAULT_URL}/api/vault/status?password=${CONFIG.VAULT_PASSWORD}`;
  const searchUrl = `${CONFIG.VAULT_URL}/api/vault/search?q=test&password=${CONFIG.VAULT_PASSWORD}`;
  
  // Use curl for reliability
  const statusResult = curlGet(statusUrl, 12000);
  const healthy = statusResult.status === 200;
  
  const searchResult = curlGet(searchUrl, 12000);
  const searchWorks = searchResult.status === 200;
  
  return { healthy, searchWorks, statusCode: statusResult.status || 0 };
}

// ─── SCHEDULER CHECK ──────────────────────────────────────────────────

async function checkSchedulerJobs() {
  try {
    const output = execSync(
      `gcloud scheduler jobs list --project=${CONFIG.GCS_PROJECT} --location=us-central1 --format=json 2>/dev/null`,
      { timeout: 10000 }
    ).toString();
    
    const jobs = JSON.parse(output || '[]');
    const jobStatus = jobs.map(j => ({
      name: j.name,
      state: j.state,
      schedule: j.schedule,
    }));
    
    const allEnabled = jobs.every(j => j.state === 'ENABLED');
    
    return { healthy: allEnabled, jobs: jobStatus };
  } catch (e) {
    return { healthy: false, error: e.message, jobs: [] };
  }
}

// ─── WHATSAPP ──────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

function queueWhatsAppMessage(jid, message) {
  // Try GreenAPI first (OpenWA deprecated since 2026-05-27)
  const greenInstance = process.env.GREENAPI_INSTANCE || '7107630227';
  const greenToken = process.env.GREENAPI_TOKEN || 'f9e7484d874043239fc97bbe3cfcef23660f6dc83a504591ae';
  const greenUrl = `https://${greenInstance.slice(0, 4)}.api.greenapi.com`;

  try {
    const { execSync } = require('child_process');
    const payload = JSON.stringify({ chatId: jid, message });
    const tmpFile = `/tmp/greenapi-payload-${Date.now()}.json`;
    fs.writeFileSync(tmpFile, payload);

    const output = execSync(
      `curl -sf -X POST "${greenUrl}/waInstance${greenInstance}/sendMessage/${greenToken}" ` +
      `-H "Content-Type: application/json" -d @${tmpFile}`,
      { encoding: 'utf-8', timeout: 15000 }
    );

    try { fs.unlinkSync(tmpFile); } catch {}

    const resp = JSON.parse(output);
    if (resp.idMessage) {
      console.log(`[WA] Sent via GreenAPI to ${jid}`);
      return true;
    }
    throw new Error(resp.error?.message || 'unknown GreenAPI error');
  } catch (e) {
    console.log(`[WA] GreenAPI failed, falling back to outbox: ${e.message}`);
    // Fallback to outbox
    const timestamp = Date.now();
    const msgFile = path.join(CONFIG.WA_OUTBOX, `health-${timestamp}.msg`);
    execSync(`mkdir -p "${CONFIG.WA_OUTBOX}"`, { stdio: 'ignore' });
    fs.writeFileSync(msgFile, `${jid}\n${message}`);
    console.log(`[WA] Queued message to ${msgFile}`);
    return msgFile;
  }
}

// ─── ENHANCEMENTS — 3 STRATEGIC CATEGORIES ──────────────────────────────

function generateEnhancements(results) {
  const { vaultSources, scheduler, vaultControl } = results;
  const bugs = [], architecture = [], capability = [];
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };

  // ── BUGS / CRITICAL ──────────────────────────────────────

  // Browser Bookmarks critically stale (>6 days)
  const browser = vaultSources.find(s => s.name === 'Browser Bookmarks');
  if (browser && browser.hoursAgo !== null && browser.hoursAgo > 144) {
    bugs.push({
      priority: 'HIGH',
      title: 'Browser Bookmarks sync broken (7+ days stale)',
      description: `Last synced ${browser.hoursAgo}h ago. Chrome extension scraper has likely failed or credentials expired.`,
      action: 'Check Chrome extension ID + browser bookmark API credentials. Verify scraper is reachable from GCP.',
    });
  }

  // Instagram 0 items for <24h (cookie/API issue)
  const instagram = vaultSources.find(s => s.name === 'Instagram Saved');
  if (instagram && instagram.items === 0 && instagram.hoursAgo !== null && instagram.hoursAgo < 24) {
    bugs.push({
      priority: 'MEDIUM',
      title: 'Instagram sync returned 0 items',
      description: `instagrapi may have cookie expiry or hit API rate limits. Instagram saved posts show 0.`,
      action: 'Verify Instagram session cookies in GCS. Check instagrapi logs in GCP Cloud Functions.',
    });
  }

  // Vault Control search failing
  if (vaultControl && !vaultControl.searchWorks) {
    bugs.push({
      priority: 'HIGH',
      title: 'Vault Control search API is failing',
      description: 'Users cannot search bookmarks via the web UI — primary discovery workflow blocked.',
      action: 'Check Vault Control Cloud Run logs. Redeploy at: omniclaw-vault-control-338789220059.us-central1.run.app',
    });
  }

  // Scheduler returned 0 jobs (all deleted or permission issue)
  if (scheduler && scheduler.jobs.length === 0 && !scheduler.error) {
    bugs.push({
      priority: 'HIGH',
      title: 'Cloud Scheduler returned 0 jobs',
      description: 'instagram-vault-daily should exist. All schedulers may have been deleted.' ,
      action: 'Check GCP Console > Cloud Scheduler. Re-create any missing scheduled jobs.',
    });
  }

  // ── ARCHITECTURE ──────────────────────────────────────

  architecture.push({
    priority: 'HIGH',
    title: 'apps/ directory is fragmented — WhatsApp/Telegram/Web are empty stubs',
    description: 'Baileys WhatsApp lives in /scripts/ not apps/whatsapp/. Telegram and Web apps are missing entirely. Codebase is misleading.' ,
    action: 'Move Baileys to apps/whatsapp/. Create apps/telegram/ and apps/web/ scaffolds. Update FILE_MAP.md.',
  });

  architecture.push({
    priority: 'MEDIUM',
    title: 'CF-to-CF calls use direct HTTP POSTs instead of Pub/Sub queues',
    description: 'twitter-sync → bookmark-vault-scheduler uses HTTP callbacks. If CF is down, callback fails silently. Pub/Sub gives at-least-once delivery.' ,
    action: 'Replace HTTP callback with GCP Pub/Sub topic. More resilient to cold starts and transient failures.',
  });

  architecture.push({
    priority: 'LOW',
    title: '4 duplicate GLM client files — maintenance burden',
    description: 'glm_client.js, glm_client_fixed.js, unified_glm_client.js, unified_glm_client_v2.js — all different. Consolidate to one canonical client.' ,
    action: 'Keep unified_glm_client_v2.js as canonical, delete other 3, update all imports across the codebase.',
  });

  // ── CAPABILITY EXPANSION ─────────────────────────────────

  capability.push({
    priority: 'MEDIUM',
    title: 'Add Discord as a new app entry point',
    description: 'Roadmap mentions Discord but not implemented. A Discord bot adds real-time voice+text channel.' ,
    action: 'Create apps/discord/ with Discord.js scaffold. Add to intent_orchestrator.js routing. Ref: huashu-design patterns.',
  });

  capability.push({
    priority: 'LOW',
    title: 'Enable ChromaDB for semantic bookmark search',
    description: 'TMLPD supports use_chromadb=True but ChromaDB not installed. Bookmark search is keyword-only, not semantic.' ,
    action: 'Add ChromaDB (docker or Cloud SQL). Populate embeddings on bookmark sync. Enable semantic search in vault.',
  });

  capability.push({
    priority: 'MEDIUM',
    title: 'Automate Twitter/Instagram cookie refresh every 20h',
    description: 'Twitter cookies expire ~24h, Instagram ~7d. Manual refresh causes sync gaps. A scheduled CF could auto-refresh.' ,
    action: 'Schedule cookie-refresh CF to run every 20h. Store refreshed cookies back to GCS vault/cookies/.',
  });

  // ── ASSEMBLE — 1 from each category, fill with any ─────
  const fromCat = (arr, n) => arr.sort((a, b) => order[a.priority] - order[b.priority]).slice(0, n);
  const picks = [
    ...fromCat(bugs, 1),
    ...fromCat(architecture, 1),
    ...fromCat(capability, 1),
  ];
  const used = new Set(picks.map(p => p.title));
  const remaining = [...bugs, ...architecture, ...capability]
    .filter(x => !used.has(x.title))
    .sort((a, b) => order[a.priority] - order[b.priority]);
  return [...picks, ...remaining].slice(0, 3);
}

// ─── REPORT FORMATTING ─────────────────────────────────────────────────

function formatReport(results) {
  const ts = new Date(results.timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  
  // Overall health
  const issues = results.enhancements.filter(e => e.priority === 'HIGH').length;
  const status = issues === 0 ? '✅ HEALTHY' : `⚠️ ${issues} HIGH PRIORITY`;
  
  // Vault table
  const vaultLines = results.vaultSources.map(s => {
    const icon = s.status === 'FRESH' ? '✅' : s.status === 'STALE' ? '⚠️' : s.status === 'CRITICAL' ? '🔴' : '❌';
    const age = s.hoursAgo !== null ? `${s.hoursAgo}h ago` : 'never';
    return `${icon} ${s.name}: ${s.items} items (${age})`;
  });
  
  // Scheduler table
  const schedLines = results.scheduler.jobs.map(j => {
    const icon = j.state === 'ENABLED' ? '✅' : '⚠️';
    return `${icon} ${j.name}: ${j.state}`;
  });
  
  // Enhancements with category labels
  const catLabel = { BUG: '🐛', ARCH: '🏗️', CAP: '🚀' };
  const enhLines = results.enhancements.map((e, i) => {
    const cat = e.title.includes('broken') || e.title.includes('failing') || e.title.includes('0 items') || e.title.includes('returned 0') 
      ? 'BUG' : e.title.includes('fragmented') || e.title.includes('duplicate') || e.title.includes('HTTP POST') 
      ? 'ARCH' : 'CAP';
    return `${i+1}. [${e.priority}] ${catLabel[cat]} ${e.title}\n   → ${e.action}`;
  });
  
  return `🤖 OmniClaw Health Report
━━━━━━━━━━━━━━━━━━━━━━
${status} | ${ts}

📦 VAULT DATA:
${vaultLines.join('\n')}

⏰ SCHEDULER:
${schedLines.join('\n') || 'Unable to fetch scheduler status'}

🎛️ VAULT CONTROL: ${results.vaultControl.searchWorks ? '✅ Search OK' : '⚠️ Search Issues'}

📋 TOP 3 ENHANCEMENTS:
${enhLines.join('\n\n') || 'None — system healthy!'}
━━━━━━━━━━━━━━━━━━━━━━`;
}

// ─── MAIN ──────────────────────────────────────────────────────────────

async function runHealthChecks() {
  console.log('[Health] Running OmniClaw health checks...\n');
  const start = Date.now();
  
  // Check all vault sources in parallel
  console.log('[Health] Checking vault data...');
  const vaultSources = await Promise.all([
    checkVaultSource('Twitter Bookmarks', 'vault/twitter_bookmarks_automated.json'),
    checkVaultSource('Instagram Saved', 'vault/instagram_scrape.json'),
    checkVaultSource('Browser Bookmarks', 'vault/browser_bookmarks.json'),
    checkVaultSource('Knowledge Graph', 'unified_knowledge_graph.json'),
    checkVaultSource('Sync Summary', 'vault/latest_sync_summary.json'),
  ]);
  
  vaultSources.forEach(s => {
    const icon = s.status === 'FRESH' ? '✅' : s.status === 'STALE' ? '⚠️' : s.status === 'CRITICAL' ? '🔴' : '❌';
    console.log(`[Health]   ${icon} ${s.name}: ${s.items} items, ${s.hoursAgo !== null ? s.hoursAgo + 'h ago' : 'NO DATA'}`);
  });
  
  // Check scheduler
  console.log('\n[Health] Checking scheduler...');
  const scheduler = await checkSchedulerJobs();
  scheduler.jobs.forEach(j => {
    const icon = j.state === 'ENABLED' ? '✅' : '⚠️';
    console.log(`[Health]   ${icon} ${j.name}: ${j.state}`);
  });
  if (scheduler.error) console.log(`[Health]   ⚠️  ${scheduler.error}`);
  
  // Check vault control
  console.log('\n[Health] Checking Vault Control...');
  const vaultControl = await checkVaultControl();
  console.log(`[Health]   ${vaultControl.healthy ? '✅' : '❌'} Vault Control: HTTP ${vaultControl.statusCode || 'FAIL'}`);
  console.log(`[Health]   ${vaultControl.searchWorks ? '✅' : '❌'} Search: ${vaultControl.searchWorks ? 'Working' : 'Failed'}`);
  
  const results = {
    timestamp: Date.now(),
    duration: Date.now() - start,
    vaultSources,
    scheduler,
    vaultControl,
    enhancements: generateEnhancements({ vaultSources, scheduler, vaultControl }),
  };
  
  results.report = formatReport(results);
  
  console.log(`\n[Health] Done in ${results.duration}ms`);
  console.log(`[Health] ${results.enhancements.length} enhancements generated`);
  
  return results;
}

// ─── CLI / SERVER ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const notify = args.includes('--notify');
  const serverMode = args.includes('--server');
  
  if (serverMode) {
    const http = require('http');
    const port = process.env.PORT || 8081;
    
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      
      try {
        if (url.pathname === '/health' && req.method === 'GET') {
          const results = await runHealthChecks();
          res.writeHead(200);
          res.end(JSON.stringify(results, null, 2));
        } else if (url.pathname === '/health/report' && req.method === 'GET') {
          const results = await runHealthChecks();
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(results.report);
        } else if (url.pathname === '/health/notify' && req.method === 'POST') {
          const results = await runHealthChecks();
          if (CONFIG.WA_DM_JID) {
            queueWhatsAppMessage(CONFIG.WA_DM_JID, results.report);
          }
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, queued: !!CONFIG.WA_DM_JID }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ 
            endpoints: ['/health', '/health/report', '/health/notify'] 
          }));
        }
      } catch (e) {
        console.error('[Health] Error:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    
    server.listen(port, () => {
      console.log(`[Health] OmniClaw Health API on http://localhost:${port}`);
      console.log(`[Health]   GET  /health        → JSON report`);
      console.log(`[Health]   GET  /health/report → Plain text report`);
      console.log(`[Health]   POST /health/notify  → Send WhatsApp + return JSON`);
    });
  } else {
    const results = await runHealthChecks();
    
    if (asJson) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log('\n' + results.report);
    }
    
    if (notify) {
      if (CONFIG.WA_DM_JID) {
        queueWhatsAppMessage(CONFIG.WA_DM_JID, results.report);
        console.log('[Health] WhatsApp notification queued');
      } else {
        console.log('[Health] No WhatsApp JID configured');
      }
    }
  }
}

main().catch(e => {
  console.error('[Health] FATAL:', e.message);
  process.exit(1);
});

module.exports = { runHealthChecks, generateEnhancements, formatReport };
