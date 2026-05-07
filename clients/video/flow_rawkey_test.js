/**
 * Test rawKeyDown character-by-character typing for Slate.js
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const PORT = 60807;
const PROMPT = process.argv[2] || 'A cute cat sleeping on a windowsill';

let msgId = 0;

function findTab() {
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

async function main() {
  const tab = await findTab();
  if (!tab) { console.error('No Flow project tab'); process.exit(1); }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
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

  // Focus editor via click
  const rect = JSON.parse(await eval_(`
    JSON.stringify((() => {
      const ed = document.querySelector('[data-slate-editor]');
      const r = ed.getBoundingClientRect();
      return {x: r.x + r.width/2, y: r.y + r.height/2};
    })())
  `));

  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left' });
  await sleep(500);

  // Try Input.insertText (simplest, worked before)
  await cdp('Input.insertText', { text: PROMPT });
  await sleep(1000);

  // Check result
  let text = await eval_("document.querySelector('[data-slate-editor]')?.innerText?.trim()");
  console.log('After insertText:', text?.substring(0, 60));

  if (!text || text === 'What do you want to create?') {
    console.log('insertText failed, trying rawKeyDown...');
    // Focus again
    await eval_("document.querySelector('[data-slate-editor]')?.focus()");
    await sleep(300);

    // rawKeyDown each character
    for (const ch of PROMPT) {
      await cdp('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: ch === ' ' ? ' ' : ch,
        code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`,
        windowsVirtualKeyCode: ch.charCodeAt(0),
      });
      await cdp('Input.dispatchKeyEvent', {
        type: 'char',
        text: ch,
        key: ch,
      });
      await cdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: ch === ' ' ? ' ' : ch,
        code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`,
        windowsVirtualKeyCode: ch.charCodeAt(0),
      });
    }
    await sleep(500);

    text = await eval_("document.querySelector('[data-slate-editor]')?.innerText?.trim()");
    console.log('After rawKeyDown:', text?.substring(0, 60));
  }

  if (!text || text === 'What do you want to create?') {
    console.log('All methods failed');
    ws.close();
    process.exit(1);
  }

  console.log('Text set! Clicking Create...');

  // Click arrow_forward Create
  const clicked = await eval_(`
    (() => {
      const b = document.querySelectorAll('button');
      for (const x of b) {
        const t = x.innerText.trim();
        const y = x.getBoundingClientRect().y;
        if (t.includes('arrow_forward') && y > 500 && x.getBoundingClientRect().width > 0) {
          x.click(); return 'clicked';
        }
      }
      return 'not found';
    })()
  `);
  console.log('Create button:', clicked);

  // Wait for images
  console.log('Waiting for generation...');
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const count = await eval_(`
      (() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        return imgs.filter(i => i.src.includes('media.getMediaUrlRedirect')).length;
      })()
    `);

    if (parseInt(count) > 0) {
      console.log(`Generated ${count} image(s) at ${i * 2}s!`);

      // Download via chunks
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
      const outPath = `/tmp/flow_output/rawkey_test_${Date.now()}.png`;
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
