// A hand the cursor has borrowed must not read as a hand that was LOST.
//
// The two look identical to the bus but mean opposite things. Absence is a
// failure, and the safe answer to it is to fail quiet: decay everything and
// force pinch to 1, because 0 means "hand open" and a volume mapping reads
// that as full blast. A borrowed hand is not a failure — it is in use
// elsewhere — and running it through the fail-quiet path drove the default
// patch's `pinch_R → volume (invquad)` mapping to zero, silencing the whole
// instrument (chords included) the moment a cursor was armed.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvSource }  from '../../src/cv.js';
import { uicontrol } from '../../src/uicontrol.js';
import { bus }       from '../../src/bus.js';

cvSource.registerSignals();
// Re-register pinch WITHOUT smoothing. The real signal is One-Euro filtered,
// and a synchronous test loop shares one timestamp, so dt is ~0 and a filtered
// value barely moves however many frames are pumped through it. Unsmoothed,
// a frame lands exactly where it is put and each assertion means what it says.
['L', 'R'].forEach(s => bus.register(`pinch_${s}`, { min: 0, max: 1 }));

// A minimal MediaPipe-shaped result: one hand per side, fingers spread so the
// shape is unambiguous, thumb and index far apart in world space (not pinched).
//
// The two hands must sit in DIFFERENT places. This built the same hand twice
// and labelled the copies Left and Right, which is not two hands — it is the
// picture of one hand detected twice, and processHands now rejects it as
// such (tests/unit/hand-dupe.test.js), because that duplicate is what let a
// single hand drive both sides' signals.
const pt = (x, y) => ({ x, y, z: 0 });
const lms = (dx = 0) => {
  const l = Array.from({ length: 21 }, () => pt(0.5 + dx, 0.6));
  l[0] = pt(0.50 + dx, 0.80); l[5] = pt(0.45 + dx, 0.68); l[9] = pt(0.50 + dx, 0.68);
  l[13] = pt(0.55 + dx, 0.68); l[17] = pt(0.60 + dx, 0.70);
  l[4] = pt(0.36 + dx, 0.74); l[8] = pt(0.45 + dx, 0.55);
  l[12] = pt(0.50 + dx, 0.54); l[16] = pt(0.55 + dx, 0.56); l[20] = pt(0.60 + dx, 0.60);
  return l;
};
const world = () => {
  const w = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  w[4] = { x: 0, y: 0, z: 0 };
  w[8] = { x: 0.12, y: 0, z: 0 };     // 12 cm apart — emphatically not a pinch
  return w;
};
const result = () => ({
  landmarks: [lms(-0.25), lms(0.25)],
  worldLandmarks: [world(), world()],
  handednesses: [[{ categoryName: 'Left', score: 0.99 }],
                 [{ categoryName: 'Right', score: 0.99 }]],
  gestures: [],
});
const pinch = s => bus.signals.get(`pinch_${s}`)?.value;

test('an unclaimed hand publishes normally — an open hand is not pinched', () => {
  uicontrol.setStageActive(false);
  cvSource.processHands(result());
  assert.ok(pinch('R') < 0.5, `open hand should read unpinched, got ${pinch('R')}`);
});

test('a LOST hand still fails quiet — pinch → 1, the silent end of a volume map', () => {
  uicontrol.setStageActive(false);
  cvSource.processHands({ landmarks: [], worldLandmarks: [], handednesses: [], gestures: [] });
  assert.equal(pinch('L'), 1, 'a lost hand reads fully pinched');
  assert.equal(pinch('R'), 1);
});

test('a BORROWED hand freezes instead — arming a cursor must not silence you', () => {
  // Put the hand somewhere audible first…
  uicontrol.setStageActive(false);
  cvSource.processHands(result());
  const before = { L: pinch('L'), R: pinch('R') };
  assert.ok(before.R < 0.5);

  // …then let the cursor take both hands. The signals must simply stop,
  // not slam to the fail-quiet value that reads as silence.
  uicontrol.setStageActive(true);
  for (let i = 0; i < 5; i++) cvSource.processHands(result());
  assert.equal(pinch('L'), before.L, 'left pinch held its value');
  assert.equal(pinch('R'), before.R, 'right pinch held its value');
  assert.notEqual(pinch('R'), 1, 'must NOT read as a lost hand');

  // And a borrowed hand that also leaves the frame still holds, rather than
  // firing the fail-quiet path from under the cursor.
  cvSource.processHands({ landmarks: [], worldLandmarks: [], handednesses: [], gestures: [] });
  assert.equal(pinch('R'), before.R);
  uicontrol.setStageActive(false);
});
