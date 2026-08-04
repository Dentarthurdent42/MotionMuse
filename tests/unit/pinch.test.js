// Pinch strength must mean what its name says: high when the fingers are
// together. It used to publish raw thumb↔index *distance*, so an open palm
// read as maximum "pinch" (1.0) while an actual pinch read ~0.3.
// Run: npm run test:unit  (plain `node --test`, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinchStrength, PINCH_CLOSED, PINCH_OPEN } from '../../src/math.js';
import { mapper } from '../../src/mapper.js';
import { engine } from '../../src/engine.js';
import { bus } from '../../src/bus.js';
import { makeDynamics } from '../../src/dynamics.js';

// World landmarks are metres; only the separation matters.
const tips = metres => [{ x: 0, y: 0, z: 0 }, { x: metres, y: 0, z: 0 }];
const at = metres => pinchStrength(...tips(metres));

test('a firm pinch reads 1, an open hand reads 0', () => {
  assert.equal(at(0.0), 1);                 // tips coincident
  assert.equal(at(PINCH_CLOSED), 1);        // realistic firm pinch (~3 cm)
  assert.equal(at(PINCH_OPEN), 0);
  assert.equal(at(0.20), 0);                // wide open palm
});

test('the direction is right — this is the reported bug', () => {
  const pinched = at(0.03), openPalm = at(0.10);
  assert.ok(pinched > openPalm,
    `pinch (${pinched}) must read stronger than an open palm (${openPalm})`);
  assert.equal(openPalm, 0);
  assert.equal(pinched, 1);
});

test('strength falls monotonically as the tips separate', () => {
  let prev = Infinity;
  for (let d = 0; d <= 0.12; d += 0.005) {
    const v = at(d);
    assert.ok(v <= prev + 1e-12, `not monotonic at ${d}`);
    assert.ok(v >= 0 && v <= 1);
    prev = v;
  }
});

test('the usable range is actually spanned, not squeezed into the top third', () => {
  // The old mapping wasted everything below ~0.3. Mid-travel should now sit
  // near the middle.
  const mid = at((PINCH_CLOSED + PINCH_OPEN) / 2);
  assert.ok(Math.abs(mid - 0.5) < 0.02, `mid-travel reads ${mid}`);
});

test('degenerate calibration windows do not produce NaN', () => {
  assert.equal(pinchStrength(...tips(0.05), 0.09, 0.09), 0);
  assert.equal(pinchStrength(...tips(0.05), 0.09, 0.03), 0);
  assert.ok(Number.isFinite(at(0)));
});

test('the default preset can actually reach silence with a real pinch', () => {
  // The whole point of the polarity+curve fix: a pinch has to drive the
  // stepped volume all the way onto the silence rung, and an open hand has to
  // reach full level. Before, pinch bottomed out around 0.3 → gain 0.09,
  // which never crossed the gate.
  engine.setVolStep({ enabled: true, steps: 6, floorDb: -30, gate: true });
  bus.register('pinch_R', { min: 0, max: 1 });
  mapper.applyPreset();

  const drive = strength => { bus.update('pinch_R', strength); mapper.tick(); return engine.PARAMS.volume.val; };
  assert.equal(drive(at(0.03)), 0, 'a firm pinch must reach exact silence');
  const open = drive(at(0.12));
  assert.equal(open, makeDynamics(engine.getVolStep()).levels.at(-1), 'an open hand must reach full level');

  // …and the silence zone must be wide enough to hit, not a knife edge.
  let silent = 0, n = 0;
  for (let d = PINCH_CLOSED; d <= PINCH_OPEN; d += 0.001) { n++; if (drive(at(d)) === 0) silent++; }
  const frac = silent / n;
  assert.ok(frac > 0.12 && frac < 0.45,
    `silence should occupy a usable slice of travel, got ${(frac * 100).toFixed(0)}%`);
});
