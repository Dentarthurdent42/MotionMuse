// Render one illustration per handshape, from a 3D hand posed by the SAME
// feature vector the recognizer matches against (src/gesture.js).
//
// The point of driving the render off `f` rather than drawing sixteen pictures
// by hand: the picture cannot disagree with the template. Retune a template —
// or add a handshape — and re-running this regenerates an illustration that
// still shows what the app is actually looking for. A hand-drawn set would
// drift silently, and a wrong picture is worse than none: it teaches a shape
// that will not match.
//
// What a wrong picture does NOT tell you, though, is which end is wrong. The
// vector is real, but the decode below is a reading of it rather than the
// inverse of math.js — and a feature vector is lossy, so no exact inverse
// exists. Two failure modes look identical on screen:
//
//   * the decode misreads a good template  → fix pose()
//   * the decode is faithful and the template describes the wrong hand
//                                          → recalibrate the template
//
// The split that separates them is already in gesture.js: `fist`, `point`,
// `peace` and `thumbs` are MEASURED from the reference photos in
// tests/gesture-img and are ground truth, while the other ten carry `est`.
// A measured shape that renders wrong is the decoder's fault, full stop. Three
// such bugs are documented against the rules in pose() below; all three were
// found that way.
//
//   node scripts/handshapes.mjs          → icons/handshapes/<id>.png
//
// Needs a Chromium (same CHROME fallback as the test suites) and three.js from
// node_modules. Not wired into CI: it writes committed assets, and a build that
// rewrites checked-in binaries on every run is a diff generator, not a check.

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { createServer } from 'http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'icons', 'handshapes');
const CHROME = process.env.CHROME
  ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);

const SIZE = 256;               // rendered at 2× the 128px display size

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
// The rig page is SERVED rather than set with page.setContent: setContent
// leaves the document on origin `null`, and the module imports below are then
// cross-origin to this very server and blocked.
const RIG_PATH = '/__rig.html';
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === RIG_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html>
<style>html,body{margin:0;background:transparent}canvas{display:block}</style>
<script type="importmap">
  { "imports": { "three": "/node_modules/three/build/three.module.js" } }
</script>
<body></body>`);
    return;
  }
  const p = join(ROOT, url);
  let body;
  try { body = readFileSync(p); }
  catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await b.newPage({ viewport: { width: SIZE, height: SIZE } });
page.on('console', m => { if (m.type() === 'error') console.error('  page:', m.text()); });

await page.goto(`http://127.0.0.1:${port}${RIG_PATH}`);

const handshapes = await page.evaluate(async ({ SIZE }) => {
  const THREE = await import('three');
  const { gesture, kindOf } = await import('/src/gesture.js');
  // The rig and the decode live in scripts/handrig.js, shared with
  // tests/handshape-render so the pictures and the check that they are
  // faithful cannot drift apart.
  const { buildRig } = await import('/scripts/handrig.js');

  const { scene, pose } = buildRig(THREE);

  // ── Lighting ───────────────────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x1a2230, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-1.4, 1.8, 2.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x00e5cc, 1.1);   // the app's cyan
  rim.position.set(1.8, 0.4, -1.6);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(1.35, 1.30, 3.5);
  camera.lookAt(0, 0.62, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE);
  renderer.setClearColor(0x000000, 0);
  document.body.appendChild(renderer.domElement);

  // ── Render every template that has one ─────────────────────────────────
  const out = [];
  for (const g of gesture.list()) {
    if (!g.f) continue;                 // no template, nothing truthful to draw
    if (kindOf(g) !== 'hand') continue; // …and a hand rig cannot draw an arm pose
    pose(g);
    renderer.render(scene, camera);
    out.push({ id: g.id, name: g.name, asl: g.asl ?? null,
               png: renderer.domElement.toDataURL('image/png') });
  }
  return out;
}, { SIZE });

mkdirSync(OUT, { recursive: true });
for (const s of handshapes) {
  writeFileSync(join(OUT, `${s.id}.png`),
                Buffer.from(s.png.split(',')[1], 'base64'));
  console.log(`  ${s.id.padEnd(10)} ${s.asl ? 'ASL ' + s.asl : ''}`);
}
console.log(`\n${handshapes.length} handshapes → icons/handshapes/`);

await b.close();
server.close();
