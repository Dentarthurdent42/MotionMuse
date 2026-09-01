// Round-trip check for the handshape illustrations.
//
// scripts/handshapes.mjs poses a 3D hand from each template's feature vector
// and renders it. That guarantees the picture is DRIVEN by the template — it
// does not guarantee the picture is FAITHFUL to it, because the decode is a
// reading of the vector rather than its inverse (no exact inverse exists: 12
// numbers summarising 21 landmarks is lossy). So a wrong-looking picture was
// unattributable — bad template, or bad decoder, no way to tell.
//
// This closes the loop. Pose the shared rig from a template, read the 21
// landmarks straight off it, run them through the same math.js the camera
// pipeline uses, and compare what comes out against what went in:
//
//   f → pose(rig) → landmarks → math.js → f'          f' ≈ f ?
//
// Two failure modes, now distinguishable:
//
//   f' far from f          the decoder misread the template. The picture shows
//                          a hand the template did not describe. Fix pose() in
//                          scripts/handrig.js.
//   f' ≈ f, picture wrong  the decoder is faithful and the TEMPLATE describes
//                          the wrong hand. Recalibrate it (Gestures →
//                          CALIBRATE) or re-derive it in src/gesture.js.
//
// The landmarks come off the rig rather than from MediaPipe run over the PNG,
// which was the first thing tried. MediaPipe is trained on photographs and
// finds this capsule hand only sporadically, and only with the detector opened
// to 0.03 confidence — landmarks from a detection that weak measure nothing,
// and a flaky check is worse than none. The rig knows where every joint is.
//
// The four measured templates (fist, point, peace, thumbs) come from reference
// photos and are ground truth, so a round-trip failure there is the decoder's
// fault with nothing to argue about — they are the hard assertions. The ten
// `est` templates are reported, not enforced: a mismatch there is exactly the
// ambiguity above, and failing a build over an estimate would pin the estimate
// in place.
//
// Needs a Chromium and three.js from node_modules — the same prerequisites as
// scripts/handshapes.mjs. Skips with a clear message if either is absent.

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { createServer } from 'http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const THREE_DIR = join(ROOT, 'node_modules/three');
const CHROME = process.env.CHROME
  ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);

// How far a round-tripped vector may drift before the picture is calling the
// template a liar. Not zero, and it should not be: the rig is capsules with
// invented proportions, so a straight finger of the wrong length reads as a
// slightly different extension. It is set well below the 0.15 separation floor
// between two DIFFERENT templates, so anything that drifts past this is closer
// to being some other handshape than to being its own — which is the point at
// which the picture stops teaching the right shape.
const DRIFT_MAX = 0.07;

if (!existsSync(THREE_DIR)) { console.log('SKIP: three not installed'); process.exit(0); }

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };
const RIG_PATH = '/__rig.html';
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === RIG_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><script type="importmap">
      { "imports": { "three": "/node_modules/three/build/three.module.js" } }
    </script><body></body>`);
    return;
  }
  let body;
  try { body = readFileSync(join(ROOT, url)); }
  catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(url)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await b.newPage();
page.on('console', m => { if (m.type() === 'error') console.error('  page:', m.text()); });
await page.goto(`http://127.0.0.1:${port}${RIG_PATH}`);

const results = await page.evaluate(async () => {
  const THREE = await import('three');
  const { buildRig } = await import('/scripts/handrig.js');
  const { gesture, matchGesture, templateDistance, kindOf, FEATURES } = await import('/src/gesture.js');
  const { fingerExt, handOpenness, dist3, thumbOut, thumbContact } = await import('/src/math.js');

  const rig = buildRig(THREE);
  // The rig is a HAND. Posing it from an arm-position vector would read
  // finger channels that a body template does not have and render a hand
  // nobody described.
  const all = gesture.list().filter(g => g.f && kindOf(g) === 'hand');
  const out = { features: FEATURES, handshapes: [] };
  for (const t of all) {
    rig.pose(t);
    const lm = rig.landmarks();
    // Byte for byte what cv.js publishes from a live frame.
    const f = [
      fingerExt(lm,0), fingerExt(lm,1), fingerExt(lm,2), fingerExt(lm,3), fingerExt(lm,4),
      handOpenness(lm), Math.min(1, dist3(lm[4],lm[20])/(dist3(lm[0],lm[9])*2.5)),
      thumbOut(lm),
      thumbContact(lm,1), thumbContact(lm,2), thumbContact(lm,3), thumbContact(lm,4),
    ].map(x => +x.toFixed(3));
    const m = matchGesture(f, all);
    out.handshapes.push({
      id: t.id, est: !!t.est, f,
      // Drift is measured with the template's OWN mask, because a channel the
      // matcher ignores is one the render was never asked to reproduce.
      drift: +templateDistance(f, t).toFixed(3),
      match: m?.id ?? null,
      // Which channels moved, worst first — the actionable half of a failure.
      worst: FEATURES.map((name, i) => [name, +((f[i] ?? 0) - (t.f[i] ?? 0)).toFixed(2), i])
                     .filter(([, d, i]) => (t.m?.[i] ?? 1) && Math.abs(d) >= 0.12)
                     .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4),
    });
  }
  return out;
});

await b.close(); server.close();

const VERBOSE = process.argv.includes('--verbose');
let fail = 0;
const rows = results.handshapes.slice().sort((a, b) => (a.est ? 1 : 0) - (b.est ? 1 : 0));
console.log("\nHandshape render round-trip   f → pose(rig) → landmarks → math.js → f'\n");
for (const r of rows) {
  const ok = r.drift <= DRIFT_MAX && r.match === r.id;
  const hard = !r.est;                       // measured templates are ground truth
  if (hard && !ok) fail++;
  const tag = hard ? (ok ? ' PASS ' : ' FAIL ') : (ok ? ' ok   ' : ' est? ');
  console.log(`  [${tag}]  ${r.id.padEnd(8)} ${hard ? 'measured ' : 'estimated'}`
    + `  drift ${r.drift.toFixed(3)}`
    + (r.match === r.id ? '' : `, reads as ${r.match ?? 'nothing'}`));
  if ((!ok || VERBOSE) && r.worst.length)
    console.log(`            off by: ${r.worst.map(([n, d]) => `${n} ${d > 0 ? '+' : ''}${d}`).join('  ')}`);
}

console.log(`\n  A measured template is ground truth, so a failure there is the decode in`);
console.log(`  scripts/handrig.js. An estimated one that reads wrong is the template —`);
console.log(`  recalibrate it in the app, or re-derive it in src/gesture.js.`);
console.log(`\n${rows.length} handshapes, drift limit ${DRIFT_MAX} — ${fail} failure(s)`);
process.exit(fail ? 1 : 0);
