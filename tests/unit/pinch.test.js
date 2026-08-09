// Pinch strength must mean what its name says: high when the fingers are
// together. It used to publish raw thumb↔index *distance*, so an open palm
// read as maximum "pinch" (1.0) while an actual pinch read ~0.3.
// Run: npm run test:unit  (plain `node --test`, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinchStrength, PINCH_CLOSED, PINCH_OPEN, PINCH_SAT } from '../../src/math.js';
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
  // The old mapping wasted everything below ~0.3. Mid-travel sits near the
  // middle — slightly above it, because the closed end saturates (PINCH_SAT).
  const mid = at((PINCH_CLOSED + PINCH_OPEN) / 2);
  assert.ok(mid > 0.45 && mid < 0.65, `mid-travel reads ${mid}`);
});

test('full strength saturates before the nominal closed distance', () => {
  // PINCH_CLOSED is a guess at fingertip-centre separation; hands whose firm
  // pinch measures a centimetre looser must still be able to read 1.0 —
  // "can't quite reach 1" audibly means "can't stop the note".
  const sat = PINCH_CLOSED + (PINCH_OPEN - PINCH_CLOSED) * PINCH_SAT;
  assert.equal(at(sat), 1, 'edge of the saturation zone reads full strength');
  assert.equal(at(sat - 0.002), 1);
  assert.ok(at(sat + 0.004) < 1, 'saturation is a margin, not the whole range');
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

test('silence is reachable coming FROM loud — the direction that matters', () => {
  // The reported bug: "minimum volume step is just quiet". The sweep above
  // starts pinched (silent) and loosens, so it only ever measured *leaving*
  // silence — sticky quantisation made that look fine while entering silence
  // from a note needed 81% pinch strength held steady. Play a note, then
  // close the pinch progressively: silence must engage before the fingers
  // are implausibly tight, and stay engaged.
  engine.setVolStep({ enabled: true, steps: 6, floorDb: -30, gate: true });
  bus.register('pinch_R', { min: 0, max: 1 });
  mapper.applyPreset();
  const drive = strength => { bus.update('pinch_R', strength); mapper.tick(); return engine.PARAMS.volume.val; };

  drive(0);                              // hand open: full level, sticky state at the top
  let entered = null;
  for (let d = PINCH_OPEN; d >= 0; d -= 0.001) {         // now close the pinch
    if (drive(at(d)) === 0) { entered = d; break; }
  }
  assert.ok(entered !== null, 'closing the pinch never reached silence');
  assert.ok(entered >= 0.045,
    `silence should engage by ~4.5cm tip distance, only engaged at ${(entered * 100).toFixed(1)}cm`);
  // and it must hold once entered (no flicker as the pinch tightens further)
  for (let d = entered; d >= 0; d -= 0.001) {
    assert.equal(drive(at(d)), 0, `silence flickered at ${d}`);
  }
});
