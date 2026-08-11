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

// ── Asymmetric silence gate (the "minimum step is just quiet" bug, and the
// follow-up "at 2 steps it won't turn on until 0.85") ──
import { GATE_HYST_DB } from '../../src/dynamics.js';

const gainAtPos = (d, pos) => 10 ** ((d.floorDb + pos * d.stepDb) / 20);

test('falling into silence is immediate — no stickiness to fight', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, gate: true, hysteresis: 0.3 });
  // Entering used to need pos < 0.2 (the 0.5 boundary minus 0.3 hysteresis).
  assert.equal(d.quantize(gainAtPos(d, 0.45), 1).idx, 0, 'the old sticky wall is gone');
  assert.equal(d.quantize(gainAtPos(d, 0.45), 4).idx, 0, '...from any rung, not just the adjacent one');
  // Above the boundary, normal stickiness still applies.
  assert.equal(d.quantize(gainAtPos(d, 0.8), 1).idx, 1);
});

test('leaving silence needs a deliberate move — no chatter at the edge', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, gate: true, hysteresis: 0.3 });
  assert.equal(d.quantize(gainAtPos(d, 0.55), 0).idx, 0, 'inside the dead band, silence holds');
  const out = d.quantize(gainAtPos(d, 0.95), 0).idx;
  assert.ok(out >= 1, `expected an audible rung, got ${out}`);
  let prev = 0, flips = 0;
  for (let i = 0; i < 200; i++) {
    const q = d.quantize(gainAtPos(d, 0.5 + (i % 2 ? 0.08 : -0.08)), prev);
    if (q.idx !== prev) flips++;
    prev = q.idx;
  }
  assert.equal(flips, 0, `chatter at the silence edge: ${flips} flips`);
});

test('the gate dead band is the same width in dB at every step count', () => {
  // The reported bug: the band was a fixed 0.3 *step units*, so it scaled with
  // the ladder — 1.8 dB at 6 steps but 9 dB at 2 steps, where one step spans
  // the whole range. At 2 steps the gate would not open until gain 0.84.
  for (const steps of [2, 3, 4, 6, 8, 12]) {
    const d = makeDynamics({ steps, floorDb: -30, gate: true, hysteresis: 0.3 });
    let idx = 0, open = null, close = null;
    for (let g = 0; g <= 1.0001; g += 0.0005) {
      const q = d.quantize(g, idx); if (q.idx !== 0 && open === null) open = g; idx = q.idx;
    }
    for (let g = 1; g >= -0.0001; g -= 0.0005) {
      const q = d.quantize(g, idx); if (q.idx === 0 && close === null) close = g; idx = q.idx;
    }
    const bandDb = 20 * Math.log10(open / close);
    assert.ok(bandDb <= GATE_HYST_DB + 0.5,
      `${steps} steps: dead band ${bandDb.toFixed(1)} dB exceeds ${GATE_HYST_DB} dB`);
    assert.ok(bandDb > 0, `${steps} steps: no dead band at all — will chatter`);
  }
});

test('a 2-step ladder is a usable on/off, not a near-impossible one', () => {
  const d = makeDynamics({ steps: 2, floorDb: -30, gate: true, hysteresis: 0.3 });
  assert.deepEqual(d.levels, [0, 1]);
  let idx = 0, open = null;
  for (let g = 0; g <= 1.0001; g += 0.0005) {
    const q = d.quantize(g, idx); if (q.idx !== 0 && open === null) open = g; idx = q.idx;
  }
  assert.ok(open < 0.35, `2-step gate opens at ${open.toFixed(3)} — was 0.841 when this was reported`);
});

test('without the gate, the bottom rung keeps symmetric rounding', () => {
  const d = makeDynamics({ steps: 6, floorDb: -30, gate: false, hysteresis: 0 });
  assert.equal(d.quantize(gainAtPos(d, 0.6), null).idx, 1, 'no oversized capture when un-gated');
});

// ── Where the gate switches (`gateAt`) ────────────────────────────────────
//
// The ladder's midpoint is a *derivation*, not a preference: at 2 steps it puts
// the on/off switch at 18% of a linear cable's travel, when what an on/off
// control implies is halfway. These tests pin the default to the shipped
// behaviour and then pin the one property that must survive any setting — that
// full volume always opens the gate.
import { GATE_AT_OPTS, GATE_AT_DEFAULT } from '../../src/dynamics.js';

// Sweep the real quantiser up then down, reporting where the gate actually
// opens and closes. Measured, not derived — the point is to catch a
// disagreement between the arithmetic and the state machine.
//
// The sweep runs in rung-position (i.e. dB) space, not linear gain. A linear
// sweep can't resolve this: at -72 dB over 2 steps the gate sits near gain
// 0.002 and its whole 2 dB dead band spans 0.0005 of linear travel, so a linear
// step fine enough to measure it there would be absurdly fine at the top.
const sweepGate = d => {
  const N = d.steps - 1, STEP = N / 20000;
  const gainAt = p => 10 ** ((d.floorDb + Math.min(p, N) * d.stepDb) / 20);
  let idx = 0, openPos = null, closePos = null;
  for (let p = 0; p <= N + 1e-9; p += STEP) {
    const q = d.quantize(gainAt(p), idx); if (q.idx !== 0 && openPos === null) openPos = p; idx = q.idx;
  }
  for (let p = N; p >= -1e-9; p -= STEP) {
    const q = d.quantize(p <= 0 ? 0 : gainAt(p), idx); if (q.idx === 0 && closePos === null) closePos = p; idx = q.idx;
  }
  return {
    openPos, closePos,
    open:  openPos  === null ? null : gainAt(openPos),
    close: closePos === null ? null : gainAt(closePos),
    bandDb: openPos === null || closePos === null ? null : (openPos - closePos) * d.stepDb,
  };
};

test('gateAt defaults to the ladder midpoint — shipped behaviour unchanged', () => {
  const d = makeDynamics({ steps: 2, floorDb: -30, gate: true, hysteresis: 0.3 });
  assert.equal(d.gateAt, GATE_AT_DEFAULT);
  assert.equal(GATE_AT_DEFAULT, 0.5, 'the default must stay the midpoint');
  // -15 dB, the midpoint of a 2-rung/-30 dB ladder.
  assert.ok(Math.abs(d.gateGain - 10 ** (-15 / 20)) < 1e-12,
    `midpoint gate at ${d.gateGain}`);
  // And an explicit 0.5 is indistinguishable from omitting it.
  const e = makeDynamics({ steps: 2, floorDb: -30, gate: true, hysteresis: 0.3, gateAt: 0.5 });
  assert.deepEqual(sweepGate(e), sweepGate(d));
});

test('raising gateAt moves the switch later, monotonically', () => {
  const cfg = { steps: 2, floorDb: -30, gate: true, hysteresis: 0.3 };
  const measured = GATE_AT_OPTS.map(gateAt => {
    const d = makeDynamics({ ...cfg, gateAt });
    const { open, close } = sweepGate(d);
    // The advertised threshold is what the sweep actually finds, within the
    // sweep's own resolution — otherwise the UI label would be a fiction.
    assert.ok(Math.abs(20 * Math.log10(close / d.gateGain)) < 0.05,
      `gateAt ${gateAt}: advertised ${d.gateGain.toFixed(4)}, measured ${close.toFixed(4)}`);
    return { gateAt, open, close };
  });
  for (let i = 1; i < measured.length; i++) {
    assert.ok(measured[i].close > measured[i - 1].close,
      `gateAt ${measured[i].gateAt} closes at ${measured[i].close} — not later than ${measured[i - 1].close}`);
    assert.ok(measured[i].open > measured[i - 1].open, 'open point must move with it');
  }
});

test('the top of the range always opens the gate, whatever it is set to', () => {
  // The failure this guards against is the one that shipped: an open point at
  // or above the top rung, so the gate latches shut and the instrument is
  // silent no matter what the player does. At 2 steps the top rung IS the
  // gate's own neighbour, which is why it has to be checked there too.
  for (const steps of [2, 3, 4, 6, 8, 12]) {
    for (const floorDb of [-12, -30, -48, -72]) {
      for (const gateAt of [...GATE_AT_OPTS, 0, 1, 5, -3, NaN, null, undefined]) {
        const d = makeDynamics({ steps, floorDb, gate: true, hysteresis: 0.3, gateAt });
        const where = `steps=${steps} floor=${floorDb} gateAt=${gateAt}`;
        assert.equal(d.quantize(1, 0).idx > 0, true, `${where}: full scale left the gate shut`);
        const { openPos, closePos, bandDb } = sweepGate(d);
        assert.ok(openPos !== null, `${where}: gate never opened on the way up`);
        assert.ok(closePos !== null, `${where}: gate never closed on the way down`);
        assert.ok(bandDb > 0,
          `${where}: dead band inverted (opens at ${openPos.toFixed(3)}, closes at ${closePos.toFixed(3)} rungs) — will chatter`);
        assert.ok(bandDb <= GATE_HYST_DB + 0.1,
          `${where}: dead band ${bandDb.toFixed(2)} dB, wider than ${GATE_HYST_DB} dB`);
      }
    }
  }
});

test('gateAt never eats the ladder — only rung 0 is affected', () => {
  // A threshold expressed against the whole ladder could silence rungs the
  // slider notches still advertise. Bounding it below rung 1 makes that
  // impossible: every audible rung stays selectable at every setting.
  for (const gateAt of GATE_AT_OPTS) {
    const d = makeDynamics({ steps: 12, floorDb: -48, gate: true, hysteresis: 0.3, gateAt });
    const reached = new Set();
    let idx = 0;
    for (let g = 0; g <= 1.0001; g += 0.0002) { idx = d.quantize(Math.min(g, 1), idx).idx; reached.add(idx); }
    assert.equal(reached.size, d.levels.length,
      `gateAt ${gateAt}: only ${reached.size} of ${d.levels.length} rungs reachable`);
  }
});

test('a raised gateAt is still chatter-free at its own edge', () => {
  const d = makeDynamics({ steps: 2, floorDb: -30, gate: true, hysteresis: 0.3, gateAt: 0.8 });
  const edge = d.gateGain;
  let prev = 0, flips = 0;
  for (let i = 0; i < 200; i++) {
    // Dither by 1 dB either side of the switch — inside the 2 dB dead band.
    const q = d.quantize(edge * 10 ** ((i % 2 ? 1 : -1) / 20), prev);
    if (q.idx !== prev) flips++;
    prev = q.idx;
  }
  assert.equal(flips, 0, `chatter at a raised gate edge: ${flips} flips`);
});

test('at 2 steps the top setting puts the switch near half volume', () => {
  // The ask behind this control: an on/off cable that flips mid-gesture rather
  // than at 18% of it.
  const d = makeDynamics({ steps: 2, floorDb: -30, gate: true, hysteresis: 0.3, gateAt: 0.8 });
  assert.ok(d.gateGain > 0.45 && d.gateGain < 0.55,
    `expected the switch near half scale, got ${d.gateGain.toFixed(3)}`);
});

test('gateAt is reported clamped, and is inert when the gate is off', () => {
  assert.equal(makeDynamics({ gateAt: 99 }).gateAt, 0.8);
  assert.equal(makeDynamics({ gateAt: -1 }).gateAt, 0.05);
  assert.equal(makeDynamics({ gateAt: 'nonsense' }).gateAt, GATE_AT_DEFAULT);
  // Un-gated, the setting must not bend the ordinary rounding.
  const a = makeDynamics({ steps: 6, gate: false, hysteresis: 0, gateAt: 0.05 });
  const b = makeDynamics({ steps: 6, gate: false, hysteresis: 0, gateAt: 0.8 });
  for (let g = 0; g <= 1.0001; g += 0.01)
    assert.equal(a.quantize(g, null).idx, b.quantize(g, null).idx, `un-gated divergence at ${g}`);
});
