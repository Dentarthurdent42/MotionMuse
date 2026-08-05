// Synthetic pose-model benchmark: renders an articulated 3D mannequin through
// a scripted 300-frame pose timeline (known joint transforms → projected
// ground truth), runs each pose backend over the frames, and compares
// latency AND accuracy — per-joint error vs the known transform of each body
// part, detection rate, and jitter on a held-still segment.
//
// Run:  npm run test:pose-bench
// Needs: npm i (three + @mediapipe/tasks-vision devDeps), a Chromium at
// CHROME (or the Playwright default), and the pose .task models in
// tests/pose-bench/models/ (auto-fetched from storage.googleapis.com when
// missing). Skips cleanly per-backend / globally when prerequisites are absent.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const MP     = join(ROOT, 'node_modules/@mediapipe/tasks-vision');
const THREEJS = join(ROOT, 'node_modules/three');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MODELS = join(HERE, 'models');

if (!existsSync(MP))      { console.log('SKIP: @mediapipe/tasks-vision not installed (npm i)'); process.exit(0); }
if (!existsSync(THREEJS)) { console.log('SKIP: three not installed (npm i)'); process.exit(0); }

// The comparison matrix. MoveNet entries run only if tfjs is reachable
// (it isn't in sandboxed CI — they report SKIP, not failure).
const MATRIX = [
  { id: 'mp-lite',           kind: 'mp',      file: 'pose_landmarker_lite',  delegate: 'GPU' },
  { id: 'mp-full',           kind: 'mp',      file: 'pose_landmarker_full',  delegate: 'GPU' },
  { id: 'mp-heavy',          kind: 'mp',      file: 'pose_landmarker_heavy', delegate: 'GPU' },
  { id: 'mp-lite-cpu',       kind: 'mp',      file: 'pose_landmarker_lite',  delegate: 'CPU' },
  { id: 'movenet-lightning', kind: 'movenet', modelType: 'SinglePose.Lightning' },
  { id: 'movenet-thunder',   kind: 'movenet', modelType: 'SinglePose.Thunder' },
];

// GT joint name → BlazePose landmark index.
const GT_TO_LM = {
  head: 0, l_shoulder: 11, r_shoulder: 12, l_elbow: 13, r_elbow: 14,
  l_wrist: 15, r_wrist: 16, l_hip: 23, r_hip: 24,
};

// ── Fetch missing .task models (immutable URLs, 40MB guard) ─────────────
mkdirSync(MODELS, { recursive: true });
for (const v of ['lite', 'full', 'heavy']) {
  const f = join(MODELS, `pose_landmarker_${v}.task`);
  if (existsSync(f)) continue;
  const url = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/1/pose_landmarker_${v}.task`;
  try {
    console.log(`fetching ${v} model…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 40 * 1024 * 1024) throw new Error('model larger than 40MB guard');
    writeFileSync(f, buf);
  } catch (e) {
    console.log(`  could not fetch ${v}: ${e.message} (its rows will SKIP)`);
  }
}

// ── Static server over the repo root ────────────────────────────────────
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  let body;
  try { body = readFileSync(p); }
  catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const b = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle'] });
const page = await b.newPage();

// MediaPipe JS/wasm from node_modules; .task models from the local copies.
await page.route('**cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/**', r => {
  const rel = r.request().url().split('tasks-vision@0.10.14/')[1];
  r.fulfill({ body: readFileSync(join(MP, rel)), contentType: MIME['.' + rel.split('.').pop()] || 'application/octet-stream' });
});
await page.route('**storage.googleapis.com/mediapipe-models/pose_landmarker/**', r => {
  const m = /pose_landmarker_(lite|full|heavy)\.task/.exec(r.request().url());
  const f = m && join(MODELS, m[0]);
  if (f && existsSync(f)) r.fulfill({ body: readFileSync(f), contentType: 'application/octet-stream' });
  else r.abort();
});

await page.goto(`http://127.0.0.1:${port}/tests/pose-bench/bench.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.benchReady === true', null, { timeout: 30000 });

// Ground truth is deterministic — collect it once.
const gt = await page.evaluate(() => {
  const out = [];
  for (let n = 0; n < window.bench.FRAMES; n++) {
    window.bench.renderFrame(n);
    out.push(window.bench.gtJoints());
  }
  return out;
});
const STATIC_START = await page.evaluate('window.bench.STATIC_START');

// ── Run one backend inside the page ──────────────────────────────────────
async function runBackend(spec) {
  return page.evaluate(async (spec) => {
    const { FRAMES, renderFrame } = window.bench;
    const stage = document.getElementById('stage');
    let detectFrame;   // canvas, tsMs → landmarks[33] | null

    if (spec.kind === 'mp') {
      const { FilesetResolver, PoseLandmarker } = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
      const make = delegate => PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/${spec.file}/float16/1/${spec.file}.task`,
          delegate,
        },
        runningMode: 'VIDEO', numPoses: 1,
      });
      let lm, usedDelegate = spec.delegate;
      try { lm = await make(spec.delegate); }
      catch { lm = await make('CPU'); usedDelegate = 'CPU*'; }   // headless GPU fallback
      detectFrame = (canvas, ts) => lm.detectForVideo(canvas, ts).landmarks?.[0] ?? null;
      spec.usedDelegate = usedDelegate;
    } else {
      // MoveNet via tfjs — requires CDN reach; probe first, skip when offline.
      try {
        const tf = await import('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/+esm');
        await tf.ready();
        const pd = await import('https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/+esm');
        const det = await pd.createDetector(pd.SupportedModels.MoveNet, { modelType: spec.modelType });
        const MAP = [[0, 0], [5, 11], [6, 12], [7, 13], [8, 14], [9, 15], [10, 16], [11, 23], [12, 24]];
        detectFrame = async (canvas) => {
          const poses = await det.estimatePoses(canvas);
          if (!poses.length) return null;
          const lm = [];
          for (const [coco, blaze] of MAP) {
            const kp = poses[0].keypoints[coco];
            if (kp && (kp.score ?? 1) >= 0.3) lm[blaze] = { x: kp.x / canvas.width, y: kp.y / canvas.height };
          }
          return lm;
        };
      } catch (e) {
        return { skip: `tfjs unreachable (${String(e).slice(0, 60)})` };
      }
    }

    const frames = [];
    for (let n = 0; n < FRAMES; n++) {
      renderFrame(n);
      const t0 = performance.now();
      const lm = await detectFrame(stage, n * 33.33);
      frames.push({ ms: performance.now() - t0, lm });
    }
    return { frames, usedDelegate: spec.usedDelegate ?? null };
  }, spec);
}

// ── Metrics ──────────────────────────────────────────────────────────────
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const med  = a => a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null;
const p95  = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] : null;

function metrics(frames) {
  const lat = frames.map(f => f.ms);
  const detected = frames.filter(f => f.lm);
  const errs = [], perJoint = {};
  for (let n = 0; n < frames.length; n++) {
    const lm = frames[n].lm;
    if (!lm) continue;
    for (const [name, idx] of Object.entries(GT_TO_LM)) {
      const p = lm[idx];
      if (!p) continue;
      const e = Math.hypot(p.x - gt[n][name].x, p.y - gt[n][name].y);
      errs.push(e);
      (perJoint[name] ??= []).push(e);
    }
  }
  // Jitter: mean frame-to-frame displacement of predicted joints while the
  // figure holds perfectly still — the ground truth doesn't move at all.
  const jit = [];
  for (let n = STATIC_START + 1; n < frames.length; n++) {
    const a = frames[n - 1].lm, c = frames[n].lm;
    if (!a || !c) continue;
    const ds = Object.values(GT_TO_LM)
      .filter(i => a[i] && c[i])
      .map(i => Math.hypot(c[i].x - a[i].x, c[i].y - a[i].y));
    if (ds.length) jit.push(mean(ds));
  }
  return {
    detectionRate: detected.length / frames.length,
    latencyMs: { mean: mean(lat), p95: p95(lat) },
    error: { mean: mean(errs), median: med(errs), p95: p95(errs) },
    perJoint: Object.fromEntries(Object.entries(perJoint).map(([k, v]) => [k, mean(v)])),
    jitter: mean(jit),
  };
}

// ── Drive the matrix ─────────────────────────────────────────────────────
const results = {};
for (const spec of MATRIX) {
  if (spec.kind === 'mp' && !existsSync(join(MODELS, `${spec.file}.task`))) {
    results[spec.id] = { skip: 'model file missing' };
    console.log(`${spec.id}: SKIP (model file missing)`);
    continue;
  }
  process.stdout.write(`${spec.id}… `);
  try {
    const r = await runBackend(spec);
    if (r.skip) { results[spec.id] = { skip: r.skip }; console.log(`SKIP (${r.skip})`); continue; }
    results[spec.id] = { ...metrics(r.frames), usedDelegate: r.usedDelegate };
    console.log('done');
  } catch (e) {
    results[spec.id] = { failure: String(e).slice(0, 120) };
    console.log(`ERROR (${String(e).slice(0, 80)})`);
  }
}

await b.close(); server.close();

// ── Report ───────────────────────────────────────────────────────────────
const fmt = (v, d = 1) => v == null ? '—' : v.toFixed(d);
console.log('\nPose model benchmark — 300 synthetic frames, 9 tracked joints');
console.log('(error/jitter in normalized image units ×1000; lower is better)\n');
const rows = [];
for (const [id, r] of Object.entries(results)) {
  if (r.skip || r.failure) { rows.push({ backend: id, note: r.skip ?? r.failure }); continue; }
  rows.push({
    backend: id + (r.usedDelegate === 'CPU*' ? ' (gpu→cpu)' : ''),
    'detect%': fmt(r.detectionRate * 100, 0),
    'lat ms': fmt(r.latencyMs.mean),
    'lat p95': fmt(r.latencyMs.p95),
    'err ×1k': fmt(r.error.mean == null ? null : r.error.mean * 1000),
    'err p95': fmt(r.error.p95 == null ? null : r.error.p95 * 1000),
    'jit ×1k': fmt(r.jitter == null ? null : r.jitter * 1000, 2),
  });
}
console.table(rows);

const anyDetected = Object.values(results).some(r => r.detectionRate > 0);
if (!anyDetected) console.log('INCONCLUSIVE: no backend detected the synthetic figure — accuracy columns are empty; latency numbers remain valid.');

mkdirSync(join(ROOT, 'test-results'), { recursive: true });
writeFileSync(join(ROOT, 'test-results/pose-bench.json'), JSON.stringify(results, null, 2));
console.log('\nfull results → test-results/pose-bench.json');
process.exit(0);
