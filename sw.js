/*
 * sw.js — offline support for pdfThings.
 *
 * Bump CACHE_VERSION whenever any cached file changes so the new files
 * replace the old ones instead of being masked by a stale cache.
 * Tesseract.js's OCR engine/language data is deliberately NOT precached
 * here — it's several MB and most sessions never touch OCR, so it's
 * fetched (and then opportunistically cached) only when first used.
 */
const CACHE_VERSION = 'pdfthings-v6';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './offline.html',
  './css/styles.css',
  './js/db.js',
  './js/pdf-tools.js',
  './js/annotate.js',
  './js/scan.js',
  './js/forms.js',
  './js/ocr.js',
  './js/ai.js',
  './js/thumbnails.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.7/Sortable.min.js',
  'https://cdn.jsdelivr.net/npm/pdf-lib-plus-encrypt@1.1.0/dist/pdf-lib-plus-encrypt.iife.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(APP_SHELL);
    // best-effort: don't let one flaky CDN request block install
    await Promise.all(CDN_ASSETS.map(async (url) => {
      try { const res = await fetch(url, { mode: 'cors' }); if (res.ok) await cache.put(url, res); } catch (e) { /* will fetch live later */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isCdn = CDN_ASSETS.includes(req.url) || url.hostname.includes('cdnjs.cloudflare.com') || url.hostname.includes('jsdelivr.net') || url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com');

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match('./index.html')) || (await cache.match('./offline.html'));
      }
    })());
    return;
  }

  if (isCdn) {
    // pinned-version CDN assets are effectively immutable — cache-first
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        // Don't override the request's mode — a plain <script src> without
        // a crossorigin attribute is issued as 'no-cors' by the browser,
        // and forcing 'cors' here could fetch something the browser
        // itself wouldn't have accepted the same way.
        const res = await fetch(req);
        // opaque (no-cors) responses read .ok === false even on success —
        // still cache them, just don't try to inspect their status.
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return hit || Response.error();
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const hit = await cache.match(req);
      const network = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await network) || Response.error();
    })());
  }
});
