// Which detection drives an enabled side when only one hand is wanted.
//
// The reported bug: "when enabling only one hand, it still detects the other
// hand". Both obvious fixes are wrong on their own — trusting MediaPipe's
// handedness label outright makes a shaky frame jump every signal to the other
// side's keys, and ignoring it (what shipped) lets a hand resting in your lap
// play the instrument. The rule is a middle one, so it is pinned here.
//
// The logic under test is cvSource._pickSide, which is pure: it takes a result
// and a side and returns an index. Extracted from the module by loading cv.js
// with the browser globals it touches at import time stubbed out.
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

const { cvSource } = await import('../../src/cv.js');

// A result with one entry per (side, score) pair given.
const res = (...hands) => ({
  landmarks: hands.map((_, i) => [{ x: i, y: 0, z: 0 }]),
  worldLandmarks: hands.map(() => [{ x: 0, y: 0, z: 0 }]),
  handednesses: hands.map(([name, score]) => [{ categoryName: name, score }]),
  gestures: hands.map(() => []),
});

const pick = (r, side) => cvSource._pickSide(r, side);

test('a confidently-matching hand is chosen', () => {
  assert.equal(pick(res(['Left', 0.99]), 'L'), 0);
  assert.equal(pick(res(['Right', 0.99]), 'R'), 0);
});

test('the wanted hand is found among two — this is the bug', () => {
  // Left enabled, right hand happens to be listed first (higher palm score,
  // e.g. it is closer to the camera resting on a desk). Before this, index 0
  // won and the right hand played.
  assert.equal(pick(res(['Right', 0.98], ['Left', 0.97]), 'L'), 1);
  assert.equal(pick(res(['Left', 0.97], ['Right', 0.98]), 'R'), 1);
});

test('a hand confidently identified as the OTHER side is rejected', () => {
  assert.equal(pick(res(['Right', 0.99]), 'L'), -1, 'left enabled, right hand shown');
  assert.equal(pick(res(['Left', 0.99]), 'R'), -1, 'right enabled, left hand shown');
});

test('an unsure hand is accepted rather than dropped', () => {
  // The old lenient behaviour, kept for exactly the case it was protecting:
  // a correctly-shown hand the model is having trouble labelling must not
  // flicker out of existence.
  assert.equal(pick(res(['Right', 0.55]), 'L'), 0);
  assert.equal(pick(res(['Left', 0.5]), 'R'), 0);
});

test('a confident match beats an unsure one, whatever the order', () => {
  assert.equal(pick(res(['Right', 0.6], ['Left', 0.95]), 'L'), 1);
  assert.equal(pick(res(['Left', 0.95], ['Right', 0.6]), 'L'), 0);
});

test('two confident wrong hands are both rejected', () => {
  assert.equal(pick(res(['Right', 0.97], ['Right', 0.95]), 'L'), -1);
});

test('no detections means no hand', () => {
  assert.equal(pick(res(), 'L'), -1);
});

test('a missing handedness entry does not throw and counts as unsure', () => {
  const r = { landmarks: [[{ x: 0 }]], worldLandmarks: [], handednesses: [[]], gestures: [] };
  assert.equal(pick(r, 'L'), 0);
});
