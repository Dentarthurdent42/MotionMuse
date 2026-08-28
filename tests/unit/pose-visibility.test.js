// Pose landmarks the model cannot actually see.
//
// MediaPipe scores every pose landmark with a `visibility`, and nothing read
// it — so a subject too close for the model to find a torso (a face filling
// the frame) still published elbow angles, shoulder swings and a torso lean,
// computed from landmarks the model had placed by extrapolating off the edge
// of the picture. Reported as "the poses are all over the place".
//
// Two rules are pinned here. An invisible landmark does not exist, and a
// signal that could not be computed this frame DECAYS rather than standing at
// the last value it was invented from — a frozen garbage angle outlives the
// frame that produced it and keeps driving whatever it is mapped to.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};
globalThis.document ??= {
  getElementById: () => null, querySelectorAll: () => [], addEventListener() {},
  body: { classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
};
globalThis.window ??= { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { cvSource, POSE_VISIBLE } = await import('../../src/cv.js');
const { bus } = await import('../../src/bus.js');
const { radial } = await import('../../src/radial.js');

cvSource.registerSignals();

// A plausible upper body. `vis` sets visibility on every landmark; per-index
// overrides go in `over`.
function pose(vis = 1, over = {}) {
  const lm = [];
  const put = (i, x, y) => { lm[i] = { x, y, z: 0, visibility: over[i] ?? vis }; };
  put(0, 0.50, 0.20);   // nose
  put(11, 0.60, 0.40); put(12, 0.40, 0.40);   // shoulders
  put(13, 0.65, 0.55); put(14, 0.35, 0.55);   // elbows
  put(15, 0.70, 0.70); put(16, 0.30, 0.70);   // wrists
  put(23, 0.58, 0.75); put(24, 0.42, 0.75);   // hips
  return { landmarks: [lm] };
}

const val = k => bus.signals.get(k).value;

test('a visible pose publishes its signals', () => {
  cvSource.processPose(pose(0.99));
  assert.ok(val('elbow_L') > 0, 'elbow angle computed');
  assert.ok(val('shoulder_width') > 0);
  assert.ok(val('head_x') > 0);
});

test('landmarks below the visibility floor are dropped', () => {
  const gated = cvSource._visiblePose(pose(0.99, { 13: 0.1, 15: 0.2 }));
  const lm = gated.landmarks[0];
  assert.ok(lm[11], 'a visible shoulder survives');
  assert.equal(lm[13], undefined, 'a guessed elbow does not');
  assert.equal(lm[15], undefined, 'nor a guessed wrist');
});

test('the floor is a floor, not a filter on everything', () => {
  const at = cvSource._visiblePose(pose(POSE_VISIBLE)).landmarks[0];
  assert.ok(at[11], 'exactly at the threshold counts as seen');
  const under = cvSource._visiblePose(pose(POSE_VISIBLE - 0.01)).landmarks[0];
  assert.equal(under[11], undefined);
});

test('a landmark with no visibility field counts as seen', () => {
  // MoveNet has already applied its own score gate (posebackends.js), so its
  // landmarks arrive unscored and must not be thrown away a second time.
  const lm = [];
  lm[11] = { x: 0.6, y: 0.4, z: 0 };
  const out = cvSource._visiblePose({ landmarks: [lm] }).landmarks[0];
  assert.ok(out[11], 'an unscored landmark survives');
});

test('signals that go invisible decay instead of freezing', () => {
  cvSource.processPose(pose(0.99));
  const held = val('elbow_L');
  assert.ok(held > 0);
  // The arm drops out of the model's confidence — the face-filling-the-frame
  // case, where the elbow it reports is extrapolated.
  for (let i = 0; i < 5; i++) cvSource.processPose(pose(0.99, { 13: 0.05, 15: 0.05 }));
  assert.ok(val('elbow_L') < held,
    'a stale angle must fall away, not stand at the value it was invented from');
});

test('a pose with nothing visible reads exactly like no pose at all', () => {
  cvSource.processPose(pose(0.99));
  const before = val('shoulder_width');
  assert.ok(before > 0);
  // Every landmark guessed: the result still has a "pose" in it, which is
  // what made this different from an empty result before the gate existed.
  cvSource.processPose(pose(0.05));
  assert.ok(val('shoulder_width') < before);
  cvSource.processPose({ landmarks: [] });   // and the empty path still works
  assert.ok(val('shoulder_width') < before);
});

test('radial mode is not handed a forearm the model only guessed at', () => {
  radial.load({ enabled: true, joint: 'wrist', side: 'R' });
  // A hand in view, but the arm behind it invisible.
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  lm[0] = { x: 0.5, y: 0.5 }; lm[9] = { x: 0.5, y: 0.42 }; lm[8] = { x: 0.38, y: 0.5 };
  cvSource.processPose(pose(0.99, { 14: 0.05, 16: 0.05 }));
  radial.feedHands({ R: lm }, null, 1);
  radial.tick();
  const geo = radial.geometry();
  assert.ok(geo, 'the ring still plays');
  // With no forearm it faces the camera: normal straight out, no lean.
  assert.ok(Math.abs(geo.basis.n[0]) < 1e-9 && Math.abs(geo.basis.n[1]) < 1e-9,
    'the ring squares up to the camera rather than riding a guess');
  radial.load({ enabled: false });
});
