// Which build am I actually looking at?
//
// This app is a PWA with a network-first service worker, so a redeploy is
// supposed to be visible on the very next load — and tests/sw-freshness asserts
// exactly that. But "supposed to" is not "confirmed": between Netlify's edge,
// the browser's own HTTP cache and the service worker, there are three places a
// stale copy can hide, and until now there was no way to tell which build was
// on screen except guessing from whether a feature had appeared.
//
// Two sources, best first:
//
//   build.json   written at deploy time (scripts/stamp.mjs) with the real
//                commit. Exact, but only exists where that script has run.
//   Last-Modified  of index.html, read with a HEAD request. Always available on
//                any static host, and answers the question that actually
//                matters — "is this the copy that was deployed most recently?"
//
// Both are fetched with `cache: 'no-store'`, which is the point: asking the
// question through a cache would return the cached answer.

const short = sha => (sha && sha !== 'unknown' ? sha.slice(0, 7) : null);

const fmt = iso => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? null
    : d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
};

let cached = null;

export async function buildInfo() {
  if (cached) return cached;

  // 1. A stamp written at deploy time.
  try {
    const res = await fetch('build.json', { cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      if (j.commit || j.built) {
        return (cached = {
          commit: short(j.commit),
          built: fmt(j.built),
          source: 'stamp',
        });
      }
    }
  } catch { /* not deployed with a stamp — fall through */ }

  // 2. When index.html was last written. A HEAD request so it costs no body.
  try {
    const res = await fetch('index.html', { method: 'HEAD', cache: 'no-store' });
    const lm = res.headers.get('last-modified');
    if (lm) return (cached = { commit: null, built: fmt(lm), source: 'header' });
  } catch { /* offline, or a host that sends no Last-Modified */ }

  return (cached = { commit: null, built: null, source: 'unknown' });
}

// One short line for a UI that has no room for two.
export const buildLabel = b =>
  b.commit && b.built ? `${b.commit} · ${b.built}`
  : b.commit ? b.commit
  : b.built  ? b.built
  : 'unstamped (local?)';
