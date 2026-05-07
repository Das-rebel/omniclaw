const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:60807/devtools/page/68B9EAC60F5AAB97947C3F0564059DBF');

let msgId = 0;

const eval_ = (expr) => new Promise((resolve) => {
  const id = ++msgId;
  const handler = (data) => {
    const r = JSON.parse(data);
    if (r.id === id) { ws.removeListener('message', handler); resolve(r?.result?.result?.value); }
  };
  ws.on('message', handler);
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  setTimeout(() => resolve(null), 10000);
});

const cdp = (method, params) => new Promise((resolve) => {
  const id = ++msgId;
  const handler = (data) => {
    const r = JSON.parse(data);
    if (r.id === id) { ws.removeListener('message', handler); resolve(r); }
  };
  ws.on('message', handler);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => resolve(null), 10000);
});

(async () => {
  await new Promise(r => ws.on('open', r));

  console.log('1. Setting prompt...');
  await eval_("document.querySelector('[data-slate-editor]')?.focus()");
  await cdp('Input.insertText', { text: 'A red balloon' });
  await new Promise(r => setTimeout(r, 1000));

  const text = await eval_("document.querySelector('[data-slate-editor]')?.innerText?.trim()");
  console.log('Editor:', text?.substring(0, 30));

  console.log('\n2. Analyzing Create button...');
  const buttonInfo = await eval_(`
    (() => {
      const bts = document.querySelectorAll('button');
      for (const x of bts) {
        const t = x.innerText.trim();
        const y = x.getBoundingClientRect().y;
        if (t.includes('arrow_forward') && y > 500) {
          return JSON.stringify({
            text: t,
            y: y,
            hasOnClick: !!x.onclick,
            hasClickAttr: !!x.getAttribute('onclick'),
            tagName: x.tagName,
            className: x.className,
            id: x.id,
            role: x.getAttribute('role')
          });
        }
      }
      return 'not found';
    })()
  `);
  console.log('Button info:', buttonInfo);

  console.log('\n3. Clicking button via dispatchEvent...');
  const clickResult = await eval_(`
    (() => {
      const bts = document.querySelectorAll('button');
      for (const x of bts) {
        const t = x.innerText.trim();
        const y = x.getBoundingClientRect().y;
        if (t.includes('arrow_forward') && y > 500) {
          const rect = x.getBoundingClientRect();
          const centerX = rect.x + rect.width / 2;
          const centerY = rect.y + rect.height / 2;
          const event = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: centerX,
            clientY: centerY
          });
          x.dispatchEvent(event);
          return 'clicked via MouseEvent';
        }
      }
      return 'not found';
    })()
  `);
  console.log('Click result:', clickResult);

  await new Promise(r => setTimeout(r, 3000));

  console.log('\n4. After click:');
  const state = await eval_(`
    (() => {
      const imgs = document.querySelectorAll('img');
      const gen = Array.from(imgs).filter(i => i.src.includes('media.getMediaUrlRedirect'));
      const editor = document.querySelector('[data-slate-editor]')?.innerText?.trim() || '';
      return JSON.stringify({genCount: gen.length, editor: editor.substring(0, 30)});
    })()
  `);
  console.log('State:', state);

  ws.close();
})().catch(e => console.error(e));
