// Unit tests for stepped volume in the engine. Works headless with no Web
// Audio because engine.set() assigns PARAMS[key].val before the `if (!started)`
// bail-out, and volEdges is counted the same way.
// Run: npm run test:unit  (plain `node --test`, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../src/engine.js';
import { makeDynamics } from '../../src/dynamics.js';

const ladder = () => makeDynamics(engine.getVolStep()).levels;
const onLadder = v => ladder().some(l => Math.abs(l - v) < 1e-12);

test('stepped volume lands only on ladder rungs', () => {
  engine.setVolStep({ enabled: true, steps: 6, floorDb: -30, gate: true });
  let seed = 7;
  for (let i = 0; i < 500; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    engine.set('volume', (seed / 0x7fffffff));
    assert.ok(onLadder(engine.PARAMS.volume.val),
      `${engine.PARAMS.volume.val} is not a rung`);
  }
});

test('the floor is exactly zero — silence is representable', () => {
  engine.setVolStep({ enabled: true, gate: true });
  engine.set('volume', 0);
  assert.equal(engine.PARAMS.volume.val, 0);
  engine.set('volume', 0.004);          // a hand hovering near closed
  assert.equal(engine.PARAMS.volume.val, 0);
});

test('a held rung fires exactly one envelope — no per-frame re-ramping', () => {
  engine.setVolStep({ enabled: true, steps: 6, floorDb: -30 });
  engine.set('volume', 0.5);                       // land somewhere
  const start = engine.volLevel().edges;
  for (let i = 0; i < 100; i++) engine.set('volume', 0.5);
  assert.equal(engine.volLevel().edges - start, 0, 'holding re-ramped');

  // jitter inside one rung must also not re-ramp
  const before = engine.volLevel().edges;
  for (let i = 0; i < 100; i++) engine.set('volume', 0.5 + (i % 2 ? 0.02 : -0.02));
  assert.equal(engine.volLevel().edges - before, 0, 'in-rung jitter re-ramped');
});

test('a full sweep fires at most one envelope per rung', () => {
  engine.setVolStep({ enabled: true, steps: 6, floorDb: -30 });
  engine.set('volume', 0);
  const start = engine.volLevel().edges;
  for (let k = 0; k <= 300; k++) engine.set('volume', k / 300);
  const fired = engine.volLevel().edges - start;
  assert.ok(fired <= 6, `expected ≤6 envelopes over the sweep, got ${fired}`);
  assert.ok(fired >= 4, `expected the sweep to actually climb, got ${fired}`);
});

test('disabled is byte-identical to continuous behaviour', () => {
  engine.setVolStep({ enabled: false });
  engine.set('volume', 0.37);
  assert.equal(engine.PARAMS.volume.val, 0.37);
  assert.equal(engine.volLevel(), null);
});

test('slider detent notches follow the ladder, and restore when disabled', () => {
  engine.setVolStep({ enabled: true, steps: 6, floorDb: -30, gate: true });
  const snaps = engine.PARAMS.volume.snaps;
  assert.ok(snaps.length > 0);
  assert.ok(snaps.every(s => onLadder(s)), 'a notch is not on the ladder');
  assert.ok(!snaps.includes(0), 'silence should not be a drag detent');
  engine.setVolStep({ enabled: false });
  assert.deepEqual(engine.PARAMS.volume.snaps, [0.25, 0.5, 0.75]);
});

test('snapshot/restore round-trips volStep, and old snapshots are safe', () => {
  engine.setVolStep({ enabled: true, steps: 8, floorDb: -36, gate: false, edge: 'pluck' });
  const snap = engine.snapshot();
  assert.equal(snap.volStep.steps, 8);
  engine.setVolStep({ enabled: false, steps: 3 });
  engine.restore(snap);
  const v = engine.getVolStep();
  assert.equal(v.steps, 8);
  assert.equal(v.floorDb, -36);
  assert.equal(v.gate, false);
  assert.equal(v.edge, 'pluck');

  // A pre-feature snapshot has no volStep — must leave the config alone.
  const before = engine.getVolStep();
  engine.restore({ params: { volume: 0.5 }, tuning: undefined });
  assert.deepEqual(engine.getVolStep(), before);
});

test('re-enabling re-fires an envelope (stale rung index is cleared)', () => {
  engine.setVolStep({ enabled: true, steps: 6 });
  engine.set('volume', 0.5);
  const before = engine.volLevel().edges;
  engine.setVolStep({ enabled: false });
  engine.setVolStep({ enabled: true });
  assert.ok(engine.volLevel().edges > before);
});

test('an unknown edge preset falls back instead of throwing', () => {
  engine.setVolStep({ enabled: true, edge: 'nonsense' });
  engine.set('volume', 0.9);
  assert.ok(onLadder(engine.PARAMS.volume.val));
});
