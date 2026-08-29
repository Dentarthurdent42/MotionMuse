// Expression: what SOUNDS a chord, once a handshape has named it.
//
// Holding a shape to hold a note makes that shape do two jobs, and the release
// shape a third — so this splits them: the shape names the chord and latches,
// and a continuous signal (the other hand's openness, or your eyebrows) plays
// it. The part worth pinning is the range mapping: hand openness does NOT
// reach 0 with a closed fist — it bottoms out near 0.38 — so feeding it in raw
// would make silence physically unreachable, which is the failure this whole
// mechanism exists to avoid.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chordmode, DEFAULT_KEY, EXPRESSION_RANGE } from '../../src/chordmode.js';
import { engine } from '../../src/engine.js';
import { gesture, FEATURES } from '../../src/gesture.js';
import { bus } from '../../src/bus.js';
import { devmode } from '../../src/devmode.js';

// chordmode.tick() is a no-op outside dev mode (chord mode is an
// under-construction feature), and needs a started engine.
globalThis.document ??= { body: { classList: { toggle() {}, add() {}, remove() {} } } };
devmode.set(true);

// Drive the recognizer the way the camera does: write a template's feature
// vector onto one hand's bus signals and tick. Registered unsmoothed so a
// frame lands exactly where it is put.
const keysFor = side => [
  ...['thumb', 'index', 'middle', 'ring', 'pinky'].map(n => `finger_${side}_${n}`),
  `hand_${side}_open`, `hand_${side}_spread`, `thumb_out_${side}`,
  ...['index', 'middle', 'ring', 'pinky'].map(n => `contact_${side}_${n}`),
];
const feed = (side, f) => {
  bus.register(`hand_${side}_x`, { min: 0, max: 1 });
  bus.update(`hand_${side}_x`, 0.5);
  keysFor(side).forEach((k, i) => {
    bus.register(k, { min: -1, max: 1 });
    bus.update(k, f[i]);
  });
};
const clearHand = side => {
  bus.register(`hand_${side}_x`, { min: 0, max: 1 });
  bus.update(`hand_${side}_x`, 0);
  keysFor(side).forEach(k => { bus.register(k, { min: -1, max: 1 }); bus.update(k, 0); });
};
const tmpl = id => gesture.list().find(g => g.id === id).f;
// The debounce needs a few frames before a gesture engages.
const settle = (n = 4) => { for (let i = 0; i < n; i++) { gesture.tick(); chordmode.tick(); } };

const setOpen = (side, v) => {
  bus.register(`hand_${side}_open`, { min: 0, max: 1 });
  bus.update(`hand_${side}_open`, v);
};
const setBrow = v => {
  bus.register('brow_raise', { min: 0, max: 1 });
  bus.update('brow_raise', v);
};

const reset = () => {
  engine.setTuning({ enabled: false, root: 'C', scale: 'chromatic' });
  chordmode.load({ enabled: true, key: { ...DEFAULT_KEY }, assignments: {} });
  chordmode.setKey({ ...DEFAULT_KEY });
  clearHand('L'); clearHand('R');
  gesture.tick();
};

test('the default is the old behaviour exactly', () => {
  reset();
  const e = chordmode.expression();
  assert.equal(e.mode, 'gesture');
  assert.equal(e.control, 'gate');
});

test('switching mode re-seeds the range for the new signal', () => {
  reset();
  chordmode.setExpression({ mode: 'hand' });
  assert.deepEqual(
    { lo: chordmode.expression().lo, hi: chordmode.expression().hi },
    EXPRESSION_RANGE.hand);
  chordmode.setExpression({ mode: 'brow' });
  // Eyebrows do not travel as far as a hand opens; keeping the hand's span
  // would make brow mode look broken rather than merely mis-tuned.
  assert.deepEqual(
    { lo: chordmode.expression().lo, hi: chordmode.expression().hi },
    EXPRESSION_RANGE.brow);
  assert.ok(chordmode.expression().hi < EXPRESSION_RANGE.hand.hi);
});

test('an explicit range in the same call still wins over the re-seed', () => {
  reset();
  chordmode.setExpression({ mode: 'brow', lo: 0.2, hi: 0.8 });
  assert.equal(chordmode.expression().lo, 0.2);
  assert.equal(chordmode.expression().hi, 0.8);
});

test('a closed fist reaches true silence — the whole point of the range', () => {
  reset();
  chordmode.setExpression({ mode: 'hand', hand: 'L', control: 'volume' });
  // Right hand names a chord; left hand expresses.
  feed('R', tmpl('point'));
  setOpen('L', 0.38);            // measured openness of a closed fist
  settle();
  assert.equal(chordmode.expressionLevel().level, 0,
    'a fist must be silence, not "fairly loud"');

  setOpen('L', 0.90);            // open palm
  settle(2);
  assert.ok(chordmode.expressionLevel().level > 0.95,
    `an open palm must reach full, got ${chordmode.expressionLevel().level}`);
});

test('the deadzone makes silence a region, not a knife edge', () => {
  reset();
  chordmode.setExpression({ mode: 'hand', hand: 'L', control: 'volume' });
  feed('R', tmpl('point'));
  // Just inside the mapped travel, but within the bottom deadzone.
  setOpen('L', 0.45);
  settle();
  assert.equal(chordmode.expressionLevel().level, 0,
    'the bottom of the travel is silence, so it need not be hit exactly');
  setOpen('L', 0.70);
  settle(2);
  assert.ok(chordmode.expressionLevel().level > 0.2, 'and midway is not');
});

test('two-handed: one hand names the chord, the other plays it', () => {
  reset();
  chordmode.setExpression({ mode: 'hand', hand: 'L', control: 'volume' });
  setOpen('L', 0.38);
  feed('R', tmpl('point'));       // fist is I by default
  settle();
  assert.equal(chordmode.expressionLevel().latched, 'point', 'the right hand named it');
  assert.equal(chordmode.currentLabel().includes('I · C'), true);

  // …and it LATCHES: dropping the naming hand does not stop the sound, because
  // that is not what it controls.
  clearHand('R');
  setOpen('L', 0.9);
  settle();
  assert.equal(chordmode.expressionLevel().latched, 'point', 'the chord held');
  assert.ok(chordmode.expressionLevel().level > 0.9);
});

test('handedness is switchable', () => {
  reset();
  chordmode.setExpression({ mode: 'hand', hand: 'R', control: 'volume' });
  setOpen('R', 0.38);
  feed('L', tmpl('point'));       // now the LEFT hand names it
  settle();
  assert.equal(chordmode.expressionLevel().latched, 'point');
  setOpen('R', 0.9);
  settle(2);
  assert.ok(chordmode.expressionLevel().level > 0.9, 'the right hand now plays');
});

test('gate control attacks once on the way up and releases on the way down', () => {
  reset();
  chordmode.setExpression({ mode: 'hand', hand: 'L', control: 'gate' });
  feed('R', tmpl('point'));
  setOpen('L', 0.42);
  settle();
  assert.equal(chordmode.expressionLevel().gateOpen, false);

  setOpen('L', 0.90);
  settle(2);
  assert.equal(chordmode.expressionLevel().gateOpen, true, 'opening the hand attacks');

  // Hovering at the threshold must not machine-gun the envelope.
  const at = chordmode.expression();
  const raw = at.lo + (at.hi - at.lo) * (at.trigger * (1 - at.deadzone) + at.deadzone);
  for (let i = 0; i < 20; i++) {
    setOpen('L', raw + (i % 2 ? 0.004 : -0.004));
    chordmode.tick();
  }
  assert.equal(chordmode.expressionLevel().gateOpen, true, 'hysteresis held it open');

  setOpen('L', 0.38);
  settle(2);
  assert.equal(chordmode.expressionLevel().gateOpen, false, 'closing releases');
});

test('one-handed: eyebrows play what the hand names', () => {
  reset();
  chordmode.setExpression({ mode: 'brow', control: 'volume' });
  setBrow(0.0);
  feed('R', tmpl('point'));
  settle();
  assert.equal(chordmode.expressionLevel().latched, 'point');
  assert.equal(chordmode.expressionLevel().level, 0, 'a resting brow is silent');
  setBrow(0.55);
  settle(2);
  assert.ok(chordmode.expressionLevel().level > 0.9, 'raised is full');
  // The hand is free to name chords with either side, since the eyebrows are
  // doing the expressing.
  clearHand('R');
  feed('L', tmpl('palm'));
  settle();
  assert.equal(chordmode.expressionLevel().latched, 'palm');
});

test('beat mode: the metronome strikes what the shape names, on SAMPLE beats only', async () => {
  const { metronome } = await import('../../src/metronome.js');
  reset();
  chordmode.setExpression({ mode: 'beat' });
  metronome.load({ on: true, bpm: 120, sig: '4/4' });   // a beat every 0.5 s
  const step = t => { metronome.tick(t); gesture.tick(); chordmode.tick(); };
  try {
    // A shape held when the bar starts: the downbeat strikes it.
    feed('R', tmpl('point'));                           // I by default
    settle();                                            // recognizer debounce
    step(10.0);
    assert.equal(chordmode.soundingDegree(), 0, 'beat one strikes the held shape');
    // Change the shape between beats: nothing moves until the clock says so.
    feed('R', tmpl('palm'));                            // V by default
    for (const t of [10.1, 10.2, 10.3, 10.4]) step(t);
    assert.equal(chordmode.soundingDegree(), 0, 'shapes changed between beats cost nothing');
    step(10.52);
    assert.equal(chordmode.soundingDegree(), 4, 'the next beat samples the new shape');
    // A masked-out beat is skipped entirely: the old chord keeps ringing.
    metronome.toggleMaskBeat(2);
    clearHand('R');
    for (const t of [10.7, 10.9, 11.03]) step(t);
    assert.equal(chordmode.soundingDegree(), 4, 'a rested beat neither strikes nor releases');
    // The next SAMPLE beat finds no shape: that is a rest, and it releases.
    step(11.55);
    assert.equal(chordmode.soundingDegree(), -1, 'a sample beat with no shape releases');
  } finally {
    metronome.load({});
    chordmode.setExpression({ mode: 'gesture' });
  }
});

test('switching expression mode does not leave a chord ringing', () => {
  reset();
  chordmode.setExpression({ mode: 'hand', hand: 'L', control: 'volume' });
  feed('R', tmpl('point'));
  setOpen('L', 0.9);
  settle();
  assert.ok(chordmode.expressionLevel().level > 0);
  chordmode.setExpression({ mode: 'gesture' });
  assert.equal(chordmode.expressionLevel().latched, null,
    'a note nothing can now stop is worse than a silence');
});

test('an inverted or degenerate range is repaired, not honoured', () => {
  reset();
  chordmode.setExpression({ mode: 'hand', lo: 0.8, hi: 0.2 });
  const e = chordmode.expression();
  assert.ok(e.hi > e.lo, `hi ${e.hi} must stay above lo ${e.lo}`);
  chordmode.setExpression({ lo: 'nonsense' });
  assert.ok(Number.isFinite(chordmode.expression().lo));
});

test('expression round-trips through save/load', () => {
  reset();
  chordmode.setExpression({ mode: 'brow', control: 'volume', lo: 0.11, hi: 0.61 });
  const s = JSON.parse(JSON.stringify(chordmode.serialize()));
  chordmode.setExpression({ mode: 'gesture' });
  chordmode.load(s);
  const e = chordmode.expression();
  assert.equal(e.mode, 'brow');
  assert.equal(e.control, 'volume');
  assert.equal(e.lo, 0.11);
  assert.equal(e.hi, 0.61);
});

test('a setup saved before expression existed loads as the old behaviour', () => {
  reset();
  chordmode.load({ enabled: true, assignments: {} });   // no `expression` key
  assert.equal(chordmode.expression().mode, 'gesture');
});

test('the feature vector length is unchanged — this adds no new inputs', () => {
  assert.equal(FEATURES.length, 12);
});
