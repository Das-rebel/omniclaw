/**
 * OmniClaw - WhatsApp Auto-Reply with Cloud AI + Vault + Multi-Voice
 * Version with auto-reconnect and connection management
 */
// WhatsApp via OpenWA REST API (no Baileys)
const http = require('http');
const https = require('https');
const OPENWA_URL = process.env.OPENWA_URL || 'http://localhost:2785';
const OPENWA_KEY = process.env.OPENWA_KEY || 'dev-admin-key';
let _openwaSession = null;
function openwaReq(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(OPENWA_URL + endpoint);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': OPENWA_KEY },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } }); });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function getOpenwaSession() {
  if (_openwaSession) return _openwaSession;
  try {
    const sessions = await openwaReq('GET', '/api/sessions');
    if (Array.isArray(sessions)) {
      const a = sessions.find(s => s.status === 'ready');
      if (a) { _openwaSession = a.id; return a.id; }
    }
  } catch {}
  return null;
}
async function openwaSendText(chatId, text) {
  const sid = await getOpenwaSession();
  if (!sid) throw new Error('No active WA session');
  await openwaReq('POST', `/api/sessions/${sid}/messages/send-text`, { chatId, text });
}
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const AUTH_DIR = '/Users/Subho/.omniclaw_auth';
const SARVAM_API_KEY = 'sk_0ct1mbzm_wsoETmHdputtlGmsowQgnd7K';
const ELEVENLABS_KEY = 'e58538575801b8faa7ea1b7dc41f60f2cc818d50e73a0ecbefbe0eb02aa1bc7c';
const OMNICLAW_JID = '919003349852';
const OMNICLAW_LID = '39372334338199';

// Voice map
const VOICE_MAP = {
  NARRATOR: { voiceId: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' },
  RAYA: { voiceId: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger' },
  ZEPHYR: { voiceId: 'SAz9YHcvj6GT2YYXdXww', name: 'River' },
  MAYA: { voiceId: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica' },
  BLAZE: { voiceId: 'SOYHLrjzK2X1ezoPC6cr', name: 'Harry' }
};

let sock = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;

// Cloud AI
async function cloudAI(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text: query });
    const options = {
      hostname: 'alexa-handler-338789220059.asia-south1.run.app',
      path: '/alexa',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          resolve(d?.response?.outputSpeech?.text || 'No response');
        } catch (e) { reject(e); }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// TTS
async function sarvamTTS(text, speaker, lang) {
  try {
    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-subscription-key': SARVAM_API_KEY },
      body: JSON.stringify({
        inputs: [text.substring(0, 500)],
        target_language: lang || 'en-IN',
        speaker: speaker || 'anushka',
        model: 'bulbul:v2'
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.audios?.[0]) {
        return Buffer.from(data.audios[0], 'base64');
      }
    }
  } catch (e) { console.log('[TTS error]', e.message); }
  return null;
}

async function elevenlabsTTS(text, voiceId) {
  try {
    const resp = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_KEY
      },
      body: JSON.stringify({
        text: text.substring(0, 500),
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.7, similarity_boost: 0.8, style: 0.5 }
      })
    });
    
    if (resp.ok) return Buffer.from(await resp.arrayBuffer());
  } catch (e) { console.log('[ElevenLabs error]', e.message); }
  return null;
}

function convertWavToMP3(wavBuffer) {
  try {
    const tmpWav = path.join(os.tmpdir(), 'wav_' + Date.now() + '.wav');
    const tmpMp3 = path.join(os.tmpdir(), 'mp3_' + Date.now() + '.mp3');
    fs.writeFileSync(tmpWav, wavBuffer);
    execSync('ffmpeg -i ' + tmpWav + ' -codec:a libmp3lame -b:a 64k ' + tmpMp3 + ' -y -loglevel error');
    const mp3 = fs.readFileSync(tmpMp3);
    try { fs.unlinkSync(tmpWav); } catch(e) {}
    try { fs.unlinkSync(tmpMp3); } catch(e) {}
    return mp3;
  } catch (e) { return null; }
}

function isMentioned(msg, from) {
  if (!from.includes('@g.us')) return true;
  
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  
  const inMentioned = mentioned.some(function(j) {
    return j.includes(OMNICLAW_LID) || j.includes('@lid') || j.includes(OMNICLAW_JID);
  });
  
  return inMentioned || text.includes('@' + OMNICLAW_LID) || text.includes('@' + OMNICLAW_JID) || text.toLowerCase().includes('@omniclaw');
}

function extractQuery(text) {
  return text
    .replace(/@omniclaw/gi, '')
    .replace(new RegExp('@' + OMNICLAW_LID, 'gi'), '')
    .replace(new RegExp('@' + OMNICLAW_JID, 'gi'), '')
    .replace(/@\d+/g, '')
    .trim();
}

function isStoryRequest(text) {
  const lower = text.toLowerCase();
  const storyKeywords = ['story', 'stories', 'tale', 'kahani', 'katha', 'chitra', 'generate a story', 'tell me a story', 'video story', 'make a story'];
  return storyKeywords.some(function(k) { return lower.includes(k); });
}

function parseStory(text) {
  const segments = [];
  const lines = text.split('\n');
  let currentChar = 'NARRATOR';
  let currentText = [];
  
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    var match = line.match(/^([A-Z][A-Z0-9_']+)[\s:_\-]+["\']?(.+)/);
    
    if (match) {
      if (currentText.length > 0) {
        var t = currentText.join(' ').replace(/^["\']|["\']$/g, '').trim();
        if (t) segments.push({ char: currentChar, text: t });
        currentText = [];
      }
      currentChar = match[1].toUpperCase().replace(/\s+/g, '_');
      currentText.push(match[2]);
    } else if (line.length > 0) {
      currentText.push(line.replace(/^["\']|["\']$/g, ''));
    }
  }
  
  if (currentText.length > 0) {
    var t = currentText.join(' ').trim();
    if (t) segments.push({ char: currentChar, text: t });
  }
  
  return segments;
}

function generateSilence(durationMs) {
  var tmp = path.join(os.tmpdir(), 'silence_' + Date.now() + '.mp3');
  execSync('ffmpeg -f lavfi -i "anullsrc=r=44100:cl=mono" -t ' + (durationMs/1000) + ' -codec:a libmp3lame -b:a 32k ' + tmp + ' -y -loglevel error');
  return fs.readFileSync(tmp);
}

function concatenateMP3(buffers) {
  if (buffers.length === 0) return null;
  if (buffers.length === 1) return buffers[0];
  
  var files = buffers.map(function(buf, i) {
    var f = path.join(os.tmpdir(), 'c_' + i + '.mp3');
    fs.writeFileSync(f, buf);
    return f;
  });
  
  var listFile = path.join(os.tmpdir(), 'cl.txt');
  fs.writeFileSync(listFile, files.map(function(f) { return "file '" + f + "'"; }).join('\n'));
  
  var outputFile = path.join(os.tmpdir(), 'full.mp3');
  execSync('ffmpeg -f concat -safe 0 -i ' + listFile + ' -codec:a copy ' + outputFile + ' -y -loglevel error');
  
  var result = fs.readFileSync(outputFile);
  files.forEach(function(f) { try { fs.unlinkSync(f); } catch(e) {} });
  try { fs.unlinkSync(listFile); } catch(e) {}
  try { fs.unlinkSync(outputFile); } catch(e) {}
  
  return result;
}

async function generateMultiVoiceAudio(text) {
  var segments = parseStory(text);
  
  if (segments.length === 0) {
    segments.push({ char: 'NARRATOR', text: text });
  }
  
  console.log('[MultiVoice] ' + segments.length + ' segments');
  
  var audioBuffers = [];
  
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    var voice = VOICE_MAP[seg.char] || VOICE_MAP.NARRATOR;
    
    try {
      var wav = await elevenlabsTTS(seg.text, voice.voiceId);
      if (wav) {
        var mp3 = convertWavToMP3(wav);
        if (mp3) audioBuffers.push(mp3);
        console.log('[' + (i+1) + '/' + segments.length + '] ' + seg.char + ': OK');
      }
    } catch (e) {
      console.log('[' + (i+1) + '/' + segments.length + '] ' + seg.char + ': FAIL');
    }
    
    if (i < segments.length - 1) {
      try { audioBuffers.push(generateSilence(300)); } catch(e) {}
    }
    
    await new Promise(function(r) { setTimeout(r, 200); });
  }
  
  if (audioBuffers.length === 0) return null;
  return concatenateMP3(audioBuffers);
}

async function startOmniClaw() {
  console.log('\n═══════════════════════════════════════');
  console.log('  OMNICLAW - Auto-Reconnect Version');
  console.log('═══════════════════════════════════════');
  console.log('  JID: ' + OMNICLAW_JID);
  console.log('  LID: ' + OMNICLAW_LID);
  console.log('═══════════════════════════════════════\n');
  
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  
  sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys) },
    version,
    printQRInTerminal: false,
    browser: ["OmniClaw", "Desktop", "20.0.0"],
    syncFullHistory: true,
    markOnlineOnConnect: true
  });

  sock.ev.on('connection.update', async function(u) {
    console.log('[Conn]', u.connection);
    
    if (u.connection === 'open') {
      console.log('[✓] Connected!');
      reconnectAttempts = 0;
    }
    
    if (u.connection === 'close') {
      console.log('[✗] Disconnected');
      
      // Auto-reconnect logic
      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        console.log('[↻] Reconnecting... attempt ' + reconnectAttempts + '/' + MAX_RECONNECT);
        await new Promise(function(r) { setTimeout(r, 5000); });
        startOmniClaw().catch(function(e) { console.error('[Reconnect error]', e.message); });
      } else {
        console.log('[✗] Max reconnect attempts reached. Please restart manually.');
      }
    }
  });

  await new Promise(function(resolve, reject) {
    var t = setTimeout(function() { reject(new Error('Timeout')); }, 60000);
    sock.ev.on('connection.update', function(u) {
      if (u.connection === 'open') { clearTimeout(t); resolve(); }
      if (u.connection === 'close') { clearTimeout(t); reject(new Error('Closed')); }
    });
  });

  console.log('[Ready] Listening...\n');

  sock.ev.on('messages.upsert', async function(ref) {
    var messages = ref.messages;
    var type = ref.type;
    
    if (type !== 'notify') return;
    
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      if (msg.key.fromMe) continue;
      
      var from = msg.key.remoteJid;
      var isGroup = from.includes('@g.us');
      
      var text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!text) continue;
      
      console.log('\n========== NEW MESSAGE ==========');
      console.log('[From]', from);
      console.log('[Text]', text.substring(0, 100));
      
      if (!isMentioned(msg, from)) {
        console.log('[SKIP] Not mentioned');
        continue;
      }
      
      var query = extractQuery(text);
      var isStory = isStoryRequest(query);
      
      console.log('[Query]', query.substring(0, 50));
      
      try {
        var reply = await cloudAI(query);
        
        await sock.sendMessage(from, { text: reply });
        console.log('[✓] Text sent:', reply.length, 'chars');
        
        if (isStory && reply.length > 50) {
          console.log('[🎤] Generating multi-voice audio...');
          var audio = await generateMultiVoiceAudio(reply);
          if (audio) {
            await sock.sendMessage(from, { audio: audio, mimetype: 'audio/mpeg' });
            console.log('[✓] Audio sent!');
          }
        }
      } catch (e) {
        console.error('[✗] Error:', e.message);
      }
    }
  });

  process.stdin.resume();
}

startOmniClaw().catch(console.error);

process.on('unhandledRejection', function(e) { console.error('[Error]', e); });
process.on('SIGINT', function() { process.exit(0); });
