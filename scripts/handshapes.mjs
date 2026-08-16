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

const shapes = await page.evaluate(async ({ SIZE }) => {
  const THREE = await import('three');
  const { gesture } = await import('/src/gesture.js');

  // ── The rig ────────────────────────────────────────────────────────────
  // A palm and five fingers of three segments each. Proportions are in palm
  // lengths, the same unit math.js normalizes by, so the model is in the units
  // the feature vector is expressed in.
  const SKIN = new THREE.MeshStandardMaterial({
    color: 0x9fb4c7, roughness: 0.55, metalness: 0.05,
  });
  const capsule = (len, r) => new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), SKIN);

  // len/radius per finger, and where each knuckle sits across the palm.
  const FINGERS = [
    { key: 'index',  x: -0.26, segs: [0.34, 0.22, 0.16], r: 0.070 },
    { key: 'middle', x: -0.09, segs: [0.38, 0.24, 0.17], r: 0.072 },
    { key: 'ring',   x:  0.08, segs: [0.35, 0.22, 0.16], r: 0.068 },
    { key: 'pinky',  x:  0.24, segs: [0.27, 0.17, 0.13], r: 0.058 },
  ];

  // A finger is a chain of hinges. `curl` 0 = straight, 1 = fully folded; the
  // joints do not bend equally — the knuckle leads, which is what makes a fist
  // read as a fist rather than a claw.
  const JOINT_SHARE = [0.9, 1.0, 0.8];
  function buildFinger(spec) {
    const root = new THREE.Group();
    let parent = root;
    const joints = [];
    spec.segs.forEach((len, i) => {
      const pivot = new THREE.Group();
      if (i > 0) pivot.position.y = spec.segs[i - 1];
      parent.add(pivot);
      const m = capsule(len, spec.r);
      m.position.y = len / 2;
      pivot.add(m);
      joints.push(pivot);
      parent = pivot;
    });
    root.userData.joints = joints;
    return root;
  }

  const scene = new THREE.Scene();
  const hand = new THREE.Group();
  scene.add(hand);

  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.72, 0.20), SKIN);
  palm.geometry.translate(0, 0.36, 0);
  hand.add(palm);
  const wrist = capsule(0.22, 0.13);
  wrist.position.y = -0.12;
  hand.add(wrist);

  const fingers = {};
  for (const spec of FINGERS) {
    const f = buildFinger(spec);
    f.position.set(spec.x, 0.72, 0);
    hand.add(f);
    fingers[spec.key] = f;
  }

  // The thumb hangs off the side of the palm and needs two extra freedoms:
  // how far it swings away from the palm (thumbOut) and how far round it
  // reaches (spread / contacts).
  const thumb = buildFinger({ segs: [0.26, 0.20, 0.15], r: 0.082 });
  const thumbYaw = new THREE.Group();
  const thumbSwing = new THREE.Group();
  thumbYaw.position.set(-0.30, 0.18, 0.02);
  thumbYaw.add(thumbSwing);
  thumbSwing.add(thumb);
  hand.add(thumbYaw);

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

  // ── Pose from the feature vector ───────────────────────────────────────
  // f = [thumb, index, middle, ring, pinky, open, spread, thumbOut, cIdx, cMid, cRing, cPinky]
  // The first five are EXTENSION: measured ~0.16-0.24 curled, ~0.80-0.94
  // extended (see the reference table in gesture.js). Map that range onto a
  // full fold rather than treating extension as a raw angle, or every shape
  // sits at a permanent half-curl.
  const EXT_MIN = 0.16, EXT_MAX = 0.92;
  const curlOf = ext => {
    const t = (ext - EXT_MIN) / (EXT_MAX - EXT_MIN);
    return Math.min(1, Math.max(0, 1 - t));
  };
  const FULL_FOLD = 1.55;                       // radians at the knuckle

  const setFinger = (f, curl, splay) => {
    f.userData.joints.forEach((j, i) => { j.rotation.x = curl * FULL_FOLD * JOINT_SHARE[i]; });
    f.rotation.z = splay;
  };

  function pose(f) {
    const [thumbExt, iExt, mExt, rExt, pExt, , spread, thumbOut, ...contacts] = f;

    const curls = [iExt, mExt, rExt, pExt].map(curlOf);
    // Fingers fan out with spread; the outer two carry most of it.
    const SPLAY = [1.0, 0.35, -0.35, -1.0];
    FINGERS.forEach((spec, i) => {
      setFinger(fingers[spec.key], curls[i], SPLAY[i] * spread * 0.30);
    });

    // Thumb. thumbOut is the dominant term — it is what separates a thumbs-up
    // from a fist — with spread opening it further across the palm.
    thumbYaw.rotation.z = 0.50 + thumbOut * 0.95 + spread * 0.25;
    thumbSwing.rotation.x = -0.45 + (1 - thumbOut) * 0.30;
    thumbYaw.rotation.y = -0.55 + thumbOut * 0.30;
    setFinger(thumb, curlOf(thumbExt) * 0.75, 0);

    // A contact means the thumb pad is touching that fingertip: curl the thumb
    // in and bring the touched finger to meet it, which is the whole visual
    // difference between ASL 6/7/8/9 and a plain open hand.
    const touched = contacts.findIndex(c => c > 0.5);
    if (touched >= 0) {
      const spec = FINGERS[touched];
      thumbYaw.rotation.z = 0.35 - spec.x * 0.8;
      thumbYaw.rotation.y = -0.25;
      thumbSwing.rotation.x = -0.95;
      setFinger(thumb, 0.42, 0);
      setFinger(fingers[spec.key], 0.52, 0);
    }
  }

  // ── Render every template that has one ─────────────────────────────────
  const out = [];
  for (const g of gesture.list()) {
    if (!g.f) continue;                 // no template, nothing truthful to draw
    pose(g.f);
    renderer.render(scene, camera);
    out.push({ id: g.id, name: g.name, asl: g.asl ?? null,
               png: renderer.domElement.toDataURL('image/png') });
  }
  return out;
}, { SIZE });

mkdirSync(OUT, { recursive: true });
for (const s of shapes) {
  writeFileSync(join(OUT, `${s.id}.png`),
                Buffer.from(s.png.split(',')[1], 'base64'));
  console.log(`  ${s.id.padEnd(10)} ${s.asl ? 'ASL ' + s.asl : ''}`);
}
console.log(`\n${shapes.length} handshapes → icons/handshapes/`);

await b.close();
server.close();
