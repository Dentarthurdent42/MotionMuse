// Audio launch guard: the engine starts with the page, muted, and says so.
//
// The reason this is a CI suite and not a scratch check: the interesting case
// is a *suspended* AudioContext, which is what every real browser hands you
// when a page builds one without a user gesture — and headless Chromium does
// not enforce that policy, so the whole failure mode is invisible in an
// ordinary test run. It shipped once already: `AudioContext.resume()` does not
// reject when permission is being withheld, it returns a promise that never
// settles, so awaiting it before rendering left the audio panel permanently
// empty on real browsers while passing here. This test forces the suspension.
//
// Run:  npm run test:launch   (needs a Chromium; no network, no API keys)

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const CHROME = process.env.CHROME
  ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' };
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

const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const p = await b.newPage();
const pageErrors = [];
p.on('pageerror', e => pageErrors.push(String(e)));
await p.setViewportSize({ width: 1440, height: 950 });

// Every AudioContext this page constructs starts suspended and only a real
// resume() can move it — the autoplay-policy contract, made explicit.
await p.addInitScript(() => {
  const Real = window.AudioContext;
  window.AudioContext = class extends Real {
    constructor(...a) { super(...a); super.suspend(); }
  };
});
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);

const engineState = () => p.evaluate(async () => {
  const { engine } = await import('/src/engine.js');
  return { started: engine.started, muted: engine.muted, ctxState: engine.ctxState };
});
const btnState = () => p.evaluate(() => {
  const el = document.getElementById('audio-btn');
  return { text: el.querySelector('.btn-text').textContent.trim(),
           muted: el.classList.contains('muted'),
           pressed: el.getAttribute('aria-pressed'),
           width: Math.round(el.getBoundingClientRect().width) };
});
const bannerShown = () => p.evaluate(() => {
  const el = document.getElementById('viz-muted');
  const r = el.getBoundingClientRect();
  return !el.hidden && r.width > 0 && r.height > 0;
});

const onLoad     = await engineState();
const onLoadBtn  = await btnState();
const bannerOn   = await bannerShown();
const sliders    = await p.$$eval('#audio-panel .apr', els => els.length);

// Clicking is the gesture: it must unmute AND start the clock.
await p.click('#audio-btn');
await p.waitForTimeout(300);
const afterClick = await engineState();
const afterBtn   = await btnState();
const clockDelta = await p.evaluate(async () => {
  const { engine } = await import('/src/engine.js');
  const a = engine.now();
  await new Promise(r => setTimeout(r, 250));
  return engine.now() - a;
});

// The hotkey, including the two cases that make Space awkward to bind.
await p.keyboard.press('Space');
await p.waitForTimeout(150);
const afterSpace = await engineState();

// The waveform must keep moving while muted — that is what distinguishes a
// silent instrument from a broken one, and why mute sits after the analyser.
// Measured HERE, not on load: muted, but with the clock running. While the
// context is suspended nothing is produced at all, which says nothing about
// where the mute gain sits.
const analyserRms = await p.evaluate(async () => {
  const { engine } = await import('/src/engine.js');
  engine.set('volume', 1); engine.set('osc1_freq', 440);
  await new Promise(r => setTimeout(r, 200));
  const w = engine.getWaveform();
  return w ? Math.sqrt(w.reduce((s, v) => s + v * v, 0) / w.length) : 0;
});

await p.focus('#audio-btn');           // focused button: must toggle once, not twice
const beforeFocused = (await engineState()).muted;
await p.keyboard.press('Space');
await p.waitForTimeout(150);
const afterFocused = (await engineState()).muted;

await p.evaluate(() => {
  const i = document.createElement('input');
  i.id = '__probe'; document.body.appendChild(i); i.focus();
});
const beforeTyping = (await engineState()).muted;
await p.keyboard.press('Space');
await p.waitForTimeout(150);
const afterTyping = (await engineState()).muted;
await p.evaluate(() => document.getElementById('__probe')?.remove());

// Tapping the visualiser is the third path to mute, alongside button and key.
const beforeViz = (await engineState()).muted;
await p.click('#viz-wrap');
await p.waitForTimeout(150);
const afterViz = (await engineState()).muted;

await b.close(); server.close();

let fail = 0;
const check = (ok, label, detail = '') => {
  if (!ok) fail++;
  console.log(`  [${ok ? ' PASS ' : ' FAIL '}]  ${label}${detail !== '' ? '  — ' + detail : ''}`);
};

console.log('\nAudio launch (suspended-context path)\n');
check(onLoad.started, 'the engine starts with the page');
check(onLoad.ctxState === 'suspended', 'the test really is exercising a suspended context', onLoad.ctxState);
check(onLoad.muted, 'output is muted on launch');
check(sliders > 0, 'the audio panel renders anyway, so controls are usable', `${sliders} sliders`);
check(onLoadBtn.muted && /MUTED/.test(onLoadBtn.text), 'the button shows the muted state', onLoadBtn.text);
check(onLoadBtn.pressed === 'true', 'the muted state is exposed to assistive tech');
check(bannerOn, 'the visualiser carries a MUTED banner');
check(!afterClick.muted, 'clicking unmutes');
check(afterClick.ctxState === 'running', 'clicking resumes the suspended context', afterClick.ctxState);
check(clockDelta > 0.1, 'the audio clock actually advances after the gesture', `+${clockDelta.toFixed(2)}s`);
check(afterBtn.width === onLoadBtn.width, 'the button keeps one width across both captions',
  `${onLoadBtn.width}px / ${afterBtn.width}px`);
check(afterSpace.muted, 'the spacebar toggles mute');
check(afterSpace.muted && analyserRms > 0.01,
  'the waveform stays live while muted (mute sits after the analyser)', `rms ${analyserRms.toFixed(3)}`);
check(beforeFocused !== afterFocused, 'the spacebar toggles once, not twice, with a button focused');
check(beforeTyping === afterTyping, 'the spacebar is left alone while typing in a field');
check(beforeViz !== afterViz, 'tapping the visualiser toggles mute');
check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '));

console.log(`\n${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
