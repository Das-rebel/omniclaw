const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:60807/devtools/page/68B9EAC60F5AAB97947C3F0564059DBF');

ws.on('open', () => {
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `JSON.stringify({
        creditText: (document.body.innerText.match(/(credit|quota|limit|remaining|left|free|used|generation|today|\\d+\\/\\d+)/gi) || []).slice(0, 20)
      })`,
      returnByValue: true
    }
  }));
});

ws.on('message', data => {
  const r = JSON.parse(data);
  console.log(r?.result?.result?.value);
  ws.close();
});

setTimeout(() => process.exit(1), 5000);
