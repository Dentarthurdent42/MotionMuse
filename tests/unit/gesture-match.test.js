// Gesture matching: the weighted metric, template separation, the migration
// path for templates recorded against a shorter feature vector, and the
// debounce that stops chord mode re-attacking on every frame.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gesture, gestureLabel, matchGesture, templateDistance, templateSeparation,
  FEATURES, WEIGHTS, NEUTRAL, padTemplate, maskFromLength,
  MATCH_THRESHOLD, SEPARATION_FLOOR,
} from '../../src/gesture.js';
import { bus } from '../../src/bus.js';

const V = x => FEATURES.map(() => x);

// ── The metric ──
test('feature vector, weights and neutrals stay the same length', () => {
  assert.equal(FEATURES.length, 12);
  assert.equal(WEIGHTS.length, FEATURES.length);
  assert.equal(NEUTRAL.length, FEATURES.length);
});

test('identical features match at distance 0', () => {
  const t = gesture.list()[0];
  const m = matchGesture(t.f, [t]);
  assert.equal(m.id, t.id);
  assert.ok(m.dist < 1e-9);
});

test('nearest template wins', () => {
  const T = [{ id: 'lo', f: V(0) }, { id: 'hi', f: V(1) }];
  assert.equal(matchGesture(V(0.9), T, 99).id, 'hi');
  assert.equal(matchGesture(V(0.1), T, 99).id, 'lo');
});

test('a pose too far from everything is rejected', () => {
  const T = [{ id: 'lo', f: V(0) }, { id: 'hi', f: V(1) }];
  assert.equal(matchGesture(V(0.5), T), null);
});

test('weights actually weight: the same error costs more on a louder channel', () => {
  const base = { id: 't', f: V(0.5) };
  const bump = i => { const f = V(0.5); f[i] += 0.3; return f; };
  const thumb    = templateDistance(bump(FEATURES.indexOf('thumb')), base);
  const contact  = templateDistance(bump(FEATURES.indexOf('cPinky')), base);
  assert.ok(contact > thumb * 2,
    `contact ${contact.toFixed(3)} should dominate dead thumb channel ${thumb.toFixed(3)}`);
});

test('hysteresis keeps the currently-held gesture but does not create matches', () => {
  const T = [{ id: 'a', f: V(0) }];
  // Build a pose sitting 3% past the threshold on channel 1 (weight 1):
  // normalized distance = Δ·sqrt(w/Σw), so invert for Δ.
  const wsum = WEIGHTS.reduce((s, w) => s + w, 0);
  const edge = V(0);
  edge[1] = MATCH_THRESHOLD * 1.03 * Math.sqrt(wsum / WEIGHTS[1]);
  assert.equal(matchGesture(edge, T), null, 'not sticky: rejected');
  assert.equal(matchGesture(edge, T, MATCH_THRESHOLD, 'a')?.id, 'a', 'sticky: held');
  const far = V(0); far[1] = 3;
  assert.equal(matchGesture(far, T, MATCH_THRESHOLD, 'a'), null, 'hysteresis is finite');
});

// ── Template set ──
//
// These assertions are about the TEMPLATE set, so they consider only entries
// that carry one. Two built-ins (Thumbs Down, I Love You) are recognized by
// MediaPipe's classifier and have never been measured on a hand here; shipping
// an invented vector for them would be a false match waiting to happen, so
// they have no `f` and matchGesture skips them.
const withTemplates = () => gesture.list().filter(g => g.f);

test('no two shipped templates sit closer than the separation floor', () => {
  const T = withTemplates();
  let worst = { d: Infinity };
  for (let i = 0; i < T.length; i++)
    for (let j = i + 1; j < T.length; j++) {
      const d = templateSeparation(T[i], T[j]);
      if (d < worst.d) worst = { d, a: T[i].id, b: T[j].id };
    }
  assert.ok(worst.d >= SEPARATION_FLOOR,
    `${worst.a} ~ ${worst.b} = ${worst.d.toFixed(3)} < floor ${SEPARATION_FLOOR}`);
  // The threshold may exceed the floor — a pose between two close shapes is
  // arbitrated by nearest-neighbour + hysteresis + debounce, not rejected —
  // but not by so much that a template's exact pose could be misread outright.
  assert.ok(MATCH_THRESHOLD <= SEPARATION_FLOOR * 1.5,
    'threshold has drifted far past the separation floor');
});

test('every template is full length and in range', () => {
  for (const g of withTemplates()) {
    assert.equal(g.f.length, FEATURES.length, `${g.id} wrong length`);
    for (const [i, v] of g.f.entries())
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${g.id}.${FEATURES[i]} = ${v}`);
  }
});

test('each template is its own nearest neighbour', () => {
  const T = withTemplates();
  for (const g of T) assert.equal(matchGesture(g.f, T).id, g.id);
});

test('ASL numbers ship with both a name and a numeral', () => {
  const ids = gesture.list().map(g => g.id);
  for (const id of ['asl0', 'asl3', 'asl4', 'asl6', 'asl7', 'asl8', 'asl9'])
    assert.ok(ids.includes(id), `missing ${id}`);
  const three = gesture.list().find(g => g.id === 'asl3');
  assert.equal(gestureLabel(three), 'Three · ASL 3');
  // 1, 2, 5 and 10 reuse the existing shapes rather than duplicating them.
  assert.equal(gestureLabel(gesture.list().find(g => g.id === 'point')), 'Point · ASL 1');
  assert.equal(gestureLabel(gesture.list().find(g => g.id === 'horns')), 'Rock Horns');
});

// ── Migration ──
test('a template from the 7-feature era is padded, not left unmatchable', () => {
  const old = { id: 'legacy', f: [0.35, 0.2, 0.2, 0.15, 0.15, 0.4, 0.2] };
  const d = templateDistance(V(0.5), old);
  assert.ok(Number.isFinite(d), 'short template must not produce NaN');
  assert.ok(matchGesture(old.f, [old], 99) !== null);

  gesture.load({ custom: [{ id: 'custom1', name: 'Old', f: old.f }] });
  const loaded = gesture.listCustom()[0];
  assert.equal(loaded.f.length, FEATURES.length);
  assert.deepEqual(loaded.f.slice(0, 7), old.f);
  assert.deepEqual(loaded.f.slice(7), NEUTRAL.slice(7));
  // The channels the recording never saw are masked out of the metric — the
  // padded values are placeholders, not opinions.
  assert.deepEqual(loaded.m, maskFromLength(7));
  const live = [...old.f, 0.9, 1, 1, 1, 1];        // wild new-channel values
  assert.ok(templateDistance(live, loaded) < 1e-9,
    'padded channels must not contribute distance');
  gesture.load({ custom: [] });
});

test('padTemplate repairs holes as well as short vectors', () => {
  const p = padTemplate([0.1, NaN, undefined, 0.4]);
  assert.equal(p.length, FEATURES.length);
  assert.equal(p[0], 0.1);
  assert.equal(p[1], NEUTRAL[1]);
  assert.equal(p[2], NEUTRAL[2]);
  assert.equal(p[3], 0.4);
  assert.ok(p.every(Number.isFinite));
});

test('calibration overrides a built-in in place and survives a round-trip', () => {
  gesture.load({ custom: [], hidden: [], recal: {} });
  // `horns` has no reference photo, so it is still a geometric estimate —
  // the ASL numerals are measured now and no longer exercise this path.
  const before = gesture.list().find(g => g.id === 'horns');
  assert.equal(before.est, true, 'horns ships as an estimate');
  assert.ok(gesture.estimated().includes('horns'));

  const tuned = V(0.42);
  gesture.load({ custom: [], hidden: [], recal: { horns: tuned } });
  const after = gesture.list().find(g => g.id === 'horns');
  assert.deepEqual(after.f, tuned);
  assert.equal(after.est, false, 'measured templates lose the estimate flag');
  assert.ok(!gesture.estimated().includes('horns'));
  assert.deepEqual(gesture.serialize().recal.horns, tuned);

  // An override naming a gesture that no longer exists is dropped, not kept.
  gesture.load({ custom: [], hidden: [], recal: { nosuchgesture: tuned } });
  assert.deepEqual(gesture.serialize().recal, {});
});

// ── Debounce ──
const HAND = 'R';
const KEYS = [
  ...['thumb','index','middle','ring','pinky'].map(n => `finger_${HAND}_${n}`),
  `hand_${HAND}_open`, `hand_${HAND}_spread`, `thumb_out_${HAND}`,
  ...['index','middle','ring','pinky'].map(n => `contact_${HAND}_${n}`),
];
// Register unsmoothed so a test frame lands exactly where it's put.
const feed = f => {
  bus.register(`hand_${HAND}_x`, { min: 0, max: 1 });
  bus.update(`hand_${HAND}_x`, 0.5);
  KEYS.forEach((k, i) => { bus.register(k, { min: 0, max: 1 }); bus.update(k, f[i]); });
};
const blank = () => {
  bus.register(`hand_${HAND}_x`, { min: 0, max: 1 });
  bus.update(`hand_${HAND}_x`, 0);
  KEYS.forEach(k => { bus.register(k, { min: 0, max: 1 }); bus.update(k, 0); });
};
const tmpl = id => gesture.list().find(g => g.id === id).f;

test('a gesture engages only after the hold window, then stays engaged', () => {
  gesture.load({ custom: [], hidden: [], recal: {} });
  blank(); gesture.tick();
  assert.deepEqual(gesture.current(), []);

  feed(tmpl('fist'));
  gesture.tick();
  assert.deepEqual(gesture.current(), [], 'one frame is not enough');
  gesture.tick();
  assert.deepEqual(gesture.current(), ['fist']);
  for (let i = 0; i < 20; i++) gesture.tick();
  assert.deepEqual(gesture.current(), ['fist'], 'stays engaged while held');
});

test('switching gestures also costs the hold window, so chords do not re-attack', () => {
  gesture.load({ custom: [], hidden: [], recal: {} });
  blank(); gesture.tick();
  feed(tmpl('palm')); gesture.tick(); gesture.tick();
  assert.deepEqual(gesture.current(), ['palm']);

  feed(tmpl('fist'));
  gesture.tick();
  assert.deepEqual(gesture.current(), ['palm'], 'one frame of the new pose must not steal it');
  gesture.tick();
  assert.deepEqual(gesture.current(), ['fist']);
});

test('alternating poses never flip the active gesture', () => {
  // This is the regression that made chord mode machine-gun: `active` used to
  // be reassigned on every matching frame, and chordmode is edge-triggered.
  gesture.load({ custom: [], hidden: [], recal: {} });
  blank(); gesture.tick();
  feed(tmpl('palm')); gesture.tick(); gesture.tick();

  let flips = 0, prev = gesture.current()[0];
  for (let i = 0; i < 40; i++) {
    feed(tmpl(i % 2 ? 'fist' : 'palm'));
    gesture.tick();
    const now = gesture.current()[0];
    if (now !== prev) flips++;
    prev = now;
  }
  assert.equal(flips, 0, `expected no flips under frame-alternating input, got ${flips}`);
});

test('a single dropped frame does not release a held gesture', () => {
  gesture.load({ custom: [], hidden: [], recal: {} });
  blank(); gesture.tick();
  feed(tmpl('fist')); gesture.tick(); gesture.tick();
  assert.deepEqual(gesture.current(), ['fist']);

  blank(); gesture.tick();
  assert.deepEqual(gesture.current(), ['fist'], 'survives one dropped frame');
  gesture.tick();
  gesture.tick();
  assert.deepEqual(gesture.current(), [], 'released after the miss window');
});
