// Minimal service worker. This app is live/real-time (screen share, chat,
// voice) and shouldn't be used "offline" in any meaningful way — this
// exists mainly to satisfy PWA installability and make the static shell
// (HTML/CSS/JS/icons) load instantly on repeat visits. It deliberately
// does NOT cache or intercept socket.io/API requests.
const CACHE_NAME = 'us-watch-shell-v2';
const SHELL_FILES = ['/', '/index.html', '/style.css', '/client.js', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never touch real-time or API traffic — only serve the static shell from cache.
  if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  // Network-first: always prefer the live file so deploys show up right
  // away. Only fall back to the cached copy if the network request fails
  // (actually offline) — this is the opposite of cache-first, which would
  // otherwise keep serving stale HTML/CSS/JS indefinitely after an update.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
