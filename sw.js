// Service worker for installing Service Desk Hub as an app.
// It always fetches the latest files from the network, so updates you upload
// to GitHub show up on the next open. The cache is only a fallback for when
// the network is down. Team data never goes through here: it lives in
// data.json in the OneDrive folder each person picked.
const CACHE = 'sdh-v4';
const FILES = ['./', './index.html', './styles.css', './app.js', './favicon.png', './app-icon-192.png', './app-icon-512.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  ev.respondWith(
    // cache: 'no-cache' makes the browser ask GitHub "has this changed?" every
    // time instead of reusing its copy for up to 10 minutes. Unchanged files
    // come back as a tiny "not modified", so it stays fast.
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
