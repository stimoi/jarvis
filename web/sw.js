// Service worker minimal : rend l'appli installable (PWA) et met la coquille en cache.
// Les appels /api et /ws ne sont jamais mis en cache.
const CACHE = 'jarvis-shell-v2';
const SHELL = ['/', '/chat/', '/auth/', '/css/hud.css', '/css/chat.css', '/css/landing.css', '/js/app.js', '/js/wake.js', '/js/worklet.js', '/js/reactor.js', '/js/auth.js', '/js/landing.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname === '/ws') return;
  // Réseau d'abord (toujours la dernière version), cache en secours hors-ligne.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))),
  );
});
