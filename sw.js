// Bump this whenever cached files change so returning visitors get updates.
const CACHE_NAME = 'route-log-v9';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// HTML (the app shell page itself) uses network-first: always try to get
// the latest index.html so script order/content can never go stale like
// this again, falling back to the cached copy only when offline.
// Everything else (css/js/icons) is cache-first for speed, since those are
// versioned by CACHE_NAME above whenever they change.
//
// IMPORTANT: only intercept same-origin requests (this app's own files).
// Supabase calls are cross-origin — if this SW intercepted those too and
// anything went wrong, respondWith could resolve to nothing and the
// browser reports it as an opaque "Load failed" with no useful detail.
// Letting cross-origin requests fall through to the network normally
// means real Supabase errors surface as their actual message instead.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  const isHTML = event.request.mode === 'navigate' ||
    (event.request.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    event.respondWith(
      fetch(event.request)
        .then((fresh) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, fresh.clone()));
          return fresh;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});