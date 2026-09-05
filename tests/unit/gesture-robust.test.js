// Gesture matching under realistic degradation — the regression test for the
// field report "most gestures register as point, or nothing at all".
//
// Templates are measured from single reference photos; live hands deviate
// from them systematically: camera angle compresses finger extensions,
// every channel carries frame noise, and where the thumb tip incidentally
// rests against curled fingers varies hand to hand. The matcher must absorb
// all of that for the shapes it ships, and it must NOT start matching a
// relaxed non-gesture hand. This suite drives the real matcher through a
// deterministic model of exactly those deviations, so a future template or
// threshold edit that regresses live behaviour fails here instead of in
// someone's hands.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gesture, matchGesture, FEATURES, MATCH_THRESHOLD,
} from '../../src/gesture.js';

// Deterministic PRNG so failures reproduce exactly.
let seed = 42;
const reset = s => { seed = s; };
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0, seed / 2 ** 32);
const clamp = v => Math.max(0, Math.min(1, v));

const CIDX = ['cIndex', 'cMiddle', 'cRing', 'cPinky'];

// Live-hand degradation model (matches the analysis that set the threshold):
//  - extended fingers vary ±15%, symmetrically. They used to be modelled as
//    compressing one-way (×0.7–1.0), which was right when extension was a
//    base-to-tip DISTANCE: the same finger genuinely measured shorter the
//    closer it came to the lens. Measured by joint angle it does not — the
//    same peace sign shot at arm's length and at 20 cm reads within 0.05 on
//    index, middle and ring — so what is left is that nobody holds a finger
//    at exactly the same bend twice, which cuts both ways.
//  - openness is still a distance ratio, so it still compresses one-way
//  - a genuine thumb contact loosens; a curled finger near the thumb reads a
//    spurious contact anywhere in 0–0.7
//  - thumbOut wobbles ±0.2, spread ±0.15, everything ±0.08 frame noise
const degrade = f => f.map((v, i) => {
  const name = FEATURES[i];
  let x = v;
  if (i >= 1 && i <= 4 && v > 0.5) x = v * (0.85 + 0.3 * rnd());
  if (name === 'open') x = v * (0.8 + 0.25 * rnd());
  if (name.startsWith('c')) {
    x = v > 0.5 ? clamp(v - 0.35 * rnd())
                : clamp(v + 0.7 * rnd() * (f[1 + CIDX.indexOf(name)] < 0.5 ? 1 : 0.2));
  }
  if (name === 'thumbOut') x = clamp(v + (rnd() - 0.5) * 0.4);
  if (name === 'spread')   x = clamp(v + (rnd() - 0.5) * 0.3);
  return clamp(x + (rnd() - 0.5) * 0.16);
});

// A relaxed, half-curled hand that means nothing.
const nonGesture = () => FEATURES.map((n, i) => {
  if (i === 0) return 0.4 + (rnd() - 0.5) * 0.1;
  if (i >= 1 && i <= 4) return 0.35 + rnd() * 0.3;
  if (n === 'open')     return 0.45 + rnd() * 0.25;
  if (n === 'spread')   return 0.2 + rnd() * 0.3;
  if (n === 'thumbOut') return 0.2 + rnd() * 0.5;
  return rnd() * 0.5;
});

// Only entries that carry a template: Thumbs Down and I Love You come from
// MediaPipe's classifier and deliberately ship without one, so there is nothing
// here to degrade or to steal a pose with.
const T = gesture.list().filter(g => g.f);
const CLASSICS = ['fist', 'point', 'peace', 'thumbs', 'palm', 'horns'];
const N = 500;

test('degraded classic poses are recognized, and almost never misread', () => {
  reset(42);
  for (const id of CLASSICS) {
    const t = T.find(g => g.id === id);
    let hit = 0, wrong = 0;
    for (let k = 0; k < N; k++) {
      const m = matchGesture(degrade(t.f), T);
      if (m?.id === id) hit++;
      else if (m) wrong++;
    }
    assert.ok(hit / N >= 0.95, `${id}: only ${(hit / N * 100).toFixed(1)}% recognized`);
    assert.ok(wrong / N <= 0.02, `${id}: ${(wrong / N * 100).toFixed(1)}% misread as another gesture`);
  }
});

test('no single template hoovers up everyone else\'s poses', () => {
  // The reported failure mode: "most registering as point". Count how often
  // each template wins a degraded pose belonging to a DIFFERENT shape.
  reset(1234);
  const stolen = Object.fromEntries(T.map(g => [g.id, 0]));
  let total = 0;
  for (const t of T) {
    for (let k = 0; k < 200; k++) {
      total++;
      const m = matchGesture(degrade(t.f), T);
      if (m && m.id !== t.id) stolen[m.id]++;
    }
  }
  for (const [id, n] of Object.entries(stolen)) {
    assert.ok(n / total <= 0.03,
      `${id} wins ${(n / total * 100).toFixed(1)}% of other shapes' poses — it's an attractor`);
  }
});

test('contact-defined ASL shapes survive ranking against greedier masks', () => {
  // Un-normalized distance let 7-channel classics steal from 12-channel
  // number shapes (asl6 recognition measured 36%). Normalization is the fix;
  // this pins it. Estimated templates are meant to be calibrated, so the bar
  // is "clearly usable", not the classics' 95%.
  reset(99);
  for (const id of ['asl6', 'asl7', 'asl8', 'asl9']) {
    const t = T.find(g => g.id === id);
    let hit = 0;
    for (let k = 0; k < N; k++) if (matchGesture(degrade(t.f), T)?.id === id) hit++;
    assert.ok(hit / N >= 0.7, `${id}: only ${(hit / N * 100).toFixed(1)}% recognized`);
  }
});

test('a relaxed non-gesture hand rarely matches anything', () => {
  reset(7);
  let accepted = 0;
  for (let k = 0; k < 2000; k++) if (matchGesture(nonGesture(), T)) accepted++;
  assert.ok(accepted / 2000 <= 0.08,
    `${(accepted / 20).toFixed(1)}% of relaxed hands matched a gesture (per frame, before debounce)`);
});

test('the threshold sits at the operating knee, not drifted', () => {
  // Both failure directions get worse fast: −0.02 starts rejecting real
  // poses, +0.04 triples non-gesture accepts. Fail if someone nudges it
  // without re-deriving the curve.
  assert.ok(MATCH_THRESHOLD >= 0.17 && MATCH_THRESHOLD <= 0.23,
    `MATCH_THRESHOLD ${MATCH_THRESHOLD} left the validated range — re-run the tuning analysis`);
});
