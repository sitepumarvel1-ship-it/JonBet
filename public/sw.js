'use strict';
// Service worker JonBet: menyimpan "kerangka" aplikasi agar cepat dibuka dan bisa dipasang.
// Data (API dan berkas data/ pada versi GitHub Pages) TIDAK pernah di-cache: aplikasi hanya berfungsi saat online.
// Semua alamat relatif terhadap lokasi sw.js, sehingga jalan di akar domain maupun subfolder (github.io/nama-repo/).
// Naikkan VERSION setiap kali berkas di folder public berubah (build GitHub Pages mengisinya otomatis dari isi berkas).
const VERSION = 'v2';
const CACHE = `jonbet-${VERSION}`;
const SCOPE = new URL('./', self.location).href;
const at = (p) => new URL(p, SCOPE).href;
// js/static/claude.js diimpor langsung oleh views/match.js: tanpa itu di cache, aplikasi tidak bisa dibuka saat offline.
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'css/app.css',
  'js/main.js', 'js/mode.js', 'js/dom.js', 'js/api.js', 'js/state.js', 'js/format.js', 'js/icons.js', 'js/logo.js', 'js/logo-art.js',
  'js/charts.js', 'js/components.js', 'js/router.js', 'js/auth.js',
  'js/views/home.js', 'js/views/matches.js', 'js/views/match.js', 'js/views/community.js', 'js/views/profile.js', 'js/views/about.js', 'js/views/ask.js',
  'js/static/claude.js', 'js/notify.js',
  'fonts/inter-400.woff', 'fonts/inter-600.woff', 'fonts/inter-display-700.woff', 'fonts/inter-display-800.woff',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-64.png',
].map(at);

// Hosting statis (GitHub Pages) memberi Cache-Control: max-age=600. Agar versi baru tidak mengambil berkas lama dari
// cache HTTP peramban, semua pengambilan oleh service worker memakai cache: 'reload' (pasang) atau 'no-cache' (cek ulang).
async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map(async (u) => {
    const res = await fetch(new Request(u, { cache: 'reload' }));
    if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`);
    await cache.put(u, res);
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('jonbet-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Ketukan pada notifikasi: fokuskan jendela JonBet yang ada dan buka laganya; bila tidak ada, buka jendela baru.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = String(event.notification.data?.hash || '');
  const safe = /^#\/match\/[^/?#\s]+$/.test(hash) ? hash : '';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (!c.url.startsWith(SCOPE)) continue;
      try { await c.focus(); c.postMessage({ type: 'jb:open', hash: safe }); return; } catch { /* coba jendela lain */ }
    }
    await self.clients.openWindow(SCOPE + safe);
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const rel = url.href.startsWith(SCOPE) ? url.href.slice(SCOPE.length) : url.pathname;
  if (rel.startsWith('api/') || rel.startsWith('data/') || url.pathname.startsWith('/api/')) return; // data: langsung ke jaringan

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok) (await caches.open(CACHE)).put(at('index.html'), fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(at('index.html'))) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const net = fetch(new Request(req, { cache: 'no-cache' })).then((res) => { if (res && res.status === 200) cache.put(req, res.clone()); return res; }).catch(() => null);
    return cached || (await net) || Response.error();
  })());
});
