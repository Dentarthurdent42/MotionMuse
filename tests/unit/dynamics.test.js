// Unit tests for the volume step ladder (dB spacing, silence gate, hysteresis).
// Run: npm run test:unit  (plain `node --test`, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDynamics, stickyStep, EDGES, EDGE_KEYS } from '../../src/dynamics.js';

const db = g => 20 * Math.log10(g);

test('ladder: length is steps, top rung is exactly 0 dB', () => {
  for (const steps of [2, 3, 6, 12]) {
    const d = makeDynamics({ steps, floorDb: -30 });
    assert.equal(d.levels.length, steps);
    assert.equal(d.levels[steps - 1], 1);
  }
});

test('ladder: rungs are equally spaced in dB, not in gain', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, gate: true });
  assert.equal(d.stepDb, 6);
  // Every audible neighbour pair is exactly stepDb apart in dB.
  for (let i = 2; i < d.levels.length; i++) {
    assert.ok(Math.abs(db(d.levels[i] / d.levels[i - 1]) - 6) < 1e-9,
      `rungs ${i - 1}→${i} spaced ${db(d.levels[i] / d.levels[i - 1])} dB`);
  }
  assert.ok(Math.abs(db(d.levels[1]) - -24) < 1e-9);
  // Linear spacing would put rung 4 at 0.8; dB spacing puts it at ~0.501.
  assert.ok(Math.abs(d.levels[4] - 0.5011872) < 1e-6);
});

test('ladder: spacing derives from both knobs', () => {
  assert.equal(makeDynamics({ steps: 5, floorDb: -24 }).stepDb, 6);
  assert.equal(makeDynamics({ steps: 7, floorDb: -36 }).stepDb, 6);
});

test('gate: bottom rung is exactly zero, and reachable', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, gate: true });
  assert.equal(d.levels[0], 0);              // strict zero, not 1e-4
  assert.equal(d.quantize(0).gain, 0);
  assert.equal(d.quantize(1e-9).gain, 0);
  assert.equal(d.quantize(0.001).gain, 0);   // a hand hovering near closed
});

test('gate off: quietest rung is audible, never exactly zero', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, gate: false });
  assert.ok(d.levels[0] > 0);
  assert.ok(Math.abs(d.levels[0] - 10 ** (-30 / 20)) < 1e-12);
  assert.equal(d.quantize(0).gain, d.levels[0]);
});

test('quantize: boundaries are perceptual midpoints, not linear ones', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, gate: true });
  // rungs 3 and 4 are -12 dB (0.2512) and -6 dB (0.5012); the dB midpoint is
  // -9 dB = 0.3548. A linear quantiser would split them at 0.3762.
  assert.equal(d.quantize(0.35).gain, d.levels[3]);
  assert.equal(d.quantize(0.36).gain, d.levels[4]);
});

test('ladder is strictly increasing and a sweep is monotone', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30 });
  for (let i = 1; i < d.levels.length; i++) assert.ok(d.levels[i] > d.levels[i - 1]);

  let prev = null, lastIdx = -1, first = null;
  for (let k = 0; k <= 500; k++) {
    const q = d.quantize(k / 500, prev);
    assert.ok(q.idx >= lastIdx, `idx went backwards at ${k / 500}`);
    if (first === null) first = q.idx;
    lastIdx = q.idx; prev = q.idx;
  }
  assert.equal(first, 0);
  assert.equal(lastIdx, d.levels.length - 1);
});

test('hysteresis prevents chatter at a boundary', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, hysteresis: 0.3 });
  let prev = d.quantize(0.73).idx, flips = 0;
  for (let i = 0; i < 200; i++) {
    const q = d.quantize(0.73 + (i % 2 ? 0.03 : -0.03), prev);
    if (q.idx !== prev) flips++;
    prev = q.idx;
  }
  assert.equal(flips, 0, `expected no chatter, saw ${flips} flips`);
});

test('...and the same input DOES chatter without hysteresis', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, hysteresis: 0 });
  let prev = d.quantize(0.73).idx, flips = 0;
  for (let i = 0; i < 200; i++) {
    const q = d.quantize(0.73 + (i % 2 ? 0.03 : -0.03), prev);
    if (q.idx !== prev) flips++;
    prev = q.idx;
  }
  assert.ok(flips >= 40, `control case should chatter, saw only ${flips}`);
});

test('hysteresis still allows genuine moves', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, hysteresis: 0.3 });
  assert.equal(d.quantize(d.levels[1], 5).idx, 1);   // big jump switches at once
  assert.equal(d.quantize(0, 5).idx, 0);             // to silence from the top
});

test('degenerate configs clamp instead of throwing', () => {
  assert.equal(makeDynamics({ steps: 1 }).steps, 2);
  assert.equal(makeDynamics({ steps: 99 }).steps, 12);
  assert.equal(makeDynamics({ floorDb: 0 }).floorDb, -3);
  assert.equal(makeDynamics({ floorDb: -200 }).floorDb, -72);
  const two = makeDynamics({ steps: 2, floorDb: -30, gate: true });
  assert.deepEqual(two.levels, [0, 1]);
});

test('non-finite input is handled without NaN', () => {
  const d = makeDynamics({ steps: 6 });
  assert.equal(d.quantize(NaN).idx, 0);
  assert.equal(d.quantize(undefined).idx, 0);
  for (const v of [0, 0.1, 0.5, 0.9, 1]) assert.equal(d.indexOf(v), d.quantize(v, null).idx);
});

test('stickyStep', () => {
  assert.equal(stickyStep(2.4, null), 2);
  assert.equal(stickyStep(2.4, 3, 0.3), 3);   // 0.6 away ≤ 0.8 → stay
  assert.equal(stickyStep(2.1, 3, 0.3), 2);   // 0.9 away > 0.8 → move
  assert.equal(stickyStep(7, 0, 0.3), 7);
  assert.equal(stickyStep(NaN, 4), 4);
});

test('edge presets are ordered attack ≤ release ≤ gate', () => {
  for (const k of EDGE_KEYS) {
    const e = EDGES[k];
    assert.ok(e.attackMs >= 5, `${k} attack too short (click risk)`);
    assert.ok(e.releaseMs >= e.attackMs, `${k} release < attack`);
    assert.ok(e.gateMs >= e.releaseMs, `${k} gate < release`);
  }
});

// ── Asymmetric silence capture (the "minimum step is just quiet" bug) ──
import { GATE_CAPTURE } from '../../src/dynamics.js';

test('silence captures well beyond the symmetric rounding boundary', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, gate: true, hysteresis: 0.3 });
  const gainAtPos = pos => 10 ** ((-30 + pos * d.stepDb) / 20);
  // Entering from rung 1 used to need pos < 0.2 (0.5 boundary minus 0.3
  // hysteresis). Now anything below GATE_CAPTURE lands on silence at once.
  assert.equal(d.quantize(gainAtPos(GATE_CAPTURE - 0.05), 1).idx, 0);
  assert.equal(d.quantize(gainAtPos(0.55), 1).idx, 0, 'the old sticky wall is gone');
  // ...from any rung, not just the adjacent one.
  assert.equal(d.quantize(gainAtPos(0.6), 4).idx, 0);
  // But above the capture zone, normal stickiness still applies.
  assert.equal(d.quantize(gainAtPos(0.8), 1).idx, 1);
});

test('leaving silence needs a deliberate move — no chatter at the edge', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, gate: true, hysteresis: 0.3 });
  const gainAtPos = pos => 10 ** ((-30 + pos * d.stepDb) / 20);
  // Inside the dead band (capture … capture+hyst) silence holds.
  assert.equal(d.quantize(gainAtPos(GATE_CAPTURE + 0.1), 0).idx, 0);
  // Beyond it, we leave — to an audible rung, never "rounding back" to 0.
  const out = d.quantize(gainAtPos(GATE_CAPTURE + 0.35), 0).idx;
  assert.ok(out >= 1, `expected an audible rung, got ${out}`);
  // Dithering across the capture edge produces zero flips.
  let prev = 0, flips = 0;
  for (let i = 0; i < 200; i++) {
    const q = d.quantize(gainAtPos(GATE_CAPTURE + (i % 2 ? 0.08 : -0.08)), prev);
    if (q.idx !== prev) flips++;
    prev = q.idx;
  }
  assert.equal(flips, 0, `chatter at the silence edge: ${flips} flips`);
});

test('without the gate, the bottom rung keeps symmetric rounding', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, gate: false, hysteresis: 0 });
  const gainAtPos = pos => 10 ** ((-30 + pos * d.stepDb) / 20);
  assert.equal(d.quantize(gainAtPos(0.6), null).idx, 1, 'no oversized capture when un-gated');
});
