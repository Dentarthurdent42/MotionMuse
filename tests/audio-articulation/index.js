// Articulation measurement: does gesture-driven volume produce *separable*
// notes? Purely numeric — drives a clean control signal into the volume
// mapping and measures the real audio at the analyser.
//
// Four things are measured, each one encoding part of "I can't get
// well-defined rearticulation":
//   settling  — does the gain stop moving while the gesture is held?
//   chatter   — does a jittery hold cause extra level changes?
//   silence   — does commanding zero actually reach silence, and how fast?
//   gaps      — alternating loud/silent: how many real gaps, how fast the attack?
//
// Runs against whatever is checked out, so it works as a before/after probe:
// `volLevel()` is optional and absent on builds without volume stepping.
//
// Run:  npm run test:audio     (needs a Chromium at CHROME or the PW default)

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LABEL = process.env.LABEL || 'run';

if (!existsSync(CHROME)) { console.log(`SKIP: no Chromium at ${CHROME}`); process.exit(0); }

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
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

const b = await chromium.launch({
  executablePath: CHROME,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle'],
});
const page = await b.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
await page.click('#audio-btn');           // real user gesture → live AudioContext
await page.waitForTimeout(400);

// A dynamic import of the same URL hands back the very module instance main.js
// already holds, so no test-only hooks are needed in production code.
const out = await page.evaluate(async () => {
  const { engine } = await import('/src/engine.js');
  const { bus }    = await import('/src/bus.js');
  const { mapper } = await import('/src/mapper.js');

  // Clean, unsmoothed control signal so we measure the audio path, not the
  // One-Euro lag on pinch_R.
  bus.register('test_ctl', { label: 'test', group: 'test', min: 0, max: 1 });
  mapper.load([{ audioParam: 'volume', signal: 'test_ctl', outMin: 0, outMax: 1, curve: 'linear' }]);

  const rms = () => {
    const w = engine.getWaveform();
    if (!w) return 0;
    let s = 0;
    for (let i = 0; i < w.length; i++) s += w[i] * w[i];
    return Math.sqrt(s / w.length);
  };
  const lvl = () => engine.volLevel?.() ?? null;   // absent pre-feature

  const samples = [];
  let running = true;
  const sample = () => {
    if (!running) return;
    samples.push({ t: performance.now(), rms: rms(), val: engine.PARAMS.volume.val, l: lvl() });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  const at = () => samples.length ? samples[samples.length - 1].t : performance.now();
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const marks = {};

  // Hands don't send clean numbers. Every phase drives a NOISY target, and
  // "quiet" is a small non-zero value — because the actual complaint is that
  // you can't land on silence with a gesture, not that gain=0 is silent.
  let seed = 12345;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;
  const QUIET = 0.03;            // a hand "closed" but not perfectly still
  let target = 0, jitter = 0;
  const feed = setInterval(() => bus.update('test_ctl',
    Math.max(0, Math.min(1, target + noise() * jitter))), 16);
  const hold = async (v, j, ms) => { target = v; jitter = j; await wait(ms); };

  // 1) hold a jittery steady level — does the OUTPUT settle despite input noise?
  await hold(0.75, 0.02, 100); marks.holdStart = at(); await wait(600); marks.holdEnd = at();

  // 2) dither across a level boundary — does it chatter?
  marks.ditherStart = at(); await hold(0.73, 0.03, 1000); marks.ditherEnd = at();

  // 3) go quiet but NOT to exactly zero — is real silence reachable by hand?
  target = QUIET; jitter = 0.02; marks.silenceCmd = at(); await wait(600); marks.silenceEnd = at();

  // 4) alternate loud ↔ quiet-but-not-zero — count separable notes
  marks.altStart = at();
  for (let i = 0; i < 4; i++) { await hold(1, 0.02, 300); await hold(QUIET, 0.02, 300); }
  marks.altEnd = at();
  clearInterval(feed);

  running = false;
  await wait(50);
  return { samples, marks, hasVolLevel: lvl() !== null, volStep: engine.getVolStep?.() ?? null };
});

await b.close(); server.close();

// ── Analysis ──────────────────────────────────────────────────────────────
const { samples, marks, hasVolLevel, volStep } = out;
const span = (a, z) => samples.filter(s => s.t >= a && s.t <= z);
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const stdev = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const SILENT = 1e-4;

// settling: coefficient of variation over the last 300ms of the hold
const tail = span(marks.holdEnd - 300, marks.holdEnd).map(s => s.rms);
const settleCv = mean(tail) > 0 ? stdev(tail) / mean(tail) : 0;

// level changes (distinct volume values) during each phase — the proxy for
// "how many envelopes were fired"
const changes = (a, z) => {
  const ss = span(a, z);
  let n = 0;
  for (let i = 1; i < ss.length; i++) if (ss[i].val !== ss[i - 1].val) n++;
  return n;
};

// silence: how long after commanding 0 does RMS reach the floor
const sil = span(marks.silenceCmd, marks.silenceEnd);
const firstSilent = sil.find(s => s.rms < SILENT);
const silenceMs = firstSilent ? Math.round(firstSilent.t - marks.silenceCmd) : null;
const silenceFloor = Math.min(...sil.map(s => s.rms));

// gaps: runs of >=60ms below the floor during the alternating phase
const alt = span(marks.altStart, marks.altEnd);
let gaps = 0, runStart = null;
for (const s of alt) {
  if (s.rms < SILENT) { if (runStart == null) runStart = s.t; }
  else { if (runStart != null && s.t - runStart >= 60) gaps++; runStart = null; }
}
if (runStart != null && alt.length && alt[alt.length - 1].t - runStart >= 60) gaps++;

// attack: from the last silent sample to >=50% of the phase peak
const peak = Math.max(...alt.map(s => s.rms), 0);
const attacks = [];
for (let i = 1; i < alt.length; i++) {
  if (alt[i - 1].rms < SILENT && alt[i].rms >= SILENT) {
    const j = alt.findIndex((s, k) => k >= i && s.rms >= peak * 0.5);
    if (j > 0) attacks.push(alt[j].t - alt[i - 1].t);
  }
}

const report = {
  label: LABEL,
  volumeSteppingPresent: hasVolLevel,
  volStep,
  samples: samples.length,
  settling:  { cv: +settleCv.toFixed(4), levelChangesWhileHeld: changes(marks.holdStart + 100, marks.holdEnd) },
  chatter:   { levelChangesWhileDithering: changes(marks.ditherStart, marks.ditherEnd) },
  silence:   { reachedMs: silenceMs, floorRms: +silenceFloor.toExponential(2) },
  gaps:      { count: gaps, attackMsMedian: attacks.length ? Math.round(attacks.sort((x, y) => x - y)[attacks.length >> 1]) : null },
};

console.log('\nArticulation measurement — ' + LABEL + '\n');
console.log(`  volume stepping present     ${report.volumeSteppingPresent}`);
console.log(`  settles while held (cv)     ${report.settling.cv}        ${settleCv < 0.02 ? 'settled' : 'STILL DRIFTING'}`);
console.log(`  level changes while held    ${report.settling.levelChangesWhileHeld}`);
console.log(`  level changes on jitter     ${report.chatter.levelChangesWhileDithering}`);
console.log(`  silence reached after       ${silenceMs == null ? 'NEVER' : silenceMs + ' ms'}   (floor rms ${report.silence.floorRms})`);
// 4 loud/quiet cycles produce at least 4 gaps (a trailing one is possible,
// since the phase ends quiet) — so report the count, not a ratio.
console.log(`  clean gaps (>=60ms silent)  ${report.gaps.count}   (want >=4)`);
console.log(`  median attack time          ${report.gaps.attackMsMedian == null ? 'n/a' : report.gaps.attackMsMedian + ' ms'}`);

mkdirSync(join(ROOT, 'test-results'), { recursive: true });
writeFileSync(join(ROOT, `test-results/articulation-${LABEL}.json`), JSON.stringify(report, null, 2));
console.log(`\nfull data → test-results/articulation-${LABEL}.json\n`);
process.exit(0);
