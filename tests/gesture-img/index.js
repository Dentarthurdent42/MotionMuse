// Gesture-recognition image test: run MediaPipe HandLandmarker over reference
// gesture photos, extract the same features cv.js publishes, and assert each
// photo matches its intended built-in gesture (which chord mode maps to a
// chord). This is what caught the original templates matching nothing real.
//
// Pass --calibrate to print the measured feature vector for each photo plus
// the full sorted pairwise distance table between templates. That output is
// where the measured built-in templates in gesture.js come from, and it's how
// to tell whether a template edit has pushed two shapes too close together.
//
// Requires a browser (WebGL/WASM). Run:  node tests/gesture-img/index.js
// Needs @mediapipe/tasks-vision installed and a Chromium at CHROME (or the
// Playwright default). Skips with a clear message if prerequisites are absent.

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const MP   = join(ROOT, 'node_modules/@mediapipe/tasks-vision');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MODEL = join(HERE, 'hand_landmarker.task');   // provide locally to run offline

// image file → expected built-in gesture id. The `asl*` photos are the
// reference set the ASL number handshapes are measured from — one per numeral,
// shot on one hand — and the four originals are a second hand's take on the
// shapes they overlap, which is what keeps a template from being fitted so
// tightly to one photo that nobody else's hand matches it.
//
// `thumb` is deliberately absent: it is a stock photo where the hand is a
// fraction of the frame and turned edge-on, so the folded fingers are hidden
// behind it and MediaPipe can only guess their joints — it reports them
// half-straight. That was survivable when extension was a base-to-tip
// distance; measuring the joints themselves means the photo has to actually
// show them. `asl10` is the same handshape with the fingers in view.
//
// `asl3b` is a SECOND hand making ASL 3, added because the first one's
// template did not recognise it in the field. Two photos of the same shape
// from different hands is the only thing that keeps a template honest: fitted
// to one photo it matches one person, and the failure is invisible until
// somebody else holds the pose.
const CASES = {
  fist: 'fist', victory: 'peace', point: 'point',
  asl1: 'point', asl2: 'peace',  asl3: 'asl3', asl4: 'asl4', asl5: 'palm',
  asl6: 'asl6',  asl7: 'asl7',   asl8: 'asl8', asl9: 'asl9', asl10: 'thumbs',
  asl3b: 'asl3',
};

if (!existsSync(MP)) { console.log('SKIP: @mediapipe/tasks-vision not installed'); process.exit(0); }
if (!existsSync(MODEL)) { console.log('SKIP: hand_landmarker.task not present next to this test'); process.exit(0); }

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const p = join(ROOT, req.url.split('?')[0]);
  let body;
  try { body = readFileSync(p); }
  catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const b = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle'] });
const p = await b.newPage();
await p.route('**cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/**', r => {
  const rel = r.request().url().split('tasks-vision@0.10.14/')[1];
  r.fulfill({ body: readFileSync(join(MP, rel)), contentType: MIME['.' + rel.split('.').pop()] || 'application/octet-stream' });
});
await p.route('**storage.googleapis.com/mediapipe-models/**', r =>
  r.fulfill({ body: readFileSync(MODEL), contentType: 'application/octet-stream' }));
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

const imgs = {};
for (const name of Object.keys(CASES))
  imgs[name] = 'data:image/jpeg;base64,' + readFileSync(join(HERE, 'img', `${name}.jpg`)).toString('base64');

const results = await p.evaluate(async (imgs) => {
  const { FilesetResolver, HandLandmarker } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
  const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
  const hand = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate: 'CPU' },
    numHands: 1, runningMode: 'IMAGE' });
  const { fingerExt, handOpenness, dist3, thumbOut, thumbContact } = await import('/src/math.js');
  const { gesture, matchGesture, templateDistance, templateSeparation, kindOf,
          FEATURES, SEPARATION_FLOOR } = await import('/src/gesture.js');
  // This suite measures HANDS from photographs of hands, so it asks the hand
  // templates. The arm poses are a different channel list and a different
  // question — scoring one against a finger vector does not give a wrong
  // answer, it gives a confident one — and matchGesture already refuses to.
  // The ranked runners-up below would otherwise report that refusal as a
  // near miss.
  const handTemplates = gesture.list().filter(g => kindOf(g) === 'hand');
  const load = src => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = src; });
  const out = { images: {}, features: FEATURES, floor: SEPARATION_FLOOR };
  for (const [name, src] of Object.entries(imgs)) {
    const res = hand.detect(await load(src));
    if (!res.landmarks?.length) { out.images[name] = { detected: false }; continue; }
    const lm = res.landmarks[0];
    // Exactly what cv.js publishes and gesture.js reads, in the same order.
    const f = [
      fingerExt(lm,0), fingerExt(lm,1), fingerExt(lm,2), fingerExt(lm,3), fingerExt(lm,4),
      handOpenness(lm), Math.min(1, dist3(lm[4],lm[20])/(dist3(lm[0],lm[9])*2.5)),
      thumbOut(lm),
      thumbContact(lm,1), thumbContact(lm,2), thumbContact(lm,3), thumbContact(lm,4),
    ].map(x => +x.toFixed(3));
    const all = handTemplates;
    const m = matchGesture(f, all);
    out.images[name] = {
      detected: true, match: m?.id ?? null, dist: m ? +m.dist.toFixed(3) : null, f,
      // Runners-up, to show how decisive the win was.
      ranked: all.map(t => [t.id, +templateDistance(f, t).toFixed(3)])
                 .sort((a, b) => a[1] - b[1]).slice(0, 3),
    };
  }
  // Pairwise separation over the whole shipped template set — via the shared
  // templateSeparation (min over both directions, since masks are
  // asymmetric), the same definition the unit floor test uses.
  const T = handTemplates;
  const pairs = [];
  for (let i = 0; i < T.length; i++)
    for (let j = i + 1; j < T.length; j++)
      pairs.push([T[i].id, T[j].id, +templateSeparation(T[i], T[j]).toFixed(3)]);
  out.pairs = pairs.sort((a, b) => a[2] - b[2]);
  out.templates = T.map(t => [t.id, t.est ? 'estimated' : 'measured', t.f]);
  return out;
}, imgs);

await b.close(); server.close();

const CALIBRATE = process.argv.includes('--calibrate');
let fail = 0;
console.log('\nGesture image recognition\n');
for (const [name, exp] of Object.entries(CASES)) {
  const r = results.images[name] || {};
  const ok = r.detected && r.match === exp;
  if (!ok) fail++;
  const runner = r.ranked?.[1];
  console.log(`  [${ok ? ' PASS ' : ' FAIL '}]  ${name.padEnd(8)} → ${r.match ?? (r.detected ? '(no match)' : '(no hand)')}`
    + `  (expected ${exp})`
    + (r.dist != null ? `   d=${r.dist}${runner ? `, next ${runner[0]} @ ${runner[1]}` : ''}` : ''));
}

// The nearest template pair bounds how precisely a live hand has to be read
// for the right gesture to win, so regressing it is worth failing over.
const nearest = results.pairs[0];
const floorOk = nearest[2] >= results.floor;
if (!floorOk) fail++;
console.log(`\n  [${floorOk ? ' PASS ' : ' FAIL '}]  closest template pair ${nearest[0]} ~ ${nearest[1]}`
  + ` = ${nearest[2]}  (floor ${results.floor})`);

if (CALIBRATE) {
  const pad = s => String(s).padStart(7);
  console.log('\n── Measured feature vectors ' + '─'.repeat(40));
  console.log('  ' + 'photo'.padEnd(9) + results.features.map(pad).join(''));
  for (const [name, r] of Object.entries(results.images)) {
    if (r.detected) console.log('  ' + name.padEnd(9) + r.f.map(v => pad(v.toFixed(2))).join(''));
  }
  console.log('\n── Shipped templates ' + '─'.repeat(47));
  console.log('  ' + 'id'.padEnd(9) + 'source'.padEnd(11) + results.features.map(pad).join(''));
  for (const [id, src, f] of results.templates) {
    // `thumbsdown` and `iloveyou` are recognised by MediaPipe's own classifier
    // and carry no feature vector, so there is nothing to tabulate — say so
    // rather than throwing halfway down the table, which is what this did.
    console.log('  ' + id.padEnd(9) + src.padEnd(11)
      + (f ? f.map(v => pad(v.toFixed(2))).join('') : '(classifier only — no template vector)'));
  }
  console.log('\n── Pairwise distances, closest first ' + '─'.repeat(31));
  for (const [a, bId, d] of results.pairs.slice(0, 20))
    console.log(`  ${d.toFixed(3)}  ${a} ~ ${bId}`);
  console.log(`  … ${results.pairs.length} pairs total, farthest ${results.pairs.at(-1)[2]}`);
}

console.log(`\n${Object.keys(CASES).length} images — ${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
