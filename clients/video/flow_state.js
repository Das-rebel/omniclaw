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

(async () => {
  await new Promise(r => ws.on('open', r));

  // Check the Flow app's internal state
  console.log('Checking Flow app internal state...\n');

  const state = await eval_(`
    (() => {
      const results = {};

      // 1. Check __NEXT_DATA__ for Next.js state
      const nextData = document.getElementById('__NEXT_DATA__');
      results.nextData = nextData ? nextData.textContent?.substring(0, 500) : null;

      // 2. Check window state objects
      const windowKeys = Object.keys(window).filter(k =>
        k.includes('flow') || k.includes('state') || k.includes('store') ||
        k.includes('api') || k.includes('data') || k.includes(' gql') || k.includes('graphql')
      );
      results.windowKeys = windowKeys.slice(0, 15);

      // 3. Check Jotai atoms state
      try {
        const store = window.__JOTAI_DEFAULT_STORE__;
        if (store && store.dev4_get_mounted_atoms) {
          const atoms = store.dev4_get_mounted_atoms();
          const atomStates = [];
          for (const atom of atoms.slice(0, 20)) {
            try {
              const val = store.get(atom);
              const key = atom.debugLabel || atom.toString().substring(0, 30);
              if (val && typeof val === 'object') {
                atomStates.push({ key, hasKeys: Object.keys(val).slice(0, 10) });
              }
            } catch(e) {}
          }
          results.jotaiAtoms = atomStates;
        }
      } catch(e) {
        results.jotaiError = e.message;
      }

      // 4. Check if there's a generation in progress
      results.generationInProgress = typeof window.generateInProgress !== 'undefined' ? window.generateInProgress : 'not found';

      // 5. Check for any pending API responses
      const pendingKeys = Object.keys(window).filter(k => k.includes('pending') || k.includes('response') || k.includes('result'));
      results.pendingKeys = pendingKeys.slice(0, 10);

      return JSON.stringify(results);
    })()
  `);

  console.log(state);

  ws.close();
})().catch(e => console.error(e));
