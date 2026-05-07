#!/usr/bin/env node
/**
 * Full-size image download from Flow via chunked base64 transfer
 * Solves the 1MB WebSocket message limit by downloading base64 in 500KB chunks
 */
const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');

const PORT = parseInt(process.argv[2] || '60807');
const IMAGE_INDEX = parseInt(process.argv[3] || '0');
const OUTPUT = process.argv[4] || `/flow_output/fullsize_${Date.now()}.png`;

async function findProjectTab() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const tabs = JSON.parse(data);
          const tab = tabs.find(t => t.url?.includes('project') && t.url?.includes('flow'));
          resolve(tab);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const tab = await findProjectTab();
  if (!tab) {
    console.error('No Flow project tab found');
    process.exit(1);
  }

  const wsUrl = tab.webSocketDebuggerUrl;
  let msgId = 0;

  const eval_ = (expr) => new Promise((resolve, reject) => {
    const id = ++msgId;
    const handler = (data) => {
      const r = JSON.parse(data);
      if (r.id === id) {
        ws.removeListener('message', handler);
        resolve(r?.result?.result?.value);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => reject(new Error('eval timeout')), 15000);
  });

  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.on('open', r));

  // Step 1: Draw full-size image to canvas, store base64 in window
  const setup = await eval_(`(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    const gen = imgs.filter(i => i.src.includes('media.getMediaUrlRedirect'));
    if (!gen.length) return JSON.stringify({error: 'no images'});
    
    const img = gen[${IMAGE_INDEX}];
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    
    // Use JPEG for better compression at full resolution
    const dataUrl = c.toDataURL('image/png');
    window.__flowB64 = dataUrl.split(',')[1];
    
    return JSON.stringify({ w: c.width, h: c.height, len: window.__flowB64.length });
  })()`);

  const info = JSON.parse(setup);
  if (info.error) {
    console.error('Error:', info.error);
    ws.close();
    process.exit(1);
  }

  console.log(`Image: ${info.w}x${info.h}, base64 length: ${info.len}`);

  // Step 2: Download in chunks of 500KB
  const chunkSize = 500000;
  const totalChunks = Math.ceil(info.len / chunkSize);
  const chunks = [];

  for (let offset = 0; offset < info.len; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, info.len);
    const chunkNum = Math.floor(offset / chunkSize) + 1;
    const chunk = await eval_(`window.__flowB64.substring(${offset}, ${end})`);
    if (chunk) {
      chunks.push(chunk);
      process.stdout.write(`  Chunk ${chunkNum}/${totalChunks} (${end}/${info.len})\n`);
    }
  }

  // Step 3: Reassemble and save
  const fullB64 = chunks.join('');
  const buf = Buffer.from(fullB64, 'base64');
  const outPath = OUTPUT;
  fs.writeFileSync(outPath, buf);
  console.log(`\nSaved: ${outPath} (${(buf.length / 1024).toFixed(0)}KB, ${info.w}x${info.h})`);

  // Cleanup
  await eval_('delete window.__flowB64');
  ws.close();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
