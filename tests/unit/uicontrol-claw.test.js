// The claw (force-pull) must arm only as a *movement* — flash open, then
// claw — and snap only on a genuine plunge. A resting curled hand that
// slowly drifts into claw shape must never take anything.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UIC, clawGate, makeClawState, clawStep, clawRay } from '../../src/uicontrol.js';

// Shape fixtures: metric halves (r/aspect) and curl halves.
const M    = over => ({ r: 1.0, aspect: 2.5, ...over });
const CLAW = over => ({ c8: 0.3, c12: 0.2, c16: 0.3, c20: 0.5,
                        h8: 1.2, h12: 1.2, h16: 1.2, ...over });
const FIST = () => CLAW({ c20: -0.6 });               // pinky folded = a fist
const OPEN = () => CLAW({ c8: 0.9, c12: 0.9, c16: 0.9 });

test('the gate: claw passes, fist and open palm do not', () => {
  assert.ok(clawGate(CLAW(), M(), false));
  assert.ok(!clawGate(FIST(), M(), false), 'pinky must stay OUT');
  assert.ok(!clawGate(OPEN(), M(), false), 'straight fingers are not a claw');
  assert.ok(!clawGate(CLAW(), M({ r: 0.5 }), false), 'mouth too closed');
  assert.ok(!clawGate(CLAW(), M({ aspect: 0.9 }), false), 'pointed at the lens');
});

test('hysteresis: a held lock survives what would not have earned it', () => {
  const border = CLAW({ c12: 0.5 });                  // 0.35 < 0.5 < 0.6
  assert.ok(!clawGate(border, M(), false), 'not good enough to enter');
  assert.ok(clawGate(border, M(), true), 'good enough to hold');
});

test('arming needs the streak AND a recent open flash', () => {
  const st = makeClawState();
  let ev = null;
  for (let i = 0; i < UIC.CLAW_ARM; i++) {
    ev = clawStep(st, CLAW(), M(), 10000 + i * 33, { openRecent: true });
  }
  assert.equal(ev, 'arm');
  assert.ok(st.on);
});

test('a stale open never arms — it coaches, once', () => {
  const st = makeClawState();
  const evs = [];
  for (let i = 0; i < UIC.CLAW_COACH + 5; i++) {
    const ev = clawStep(st, CLAW(), M(), 10000 + i * 33, { openRecent: false });
    if (ev) evs.push(ev);
  }
  assert.deepEqual(evs, ['coach']);
  assert.ok(!st.on);
});

test('a bad frame decays the streak instead of resetting it', () => {
  const st = makeClawState();
  for (let i = 0; i < 10; i++) clawStep(st, CLAW(), M(), 10000 + i * 33, { openRecent: true });
  const before = st.pose;
  clawStep(st, OPEN(), M(), 10400, { openRecent: true });
  assert.equal(st.pose, before - UIC.CLAW_STREAK_DN);
  assert.ok(st.pose > 0, 'one hiccup must not zero the streak');
});

const armIt = (st, t0) => {
  for (let i = 0; i < UIC.CLAW_ARM + 2; i++) {
    clawStep(st, CLAW(), M(), t0 + i * 33, { openRecent: true });
  }
  assert.ok(st.on);
};

test('the plunge: an absolute slam snaps', () => {
  const st = makeClawState();
  armIt(st, 10000);
  assert.equal(clawStep(st, CLAW(), M({ r: 0.30 }), 11000, {}), 'snap');
  assert.ok(!st.on);
});

test('the plunge: a fast collapse from the recent peak snaps', () => {
  const st = makeClawState();
  armIt(st, 10000);
  clawStep(st, CLAW(), M({ r: 1.0 }), 11000, {});     // recent peak
  assert.equal(clawStep(st, CLAW(), M({ r: 0.45 }), 11100, {}), 'snap');
});

test('a slow drift closed never snaps', () => {
  const st = makeClawState();
  armIt(st, 10000);
  // Descend 1.0 → 0.7 over 2s: never < 0.34, never a 0.22 drop within
  // 280ms, and never below the loose mouth floor — held throughout.
  let ev = null;
  for (let i = 0; i <= 40; i++) {
    ev = clawStep(st, CLAW(), M({ r: 1.0 - i * 0.0075 }), 11000 + i * 50, {});
    assert.notEqual(ev, 'snap', `slow drift snapped at step ${i}`);
  }
  assert.equal(ev, 'hold');
  assert.ok(st.on, 'still locked, still straining');
});

test('losing the shape releases the lock after the grace', () => {
  const st = makeClawState();
  armIt(st, 10000);
  assert.equal(clawStep(st, OPEN(), M({ r: 0.9 }), 11000, {}), 'hold');
  assert.equal(clawStep(st, OPEN(), M({ r: 0.9 }), 11000 + UIC.CLAW_LOST_MS + 50, {}), 'drop');
  assert.ok(!st.on);
});

test('clawRay points away from the palm', () => {
  // Thumb and index tips vertical at x≈0.4 (mirrors to 0.6), palm center to
  // their right in image space (mirrors to their LEFT on screen) — so the
  // mouth faces screen-right.
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  lm[4] = { x: 0.4, y: 0.55 };   // thumb tip
  lm[8] = { x: 0.4, y: 0.45 };   // index tip
  lm[5] = { x: 0.5, y: 0.45 };   // knuckle row → palm center right of the mouth
  lm[17] = { x: 0.5, y: 0.55 };
  const ray = clawRay(lm);
  assert.ok(Math.abs(ray.dy) < 0.01, 'mouth line is vertical → ray horizontal');
  assert.ok(ray.dx > 0.9, `ray must face away from the palm, got dx=${ray.dx}`);
});
