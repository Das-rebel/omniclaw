/**
 * Flow paste-based generation test
 * Uses ClipboardEvent('paste') which Slate.js handles natively
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const PORT = 60807;
const PROMPT = process.argv[2] || 'A cute cat sleeping on a windowsill';

let msgId = 0;

function getTab() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const tabs = JSON.parse(d);
        resolve(tabs.find(t => t.url?.includes('project') && t.url?.includes('flow')));
      });
    }).on('error', reject);
  });
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: PORT, path: `/json/new?${url}`, method: 'PUT' };
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  // Create new tab
  console.log('Creating Flow tab...');
  const tab = await createTab('https://labs.google/fx/tools/flow');
  const wsUrl = tab.webSocketDebuggerUrl;
  console.log('Tab:', tab.id?.substring(0, 12));

  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.on('open', r));

  const eval_ = (expr) => new Promise((resolve, reject) => {
    const id = ++msgId;
    const handler = (data) => {
      const r = JSON.parse(data);
      if (r.id === id) { ws.removeListener('message', handler); resolve(r?.result?.result?.value); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => reject(new Error('timeout')), 15000);
  });

  const cdp = (method, params) => new Promise((resolve, reject) => {
    const id = ++msgId;
    const handler = (data) => {
      const r = JSON.parse(data);
      if (r.id === id) { ws.removeListener('message', handler); resolve(r); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error('timeout')), 10000);
  });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Wait for page load
  console.log('Waiting for page load...');
  await sleep(10000);

  // Click "Create with Flow" if on landing page
  await eval_(`(() => {
    const b = document.querySelectorAll('button');
    for (const x of b) { if (x.innerText.includes('Create with Flow')) { x.click(); return true; } }
  })()`);
  await sleep(10000);

  // Create new project
  console.log('Creating project...');
  await eval_(`(() => {
    const b = document.querySelectorAll('button');
    for (const x of b) {
      if (x.innerText.includes('New project') && x.getBoundingClientRect().width > 50) {
        x.click(); return true;
      }
    }
  })()`);
  await sleep(5000);

  // Dismiss dialogs
  for (let i = 0; i < 20; i++) {
    const r = await eval_(`(() => {
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
    await sleep(500);
  }

  // Wait for editor
  for (let i = 0; i < 15; i++) {
    if (await eval_(`!!document.querySelector('[data-slate-editor]')`) === 'true') break;
    await sleep(1000);
  }
  console.log('Editor ready');

  // Focus editor
  await eval_(`document.querySelector('[data-slate-editor]')?.focus()`);
  await sleep(500);

  // === KEY METHOD: Use ClipboardEvent paste which Slate handles natively ===
  const setText = await eval_(`
    (() => {
      const ed = document.querySelector('[data-slate-editor]');
      ed.focus();
      
      const text = ${JSON.stringify(PROMPT)};
      
      // Create and dispatch a paste event
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      ed.dispatchEvent(pasteEvent);
      
      return 'pasted';
    })()
  `);
  console.log('Paste:', setText);
  await sleep(1000);

  // Verify
  const editorText = await eval_(`document.querySelector('[data-slate-editor]')?.innerText?.trim()`);
  console.log('Editor:', editorText?.substring(0, 50));

  if (!editorText || editorText === 'What do you want to create?') {
    console.log('Paste failed, trying execCommand fallback...');
    await eval_(`document.querySelector('[data-slate-editor]')?.focus()`);
    await sleep(200);
    await eval_(`document.execCommand('insertText', false, ${JSON.stringify(PROMPT)})`);
    await sleep(500);
    const t2 = await eval_(`document.querySelector('[data-slate-editor]')?.innerText?.trim()`);
    console.log('After execCommand:', t2?.substring(0, 50));
  }

  // Click arrow_forward Create button
  const clicked = await eval_(`
    (() => {
      const b = document.querySelectorAll('button');
      for (const x of b) {
        const t = x.innerText.trim();
        const y = x.getBoundingClientRect().y;
        if (t.includes('arrow_forward') && y > 500 && x.getBoundingClientRect().width > 0) {
          x.click(); return 'clicked: ' + t;
        }
      }
      return 'not found';
    })()
  `);
  console.log('Create button:', clicked);

  // Wait for generation
  console.log('Waiting for images...');
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const imgCount = await eval_(`
      (() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        return imgs.filter(i => i.src.includes('media.getMediaUrlRedirect')).length;
      })()
    `);

    if (parseInt(imgCount) > 0) {
      console.log(`Generated ${imgCount} image(s) at ${i * 2}s!`);

      // Download first image full-size via chunks
      const info = JSON.parse(await eval_(`
        (() => {
          const imgs = Array.from(document.querySelectorAll('img'));
          const img = imgs.filter(i => i.src.includes('media.getMediaUrlRedirect'))[0];
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          window.__b64 = c.toDataURL('image/png').split(',')[1];
          return JSON.stringify({w: c.width, h: c.height, len: window.__b64.length});
        })()
      `));

      const chunkSize = 500000;
      const chunks = [];
      for (let off = 0; off < info.len; off += chunkSize) {
        const end = Math.min(off + chunkSize, info.len);
        const chunk = await eval_(`window.__b64.substring(${off}, ${end})`);
        if (chunk) chunks.push(chunk);
      }

      const buf = Buffer.from(chunks.join(''), 'base64');
      const outPath = `/tmp/flow_output/paste_test_${Date.now()}.png`;
      fs.mkdirSync('/tmp/flow_output', { recursive: true });
      fs.writeFileSync(outPath, buf);
      console.log(`Saved: ${outPath} (${(buf.length / 1024).toFixed(0)}KB, ${info.w}x${info.h})`);
      await eval_('delete window.__b64');
      ws.close();
      return;
    }

    if (i % 10 === 0) console.log(`  ${i * 2}s...`);
  }

  console.log('Timed out');
  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
