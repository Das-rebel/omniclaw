/**
 * Flow Video Generation Test
 * Select Veo model and generate video instead of image
 */
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 60807;

let msgId = 0;

function findTab() {
  return new Promise((resolve, reject) => {
    const http = require('http');
    http.get(`http://127.0.0.1:${PORT}/json/list`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const tabs = JSON.parse(d);
        resolve(tabs.find(t => t.url?.includes('flow')));
      });
    }).on('error', reject);
  });
}

async function main() {
  const tab = await findTab();
  if (!tab) { console.error('No Flow tab'); process.exit(1); }
  
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

  console.log('Creating new project...');
  
  // Navigate to new project
  await eval_("window.location.href = 'https://labs.google/fx/tools/flow/project/new'");
  await sleep(8000);
  
  // Dismiss dialogs
  for (let i = 0; i < 15; i++) {
    const r = await eval_(`
      (() => {
        const b = document.querySelectorAll('button');
        for (const x of b) {
          const t = x.innerText.trim();
          if (['Continue','Accept','Next','Get started','Close','Got it'].includes(t)) {
            const rect = x.getBoundingClientRect();
            if (rect.width > 0) { x.click(); return t; }
          }
        }
        return 'none';
      })()
    `);
    if (r === 'none') break;
    await sleep(500);
  }
  
  // Wait for editor
  for (let i = 0; i < 10; i++) {
    const has = await eval_("!!document.querySelector('[data-slate-editor]')");
    if (has === true || has === 'true') break;
    await sleep(1000);
  }
  
  // Find and click model selector to choose Veo
  console.log('Looking for Veo model...');
  const modelInfo = await eval_(`
    (() => {
      // Find model selector button (shows current model like "Nano Banana 2")
      const btns = document.querySelectorAll('button');
      for (const x of btns) {
        const t = x.innerText.trim();
        if (t.includes('Nano Banana') || t.includes('Veo')) {
          return t;
        }
      }
      return 'not found';
    })()
  `);
  console.log('Current model:', modelInfo);
  
  // Set prompt
  const prompt = 'A flowing river in a forest at sunset, cinematic';
  await eval_("document.querySelector('[data-slate-editor]')?.focus()");
  await sleep(300);
  await cdp('Input.insertText', { text: prompt });
  await sleep(1000);
  
  // Verify
  const text = await eval_("document.querySelector('[data-slate-editor]')?.innerText?.trim()");
  console.log('Prompt set:', text?.substring(0, 40));
  
  // Click Create
  await eval_(`
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
  
  console.log('Waiting for video generation (this may take 2-5 minutes)...');
  
  // Wait for video (longer timeout)
  for (let i = 0; i < 360; i++) {
    await sleep(10000); // 10 second intervals
    
    const result = await eval_(`
      (() => {
        // Look for video elements
        const videos = document.querySelectorAll('video');
        const sources = document.querySelectorAll('video source');
        const imgs = Array.from(document.querySelectorAll('img'));
        const gen = imgs.filter(i => i.src.includes('media.getMediaUrlRedirect'));
        
        return JSON.stringify({
          videos: videos.length,
          sources: sources.length,
          generatedImages: gen.length,
          body: document.body.innerText.substring(0, 200)
        });
      })()
    `);
    
    const r = JSON.parse(result);
    console.log(`[${Math.floor(i*10/60)}m] videos: ${r.videos}, images: ${r.generatedImages}`);
    
    if (r.videos > 0 || r.sources > 0 || r.generatedImages > 0) {
      console.log('FOUND MEDIA!');
      break;
    }
    
    if (i % 6 === 0) {
      console.log(`Waiting... ${Math.floor(i*10/60)} min`);
    }
  }
  
  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
