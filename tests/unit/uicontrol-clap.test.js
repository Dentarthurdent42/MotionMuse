// The clap is the wake word: it must fire on a real clap — palms together,
// fingers up, from apart — and on nothing else, because a false clap opens
// an arming window mid-performance. These drive the pure detector through
// the qualifying sequence and each disqualifier.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UIC, makeClapState, clapStep, makeSelectState, selectStep, raisedQualify } from '../../src/uicontrol.js';

// A hand snapshot at horizontal position wx (mirrored-normalized).
const hand = (wx, over = {}) => ({
  present: true, wx, wy: 0.5, mcpx: wx, mcpy: 0.42,
  up: 1.2, open: 0.9, r: 0.9, pinched: false, lastPinchT: 0, ...over,
});
const gone = { present: false, wx: 0, wy: 0, mcpx: 0, mcpy: 0,
               up: 0, open: 0, r: 1, pinched: false, lastPinchT: 0 };

// Drive a converge-and-clap: apart for a few frames, then together.
// Returns the events fired at each together-frame.
function converge(st, t0, { L = {}, R = {} } = {}) {
  let ev = null;
  for (let i = 0; i < 6; i++) {
    ev = clapStep(st, hand(0.30, L), hand(0.70, R), t0 + i * 33);
    assert.equal(ev, null, 'apart hands must not clap');
  }
  return clapStep(st, hand(0.48, L), hand(0.52, R), t0 + 220);
}

test('the qualifying sequence fires', () => {
  assert.equal(converge(makeClapState(), 10000), 'clap');
});

test('hands that were never apart cannot clap', () => {
  const st = makeClapState();
  let ev = null;
  for (let i = 0; i < 8; i++) {
    ev = clapStep(st, hand(0.48), hand(0.52), 10000 + i * 33);
  }
  assert.equal(ev, null);
});

test('fingers not up disqualifies', () => {
  assert.equal(converge(makeClapState(), 10000, { L: { up: 0.3 } }), null);
});

test('closed hands disqualify', () => {
  assert.equal(converge(makeClapState(), 10000, { R: { open: 0.3, r: 0.3 } }), null);
});

test('a recent pinch on either hand disqualifies', () => {
  assert.equal(
    converge(makeClapState(), 10000, { L: { lastPinchT: 10000 - 200 } }), null);
  // …but an old pinch does not.
  assert.equal(
    converge(makeClapState(), 10000,
             { L: { lastPinchT: 10000 - UIC.CLAP_PINCH_BLOCK - 500 } }), 'clap');
});

test('a grabbed item disqualifies', () => {
  const st = makeClapState();
  for (let i = 0; i < 6; i++) clapStep(st, hand(0.30), hand(0.70), 10000 + i * 33, true);
  assert.equal(clapStep(st, hand(0.48), hand(0.52), 10220, true), null);
});

test('the cooldown blocks an immediate second clap', () => {
  const st = makeClapState();
  assert.equal(converge(st, 10000), 'clap');
  assert.equal(converge(st, 10300), null);
  assert.equal(converge(st, 10300 + UIC.CLAP_COOLDOWN + 1000), 'clap');
});

test('vanish fallback: palms merging at contact still fires', () => {
  const st = makeClapState();
  const t0 = 10000;
  for (let i = 0; i < 6; i++) clapStep(st, hand(0.30), hand(0.70), t0 + i * 33);
  // Converging sample inside the vanish distance but not yet at contact…
  clapStep(st, hand(0.44), hand(0.56), t0 + 220);
  // …then both detections vanish (the palms became one blob).
  assert.equal(clapStep(st, gone, gone, t0 + 280), 'clap');
});

test('vanishing without a qualified converging sample does not fire', () => {
  const st = makeClapState();
  for (let i = 0; i < 6; i++) clapStep(st, hand(0.30), hand(0.70), 10000 + i * 33);
  assert.equal(clapStep(st, gone, gone, 10220), null);
});

// ── Selection window ─────────────────────────────────────────────────────

test('a held raise fills the dwell and toggles once', () => {
  const st = makeSelectState(1000);
  let toggled = [];
  for (let t = 1000; t <= 1000 + UIC.DWELL_MS + 100; t += 50) {
    toggled = toggled.concat(selectStep(st, { L: true, R: false }, t, 50));
  }
  assert.deepEqual(toggled, ['L']);
  // Holding past the fill must not re-toggle.
  assert.deepEqual(selectStep(st, { L: true, R: false }, 2000, 50), []);
});

test('dropping the hand drains the dwell at double speed', () => {
  const st = makeSelectState(1000);
  for (let t = 1000; t < 1400; t += 50) selectStep(st, { L: true, R: false }, t, 50);
  const filled = st.dwell.L;
  assert.ok(filled >= 350, 'accumulated while raised');
  selectStep(st, { L: false, R: false }, 1450, 100);
  assert.ok(st.dwell.L <= filled - 190, 'drains at 2×');
});

test('the window expires quietly', () => {
  const st = makeSelectState(1000);
  assert.deepEqual(selectStep(st, { L: true, R: true }, 1000 + UIC.WINDOW_MS + 1, 50), []);
  assert.equal(st.dwell.L, 0);
});

test('both hands toggled closes the window', () => {
  const st = makeSelectState(1000);
  let all = [];
  for (let t = 1000; t <= 1000 + UIC.DWELL_MS + 200; t += 50) {
    all = all.concat(selectStep(st, { L: true, R: true }, t, 50));
  }
  assert.deepEqual(all.sort(), ['L', 'R']);
  assert.equal(st.until, 0, 'window closed itself');
});

test('raisedQualify wants height and openness together', () => {
  assert.ok(raisedQualify(0.8, 0.9));
  assert.ok(!raisedQualify(0.4, 0.9));   // hand not up
  assert.ok(!raisedQualify(0.8, 0.4));   // hand not open
});
