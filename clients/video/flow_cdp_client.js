/**
 * Google Flow CDP Client - WORKING
 * 
 * Automates Google Flow (Nano Banana 2) image generation via Chrome DevTools Protocol.
 * 
 * HOW IT WORKS:
 * 1. Connects to existing Chrome with Google auth (Colab browser on port 60807)
 * 2. Creates a new Flow project
 * 3. Types prompt using CDP Input.insertText (triggers Slate.js beforeinput)
 * 4. Clicks Create to generate images
 * 5. Downloads generated images via canvas toDataURL
 * 
 * KEY DISCOVERY: Slate.js requires CDP Input.insertText to trigger beforeinput events.
 * All other methods (execCommand, rawKeyDown, keyDown, Ctrl+V) fail.
 * 
 * Usage:
 *   node flow_cdp_client.js --prompt "A cute puppy in flowers"
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');

class FlowCDPClient {
  constructor(port = 60807) {
    this.port = port;
    this.wsUrl = null;
    this.tabId = null;
    this.outputDir = '/tmp/flow_output';
    this.msgId = 0;
  }

  async connect() {
    // Find or create Flow tab
    const tabs = await this._httpGet(`/json/list`);
    let flowTab = tabs.find(t => t.url?.includes('labs.google'));
    
    if (!flowTab) {
      flowTab = await this._httpPut(`/json/new?https://labs.google/fx/tools/flow`);
      await this._sleep(8000);
    }
    
    this.tabId = flowTab.id;
    this.wsUrl = flowTab.webSocketDebuggerUrl;
    return this;
  }

  async evaluate(expr) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: ++this.msgId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
      });
      ws.on('message', (data) => {
        const r = JSON.parse(data);
        ws.close();
        resolve(r?.result?.result?.value);
      });
      ws.on('error', reject);
      setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 10000);
    });
  }

  async cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: ++this.msgId, method, params }));
      });
      ws.on('message', (data) => {
        ws.close();
        resolve(JSON.parse(data));
      });
      ws.on('error', reject);
      setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 10000);
    });
  }

  /**
   * Complete image generation pipeline
   */
  async generate(prompt, options = {}) {
    const { outputDir = this.outputDir } = options;
    fs.mkdirSync(outputDir, { recursive: true });

    console.log(`\n🎨 Flow Image Generation`);
    console.log(`   Prompt: "${prompt.substring(0, 60)}${prompt.length > 60 ? '...' : ''}"`);

    // Step 1: Navigate to Flow
    console.log('   [1/5] Navigating...');
    await this.evaluate(`window.location.href = 'https://labs.google/fx/tools/flow'`);
    await this._sleep(10000);

    // Handle auth redirect
    const url = await this.evaluate('window.location.href');
    if (url?.includes('accounts.google.com')) {
      await this.evaluate(`(() => {
        const els = document.querySelectorAll('[role="link"]');
        for (const el of els) { if (el.innerText.includes('@')) { el.click(); return true; } }
      })()`);
      await this._sleep(10000);
    }

    // Click "Create with Flow" if on landing page
    await this.evaluate(`(() => {
      const b = document.querySelectorAll('button');
      for (const x of b) { if (x.innerText.includes('Create with Flow')) { x.click(); return true; } }
    })()`);
    await this._sleep(8000);

    // Step 2: Create new project
    console.log('   [2/5] Creating project...');
    await this.evaluate(`(() => {
      const b = document.querySelectorAll('button');
      for (const x of b) {
        if (x.innerText.includes('New project') && x.getBoundingClientRect().width > 50) {
          x.click(); return true;
        }
      }
    })()`);
    await this._sleep(5000);

    // Dismiss all dialogs
    for (let i = 0; i < 20; i++) {
      const r = await this.evaluate(`(() => {
        const b = document.querySelectorAll('button');
        for (const x of b) {
          const t = x.innerText.trim();
          if (['Continue','Accept','Next','Get started','Close','Got it'].includes(t)) {
            const r = x.getBoundingClientRect();
            if (r.width > 0) { x.click(); return t; }
          }
        }
        return 'none';
      })()`);
      if (r === 'none') break;
      await this._sleep(800);
    }

    // Wait for editor
    for (let i = 0; i < 15; i++) {
      const hasEditor = await this.evaluate(`!!document.querySelector('[data-slate-editor]')`);
      if (hasEditor === true || hasEditor === 'true') break;
      await this._sleep(1000);
    }

    // Step 3: Set prompt via Input.insertText
    // Slate.js requires: 1) click the editor, 2) selectAll to clear, 3) insertText
    console.log('   [3/5] Setting prompt...');

    // Click directly on the editor element via CDP for reliable focus
    const editorRect = await this.evaluate(`(() => {
      const ed = document.querySelector('[data-slate-editor="true"]');
      if (!ed) return null;
      const r = ed.getBoundingClientRect();
      return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
    })()`);

    if (editorRect) {
      const coords = JSON.parse(editorRect);
      await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left' });
      await this._sleep(500);
    }

    // Select all + delete to clear any existing text
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 }); // Ctrl+A
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await this._sleep(200);
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    await this._sleep(300);

    // Type the prompt via insertText
    await this.cdp('Input.insertText', { text: prompt });
    await this._sleep(1500);

    // Verify via innerText (placeholder check)
    const editorText = await this.evaluate(`(() => {
      const ed = document.querySelector('[data-slate-editor="true"]');
      return ed?.innerText?.trim() || '';
    })()`);

    // If editor still shows placeholder, try once more with CDP focus
    if (!editorText || editorText === 'What do you want to create?' || editorText.length < 5) {
      console.log('   ⚠️ First attempt failed, retrying with CDP focus...');
      // Use DOM focus method
      await this.evaluate(`document.querySelector('[data-slate-editor="true"]')?.focus()`);
      await this._sleep(500);
      await this.cdp('Input.insertText', { text: prompt });
      await this._sleep(1000);
    }

    // Final verification
    const finalText = await this.evaluate(`(() => {
      const ed = document.querySelector('[data-slate-editor="true"]');
      return ed?.innerText?.trim() || '';
    })()`);

    if (!finalText || finalText === 'What do you want to create?') {
      console.log(`   ❌ Prompt not set in editor: "${finalText?.substring(0, 40)}"`);
      return { success: false, error: 'Failed to set prompt in Slate editor' };
    }
    console.log(`   ✅ Prompt set: "${finalText.substring(0, 50)}..."`);

    // Step 4: Submit - click the arrow_forward/Create button
    console.log('   [4/5] Generating...');
    const clicked = await this.evaluate(`(() => {
      const b = document.querySelectorAll('button');
      // PREFER arrow_forward button (the actual submit/generate button)
      // The "add_2 Create" button is different and may not trigger generation
      for (const x of b) {
        const t = x.innerText.trim();
        const y = x.getBoundingClientRect().y;
        const vis = x.getBoundingClientRect().width > 0;
        if (vis && t.includes('arrow_forward') && y > 500) { x.click(); return 'arrow_forward: ' + t; }
      }
      // Fallback: look for Create button with vis rect > 0 and y > 600
      for (const x of b) {
        const t = x.innerText.trim();
        const y = x.getBoundingClientRect().y;
        const vis = x.getBoundingClientRect().width > 0;
        if (vis && t === 'Create' && y > 600) { x.click(); return 'Create: ' + t; }
      }
      return 'NOT_FOUND';
    })()`);
    console.log(`   Clicked: "${clicked}"`);
    if (clicked === 'NOT_FOUND') {
      console.log('   ⚠️ Create button not found, trying keyboard shortcut...');
      // Try Enter key as fallback
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    }

    // Step 5: Wait for generation and download
    console.log('   [5/5] Waiting for images...');
    
    for (let i = 0; i < 300; i++) {
      await this._sleep(1000);
      
      const imgData = await this.evaluate(`(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const generated = imgs.filter(i => i.src.includes('media.getMediaUrlRedirect'));
        return JSON.stringify(generated.map(i => ({
          src: i.src,
          w: i.naturalWidth,
          h: i.naturalHeight,
        })));
      })()`);

      try {
        const images = JSON.parse(imgData);
        if (images.length > 0) {
          console.log(`   ✅ Generated ${images.length} image(s) at ${i}s!`);
          
          // Download images via canvas
          const paths = [];
          for (let j = 0; j < images.length; j++) {
            const imgPath = await this._downloadImage(j, outputDir);
            if (imgPath) paths.push(imgPath);
          }
          
          return { success: true, images: paths, mediaUrls: images.map(i => i.src) };
        }
      } catch {}

      if (i % 20 === 0) process.stdout.write(`     ${i}s...\n`);
    }

    return { success: false, error: 'Generation timed out' };
  }

  /**
   * Download a generated image at FULL resolution via chunked base64 transfer.
   * Solves the 1MB WebSocket message limit by transferring in 500KB chunks.
   * 
   * @param {number} index - Image index (0-based)
   * @param {string} outputDir - Output directory
   * @param {object} [opts] - Options
   * @param {boolean} [opts.fullSize=true] - Download at full 1376×768 resolution
   * @param {number} [opts.maxWidth] - If set, resize to this max width (quick mode)
   * @returns {Promise<string|null>} - File path or null on failure
   */
  async _downloadImage(index, outputDir, opts = {}) {
    const { fullSize = true, maxWidth } = opts;
    const ts = Date.now();

    if (fullSize && !maxWidth) {
      // ── Full resolution via chunked base64 ──
      return this._downloadFullSize(index, outputDir, ts);
    }

    // ── Quick/resized mode (single toDataURL, fits in 1 WebSocket message) ──
    const fname = `flow_${ts}_${index}.jpg`;
    const fpath = path.join(outputDir, fname);
    const targetWidth = maxWidth || 800;

    const dataUrl = await this.evaluate(`(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const img = imgs.filter(i => i.src.includes('media.getMediaUrlRedirect'))[${index}];
      if (!img) return '';
      
      const canvas = document.createElement('canvas');
      const scale = ${targetWidth} / img.naturalWidth;
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.9);
    })()`);

    if (dataUrl && dataUrl.includes('base64,')) {
      const b64 = dataUrl.split(',')[1];
      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(fpath, buf);
      console.log(`     Saved: ${fpath} (${(buf.length / 1024).toFixed(0)}KB)`);
      return fpath;
    }

    return null;
  }

  /**
   * Download full-resolution image via chunked base64 transfer.
   * Breaks the ~2.6MB base64 into 500KB chunks to stay within WebSocket limits.
   */
  async _downloadFullSize(index, outputDir, ts) {
    const fname = `flow_full_${ts}_${index}.png`;
    const fpath = path.join(outputDir, fname);

    // Step 1: Render to canvas and store base64 in window
    const setup = await this.evaluate(`(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const img = imgs.filter(i => i.src.includes('media.getMediaUrlRedirect'))[${index}];
      if (!img) return JSON.stringify({error: 'no image'});
      
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      
      const dataUrl = canvas.toDataURL('image/png');
      window.__flowB64 = dataUrl.split(',')[1];
      
      return JSON.stringify({
        w: canvas.width, h: canvas.height,
        len: window.__flowB64.length
      });
    })()`);

    try {
      const info = JSON.parse(setup);
      if (info.error) return null;

      const chunkSize = 500000;
      const chunks = [];

      // Step 2: Download in chunks
      for (let offset = 0; offset < info.len; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, info.len);
        const chunk = await this.evaluate(
          `window.__flowB64.substring(${offset}, ${end})`
        );
        if (chunk) chunks.push(chunk);
      }

      // Step 3: Reassemble and save
      const fullB64 = chunks.join('');
      const buf = Buffer.from(fullB64, 'base64');
      fs.writeFileSync(fpath, buf);
      console.log(
        `     Saved full: ${fpath} (${(buf.length / 1024).toFixed(0)}KB, ${info.w}×${info.h})`
      );
      return fpath;
    } finally {
      // Cleanup window memory
      await this.evaluate('delete window.__flowB64').catch(() => {});
    }
  }

  // Helpers
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  _httpGet(path) {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${this.port}${path}`, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
      }).on('error', reject);
    });
  }

  _httpPut(urlPath) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1',
        port: this.port,
        path: urlPath,
        method: 'PUT',
      };
      const req = http.request(opts, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
      });
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Launch Chrome with remote debugging using the user's real Chrome profile.
   * Must visit accounts.google.com first to activate the session.
   * 
   * @param {number} port - Remote debugging port (default 60807)
   * @returns {Promise<FlowCDPClient>}
   */
  static async launchWithProfile(port = 60807) {
    const { execSync } = require('child_process');
    const homeDir = require('os').homedir();
    const fs = require('fs');

    const profileDir = '/tmp/chrome-flow-debug';
    const defaultDir = `${profileDir}/Default`;
    const srcDefault = `${homeDir}/Library/Application Support/Google/Chrome/Default`;
    const srcRoot = `${homeDir}/Library/Application Support/Google/Chrome`;

    // Kill existing debug Chrome
    try { execSync('pkill -f chrome-flow-debug', { stdio: 'ignore' }); } catch {}
    await new Promise(r => setTimeout(r, 2000));

    // Copy essential auth files
    fs.mkdirSync(defaultDir, { recursive: true });
    for (const file of ['Cookies', 'Login Data', 'Web Data', 'Preferences', 'Secure Preferences', 'Network Persistent State']) {
      try { fs.copyFileSync(`${srcDefault}/${file}`, `${defaultDir}/${file}`); } catch {}
    }
    try { fs.copyFileSync(`${srcRoot}/Local State`, `${profileDir}/Local State`); } catch {}

    // Launch Chrome
    execSync(`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      --remote-debugging-port=${port} \
      --user-data-dir=${profileDir} \
      --no-first-run \
      --no-default-browser-check \
      --disable-background-networking \
      --disable-extensions \
      --window-size=1280,900 \
      'https://accounts.google.com' \
      &>/dev/null &`, { shell: '/bin/bash' });

    // Wait for Chrome to start
    await new Promise(r => setTimeout(r, 8000));

    // Verify
    const http = require('http');
    const version = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/json/version`, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });

    if (!version) throw new Error('Chrome did not start with remote debugging');
    console.log(`Chrome launched: ${version.Browser}`);

    // Wait for Google account page to load
    await new Promise(r => setTimeout(r, 5000));

    // Now create client and connect
    const client = new FlowCDPClient(port);
    await client.connect();

    // Navigate to Flow (Google session should auto-auth)
    await client.evaluate(`window.location.href = 'https://labs.google/fx/tools/flow'`);
    await new Promise(r => setTimeout(r, 10000));

    return client;
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

  const prompt = getArg('--prompt') || getArg('-p') || 'A cute golden puppy in a sunflower field at sunset';
  const port = parseInt(getArg('--port') || '60807');
  const output = getArg('--output') || getArg('-o') || '/tmp/flow_output';

  (async () => {
    const client = new FlowCDPClient(port);
    await client.connect();
    const result = await client.generate(prompt, { outputDir: output });
    console.log('\n' + JSON.stringify(result, null, 2));
  })().catch(e => { console.error('Error:', e.message); process.exit(1); });
}

module.exports = FlowCDPClient;
