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

  // Deep search for ANY image or media elements on the page
  console.log('Searching for ALL images and media elements...\n');

  const results = await eval_(`
    (() => {
      const results = {};

      // 1. All img elements
      const imgs = Array.from(document.querySelectorAll('img'));
      results.images = imgs.map(i => ({
        src: i.src.substring(0, 80),
        w: i.naturalWidth,
        h: i.naturalHeight,
        visible: i.getBoundingClientRect().width > 0
      }));

      // 2. Picture elements
      const pictures = Array.from(document.querySelectorAll('picture'));
      results.pictures = pictures.length;

      // 3. Video elements
      const videos = Array.from(document.querySelectorAll('video'));
      results.videos = videos.length;

      // 4. Canvas elements
      const canvases = Array.from(document.querySelectorAll('canvas'));
      results.canvases = canvases.length;

      // 5. Elements with background-image
      const withBg = Array.from(document.querySelectorAll('*')).filter(el => {
        const style = window.getComputedStyle(el);
        return style.backgroundImage && style.backgroundImage !== 'none' && style.backgroundImage.includes('url');
      });
      results.withBackgroundImage = withBg.length;

      // 6. Check for data URIs
      const dataUriEls = Array.from(document.querySelectorAll('img[src^="data:"]'));
      results.dataUriImages = dataUriEls.length;

      // 7. Check for media.getMediaUrlRedirect URLs anywhere
      const allEls = Array.from(document.querySelectorAll('*'));
      const mediaRedirects = [];
      for (const el of allEls) {
        const src = el.src || '';
        const href = el.href || '';
        const dataSrc = el.getAttribute('data-src') || '';
        const mediaSrc = el.getAttribute('media-src') || '';
        if (src.includes('media') || href.includes('media') || dataSrc.includes('media') || mediaSrc.includes('media')) {
          mediaRedirects.push({ tag: el.tagName, src: src.substring(0, 50), href: href.substring(0, 50) });
        }
      }
      results.mediaRedirects = mediaRedirects.slice(0, 10);

      // 8. Check localStorage and sessionStorage for any media URLs
      let storageMedia = [];
      try {
        for (let key in localStorage) {
          if (localStorage[key] && typeof localStorage[key] === 'string' && 
              (localStorage[key].includes('media.getMediaUrlRedirect') || 
               localStorage[key].includes('.googleusercontent.com'))) {
            storageMedia.push(key.substring(0, 30));
          }
        }
      } catch(e) {}
      results.storageMedia = storageMedia.slice(0, 5);

      // 9. Check if there's a loading state
      const loading = document.querySelector('[class*=loading], [class*=spinner], [role=progressbar]');
      results.isLoading = !!loading;

      // 10. Check for any error banners or messages
      const errorEls = Array.from(document.querySelectorAll('[class*=error], [class*=Error], [role=alert]'));
      results.errors = errorEls.map(e => e.innerText?.trim()?.substring(0, 50)).slice(0, 5);

      return JSON.stringify(results);
    })()
  `);

  console.log(results);

  ws.close();
})().catch(e => console.error(e));
