const CACHE = 'biosignal-v18';

// MediaPipe wasm + .task model files live at versioned/immutable URLs, so
// cache-first is safe and saves ~10-25MB of re-download on every cold load
// (the single biggest startup cost). Other cross-origin stays pass-through.
const CDN_CACHE = 'biosignal-cdn-v1';
const CDN_RE = /(cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@|storage\.googleapis\.com\/mediapipe-models\/)/;

// Derive base from the SW's own scope so paths work whether the app is
// served from / (Cloudflare Pages, GitHub Pages custom domain) or a
// subpath like /music-maker/ (GitHub Pages project URL).
const BASE = self.registration.scope.replace(/\/$/, '');

const STATIC = [
  '/',
  '/index.html',
  '/css/main.css',
  '/src/main.js',
  '/src/bus.js',
  '/src/filter.js',
  '/src/math.js',
  '/src/engine.js',
  '/src/scale.js',
  '/src/mapper.js',
  '/src/preset.js',
  '/src/chords.js',
  '/src/gesture.js',
  '/src/chordmode.js',
  '/src/devmode.js',
  '/src/shader.js',
  '/src/soundkit.js',
  '/src/songs.js',
  '/src/playalong.js',
  '/src/cv.js',
  '/src/posebackends.js',
  '/src/depth.js',
  '/src/face.js',
  '/src/ui/status.js',
  '/src/ui/resize.js',
  '/src/ui/viewport.js',
  '/src/ui/fullscreen.js',
  '/src/ui/keyboard.js',
  '/src/ui/playalong-ui.js',
  '/src/ui/gesture-ui.js',
  '/src/ui/shader-ui.js',
  '/src/ui/signals.js',
  '/src/ui/mapper-ui.js',
  '/src/ui/audio-ui.js',
  '/src/ui/viz.js',
  '/src/ui/donate.js',
  '/src/ui/model-ui.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.json',
].map(p => BASE + p);

// Pre-cache all local static assets on install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

// Remove stale caches on activation (the CDN model cache survives app bumps)
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== CDN_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate for local assets; network-only for CDN (MediaPipe
// models, fonts). Serving from cache keeps loads instant and offline-capable,
// while the background fetch refreshes the cache so a new deploy propagates on
// the next load — no manual cache-version bump required for every change.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // MediaPipe wasm/models: cache-first (immutable versioned URLs). Everything
  // else cross-origin passes straight through.
  if (url.origin !== self.location.origin) {
    if (CDN_RE.test(url.href) && e.request.method === 'GET') {
      e.respondWith(
        caches.open(CDN_CACHE).then(async cache =>
          (await cache.match(e.request)) ??
          fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          })
        )
      );
    } else {
      e.respondWith(fetch(e.request));
    }
    return;
  }

  // Only GET requests are cacheable
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      const network = fetch(e.request)
        .then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      // Serve cache immediately when present; always revalidate in the background.
      return cached || network;
    })
  );
});
