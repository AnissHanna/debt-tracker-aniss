// My Debt Tracker service worker.
// Caches only the app files. It never reads, clears or migrates localStorage / IndexedDB,
// so payment records and receipt images are untouched by installs and updates.
const VERSION = 'mdt-shell-v5';
const RUNTIME = 'mdt-runtime';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './config.js',
  './mdt-sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mdt-shell-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pages: network first so updates arrive, cached copy when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copy)); } return res; })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // config.js: network first (so a changed key arrives), cached copy offline.
  if (url.origin === self.location.origin && url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; }).catch(() => caches.match(req)));
    return;
  }

  // App files: cache first.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // Google Fonts + the pinned Supabase JS client: cached copy first, refreshed in the background.
  // Supabase API / Storage calls are never cached.
  if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/@supabase/supabase-js@2/'))) {
    e.respondWith(
      caches.open(RUNTIME).then((c) => c.match(req).then((hit) => {
        const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      }))
    );
  }
});
