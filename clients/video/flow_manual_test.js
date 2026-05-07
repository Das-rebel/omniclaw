const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const PORT = 60807;
const PROMPT = process.argv[2] || 'A red sports car on a coastal highway at golden hour';

async function getTab() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const tabs = JSON.parse(d);
        const tab = tabs.find(t => t.url?.includes('project') && t.url?.includes('flow'));
        resolve(tab);
      });
    }).on('error', reject);
  });
}

async function main() {
  const tab = await getTab();
  if (!tab) { console.error('No project tab'); process.exit(1); }
  
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let msgId = 0;
  
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++msgId;
    const handler = (data) => {
      const r = JSON.parse(data);
      if (r.id === id) { ws.removeListener('message', handler); resolve(r); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error('timeout')), 10000);
  });
  
  const eval_ = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true })
    .then(r => r?.result?.result?.value);

  await new Promise(r => ws.on('open', r));
  
  // Click on editor
  const rect = JSON.parse(await eval_(`
    JSON.stringify((() => {
      const ed = document.querySelector('[data-slate-editor]');
      const r = ed.getBoundingClientRect();
      return {x: r.x + r.width/2, y: r.y + r.height/2};
    })())
  `));
  
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left' });
  await new Promise(r => setTimeout(r, 500));
  
  // Type prompt
  await send('Input.insertText', { text: PROMPT });
  await new Promise(r => setTimeout(r, 1000));
  
  const text = await eval_(`document.querySelector('[data-slate-editor]')?.innerText?.trim()`);
  console.log('Editor text:', text?.substring(0, 50));
  
  if (!text || text === 'What do you want to create?') {
    console.log('Prompt not set, aborting');
    ws.close();
    process.exit(1);
  }
  
  // Click arrow_forward Create
  const clicked = await eval_(`
    (() => {
      const b = document.querySelectorAll('button');
      for (const x of b) {
        const t = x.innerText.trim();
        const y = x.getBoundingClientRect().y;
        if (t.includes('arrow_forward') && y > 500 && x.getBoundingClientRect().width > 0) {
          x.click();
          return 'clicked: ' + t;
        }
      }
      return 'not found';
    })()
  `);
  console.log('Button:', clicked);
  
  // Wait for generation
  console.log('Waiting for images...');
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const imgData = await eval_(`
      (() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const gen = imgs.filter(i => i.src.includes('media.getMediaUrlRedirect'));
        return JSON.stringify(gen.map(i => ({w: i.naturalWidth, h: i.naturalHeight})));
      })()
    `);
    try {
      const imgs = JSON.parse(imgData);
      if (imgs.length > 0) {
        console.log(`\nGenerated ${imgs.length} image(s) at ${i}s!`);
        imgs.forEach((img, j) => console.log(`  [${j}] ${img.w}x${img.h}`));
        
        // Download first image full-size
        // Store base64 in window first
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
        console.log(`Image: ${info.w}x${info.h}, b64 len: ${info.len}`);
        
        // Chunked download
        const chunkSize = 500000;
        const chunks = [];
        for (let off = 0; off < info.len; off += chunkSize) {
          const end = Math.min(off + chunkSize, info.len);
          const chunk = await eval_(`window.__b64.substring(${off}, ${end})`);
          if (chunk) chunks.push(chunk);
        }
        
        const buf = Buffer.from(chunks.join(''), 'base64');
        const outPath = `/tmp/flow_output/manual_test_${Date.now()}.png`;
        fs.mkdirSync('/tmp/flow_output', { recursive: true });
        fs.writeFileSync(outPath, buf);
        console.log(`Saved: ${outPath} (${(buf.length/1024).toFixed(0)}KB)`);
        
        await eval_('delete window.__b64');
        ws.close();
        process.exit(0);
      }
    } catch {}
    
    if (i % 10 === 0) process.stdout.write(`  ${i}s...\n`);
  }
  
  console.log('Timed out');
  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
