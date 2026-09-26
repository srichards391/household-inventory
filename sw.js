// Service worker: caches the app shell so Meds opens instantly and works offline,
// and shows the breakfast and dinner push reminders sent by GitHub Actions.
// Bump CACHE_VERSION whenever app files change so installed copies pick up the update.
const CACHE_VERSION = 'meds-v1.1.0';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './sync-core.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first for the shell (so updates land), cache as the offline fallback.
// Only our own files: sync talks to api.github.com and must never be served from cache.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html')))
  );
});

// ---------- push reminders ----------
// Sent by scripts/send-push.mjs as JSON: { slot, title, body, url }.
// Always show a notification: iOS turns push off for apps that receive one silently.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* not JSON; use the defaults */ }
  const title = data.title || 'Meds';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Time for your meds. Tap to log.',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: `meds-${data.slot || 'reminder'}`,
    renotify: true,
    data: { url: data.url || './#today' },
  }));
});

// Tap: bring Meds forward on Today, or open it if it isn't running.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './#today', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (win) {
      await win.focus();
      win.postMessage({ type: 'open-today' });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
