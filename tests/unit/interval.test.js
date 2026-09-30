// Interval mode: a handshape names the DISTANCE to the next note — a 3 is a
// third from wherever the melody is — and a trigger (a beat, the STEP input,
// or the shape itself) decides when it moves.
//
// Pinned here: the scale arithmetic (a third is the KEY's third, off-scale
// notes snap, the range folds), the lean → direction rule with its
// hysteresis, how the hands' readings combine (two hands add up, a resting
// fist does not cancel the other hand, sustain holds), and the mode end to
// end with real template features on the bus.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document ??= { body: { classList: { toggle() {}, add() {}, remove() {} } } };

const { interval, stepPitch, scaleIndexOf, midiAtIndex, foldRange, planMove, planOnChange,
        directionFrom, stepsFor, sizeName, DEFAULT_GESTURES, TILT_AT, MIDI_HI } = await import('../../src/interval.js');
const { handTilt } = await import('../../src/math.js');
const { chordmode, DEFAULT_KEY } = await import('../../src/chordmode.js');
const { radial } = await import('../../src/radial.js');
const { engine } = await import('../../src/engine.js');
const { gesture } = await import('../../src/gesture.js');
const { bus } = await import('../../src/bus.js');

const C_MAJOR = { root: 'C', mode: 'major (ionian)' };

// ── Scale arithmetic ─────────────────────────────────────────────────────

test('a size counts like an interval name: a 2nd is one step, a unison none', () => {
  assert.equal(stepsFor(1, 'scale'), 0);
  assert.equal(stepsFor(2, 'scale'), 1);
  assert.equal(stepsFor(8, 'scale'), 7, 'an octave is seven scale steps');
  assert.equal(stepsFor(3, 'semitone'), 3, 'in semitones a size is itself');
  assert.equal(sizeName(8), 'octave');
  assert.equal(sizeName(3, 'semitone'), 'm3');
});

test('the scale line round-trips every note of the key', () => {
  for (let k = 20; k < 50; k++) {
    const m = midiAtIndex(k, 'D', 'dorian');
    assert.equal(scaleIndexOf(m, 'D', 'dorian'), k);
  }
});

test('a third is the key\'s own third — major on C, minor on D', () => {
  assert.equal(stepPitch(60, 2, 'scale', C_MAJOR), 64, 'C up a third is E');
  assert.equal(stepPitch(62, 2, 'scale', C_MAJOR), 65, 'D up a third is F');
  assert.equal(stepPitch(60, -1, 'scale', C_MAJOR), 59, 'C down a second is B');
  assert.equal(stepPitch(60, 7, 'scale', C_MAJOR), 72, 'up an octave');
  assert.equal(stepPitch(60, 2, 'semitone', C_MAJOR), 62, 'semitones ignore the key');
});

test('a note off the key snaps to the scale note below before moving', () => {
  // C# is not in C major: it counts as C, so up a second lands on D, and a
  // unison puts it back on the scale.
  assert.equal(stepPitch(61, 1, 'scale', C_MAJOR), 62);
  assert.equal(stepPitch(61, 0, 'scale', C_MAJOR), 60);
});

test('pentatonic keys step through their five notes', () => {
  const key = { root: 'A', mode: 'minor pentatonic' };   // A C D E G
  assert.equal(stepPitch(57, 1, 'scale', key), 60);
  assert.equal(stepPitch(60, 2, 'scale', key), 64);
});

test('a walk off either end folds back an octave instead of sticking', () => {
  assert.equal(foldRange(MIDI_HI + 2), MIDI_HI + 2 - 12);
  assert.equal(foldRange(20), 44, 'up two octaves into range');
  assert.ok(stepPitch(95, 3, 'scale', C_MAJOR) <= MIDI_HI);
});

// ── The lean ─────────────────────────────────────────────────────────────

test('handTilt: upright is 0, fingers to your right +, to your left −', () => {
  const hand = (dx, dy) => { const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 })); lm[9] = { x: 0.5 + dx, y: 0.5 + dy }; return lm; };
  assert.equal(handTilt(hand(0, -0.1)), 0);
  // The camera image is unmirrored: YOUR right is the image's left (−x).
  assert.ok(Math.abs(handTilt(hand(-0.1, 0)) - 1) < 1e-9, 'flat to your right');
  assert.ok(Math.abs(handTilt(hand(0.1, 0)) + 1) < 1e-9, 'flat to your left');
  assert.ok(Math.abs(handTilt(hand(0.1, -0.1)) + 0.5) < 1e-9, '45° to your left');
  // Normalised x is a fraction of the WIDTH: on a 16:9 frame the same numbers
  // are a steeper lean than on a square one.
  assert.ok(handTilt(hand(0.1, -0.1), 16 / 9) < handTilt(hand(0.1, -0.1), 1));
  assert.equal(handTilt(hand(0.1, 0.3)), -1, 'past horizontal stays at −1');
});

test('upright goes up; tipped left past the threshold goes down, with hysteresis', () => {
  assert.equal(directionFrom(0), 1);
  assert.equal(directionFrom(0.8), 1, 'leaning right is still up');
  assert.equal(directionFrom(-TILT_AT), 1, 'at the threshold, not yet');
  assert.equal(directionFrom(-0.6), -1);
  assert.equal(directionFrom(-TILT_AT, -1), -1, 'once down, the edge holds it down');
  assert.equal(directionFrom(-0.1, -1), 1);
});

// ── Combining the hands ──────────────────────────────────────────────────

const step = (size, dir) => ({ kind: 'step', size, dir });

test('two hands add up: up a third and down a second is up a step', () => {
  assert.deepEqual(planMove([step(3, 1), step(2, -1)]), { action: 'step', steps: 1 });
  assert.deepEqual(planMove([step(3, 1), step(3, -1)]), { action: 'step', steps: 0 },
    'cancelling moves still strike — the same note again');
});

test('a resting fist on the idle hand does not cancel the other hand\'s move', () => {
  assert.deepEqual(planMove([{ kind: 'silence' }, step(2, 1)]), { action: 'step', steps: 1 });
  assert.deepEqual(planMove([{ kind: 'silence' }, { kind: 'none' }]), { action: 'silence' });
  assert.deepEqual(planMove([{ kind: 'sustain' }, { kind: 'silence' }]), { action: 'sustain' });
  assert.deepEqual(planMove([{ kind: 'none' }]), { action: 'silence' }, 'no hand fails quiet');
});

test('on the shape trigger only the hand that changed moves', () => {
  // Left has been holding down-a-2nd; right forms up-a-3rd: only the third.
  assert.deepEqual(planOnChange([step(3, 1)], [step(2, -1), step(3, 1)]), { action: 'step', steps: 2 });
  // Right relaxes while left still holds a shape: keep ringing.
  assert.deepEqual(planOnChange([{ kind: 'none' }], [step(2, -1), { kind: 'none' }]), { action: 'sustain' });
  assert.deepEqual(planOnChange([{ kind: 'none' }], [{ kind: 'none' }]), { action: 'silence' });
  assert.deepEqual(planOnChange([{ kind: 'silence' }], [step(2, -1), { kind: 'silence' }]), { action: 'silence' });
});

// ── End to end ───────────────────────────────────────────────────────────

const keysFor = side => [
  ...['thumb', 'index', 'middle', 'ring', 'pinky'].map(n => `finger_${side}_${n}`),
  `hand_${side}_open`, `hand_${side}_spread`, `thumb_out_${side}`,
  ...['index', 'middle', 'ring', 'pinky'].map(n => `contact_${side}_${n}`),
];
const tilt = (side, v) => { bus.register(`hand_${side}_tilt`, { min: -1, max: 1 }); bus.update(`hand_${side}_tilt`, v); };
const feed = (side, id, lean = 0) => {
  const f = gesture.list().find(g => g.id === id).f;
  bus.register(`hand_${side}_x`, { min: 0, max: 1 });
  bus.update(`hand_${side}_x`, 0.5);
  keysFor(side).forEach((k, i) => { bus.register(k, { min: -1, max: 1 }); bus.update(k, f[i]); });
  tilt(side, lean);
};
const clearHand = side => {
  bus.register(`hand_${side}_x`, { min: 0, max: 1 });
  bus.update(`hand_${side}_x`, 0);
  keysFor(side).forEach(k => { bus.register(k, { min: -1, max: 1 }); bus.update(k, 0); });
  tilt(side, 0);
};
const settle = (n = 6) => { for (let i = 0; i < n; i++) { gesture.tick(); interval.tick(); } };
const press = () => { interval.step(); interval.tick(); };

const reset = (cfg = {}) => {
  engine.setTuning({ enabled: false, root: 'C', scale: 'chromatic' });
  chordmode.load({ enabled: false, key: { ...DEFAULT_KEY, follow: false } });
  radial.load({ enabled: false });
  interval.load({ enabled: true, trigger: 'step', ...cfg });
  clearHand('L'); clearHand('R');
  settle();
};

test('one hand: the shape says how far, the lean says which way', () => {
  reset();
  assert.equal(interval.note(), 60, 'starts on the tonic, C4');
  feed('R', DEFAULT_GESTURES[3]); settle();
  assert.equal(interval.note(), 60, 'holding a shape moves nothing without a trigger');
  press();
  assert.equal(interval.note(), 64, 'up a third: E');
  assert.equal(interval.sounding(), true);
  feed('R', DEFAULT_GESTURES[2], -0.8); settle(); press();
  assert.equal(interval.note(), 62, 'tipped left: down a second, D');
  feed('R', DEFAULT_GESTURES.silence); settle(); press();
  assert.equal(interval.sounding(), false, 'a fist is silence');
  assert.equal(interval.note(), 62, 'and the melody stays where it was');
  interval.home();
  assert.equal(interval.note(), 60, 'HOME goes back to the tonic');
});

test('one hand reads only the playing hand', () => {
  reset({ hand: 'R' });
  feed('L', DEFAULT_GESTURES[5]); settle(); press();
  assert.equal(interval.sounding(), false, 'the left hand is free for other work');
  assert.equal(interval.note(), 60);
});

test('two hands: the right hand goes up, the left goes down', () => {
  reset({ hands: 'two' });
  feed('R', DEFAULT_GESTURES[5]); settle(); press();
  assert.equal(interval.note(), 67, 'up a fifth: G');
  feed('R', DEFAULT_GESTURES.silence);
  feed('L', DEFAULT_GESTURES[3], 0.9); settle(); press();
  assert.equal(interval.note(), 64, 'left hand down a third — lean does not matter here');
});

test('the shape trigger moves once per shape formed, not per frame', () => {
  reset({ trigger: 'change' });
  feed('R', DEFAULT_GESTURES[2]); settle(12);
  assert.equal(interval.note(), 62, 'one step, however long it is held');
  clearHand('R'); settle(12);
  assert.equal(interval.sounding(), false, 'dropping the hand lets go');
  feed('R', DEFAULT_GESTURES[2]); settle(12);
  assert.equal(interval.note(), 64, 'forming it again moves again');
});

test('the modes share the chord bank: enabling one parks the others', () => {
  reset();
  assert.equal(interval.enabled, true);
  assert.equal(chordmode.enabled, false);
  chordmode.setEnabled(true);
  interval.tick();
  assert.equal(interval.enabled, false, 'gesture mode switching on takes the bank');
  interval.setEnabled(true);
  assert.equal(chordmode.enabled, false, 'and switching this on takes it back');
  interval.load({ enabled: false });
});

test('a setup carries its interval settings, and one shape keeps one job', () => {
  reset({ hands: 'two', unit: 'semitone', trigger: 'beat' });
  interval.setGesture('sustain', DEFAULT_GESTURES[4]);
  const saved = interval.serialize();
  assert.equal(saved.gestures[4], null, 'taking ASL 4 for sustain freed it from the 4th');
  interval.load({});
  interval.load(saved);
  assert.deepEqual(interval.config(), { hands: 'two', hand: 'R', trigger: 'beat', unit: 'semitone' });
  assert.equal(interval.gestures().sustain, DEFAULT_GESTURES[4]);
  interval.load({ enabled: false });
});

test('a default interval setup is left out of saves, and absent loads as off', () => {
  interval.load({});
  assert.equal(interval.isDefault(), true);
  interval.setUnit('semitone');
  assert.equal(interval.isDefault(), false, 'any change is worth saving');
  interval.load({});
  assert.equal(interval.config().unit, 'scale');
  assert.equal(interval.enabled, false);
});
