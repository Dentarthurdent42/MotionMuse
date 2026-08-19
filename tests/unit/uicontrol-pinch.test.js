// The pinch gate is the load-bearing wall of the hand cursor: every press,
// tap, drag and fling starts and ends here. These tests drive the pure state
// machine through the situations that made naive gap-thresholding unusable —
// fists that look like pinches, motion blur, one-frame noise — and pin the
// hysteresis, probation, ghost and sanity behaviours.
// Run: npm run test:unit  (plain `node --test`, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UIC, pinchSignature, makePinchState, pinchStep } from '../../src/uicontrol.js';

// Metric fixtures. A frontal OK-sign pinch: index arch collapsed, back three
// tall. A fist: every arch collapsed. An open palm: everything tall.
const M = over => ({
  span: 0.1, r: 0.8, aspect: 3.5, tRel: 0.5,
  f8: 1.7, backMean: 1.7, up: 1, open: 0.9, ...over,
});
const PINCH = over => M({ r: 0.2, f8: 1.05, backMean: 1.55, ...over });
const FIST  = over => M({ r: 0.25, f8: 1.05, backMean: 1.10, ...over });

test('signature: OK-sign contrast passes, a fist does not', () => {
  assert.ok(pinchSignature(PINCH()));
  assert.ok(!pinchSignature(FIST()));
  assert.ok(!pinchSignature(M()));                       // open palm
});

test('signature: a rotated palm is judged by the thumb instead', () => {
  assert.ok(pinchSignature(M({ aspect: 1.5, tRel: 1.2, f8: 1.4, backMean: 1.4 })));
  assert.ok(!pinchSignature(M({ aspect: 1.5, tRel: 0.6, f8: 1.4, backMean: 1.4 })));
});

test('enter needs 2 consecutive signature frames, then hysteresis holds', () => {
  const st = makePinchState();
  assert.equal(pinchStep(st, PINCH(), 1000, 0), null);    // 1st: sigPrev not set
  assert.equal(pinchStep(st, PINCH(), 1033, 0), 'press'); // 2nd: instant path
  // Between enter (0.32) and exit (0.55): held.
  assert.equal(pinchStep(st, PINCH({ r: 0.45 }), 1066, 0), null);
  assert.ok(st.pinched);
  assert.equal(pinchStep(st, PINCH({ r: 0.60 }), 1100, 0), 'release');
  assert.ok(!st.pinched);
});

test('enter via the confidence EMA when the instant path misses', () => {
  const st = makePinchState();
  // Five open-but-signatured frames build confidence without entering…
  for (let i = 0; i < 5; i++) pinchStep(st, PINCH({ r: 0.8 }), 1000 + i * 33, 0);
  assert.ok(st.okEma > UIC.EMA_TRUST);
  // …then a gap-closed frame whose own signature is dead still enters.
  assert.equal(pinchStep(st, FIST({ r: 0.25 }), 1200, 0), 'press');
});

test('fast hands need a clearly-open read twice to release', () => {
  const st = makePinchState();
  pinchStep(st, PINCH(), 1000, 0);
  pinchStep(st, PINCH(), 1033, 0);
  const fast = UIC.FAST_HAND + 0.1;
  // 0.60 clears the slow bar (0.55) but not the fast bar (0.70): held.
  assert.equal(pinchStep(st, PINCH({ r: 0.60 }), 1066, fast), null);
  // One clearly-open frame at speed: not yet.
  assert.equal(pinchStep(st, PINCH({ r: 0.75 }), 1100, fast), null);
  // Two in a row: released.
  assert.equal(pinchStep(st, PINCH({ r: 0.75 }), 1133, fast), 'release');
});

test('probation: a fresh pinch that loses its signature is revoked silently', () => {
  const st = makePinchState();
  pinchStep(st, PINCH(), 1000, 0);
  pinchStep(st, PINCH(), 1033, 0);                        // press
  let ev = null;
  for (let i = 0; i < UIC.PROBATION_BAD; i++) {
    ev = pinchStep(st, FIST({ r: 0.25 }), 1066 + i * 33, 0);
  }
  assert.equal(ev, 'drop');
  assert.ok(st.probKill, 'the revoked grip must mute its tap');
  assert.ok(!st.pinched);
});

test('probation does not apply after it has been survived', () => {
  const st = makePinchState();
  pinchStep(st, PINCH(), 1000, 0);
  pinchStep(st, PINCH(), 1033, 0);
  // Live through the probation window with the signature intact…
  for (let t = 1066; t < 1000 + UIC.PROBATION_MS + 100; t += 33) {
    pinchStep(st, PINCH({ r: 0.4 }), t, 0);
  }
  // …after which a curled carry (fist-shaped) no longer revokes.
  for (let i = 0; i < UIC.PROBATION_BAD + 2; i++) {
    assert.equal(pinchStep(st, FIST({ r: 0.3 }), 1600 + i * 33, 0), null);
  }
  assert.ok(st.pinched);
});

test('a pinch born at speed is a ghost: no grab until the hand settles', () => {
  const st = makePinchState();
  pinchStep(st, PINCH(), 1000, UIC.GHOST_BORN + 0.1);
  assert.equal(pinchStep(st, PINCH(), 1033, UIC.GHOST_BORN + 0.1), null);
  assert.ok(st.ghost, 'pinched but not gripping');
  // Self-heal: once slow, the grab fires without a re-pinch.
  assert.equal(pinchStep(st, PINCH({ r: 0.4 }), 1200, UIC.GHOST_HEAL - 0.1), 'press');
  assert.ok(!st.ghost);
});

test('a ghost that opens without healing never pressed — release is a drop', () => {
  const st = makePinchState();
  pinchStep(st, PINCH(), 1000, UIC.GHOST_BORN + 0.1);
  pinchStep(st, PINCH(), 1033, UIC.GHOST_BORN + 0.1);
  assert.equal(pinchStep(st, PINCH({ r: 0.8 }), 1066, 0), 'drop');
});

test('an impossible aspect ratio drops everything', () => {
  const st = makePinchState();
  pinchStep(st, PINCH(), 1000, 0);
  pinchStep(st, PINCH(), 1033, 0);
  assert.equal(pinchStep(st, PINCH({ aspect: UIC.ASPECT_INSANE + 1 }), 1066, 0), 'drop');
  assert.ok(!st.pinched);
});

test('a hand already holding is exempt from the signature test', () => {
  const st = makePinchState();
  // A closed carry looks like a fist; with holding=true it still enters and
  // survives probation.
  assert.equal(pinchStep(st, FIST({ r: 0.25 }), 1000, 0, true), 'press');
  for (let i = 0; i < UIC.PROBATION_BAD + 1; i++) {
    assert.equal(pinchStep(st, FIST({ r: 0.3 }), 1033 + i * 33, 0, true), null);
  }
  assert.ok(st.pinched);
});
