// What a released pinch *was* — a tap, a fling, or just letting go — decides
// whether a button fires or a card flies. A grip that never travelled is a
// tap however long it was held; one that hit speed and carried it into the
// release is a fling. These pin each boundary.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UIC, classifyRelease, histVel, cursorMap, handMetrics, speedScale }
  from '../../src/uicontrol.js';

const rel = over => classifyRelease({
  gripMs: 200, trav: 0.005, peak: 0, lastS: 0, probKill: false, ...over,
});

test('short and still is a tap', () => {
  assert.equal(rel({}), 'tap');
});

test('a probation-killed grip never taps', () => {
  assert.equal(rel({ probKill: true }), 'drop');
});

// The bug this pins: a real "pinch to click" is neither quick nor perfectly
// still — a hand drifts while its fingers close, and a first-timer holds the
// pinch for half a second. The old rule (under 300 ms AND under 26 px)
// classified every such press as a drop, so no click ever fired even though
// the press was detected and the cursor moved.
test('a deliberate, held pinch still taps', () => {
  assert.equal(rel({ gripMs: 500,  trav: 0.02 }), 'tap');
  assert.equal(rel({ gripMs: 1500, trav: 0.04 }), 'tap', 'holding is not a reason to refuse');
});

test('travel, not duration, is what makes it a drag', () => {
  assert.equal(rel({ gripMs: 120, trav: UIC.TAP_SLOP + 0.01 }), 'drop');
  assert.equal(rel({ gripMs: 5000, trav: UIC.TAP_SLOP - 0.01 }), 'tap');
});

test('speedScale converts camera travel to screen travel', () => {
  assert.equal(speedScale(0), 1);
  assert.ok(Math.abs(speedScale(0.15) - 1 / 0.7) < 1e-9);
  // A drift the camera sees as small covers more screen at a closer reach,
  // which is exactly why the threshold is applied to the scaled value.
  assert.ok(speedScale(0.22) > speedScale(0.10));
});

test('a fling needs peak speed AND follow-through', () => {
  const fast = { gripMs: 400, trav: 0.2, peak: UIC.FLING_PEAK + 0.2 };
  assert.equal(rel({ ...fast, lastS: (UIC.FLING_PEAK + 0.2) * 0.5 }), 'fling');
  // Peak without follow-through: the hand stopped before releasing.
  assert.equal(rel({ ...fast, lastS: (UIC.FLING_PEAK + 0.2) * 0.2 }), 'drop');
  // Follow-through without peak: never got fast enough.
  assert.equal(rel({ gripMs: 400, trav: 0.2, peak: 0.3, lastS: 0.3 }), 'drop');
});

test('a blur-length grip cannot throw', () => {
  assert.equal(rel({
    gripMs: UIC.FLING_MIN_GRIP - 20, trav: 0.2,
    peak: UIC.FLING_PEAK + 0.5, lastS: UIC.FLING_PEAK + 0.5,
  }), 'drop');
});

test('histVel: peak over the window, velocity from the last segment', () => {
  // 33ms steps moving 0.033/frame → 1.0 frame-widths/s, then a still tail.
  const hist = [];
  for (let i = 0; i < 6; i++) hist.push({ x: i * 0.033, y: 0, t: 1000 + i * 33 });
  hist.push({ x: 5 * 0.033, y: 0, t: 1000 + 6 * 33 });    // still frame
  const { peak, lastS, vx } = histVel(hist, 1000 + 6 * 33);
  assert.ok(Math.abs(peak - 1.0) < 0.02, `peak ≈ 1.0, got ${peak}`);
  assert.ok(lastS < 0.01, 'final segment is still');
  assert.ok(Math.abs(vx) < 0.01);
});

test('histVel: only the recent window counts toward peak', () => {
  // A fast segment older than PEAK_WIN must not register.
  const hist = [
    { x: 0.0, y: 0, t: 1000 }, { x: 0.1, y: 0, t: 1033 },   // fast, old
    { x: 0.1, y: 0, t: 1500 }, { x: 0.101, y: 0, t: 1533 }, // slow, recent
  ];
  const { peak } = histVel(hist, 1533);
  assert.ok(peak < 0.1, `old speed must age out, got ${peak}`);
});

test('cursorMap: the inner frame reaches the full screen, mirrored input', () => {
  const m = 0.15, vw = 1280, vh = 800;
  assert.deepEqual(cursorMap(m, m, m, vw, vh), { x: 0, y: 0 });
  assert.deepEqual(cursorMap(1 - m, 1 - m, m, vw, vh), { x: vw, y: vh });
  const c = cursorMap(0.5, 0.5, m, vw, vh);
  assert.ok(Math.abs(c.x - vw / 2) < 1e-6 && Math.abs(c.y - vh / 2) < 1e-6);
  // Outside the margin clamps rather than escaping.
  assert.deepEqual(cursorMap(0, 1, m, vw, vh), { x: 0, y: vh });
});

test('handMetrics: a synthetic upright hand measures sanely', () => {
  // Wrist below middle-MCP, fingertips above: up should be positive ≈1.
  const p = (x, y) => ({ x, y });
  const lm = Array.from({ length: 21 }, () => p(0.5, 0.5));
  lm[0]  = p(0.50, 0.80);            // wrist
  lm[9]  = p(0.50, 0.70);            // middle MCP → span 0.1
  lm[5]  = p(0.46, 0.70); lm[13] = p(0.54, 0.70); lm[17] = p(0.58, 0.70);
  lm[4]  = p(0.42, 0.62); lm[8]  = p(0.46, 0.55);
  lm[12] = p(0.50, 0.52); lm[16] = p(0.54, 0.55); lm[20] = p(0.58, 0.58);
  const m = handMetrics(lm);
  assert.ok(Math.abs(m.span - 0.1) < 1e-9);
  assert.ok(Math.abs(m.up - 1.0) < 1e-9, `fingers-up hand: up ≈ 1, got ${m.up}`);
  assert.ok(m.r > 0.5, 'thumb and index tips are apart');
  assert.ok(m.aspect > 0 && Number.isFinite(m.aspect));
});
