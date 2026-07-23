"use strict";
// Bump this on any change to the cached file list (including editing the files
// themselves) so clients pick up the new version instead of a stale cache.
const CACHE_NAME = "inkpad-shell-v20";

const ASSETS = [
  "./index.html",
  "./app.html",
  "./style.css",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/state.js",
  "./js/history.js",
  "./js/render.js",
  "./js/debug-hud.js",
  "./js/input.js",
  "./js/clipboard.js",
  "./js/text-edit.js",
  "./js/audio.js",
  "./js/images.js",
  "./js/shape-tools.js",
  "./js/shape-svg.js",
  "./js/dialogs.js",
  "./js/pages-pdf.js",
  "./js/storage.js",
  "./js/drive-sync.js",
  "./js/pdf-export.js",
  "./js/toolbar-ui.js",
  "./js/sidebar.js",
  "./js/random-tools.js",
  "./js/timer.js",
  "./js/keymap-colorring.js",
  "./js/main.js",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate for the app shell only: answer instantly from cache
// (so it works offline and loads fast), then refetch in the background to
// update the cache for next time. Cross-origin requests (Drive API, Google
// auth) are left alone entirely — never intercepted or cached.
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;

  e.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(req);
      const network = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
