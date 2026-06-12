const CACHE_NAME = 'patch-v15';
const STATIC_ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return;

  // Bypass the SW for Supabase: let the browser fetch it directly. The old
  // caches.match fallback was never populated (API responses aren't cached),
  // so on failure it resolved undefined and respondWith threw "FetchEvent ...
  // returned response is null". Bypassing lets offline failures reject
  // natively to the app instead of a manufactured null response.
  if (url.hostname.includes('supabase.co')) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
