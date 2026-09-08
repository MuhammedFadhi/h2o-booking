/* SA'DA H2O — Installer PWA service worker (v22)
   Strategy:
     - HTML/CSS/JS/manifest → stale-while-revalidate (fast + fresh)
     - Images → cache-first (rarely change)
     - Supabase & /api/* → network only (never cache)
*/
const VERSION = 'sada-installer-v22.3';
const SHELL_CACHE = `${VERSION}-shell`;
const IMAGE_CACHE = `${VERSION}-img`;

const PRECACHE = [
  './installer/portal.html',
  './installer/login.html',
  './shared/theme.css',
  './shared/ui.js',
  './shared/supabase.js',
  './assets/SADA_h2o_logo.png',
  './assets/sada-app-icon-192.png',
  './assets/sada-app-icon-512.png',
  './manifest-installer.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(PRECACHE).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

function staleWhileRevalidate(cacheName, request) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => {
      const network = fetch(request).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') cache.put(request, resp.clone());
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
}
function cacheFirst(cacheName, request) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => cached ||
      fetch(request).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') cache.put(request, resp.clone());
        return resp;
      })
    )
  );
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.hostname.includes('supabase.co') || url.pathname.startsWith('/api/')) return;
  if (url.pathname.match(/\.(png|jpg|jpeg|webp|svg|ico)$/i) && url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(IMAGE_CACHE, event.request));
    return;
  }
  if (url.pathname.startsWith('/installer/') ||
      url.pathname.startsWith('/shared/') ||
      url.pathname === '/manifest-installer.json') {
    event.respondWith(staleWhileRevalidate(SHELL_CACHE, event.request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
