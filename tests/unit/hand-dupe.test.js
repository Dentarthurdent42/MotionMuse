// One hand, detected twice.
//
// Held close to the lens a single hand can trip the palm detector twice and
// survive non-max suppression as two overlapping detections — which the
// classifier then labels Left and Right, because it is guessing at the same
// pixels twice. Reported as "the hands are intersecting impossibly, and only
// one hand is on screen".
//
// The cost is not the double-drawn skeleton. With both sides enabled the two
// copies are filed under L and R, so ONE hand drives BOTH sides' signals: the
// off hand that bends a note sharp, or plays its volume, becomes the same
// hand that named the note.
//
// The trap this pins is the measure. Clapped hands sit about half a palm
// apart at the WRIST (uicontrol's clap is exactly that pose), so a wrist test
// tight enough to catch a duplicate fuses a clap — which is why the rule is a
// mean over all 21 landmarks, where mirrored hands are an order of magnitude
// apart and a duplicate is near zero.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};
globalThis.document ??= {
  getElementById: () => null, querySelectorAll: () => [], addEventListener() {},
  documentElement: {},
  body: { classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
};
globalThis.window ??= { addEventListener() {}, matchMedia: () => ({ matches: false }) };
// The overlay inks its wrist anchor from a theme token, which is read off the
// live stylesheet; there isn't one here, so every token falls back.
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '' });

const { cvSource } = await import('../../src/cv.js');

// A 21-landmark hand at (x, y), palm length 0.08 — the scale uicontrol's clap
// test uses. `flip` mirrors it about its own wrist, which is what the other
// hand of a pair actually looks like.
function hand(x, y, { flip = false, jitter = 0 } = {}) {
  const s = flip ? -1 : 1;
  const lm = [];
  // 0 wrist, 9 middle MCP one palm "up", the rest fanned out beyond it —
  // enough spread that a mirrored copy separates per landmark.
  lm[0] = { x, y, z: 0 };
  lm[9] = { x, y: y - 0.08, z: 0 };
  for (let i = 1; i < 21; i++) {
    if (i === 9) continue;
    const t = i / 21;
    lm[i] = {
      x: x + s * (0.02 + 0.10 * t) + jitter,
      y: y - 0.02 - 0.09 * t + jitter,
      z: 0,
    };
  }
  return lm;
}

// World landmarks are metres, and only the thumb/index tips are read (pinch),
// but the array has to be a full hand or that read runs off the end.
const worldHand = () => {
  const w = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  w[8] = { x: 0.12, y: 0, z: 0 };     // 12 cm from the thumb: not a pinch
  return w;
};

const result = (...entries) => ({
  landmarks: entries.map(e => e.lm),
  worldLandmarks: entries.map(worldHand),
  handednesses: entries.map(e => [{ categoryName: e.name, score: e.score }]),
  gestures: entries.map(() => []),
});

test('two detections of one hand collapse to one', () => {
  // The same hand, found twice with a little box-to-box wobble, labelled
  // opposite ways — the exact shape of the reported bug.
  const r = result(
    { lm: hand(0.5, 0.5),                    name: 'Right', score: 0.62 },
    { lm: hand(0.5, 0.5, { jitter: 0.004 }), name: 'Left',  score: 0.55 },
  );
  const keep = cvSource._distinctHands(r);
  assert.equal(keep.length, 1, 'one hand is one hand');
  assert.equal(keep[0], 0, 'the copy the model is surer of survives');
});

test('the surviving copy is the better-scored one, whichever came first', () => {
  const r = result(
    { lm: hand(0.5, 0.5),                    name: 'Left',  score: 0.51 },
    { lm: hand(0.5, 0.5, { jitter: 0.004 }), name: 'Right', score: 0.97 },
  );
  assert.deepEqual(cvSource._distinctHands(r), [1]);
});

test('two real hands are two hands — even clapped together', () => {
  // uicontrol's clap: wrists 0.04 apart on a 0.08 palm — half a palm — and
  // mirrored, which is what a wrist-distance rule could not tell from a
  // duplicate.
  const r = result(
    { lm: hand(0.48, 0.5),                 name: 'Left',  score: 0.9 },
    { lm: hand(0.52, 0.5, { flip: true }), name: 'Right', score: 0.9 },
  );
  assert.deepEqual(cvSource._distinctHands(r), [0, 1],
    'a clap must survive, or the wake gesture stops firing');
});

test('hands apart are obviously two', () => {
  const r = result(
    { lm: hand(0.30, 0.5),                 name: 'Left',  score: 0.9 },
    { lm: hand(0.70, 0.5, { flip: true }), name: 'Right', score: 0.9 },
  );
  assert.deepEqual(cvSource._distinctHands(r), [0, 1]);
});

test('nothing detected is nothing kept', () => {
  assert.deepEqual(cvSource._distinctHands({ landmarks: [] }), []);
  assert.deepEqual(cvSource._distinctHands({}), []);
});

test('a degenerate hand cannot swallow a real one', () => {
  // Palm length zero: no scale to measure against, so it is not evidence that
  // anything is a duplicate.
  const flat = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const r = result(
    { lm: flat,            name: 'Left',  score: 0.9 },
    { lm: hand(0.5, 0.5),  name: 'Right', score: 0.9 },
  );
  assert.equal(cvSource._distinctHands(r).length, 2);
});

test('one hand detected twice draws one skeleton', () => {
  // The reported symptom, end to end: process the duplicate pair, then draw,
  // and count the strokes. The overlay takes what processHands RESOLVED, so
  // the picture cannot show a hand the instrument is not playing.
  const ops = [];
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'canvas' ? {} : (...a) => ops.push([String(k), ...a])),
    set: () => true,
  });
  Object.assign(cvSource, {
    ctx, canvas: { width: 640, height: 480 },
    video: { videoWidth: 640, videoHeight: 480 },
    handsL: true, handsR: true,
  });

  cvSource.processHands(result(
    { lm: hand(0.5, 0.5),                    name: 'Right', score: 0.62 },
    { lm: hand(0.5, 0.5, { jitter: 0.004 }), name: 'Left',  score: 0.55 },
  ));
  const sides = ['L', 'R'].filter(s => cvSource._hands[s]);
  assert.deepEqual(sides, ['R'], 'one hand is filed under one side');

  cvSource.drawOverlay(cvSource._hands, null);
  // One stroked skeleton per hand drawn.
  assert.equal(ops.filter(o => o[0] === 'stroke').length, 1,
    'two skeletons intersecting on one hand is the bug');
});

test('_pickSide only considers the distinct hands', () => {
  // One real right hand on screen, found twice; the phantom copy carries a
  // confident "Left".
  const r = result(
    { lm: hand(0.5, 0.5),                    name: 'Right', score: 0.99 },
    { lm: hand(0.5, 0.5, { jitter: 0.004 }), name: 'Left',  score: 0.98 },
  );
  const keep = cvSource._distinctHands(r);
  // With only the LEFT side enabled there is nothing to play with: the one
  // hand present is confidently the right one, and a hand the model is sure
  // belongs to the other side is rejected.
  assert.equal(cvSource._pickSide(r, 'L', keep), -1,
    'a phantom must not become the enabled side’s hand');
  // Unfiltered, the phantom is exactly what it would have returned.
  assert.equal(cvSource._pickSide(r, 'L'), 1);
  // …and the side that IS on screen still gets its hand.
  assert.equal(cvSource._pickSide(r, 'R', keep), 0);
});
