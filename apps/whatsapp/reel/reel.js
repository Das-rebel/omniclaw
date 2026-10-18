// ─────────────────────────────────────────────────────────────
//  REEL.JS — Daily Vault Reel (ensemble shortlist #7, 42pts)
//  3 vault saves → 1080x1920 vertical video with TTS voiceover
//  /reel · /reel daily on|off
// ─────────────────────────────────────────────────────────────

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VAULT_URL = 'http://159.65.10.49:8080/api/search';
const SCHEDULES_FILE = '/tmp/omniclaw_wa_schedules.json';
const REELS_DIR = '/tmp/omniclaw_reels';
const RENDERER = '/opt/whatsapp/reel_render_v7.py';
const PUBLIC_BASE = 'https://159.65.10.49:8090';

const NV_API = () => process.env.NV_API_KEY || '';

let waSend = async () => {};
let showTyping = async () => {};
let sendFile = async () => {};
function init(deps) {
  if (deps.waSend) waSend = deps.waSend;
  if (deps.showTyping) showTyping = deps.showTyping;
  if (deps.sendFileByUrl) sendFile = deps.sendFileByUrl;
  if (!fs.existsSync(REELS_DIR)) fs.mkdirSync(REELS_DIR, { recursive: true });
  ensureDailySchedule('917977110915', '09:15');
  // GCS schedule load overwrites /tmp at t+5s — re-seed after it lands
  setTimeout(() => ensureDailySchedule('917977110915', '09:15'), 15000);
  setInterval(() => ensureDailySchedule('917977110915', '09:15'), 300000);
  setTimeout(migrateSchedulePhones, 15000);
  setInterval(migrateSchedulePhones, 300000);
}

// ─── Self-seed the daily reel schedule (survives restarts; /tmp is truth, GCS read-only) ───
function ensureDailySchedule(phone, time) {
  try {
    const scheds = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8') || '[]');
    const id = 'reel-daily-' + phone;
    if (scheds.find(s => s.id === id)) return;
    const parts = time.split(':').map(Number);
    let mins = parts[0] * 60 + parts[1] - 330; // IST -> UTC
    let dayShift = 0;
    if (mins < 0) { mins += 1440; dayShift = 1; }
    const now = new Date();
    let next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayShift, Math.floor(mins / 60), mins % 60, 0));
    if (next <= now) { next = new Date(next.getTime() + 86400000); }
    scheds.push({ id, task: 'reel', interval: 'daily', time, params: {}, enabled: true,
      created: now.toISOString(), phone, nextRun: next.toISOString(), lastRun: null });
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(scheds, null, 1));
    console.log('🎬 Daily reel schedule seeded: ' + id + ' @ ' + time + ' IST (next ' + next.toISOString() + ')');
  } catch (e) { console.error('reel schedule seed failed:', e.message); }
}

// ─── Upload local file to GreenAPI (proven Wrapped path) -> urlFile ───
const GOWA_URL = process.env.GOWA_URL || 'http://127.0.0.1:3000';
function gowaSendVideo(phone, filePath, caption) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile('curl', ['-sS', '-m', '180', '-X', 'POST', GOWA_URL + '/send/video',
      '-F', 'phone=' + phone,
      '-F', 'video=@' + filePath + ';type=video/mp4',
      '-F', 'caption=' + caption], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const j = JSON.parse(stdout);
        if (j.code === 'SUCCESS') return resolve(true);
        reject(new Error(j.message || stdout.slice(0, 140)));
      } catch (e) { reject(new Error('gowa bad response: ' + stdout.slice(0, 140))); }
    });
  });
}
function migrateSchedulePhones() {
  try {
    const s = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8') || '[]');
    let changed = false;
    for (const e of s) {
      if (String(e.phone).includes('919003349952')) { e.phone = '917977110915'; changed = true; }
      if (e.id && String(e.id).includes('919003349952')) { e.id = String(e.id).replace('919003349952', '917977110915'); changed = true; }
    }
    if (changed) {
      fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(s, null, 1));
      console.log('[reel] migrated schedule phones 919003349952 -> 917977110915');
    }
  } catch (e) {}
}
function uploadToGreenAPI(filePath) {
  const inst = process.env.GREENAPI_INSTANCE || '';
  const tok = process.env.GREENAPI_TOKEN || '';
  if (!inst || !tok) return null;
  for (const host of ['media.green-api.com', 'media.greenapi.com']) {
    try {
      const up = spawnSync('curl', ['-sS', '-m', '180', '-X', 'POST',
        'https://' + host + '/waInstance' + inst + '/uploadFile/' + tok,
        '-F', 'file=@' + filePath], { encoding: 'utf8' });
      const j = JSON.parse(up.stdout || '{}');
      if (j.urlFile) return j.urlFile;
    } catch (e) {}
  }
  return null;
}

// ─── LLM (nemotron + retry, MiniMax fallback) ────────────────
async function llm(systemMsg, userMsg, maxTokens) {
  if (NV_API()) {
    const backoffs = [4000, 10000, 15000];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + NV_API() },
          body: JSON.stringify({
            model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
            messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
            max_tokens: Math.max(maxTokens || 1200, 1500),
            temperature: 0.8
          }),
          signal: AbortSignal.timeout(50000)
        });
        if (res.status === 503 || res.status === 429) {
          if (attempt < 2) { await new Promise(r => setTimeout(r, backoffs[attempt])); continue; }
          break;
        }
        if (!res.ok) break;
        const data = await res.json();
        let c = (data?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (c) return c;
        break;
      } catch (e) { if (attempt < 2) { await new Promise(r => setTimeout(r, backoffs[attempt])); continue; } }
    }
  }
  const key = process.env.MINIMAX_API_KEY || '';
  if (!key) return null;
  try {
    const res = await fetch('https://api.minimaxi.chat/v1/text/chatcompletion_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
        max_tokens: 2000, temperature: 0.8
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.base_resp?.status_code !== 0) return null;
    return (data?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
  } catch (e) { return null; }
}

async function callRenderer(job) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [RENDERER, JSON.stringify(job)]);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error('renderer exit ' + code + ': ' + err.slice(-300))));
  });
}

// ─── Relevance: freshest substantive saves, straight from vault.db ──
const VAULT_DB = '/opt/vault-sync/vault.db';

function dbQuery(sql) {
  try {
    const p = spawnSync('sqlite3', ['-json', VAULT_DB, sql], { encoding: 'utf8', timeout: 8000 });
    return JSON.parse(p.stdout || '[]');
  } catch (e) { return []; }
}

// v7.2: digest-shaped selection - mirrors digest v2's 3 sections (Twitter / Instagram / DMs)
function digestThree() {
  const secRows = (src, n) => dbQuery("SELECT title, content, url, metadata, created_at FROM bookmarks WHERE is_active=1 AND source='" + src + "' AND title NOT LIKE 'dm%' AND length(content) > 80 ORDER BY created_at DESC LIMIT " + n);
  const mediaFirst = (rows) => rows.map(r => {
    try {
      let m = r.metadata;
      if (typeof m === 'string') { const t = m.trim(); m = (!t || t.indexOf('[object Object]') !== -1) ? null : JSON.parse(t); }
      r._hasMedia = !!(m && typeof m === 'object' && (((Array.isArray(m.media)) && m.media[0] && m.media[0].url) || m.thumbnail_url));
    } catch (e) { r._hasMedia = false; }
    return r;
  }).sort((a, b) => (b._hasMedia ? 1 : 0) - (a._hasMedia ? 1 : 0));
  const tw = mediaFirst(secRows('twitter', 40));
  // IG section: real posts/reels only — the IG scraper also files DM-request spam under source='instagram'
  // v7.3: IG section is RECENCY-FIRST, not text-first — recent saves carry thumbnails but
  // captions are missing upstream; enrichment OCRs the thumb so the LLM still gets copy.
  // Window widens 3d -> 10d -> legacy text-bearing rows only as a last resort.
  let ig = mediaFirst(dbQuery("SELECT title, content, url, metadata, created_at FROM bookmarks WHERE is_active=1 AND source='instagram' AND title NOT LIKE 'dm%' AND metadata LIKE '%thumbnail_url%scontent%' AND (url LIKE '%/p/%' OR url LIKE '%/reel/%' OR url LIKE '%/tv/%') AND created_at >= datetime('now','-3 days') ORDER BY created_at DESC LIMIT 12")).filter(r => /instagram\.(com|co)\/(p|reel|tv)\//.test(r.url || ''));
  if (!ig.length) ig = mediaFirst(dbQuery("SELECT title, content, url, metadata, created_at FROM bookmarks WHERE is_active=1 AND source='instagram' AND title NOT LIKE 'dm%' AND metadata LIKE '%thumbnail_url%scontent%' AND (url LIKE '%/p/%' OR url LIKE '%/reel/%' OR url LIKE '%/tv/%') AND created_at >= datetime('now','-10 days') ORDER BY created_at DESC LIMIT 12")).filter(r => /instagram\.(com|co)\/(p|reel|tv)\//.test(r.url || ''));
  if (!ig.length) ig = mediaFirst(secRows('instagram', 40)).filter(r => /instagram\.(com|co)\/(p|reel|tv)\//.test(r.url || ''));
  let dmReal = null; const dmCounts = { inbox: 0, pending: 0 };
  try {
    const dmRows = dbQuery("SELECT title, content, url, metadata FROM bookmarks WHERE source_id LIKE 'dm:%' ORDER BY created_at DESC LIMIT 50");
    for (const r of dmRows) {
      let kind = null; try { kind = (JSON.parse(r.metadata || '{}') || {}).kind; } catch (e) {}
      kind = kind || 'request';
      dmCounts[kind === 'inbox' ? 'inbox' : 'pending']++;
      if (!dmReal && kind === 'inbox' && r.content && r.content.length > 60) dmReal = r;
    }
  } catch (e) {}
  return { tw, ig, dmReal, dmCounts };
}

function pickThreeToday() {
  // v7.1: prefer items WITH images — b-roll beats text-only cards
  const withMedia = (days) => dbQuery(
    "SELECT url, title, content, metadata FROM bookmarks WHERE is_active=1 AND url NOT LIKE '%/direct/%' " +
    "AND (metadata LIKE '%pbs.twimg.com/media%' OR metadata LIKE '%thumbnail_url%scontent%') " +
    "AND (length(COALESCE(NULLIF(content,'[object Object]'), title)) > 40) " +
    "AND scraped_at >= datetime('now','-" + days + " days') " +
    "ORDER BY length(COALESCE(NULLIF(content,'[object Object]'), title)) DESC LIMIT 30"
  );
  const fresh = (days) => dbQuery(
    "SELECT url, title, content, metadata FROM bookmarks WHERE is_active=1 AND url NOT LIKE '%/direct/%' " +
    "AND (length(COALESCE(NULLIF(content,'[object Object]'), title)) > 40) " +
    "AND scraped_at >= datetime('now','-" + days + " days') " +
    "ORDER BY length(COALESCE(NULLIF(content,'[object Object]'), title)) DESC LIMIT 30"
  );
  let rows = withMedia(21);
  if (rows.length >= 3) return rows.filter(r => {
    const t = (r.content && r.content.length > r.title.length ? r.content : r.title) || '';
    return t.length > 40 && !/^https?:\/\//.test(t);
  });
  rows = fresh(2);
  if (rows.length < 3) rows = fresh(7);
  return rows.filter(r => {
    const t = (r.content && r.content.length > r.title.length ? r.content : r.title) || '';
    return t.length > 40 && !/^https?:\/\//.test(t);
  });
}

function dailyStats() {
  const bars7 = dbQuery("SELECT substr(created_at,6,5) d, count(*) v FROM bookmarks WHERE created_at >= datetime('now','-7 days') GROUP BY substr(created_at,6,5) ORDER BY 1")
    .map(r => [r.d, r.v]);
  const today = (dbQuery("SELECT count(*) v FROM bookmarks WHERE created_at >= datetime('now','-1 day')")[0] || {}).v || 0;
  let streak = 0;
  try { streak = JSON.parse(fs.readFileSync('/opt/vault-sync/brief_state.json', 'utf8')).streak || 0; } catch (e) {}
  return { today, streak, bars7 };
}

function dailyStyle() {
  const d = new Date();
  const seed = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  const voices = ['en-US-GuyNeural', 'en-US-AndrewNeural', 'en-US-ChristopherNeural', 'en-US-AriaNeural', 'en-US-BrianNeural'];
  const accents = [[76, 220, 156], [120, 170, 255], [255, 170, 90], [200, 150, 255], [255, 120, 150]];
  return {
    seed,
    voice: voices[seed % voices.length],
    accent: accents[(seed >> 1) % accents.length],
    layout: seed % 2 ? 'top' : 'center'
  };
}

function authorOf(url) {
  try {
    const m = url.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status/) ||
              url.match(/instagram\.com\/(?!p\/|reel\/|tv\/|explore\/)([A-Za-z0-9_.]+)/);
    return m ? '@' + m[1] : 'vault';
  } catch (e) { return 'vault'; }
}

// ─── Detect language of the first item ────────────────────────
function detectLang(text) {
  // Devanagari range
  return /[\u0900-\u097F]/.test(text) ? 'hi' : 'en';
}

// ─── Core: generate reel (v4 — 5-beat duno grammar, today's saves, motion) ──
let _renderBusy = false; // v7.2: single-flight — concurrent renders share tmp dirs and corrupt each other
async function generateReel() {
  if (_renderBusy) return { error: 'A reel is already rendering — skipping this tick.' };
  _renderBusy = true;
  try { return await _generateReelInner(); } finally { _renderBusy = false; }
}
async function _generateReelInner() {
  const stats = dailyStats();
  const style = dailyStyle();
  const d3 = digestThree();
  const rows = [];
  if (d3.tw.length) rows.push(Object.assign({}, d3.tw[0], { _sec: 'twitter' }));
  if (d3.ig.length) rows.push(Object.assign({}, d3.ig[0], { _sec: 'instagram' }));
  for (const r of d3.tw.slice(1)) { if (rows.length >= 2) break; rows.push(Object.assign({}, r, { _sec: 'twitter' })); }
  for (const r of d3.ig.slice(1)) { if (rows.length >= 2) break; rows.push(Object.assign({}, r, { _sec: 'instagram' })); }
  if (rows.length) {
    if (d3.dmReal) rows.push(Object.assign({}, d3.dmReal, { _sec: 'dm' }));
    else if (d3.dmCounts.inbox + d3.dmCounts.pending > 0) {
      const nDm = d3.dmCounts.inbox + d3.dmCounts.pending;
      rows.push({ _sec: 'dm_counts', title: 'DMs', url: '', metadata: '{}',
        content: nDm + ' DMs waiting in requests — the morning brief sorts the real ones from the spam.' });
    } else {
      for (const r of d3.tw.slice(1).concat(d3.ig.slice(1))) { if (rows.length >= 3) break; if (rows.some(x => x.url === r.url)) continue; rows.push(Object.assign({}, r, { _sec: 'twitter' })); }
    }
  }
  if (rows.length < 2) return { error: 'Vault has too few fresh items for a reel — sync may not have run.' };

  const items = rows.slice(0, 12).map(r => {
    const text = ((r.content && r.content.length > r.title.length ? r.content : r.title) || '').replace(/\s+/g, ' ').trim();
    // v5: parse metadata for renderer extras (may be '[object Object]', '{}', or empty — guarded)
    let media_url = null, local_media = null, likes = null, rts = null, views = null, src_type = null;
    try {
      let md = r.metadata;
      if (typeof md === 'string') {
        const s = md.trim();
        md = (!s || s.indexOf('[object Object]') !== -1) ? null : JSON.parse(s);
      }
      if (md && typeof md === 'object') {
        if (Number.isFinite(md.like_count)) likes = md.like_count;
        if (Number.isFinite(md.retweet_count)) rts = md.retweet_count;
        if (Number.isFinite(md.view_count)) views = md.view_count;
        const m0 = Array.isArray(md.media) ? md.media[0] : null;
        if (m0 && m0.url) media_url = m0.url;
        if (!media_url && md.thumbnail_url) media_url = md.thumbnail_url; // IG posts
        if (md.local_media) local_media = String(md.local_media);
        if (md.type === 'image' || md.type === 'carousel' || md.type === 'video') src_type = md.type;
        else if (m0 && m0.type === 'photo') src_type = 'photo';
      }
    } catch (e) {}
    return { name: authorOf(r.url), text, url: r.url, media_url, local_media, likes, rts, views, src_type, sec: r._sec || null };
  });
  for (const it of items) {
    if (it.sec === 'instagram') { const m2 = String(it.url || '').match(/instagram\.com\/([^\/?]+)/); if (m2 && !['p', 'reel', 'tv', 'explore'].includes(m2[1])) it.name = '@' + m2[1]; else it.name = 'Instagram post'; }
    else if (it.sec === 'dm') it.name = 'DM · ' + it.name;
    else if (it.sec === 'dm_counts') it.name = 'DM inbox';
  }

  // v7.3: IG media guarantee — signed CDN URLs expire; cache bytes locally and reuse.
  // Caption-less IG saves get their thumbnail OCR'd so they can carry a beat.
  try {
    const MEDIA_CACHE = '/opt/whatsapp/media_cache';
    if (!fs.existsSync(MEDIA_CACHE)) fs.mkdirSync(MEDIA_CACHE, { recursive: true });
    // v7.4: GC — prune cache files older than 14 days (signed IG URLs expire faster)
    try {
      const now = Date.now();
      const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
      for (const f of fs.readdirSync(MEDIA_CACHE)) {
        const fp = MEDIA_CACHE + '/' + f;
        try {
          if (now - fs.statSync(fp).mtimeMs > maxAgeMs) fs.unlinkSync(fp);
        } catch (e) {}
      }
    } catch (eGC) {}
    for (const it of items) {
      if (!it.media_url || it.local_media) continue;
      if (!/scontent|cdninstagram|fbcdn/.test(it.media_url)) continue;
      const sm = String(it.url || '').match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
      const key = sm ? sm[1] : String(it.media_url).replace(/[^A-Za-z0-9]/g, '').slice(-24);
      const lp = MEDIA_CACHE + '/' + key + '.jpg';
      if (!fs.existsSync(lp) || fs.statSync(lp).size < 2000) {
        spawnSync('curl', ['-sS', '-m', '25', '-A', 'Mozilla/5.0', '-o', lp, it.media_url], { timeout: 30000 });
        if (!fs.existsSync(lp) || fs.statSync(lp).size < 2000) { try { fs.unlinkSync(lp); } catch (e2) {} it.media_url = null; continue; }
      }
      it.local_media = lp;
      if (!it.text || it.text.length < 40) {
        const ocr = spawnSync('tesseract', [lp, '-', '--psm', '6'], { encoding: 'utf8', timeout: 20000 });
        const otxt = String(ocr.stdout || '').replace(/\s+/g, ' ').trim();
        if (otxt.length >= 40) it.text = otxt.slice(0, 300);
      }
    }
  } catch (eMC) {}

  const lang = detectLang(items.slice(0, 4).map(i => i.text).join(' '));
  const langName = lang === 'hi' ? 'Hindi/Hinglish' : 'English';
  const ctx = items.map((r, i) => '[' + (i + 1) + '] ' + r.name + ': ' + r.text.slice(0, 220)).join('\n\n');

  const raw = await llm(
    'You write a 5-beat VERTICAL VIDEO script (1080x1920) using duno scene grammar: SUBJECT + CLAIM + VISUAL PROOF + TRANSITION. The narration tells the story. The screen shows the proof. They NEVER repeat each other.\n' +
    'Beat 1 = HOOK built from TODAY STATS (a big counter animates on screen; reference the exact number).\n' +
    'Beat 2 = TWITTER section: item [1]. Beat 3 = INSTAGRAM section: item [2] (may be a 2nd Twitter pick if no IG saves). Beat 4 = DM section: item [3] — if the item name is the DM inbox count, frame it as N DMs waiting to be triaged — never claim they are real or valuable messages (most requests are promotional spam); else narrate the message. Each: headline = bold claim <=8 words, body = concrete value/surprise <=18 words.\n' +
    'Beat 5 = OUTRO sign-off, short.\n' +
    'Persona voices: HOOK = announcer energy — lead with the stat and the cost-of-nothing angle, sentences <=20 words.\n' +
    'SAVE beats = curator persona — narrate each as "here\'s why this earned a slot"; name the author/source naturally.\n' +
    'OUTRO = calm sign-off persona — MUST end with ONE concrete next step the viewer takes now (open the 8am brief, check the vault); never a generic sign-off.\n' +
    'Respond with EXACTLY this JSON, nothing else:\n' +
    '{"beats":[\n {"kind":"stat","headline":"<=14 words incl the number","body":"","stat":{"big":"<the number>","label":"<3-6 word label>"}},\n' +
    ' {"kind":"save","n":1,"headline":"...","body":"..."},\n' +
    ' {"kind":"save","n":2,"headline":"...","body":"..."},\n' +
    ' {"kind":"save","n":3,"headline":"...","body":"..."},\n' +
    ' {"kind":"outro","headline":"<=8 words","body":"<=12 words"}\n]}\n' +
    'Write in ' + langName + '. JSON only, no markdown.',
    'TODAY STATS: ' + JSON.stringify({ saves_today: stats.today, streak_days: stats.streak }) + '\n\nSAVED ITEMS:\n' + ctx,
    1400
  );

  let beats = null;
  if (raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
    }
    if (parsed && Array.isArray(parsed.beats) && parsed.beats.length >= 4) {
      beats = parsed.beats.slice(0, 5).map(b => {
        const kind = b.kind || 'save';
        if (kind === 'stat') {
          const st = b.stat || {};
          return { kind, headline: String(b.headline || '').slice(0, 140), body: '', stat: { big: String(st.big || stats.today).slice(0, 6), label: String(st.label || 'saves today').slice(0, 40) } };
        }
        if (kind === 'outro') {
          return { kind, headline: String(b.headline || 'Full vault').slice(0, 100), body: String(b.body || '').slice(0, 120) };
        }
        const src = items[(b.n || 1) - 1] || items[0];
        return { kind, headline: String(b.headline || '').slice(0, 120), body: String(b.body || '').slice(0, 200), author: src.name, sec: src.sec, url: src.url, media_url: src.media_url, local_media: src.local_media, likes: src.likes, rts: src.rts, views: src.views, src_type: src.src_type };
      });
    }
  }
  if (!beats) {
    // Deterministic fallback — the daily send never hard-fails
    const clip = (t, n) => t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t;
    beats = [
      { kind: 'stat', headline: stats.today + ' saves today — day ' + stats.streak + ' streak', body: '', stat: { big: String(stats.today), label: 'saves today · ' + stats.streak + '-day streak' } },
      ...items.slice(0, 3).map(it => ({ kind: 'save', headline: clip(it.text, 70), body: clip(it.text.slice(70), 150), author: it.name, sec: it.sec, url: it.url, media_url: it.media_url, local_media: it.local_media, likes: it.likes, rts: it.rts, views: it.views, src_type: it.src_type })),
      { kind: 'outro', headline: 'Open the 8am brief', body: 'Full links at 8. Reel back at 9:15.' }
    ];
  }

  // vault law: photo within 2s — stat beat carries the best saved photo (stat PiP)
  const pipItem = items.find(it => it.media_url) || null;
  if (pipItem) for (const b of beats) { if (b.kind === 'stat') { b.media_url = pipItem.media_url; b.local_media = pipItem.local_media || null; b.src_type = 'photo'; } }

  // GC old reels, keep last 5
  const files = fs.readdirSync(REELS_DIR).filter(f => f.endsWith('.mp4')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - 4))) {
    try { fs.unlinkSync(path.join(REELS_DIR, old)); } catch (e) {}
  }

  const id = Date.now().toString(36);
  const outPath = path.join(REELS_DIR, `reel_${id}.mp4`);
  await callRenderer({ beats, lang, out_path: outPath, stats, style });
  return { style, stats, beats, lang, file: path.basename(outPath), url: PUBLIC_BASE + '/reels/' + path.basename(outPath), bytes: fs.statSync(outPath).size };
}

async function sendReel(phone) {
  await showTyping(phone, true).catch(() => {});
  let r;
  try { r = await generateReel(); }
  catch (e) { await showTyping(phone, false).catch(() => {}); return waSend(phone, '🎬 Reel failed: ' + e.message.slice(0, 120)); }
  await showTyping(phone, false).catch(() => {});

  if (r.error) return waSend(phone, '🎬 ' + r.error);

  // caption card + the video file
  const caption = '🎬 *VAULT REEL · ' + new Date().toISOString().slice(0, 10) + '*\n'
    + '━━━━━━━━━━━━━\n'
    + '🎯 ' + (r.beats || []).filter(b => b.kind === 'save' && b.sec !== 'dm_counts').length + ' saves' + (((r.beats || []).some(b => b.sec === 'dm_counts')) ? ' + DM triage' : '') + ' · ~45 sec\n'
    + '📦 mined from your vault (' + ((r.style && r.style.seed) || '') + ')\n'    + (((r.beats || []).some(b => b.kind === 'save')) ? '\n' + (r.beats || []).filter(b => b.kind === 'save').map(b => { const e = b.sec === 'instagram' ? '\ud83d\udcf7 ' : (b.sec === 'dm' || b.sec === 'dm_counts') ? '\ud83d\udcac ' : b.sec === 'twitter' ? '\ud83d\udc26 ' : ''; return '\u2022 ' + e + (b.author || '') + ': ' + (b.headline || '').slice(0, 48); }).join('\n') + '\n' : '')
    + '🗣 ' + (r.lang === 'hi' ? 'Hindi voiceover' : 'English voiceover') + '\n'
    + '━━━━━━━━━━━━━\n'
    + '▶️ watch below';
  const chatId = phone.includes('@') ? phone : phone + '@c.us';
  // Send: GoWA native upload first (quota-free, real WhatsApp ACK), then GreenAPI, then self-hosted URL, then plain link
  let sent = false;
  try { sent = await gowaSendVideo(phone, path.join(REELS_DIR, r.file), caption); }
  catch (e) { console.error('reel gowaSendVideo failed:', e.message || e); }
  if (!sent) {
    const gUrl = uploadToGreenAPI(path.join(REELS_DIR, r.file));
    if (gUrl) {
      try { await sendFile(chatId, gUrl, r.file, caption); sent = true; }
      catch (e) { console.error('reel sendFileByUrl(GreenAPI) failed:', e.message || e); }
    }
  }
  if (!sent) {
    try { await sendFile(chatId, r.url, r.file, caption); sent = true; }
    catch (e) { console.error('reel sendFileByUrl(self-hosted) failed:', e.message || e); }
  }
  if (!sent) await waSend(phone, '📹 ' + r.url);
  // Schedule GC: remove any reels older than 24h (best-effort, lazy)
  setTimeout(() => gcOldReels(), 60_000);
}

function gcOldReels() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(REELS_DIR).filter(x => x.endsWith('.mp4'))) {
    try {
      const st = fs.statSync(path.join(REELS_DIR, f));
      if (st.mtime.getTime() < cutoff) fs.unlinkSync(path.join(REELS_DIR, f));
    } catch (e) {}
  }
}

// ─── Command router ──────────────────────────────────────────
function saveScheds(s) { fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(s, null, 1)); }

async function handleReel(phone, text) {
  const arg = text.replace(/^\/reel\s*/i, '').trim().toLowerCase();

  if (arg.startsWith('daily')) {
    const sub = arg.split(/\s+/)[1];
    const scheds = (() => { try { return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8') || '[]'); } catch (e) { return []; } })();
    const mine = scheds.filter(s => s.phone === phone && s.task === 'reel');
    if (sub === 'on' || sub === 'off') {
      const rest = scheds.filter(s => !(s.phone === phone && s.task === 'reel'));
      if (sub === 'on') {
        const time = (arg.split(/\s+/)[2] || '10:00');
        rest.push({ task: 'reel', phone, interval: 'daily', enabled: true, time, nextRun: null, params: {}, lastRun: null });
        saveScheds(rest);
        return waSend(phone, '🎬 Daily Vault Reel ON at ' + time + ' IST. /reel daily off to stop.');
      }
      saveScheds(rest);
      return waSend(phone, '❌ Daily Vault Reel OFF.');
    }
    return waSend(phone, mine.length ? '📅 Daily Reel: ON (' + mine[0].time + ' IST)\nTurn off: /reel daily off' : '📅 Daily Reel: OFF\nTurn on: /reel daily on [HH:MM IST]');
  }

  if (arg && arg !== 'now') {
    return waSend(phone, '🎬 *Vault Reel*\n/reel — 1080x1920 vertical video, ~45 sec, 3 saves from your vault with voiceover\n/reel daily on [HH:MM IST] — morning reel');
  }

  await waSend(phone, '🎬 Rendering your 3-save reel (TTS + frames + ffmpeg)...');
  return sendReel(phone);
}

module.exports = { init, handleReel, sendReel, generateReel };
