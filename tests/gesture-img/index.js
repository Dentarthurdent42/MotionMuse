// Gesture-recognition image test: run MediaPipe HandLandmarker over reference
// gesture photos, extract the same 7 features cv.js publishes, and assert each
// photo matches its intended built-in gesture (which chord mode maps to a
// chord). This is what caught the original templates matching nothing real.
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

// image file → expected built-in gesture id
const CASES = { fist: 'fist', victory: 'peace', point: 'point', thumb: 'thumbs' };

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
  const { fingerExt, handOpenness, dist3 } = await import('/src/math.js');
  const { gesture, matchGesture } = await import('/src/gesture.js');
  const load = src => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = src; });
  const out = {};
  for (const [name, src] of Object.entries(imgs)) {
    const res = hand.detect(await load(src));
    if (!res.landmarks?.length) { out[name] = { detected: false }; continue; }
    const lm = res.landmarks[0];
    const f = [fingerExt(lm,0),fingerExt(lm,1),fingerExt(lm,2),fingerExt(lm,3),fingerExt(lm,4),
               handOpenness(lm), Math.min(1, dist3(lm[4],lm[20])/(dist3(lm[0],lm[9])*2.5))];
    const m = matchGesture(f, gesture.list());
    out[name] = { detected: true, match: m?.id ?? null };
  }
  return out;
}, imgs);

await b.close(); server.close();

let fail = 0;
console.log('\nGesture image recognition\n');
for (const [name, exp] of Object.entries(CASES)) {
  const r = results[name] || {};
  const ok = r.detected && r.match === exp;
  if (!ok) fail++;
  console.log(`  [${ok ? ' PASS ' : ' FAIL '}]  ${name.padEnd(8)} → ${r.match ?? (r.detected ? '(no match)' : '(no hand)')}  (expected ${exp})`);
}
console.log(`\n${Object.keys(CASES).length} images — ${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
