// Gestures that are not handshapes.
//
// Asked for from playing: "allow the user to add new gestures, including ones
// that don't use hands". Nothing in the matcher was ever about hands — it is a
// weighted RMS over channels normalized to 0–1, and the bus already publishes
// two more sets of exactly that (the face model's expression channels, the
// pose model's joint angles). A kind is a named channel list; the hand kind is
// the one that has sides.
//
// What these tests pin down is the part that is easy to get wrong: a vector
// read for ONE kind must never be scored against another kind's template. The
// arrays are different lengths and mean different things, so a face template
// asked about a hand vector does not return a wrong answer — it returns a
// confident one.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gesture, gestureLabel, matchGesture, templateDistance, templateSeparation,
  KINDS, kindOf, specOf, padFor, maskFor, SIDELESS_KINDS,
  FEATURES, MATCH_THRESHOLD,
} from '../../src/gesture.js';
import { bus } from '../../src/bus.js';

// ── The kinds themselves ──

test('every kind carries channels, weights and neutrals of one length', () => {
  for (const [name, spec] of Object.entries(KINDS)) {
    assert.equal(spec.weights.length, spec.features.length, `${name} weights`);
    assert.equal(spec.neutral.length, spec.features.length, `${name} neutrals`);
    assert.ok(spec.features.length > 0, `${name} has channels`);
  }
});

test('hand is the sided kind; face and body are not', () => {
  assert.equal(KINDS.hand.sided, true);
  assert.deepEqual(SIDELESS_KINDS.sort(), ['body', 'face']);
});

test('a gesture with no kind is a hand gesture — every built-in, and every save ever made', () => {
  assert.equal(kindOf(undefined), 'hand');
  assert.equal(kindOf({ id: 'fist' }), 'hand');
  assert.equal(kindOf({ id: 'x', kind: 'nonsense' }), 'hand');
  assert.equal(kindOf({ id: 'x', kind: 'face' }), 'face');
  assert.equal(specOf({ kind: 'face' }).features.length, KINDS.face.features.length);
  gesture.list().forEach(g => assert.equal(kindOf(g), 'hand', `${g.id} is a handshape`));
});

test('the face vector excludes gaze, and the body vector excludes where you are standing', () => {
  // Both would make a recorded gesture also demand that you look where you
  // looked, or stand where you stood, when you recorded it.
  assert.ok(!KINDS.face.features.some(f => f.startsWith('gaze')));
  assert.ok(!KINDS.body.features.includes('head_x'));
  assert.ok(!KINDS.body.features.includes('head_y'));
  assert.ok(!KINDS.body.features.includes('shoulder_width'));
});

// ── Kind isolation: the whole point ──

test('a live vector is only scored against templates of its own kind', () => {
  const faceT = { id: 'f1', kind: 'face', f: KINDS.face.features.map(() => 0.5) };
  const handT = { id: 'h1', f: FEATURES.map(() => 0.5) };
  const faceV = KINDS.face.features.map(() => 0.5);

  // Asked as a face vector, only the face template is a candidate…
  assert.equal(matchGesture(faceV, [faceT, handT], MATCH_THRESHOLD, null, 'face')?.id, 'f1');
  // …and asked as a hand vector, the face template is not offered at all,
  // even though its numbers would score perfectly against this one.
  assert.equal(matchGesture(faceV, [faceT], MATCH_THRESHOLD, null, 'hand'), null);
});

test('kind defaults to hand, so existing callers see exactly what they saw', () => {
  const handT = { id: 'h1', f: FEATURES.map(() => 0.5) };
  const faceT = { id: 'f1', kind: 'face', f: KINDS.face.features.map(() => 0.5) };
  const v = FEATURES.map(() => 0.5);
  assert.equal(matchGesture(v, [faceT, handT])?.id, 'h1');
});

test('distance is measured over the template\'s own channel list', () => {
  // A face template has 14 channels; scoring it as if it had the hand's 12
  // would silently ignore the last two — here, the two that differ.
  const t = { id: 'f', kind: 'face', f: KINDS.face.features.map((_, i) => i < 12 ? 0 : 1) };
  const same = KINDS.face.features.map((_, i) => i < 12 ? 0 : 1);
  const differs = KINDS.face.features.map(() => 0);
  assert.equal(templateDistance(same, t), 0);
  assert.ok(templateDistance(differs, t) > 0, 'the tail channels are actually read');
});

test('templates of different kinds can never collide, however close their numbers look', () => {
  const a = { id: 'a', kind: 'face', f: KINDS.face.features.map(() => 0.5) };
  const b = { id: 'b', kind: 'body', f: KINDS.body.features.map(() => 0.5) };
  const c = { id: 'c', kind: 'face', f: KINDS.face.features.map(() => 0.5) };
  assert.equal(templateSeparation(a, b), Infinity, 'never asked at the same time');
  assert.equal(templateSeparation(a, c), 0, 'same kind, same pose — a real collision');
});

// ── Padding and masks follow the kind ──

test('a short template is padded against its OWN channel list, not the hand\'s', () => {
  assert.equal(padFor('face', [0.3]).length, KINDS.face.features.length);
  assert.equal(padFor('body', []).length, KINDS.body.features.length);
  assert.equal(padFor('hand', []).length, FEATURES.length);
  assert.equal(padFor('face', [0.3])[0], 0.3);
  assert.equal(maskFor('face', 2).filter(Boolean).length, 2);
  assert.equal(maskFor('face', 2).length, KINDS.face.features.length);
});

// ── Presence: a resting face and no face are the same all-zero vector ──

test('a sideless kind matches nothing until its source says there is something to read', () => {
  KINDS.face.features.forEach(k =>
    bus.register(k, { label: k, group: 'face', min: 0, max: 1 }));
  gesture.load({ custom: [{ id: 'custom1', name: 'Brows', kind: 'face',
                            f: KINDS.face.features.map(() => 0) }] });

  gesture.setPresence('face', false);
  gesture.tick();
  assert.equal(gesture.current().includes('custom1'), false,
    'a dead face model must not hold a gesture matched forever');

  gesture.setPresence('face', true);
  for (let i = 0; i < 6; i++) gesture.tick();
  assert.equal(gesture.current().includes('custom1'), true);

  gesture.setPresence('face', false);
  for (let i = 0; i < 6; i++) gesture.tick();
  assert.equal(gesture.current().includes('custom1'), false, 'and it lets go again');
  gesture.load({ custom: [] });
});

// ── activeOn: a sideless gesture is held on neither hand, so either may use it ──

test('a sideless gesture answers for either hand, and a hand gesture on that hand wins', () => {
  KINDS.face.features.forEach(k =>
    bus.register(k, { label: k, group: 'face', min: 0, max: 1 }));
  gesture.load({ custom: [{ id: 'custom1', name: 'Brows', kind: 'face',
                            f: KINDS.face.features.map(() => 0) }] });
  gesture.setPresence('face', true);
  for (let i = 0; i < 6; i++) gesture.tick();

  // NAMED BY: LEFT must not make face gestures unplayable.
  assert.equal(gesture.activeOn('L'), 'custom1');
  assert.equal(gesture.activeOn('R'), 'custom1');

  gesture.setPresence('face', false);
  for (let i = 0; i < 6; i++) gesture.tick();
  assert.equal(gesture.activeOn('L'), null);
  gesture.load({ custom: [] });
});

// ── Renaming ──

test('renaming a built-in keeps its gloss — the gloss is what the shape IS', () => {
  const before = gesture.list().find(g => g.asl === '1');
  assert.ok(before, 'ASL 1 is a built-in');
  const after = gesture.rename(before.id, 'Left Index');
  assert.equal(after.name, 'Left Index');
  assert.equal(after.asl, '1', 'the gloss survives');
  assert.equal(gestureLabel(after), 'ASL 1 · Left Index');
  assert.equal(gesture.list().find(g => g.id === before.id).name, 'Left Index');
  gesture.resetNames();
  assert.equal(gesture.list().find(g => g.id === before.id).name, before.name);
});

test('renaming refuses a blank or unchanged name rather than silently clearing one', () => {
  const g = gesture.list()[0];
  assert.equal(gesture.rename(g.id, '   '), null);
  assert.equal(gesture.rename(g.id, g.name), null);
  assert.equal(gesture.rename('nosuchgesture', 'X'), null);
  assert.equal(gesture.list()[0].name, g.name);
});

test('a renamed gesture re-labels its bus signal, so the patchbay agrees with the panel', () => {
  const g = gesture.list().find(x => x.asl === '1');
  gesture.registerSignals();
  gesture.rename(g.id, 'Pointer');
  assert.equal(bus.signals.get(`gesture_${g.id}`).label, 'ASL 1 · Pointer');
  gesture.resetNames();
});

// ── Persistence ──

test('kind and names survive a save/load round trip', () => {
  gesture.load({ custom: [] });
  const builtin = gesture.list().find(g => g.asl === '1');
  gesture.rename(builtin.id, 'Pointer');
  gesture.load({
    ...gesture.serialize(),
    custom: [{ id: 'custom4', name: 'Cheeks', kind: 'face',
               f: KINDS.face.features.map(() => 0.4) }],
  });
  const back = gesture.list().find(g => g.id === 'custom4');
  assert.equal(kindOf(back), 'face');
  assert.equal(back.f.length, KINDS.face.features.length);
  assert.equal(gesture.list().find(g => g.id === builtin.id).name, 'Pointer');

  // …and a save from before kinds existed still loads as handshapes.
  gesture.load([{ id: 'custom1', name: 'Old', f: FEATURES.map(() => 0.5) }]);
  assert.equal(kindOf(gesture.list().find(g => g.id === 'custom1')), 'hand');
  gesture.resetNames();
  gesture.load({ custom: [] });
});

// ── Recalibration records the channels the gesture is already made of ──

test('recalibrating a face gesture records a face vector, not a hand one', () => {
  KINDS.face.features.forEach(k =>
    bus.register(k, { label: k, group: 'face', min: 0, max: 1 }));
  gesture.load({ custom: [{ id: 'custom1', name: 'Brows', kind: 'face',
                            f: KINDS.face.features.map(() => 0.1) }] });
  gesture.setPresence('face', true);
  KINDS.face.features.forEach(k => bus.update(k, 0.8));

  let done = null;
  gesture.recalibrate('custom1', g => { done = g; });
  for (let i = 0; i < 12 && !done; i++) gesture.tick();
  assert.ok(done, 'the capture completed');
  assert.equal(done.f.length, KINDS.face.features.length,
    'a hand-length vector here would overwrite the gesture, not calibrate it');
  gesture.load({ custom: [] });
});
