const CACHE = 'motionmuse-v36';

// MediaPipe wasm + .task model files live at versioned/immutable URLs, so
// cache-first is safe and saves ~10-25MB of re-download on every cold load
// (the single biggest startup cost). Other cross-origin stays pass-through.
// Deliberately keeps its pre-rebrand name: it's an internal Cache Storage key
// holding ~15MB of MediaPipe wasm/models, and renaming it would evict them for
// a re-download with no user-visible benefit.
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
  '/src/controls.js',
  '/src/audiosession.js',
  '/src/scale.js',
  '/src/storage.js',
  '/src/dynamics.js',
  '/src/qr.js',
  '/src/share.js',
  '/src/mapper.js',
  '/src/preset.js',
  '/src/chart.js',
  '/src/chords.js',
  '/src/gesture.js',
  '/src/okcolor.js',
  '/src/overlaypalette.js',
  '/src/chordmode.js',
  '/src/radial.js',
  '/src/metronome.js',
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
  '/src/ui/viewport.js',
  '/src/ui/fullscreen.js',
  '/src/ui/cam-badge.js',
  '/src/ui/keyboard.js',
  '/src/ui/playalong-ui.js',
  '/src/ui/gesture-ui.js',
  '/src/ui/radial-ui.js',
  '/src/ui/metronome-ui.js',
  '/src/ui/numeric.js',
  '/src/ui/shader-ui.js',
  '/src/ui/signals.js',
  '/src/ui/mapper-ui.js',
  '/src/ui/arp-ui.js',
  '/src/ui/audio-ui.js',
  '/src/ui/ports.js',
  '/src/ui/rows.js',
  '/src/ui/voice-ui.js',
  '/src/ui/viz.js',
  '/src/ui/donate.js',
  '/src/ui/hotkeys.js',
  '/src/ui/share.js',
  '/src/ui/firstrun.js',
  '/src/ui/workspace.js',
  '/src/workspace.js',
  '/src/params.js',
  '/vendor/lit-html.js',
  '/vendor/d3-zoom.js',
  '/vendor/dagre.js',
  '/src/ui/theme.js',
  '/src/ui/tutorial.js',
  '/src/ui/preset-menu.js',
  '/src/ui/model-ui.js',
  '/src/ui/settings.js',
  '/src/ui/stage-ui.js',
  '/src/ui/uicontrol-ui.js',
  '/src/ui/uidriver.js',
  '/src/ui/looper-ui.js',
  '/src/arp.js',
  '/src/arpvoice.js',
  '/src/graph.js',
  '/src/midifile.js',
  '/src/songgen.js',
  '/src/build.js',
  '/src/is.js',
  '/src/mic.js',
  '/src/saved.js',
  '/src/shepard.js',
  '/src/stage.js',
  '/src/uicontrol.js',
  '/src/looper.js',
  '/src/pedal.js',
  '/src/loop-recorder.worklet.js',
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

// How long to wait for the network before falling back to cache. Long enough
// that a normal mobile connection wins, short enough that a dead one doesn't
// stall the app open.
const NET_TIMEOUT = 3500;

// Network-first for local assets, with cache fallback; cache-first for the
// immutable MediaPipe CDN files.
//
// This used to be stale-while-revalidate — `cached || network` — which is
// wrong for an app under active development, and shipped a genuinely bad
// experience: a returning user ALWAYS saw the previous build, because the
// cached copy was served and the fresh one only landed in the cache for next
// time. Someone who opened the site every few weeks could sit many releases
// behind and reasonably conclude features had been removed. Worse, each
// resource revalidated independently, so a load could mix a new index.html
// with stale modules.
//
// Network-first costs a round trip on a good connection and gives correctness:
// what you load is what's deployed. Offline still works — the fetch fails (or
// times out) and the cache answers — which is all the PWA install actually
// needs. The heavy MediaPipe wasm/models stay cache-first below: they're
// versioned, immutable, and ~15MB, so re-fetching them would be pure waste.
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
      try {
        return await withTimeout(e.request, cache);
      } catch {
        // Offline, or the network is too slow to be worth waiting for.
        const cached = await cache.match(e.request);
        if (cached) return cached;
        // A navigation with nothing cached for this exact URL still has the
        // app shell to fall back on (the SPA rewrite means every path is
        // index.html anyway).
        if (e.request.mode === 'navigate') {
          const shell = await cache.match(BASE + '/index.html');
          if (shell) return shell;
        }
        return Response.error();
      }
    })
  );
});

// Fetch with a deadline. The underlying request is deliberately NOT aborted on
// timeout: letting it finish warms the cache, so a slow connection still
// converges on fresh content for the next load.
function withTimeout(request, cache) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), NET_TIMEOUT);
    fetch(request).then(res => {
      if (res.ok) cache.put(request, res.clone()).catch(() => {});
      clearTimeout(timer);
      resolve(res);
    }).catch(err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
