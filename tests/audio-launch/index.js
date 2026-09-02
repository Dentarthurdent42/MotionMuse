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
const sliders    = await p.$$eval('.apr', els => els.length);

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

// ── The iOS Ring/Silent switch workaround ────────────────────────────────
//
// On an iPhone, unmuting has to also start a silent media element, or the
// page stays in the "ambient" audio category and the switch silences the
// whole instrument (see src/audiosession.js). Chromium is not iOS, but the
// decision is taken from the agent string, so an iPhone UA exercises the real
// path: the element is created, played, and — the part that would quietly
// undo the whole thing — left UNMUTED at a non-zero volume.
const asIOS = await (async () => {
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
             + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  const read = () => page.evaluate(() => {
    const a = document.querySelector('audio');
    return {
      exists: !!a,
      paused: a?.paused ?? null,
      muted: a?.muted ?? null,
      volume: a?.volume ?? null,
      loop: a?.loop ?? null,
      inline: a?.hasAttribute('playsinline') ?? null,
    };
  });

  // Nothing is held before the user makes the instrument audible: the
  // playback category stops whatever the phone was already playing.
  const before = await read();
  await page.click('#audio-btn');
  await page.waitForTimeout(400);
  const unmuted = await read();
  await page.click('#audio-btn');
  await page.waitForTimeout(400);
  const remuted = await read();
  await ctx.close();
  return { before, unmuted, remuted, errs };
})();

// …and no other platform pays for it. A playing media element costs Android
// the user's audio focus and the desktop a set of media keys for a track that
// does not exist, and neither has a Ring/Silent switch to work around.
const asDesktop = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await page.click('#audio-btn');
  await page.waitForTimeout(400);
  const out = await page.evaluate(() => document.querySelectorAll('audio').length);
  await ctx.close();
  return out;
})();

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
// The button lives on the camera view now, among the other icons there, so
// the state it shows is the speaker glyph plus its amber styling rather than
// a caption. aria-pressed and the title carry it for anyone not looking at
// the picture — checked immediately below.
check(onLoadBtn.muted && onLoadBtn.text === '🔇', 'the button shows the muted state', onLoadBtn.text);
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

console.log('\niOS Ring/Silent switch\n');
{
  const { before, unmuted, remuted, errs } = asIOS;
  check(errs.length === 0, 'no page errors under an iPhone agent', errs.join(' | '));
  check(!before.exists, 'nothing is held before the instrument is audible');
  check(unmuted.exists && unmuted.paused === false,
    'unmuting starts the silent element, which is what buys the playback category',
    `exists=${unmuted.exists} paused=${unmuted.paused}`);
  // The trap this whole thing turns on: a MUTED element does not count as
  // playing audio, so it would leave the page in "ambient" and change
  // nothing. Silence has to come from the file, never from the element.
  check(unmuted.muted === false && unmuted.volume > 0,
    'and it is unmuted at full volume — a muted element would not move the category',
    `muted=${unmuted.muted} volume=${unmuted.volume}`);
  check(unmuted.loop === true, 'it loops, so the category is held for as long as we play');
  check(unmuted.inline === true, 'playsinline, so iOS does not take over the screen for it');
  check(remuted.paused === true,
    'muting releases it again, giving the phone its own audio back', `paused=${remuted.paused}`);
}
check(asDesktop === 0,
  'no other platform pays for it — nothing is created off iOS', `${asDesktop} elements`);

console.log(`\n${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
