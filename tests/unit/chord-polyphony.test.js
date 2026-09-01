// Gesture mode used to be monophonic: one `playing` id, so the second hand
// could name a chord and nothing whatever would happen. That is a strange
// limit for a mode whose whole subject is chords — "play a C and an E
// together" was unreachable — and it is what made the MULTI play-along level
// unplayable there.
//
// What is pinned here is the union: every source that names a live degree
// sounds, all of them at once, and the bank plays the union of what they ask
// for. The envelope policy is pinned alongside it, because it is the part
// that is easy to get subtly wrong — one hand LEAVING must not restrike the
// other hand's chord, and one hand ARRIVING must be audible.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chordmode, DEFAULT_KEY } from '../../src/chordmode.js';
import { diatonicChord } from '../../src/chords.js';
import { engine } from '../../src/engine.js';
import { gesture } from '../../src/gesture.js';
import { bus } from '../../src/bus.js';
import { devmode } from '../../src/devmode.js';

globalThis.document ??= { body: { classList: { toggle() {}, add() {}, remove() {} } } };
devmode.set(true);

// Same rig as chord-expression.test.js: write a template's feature vector onto
// one hand's bus signals and tick, which is what the camera does.
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
const settle = (n = 5) => { for (let i = 0; i < n; i++) { gesture.tick(); chordmode.tick(); } };

const reset = ({ voicing = 'chord' } = {}) => {
  engine.setTuning({ enabled: false, root: 'C', scale: 'chromatic' });
  chordmode.load({ enabled: true, key: { ...DEFAULT_KEY }, assignments: {} });
  chordmode.setKey({ ...DEFAULT_KEY });
  chordmode.setVoicing(voicing);
  chordmode.setNamingHand('any');
  clearHand('L'); clearHand('R');
  gesture.tick();
};

const midiOut = () => (chordmode.currentChord()?.midi ?? []).slice();
const degrees = () => chordmode.soundingDegrees().slice().sort((a, b) => a - b);
const chordMidi = d => diatonicChord('C', 4, 'major (ionian)', d,
  chordmode.sevenths()[d]).midi;

// ── The union ────────────────────────────────────────────────────────────

test('two hands naming two degrees sound BOTH of them', () => {
  reset();
  feed('L', tmpl('point'));            // ASL 1 → I
  settle();
  assert.deepEqual(degrees(), [0], 'one hand, one degree');
  const one = midiOut();
  assert.deepEqual(one, chordMidi(0));

  feed('R', tmpl('peace'));            // ASL 2 → ii, alongside it
  settle();
  assert.deepEqual(degrees(), [0, 1], 'both hands name');
  const both = midiOut();
  // Every note of each chord is present, and nothing was invented.
  for (const m of chordMidi(0)) assert.ok(both.includes(m), `I lost ${m}`);
  for (const m of chordMidi(1)) assert.ok(both.includes(m), `ii lost ${m}`);
  assert.equal(both.length, new Set([...chordMidi(0), ...chordMidi(1)]).size);
  assert.ok(both.length > one.length, 'the second hand added something');
});

test('a shared note between two chords is voiced once, not twice', () => {
  reset();
  // I (C E G) and vi (A C E) in C share C and E. Six names, four notes.
  feed('L', tmpl('point'));            // I
  feed('R', tmpl('asl6'));             // vi
  settle();
  const out = midiOut();
  assert.deepEqual(out, [...new Set(out)], 'no duplicate pitches');
  assert.deepEqual(out, [...new Set([...chordMidi(0), ...chordMidi(5)])]
    .sort((a, b) => a - b));
});

test('one hand leaving leaves the other one ringing', () => {
  reset();
  feed('L', tmpl('point'));
  feed('R', tmpl('peace'));
  settle();
  assert.deepEqual(degrees(), [0, 1]);

  clearHand('R');
  settle();
  assert.deepEqual(degrees(), [0], 'the left hand keeps its chord');
  assert.deepEqual(midiOut(), chordMidi(0));

  clearHand('L');
  settle();
  assert.deepEqual(degrees(), [], 'and the last one leaving is silence');
  assert.equal(chordmode.currentChord(), null);
});

test('the readout names every source, not just the first', () => {
  reset();
  feed('L', tmpl('point'));
  settle();
  const solo = chordmode.currentLabel();
  assert.ok(solo.includes('I · C'), solo);

  feed('R', tmpl('asl4'));             // ASL 4 → IV
  settle();
  const duo = chordmode.currentLabel();
  assert.ok(duo.includes('I · C'), duo);
  assert.ok(duo.includes('IV · F'), duo);
  assert.ok(duo.length > solo.length, 'the second source is spelled out too');
});

// A sideless gesture — a face, a stance — is held on neither hand and so
// answers for BOTH when the scan asks each side in turn. One raised eyebrow
// is one voice; counting it twice would double its notes for free.
test('a source is counted once even when both sides report it', () => {
  reset();
  feed('L', tmpl('point'));
  feed('R', tmpl('point'));            // the same shape on both hands
  settle();
  assert.deepEqual(degrees(), [0], 'one degree, named twice');
  assert.deepEqual(midiOut(), chordMidi(0));
});

// The naming-hand filter is what frees a hand to drive a cable. Polyphony must
// not quietly undo it: with one hand naming, the other's shapes stay ignored.
test('polyphony does not override the naming-hand setting', () => {
  reset();
  chordmode.setNamingHand('L');
  feed('L', tmpl('point'));
  feed('R', tmpl('peace'));
  settle();
  assert.deepEqual(degrees(), [0], 'only the naming hand is read');
  chordmode.setNamingHand('any');
  settle();
  assert.deepEqual(degrees(), [0, 1], 'and both, once both are allowed');
});

// The release shape is a stop, not a degree — it stops EVERYTHING, because a
// per-hand release would leave the other hand's chord with no way to end.
test('the release shape stops every source', () => {
  reset();
  feed('L', tmpl('point'));
  feed('R', tmpl('peace'));
  settle();
  assert.deepEqual(degrees(), [0, 1]);
  feed('R', tmpl('fist'));             // the default release shape
  settle();
  assert.deepEqual(degrees(), [], 'a fist is a full stop');
});

// The request this all came from: "support multiple gesture sources so the
// user can play with both hands". A source is not only a hand — a semaphore
// arm position is one too, and the two stack, so you can hold a degree with
// your arms and add another with a hand.
test('a semaphore pose names a chord alongside a handshape', () => {
  reset();
  // Semaphore B is the right arm horizontal, left arm down. Put it on IV.
  for (const k of ['elbow_L', 'elbow_R', 'shoulder_elev_L', 'shoulder_elev_R'])
    bus.register(k, { min: 0, max: 180 });
  for (const k of ['arm_raise_L', 'arm_raise_R']) bus.register(k, { min: 0, max: 1 });
  for (const k of ['shoulder_azim_L', 'shoulder_azim_R']) bus.register(k, { min: -180, max: 180 });
  bus.register('torso_tilt', { min: -1, max: 1 });
  const arms = (L, R) => {
    bus.update('elbow_L', 180); bus.update('elbow_R', 180);
    bus.update('arm_raise_L', L / 180); bus.update('arm_raise_R', R / 180);
    bus.update('shoulder_elev_L', L); bus.update('shoulder_elev_R', R);
    bus.update('shoulder_azim_L', 0); bus.update('shoulder_azim_R', 0);
    bus.update('torso_tilt', 0);
  };
  gesture.setPresence('body', true);
  chordmode.setDegreeGesture(3, 'sem_b');          // IV
  arms(0, 90);                                     // right arm out = B
  settle(10);
  assert.deepEqual(degrees(), [3], 'the arms alone name a degree');

  feed('L', tmpl('point'));                        // …and a hand joins it
  settle();
  assert.deepEqual(degrees(), [0, 3], 'hand and arms sound together');

  arms(0, 0);                                      // arms back to rest
  settle(10);
  assert.deepEqual(degrees(), [0], 'and dropping the arms leaves the hand');
  gesture.setPresence('body', false);
});

// ── The envelope ─────────────────────────────────────────────────────────
//
// The bank has ONE shared envelope, so "attack" is all-or-nothing: an arrival
// has to run it or the new note is inaudible under a percussive setting, and a
// departure must NOT, or letting go of one hand would restrike the other's
// chord — a note you did not play, at a moment you did not choose.
test('arriving attacks, leaving only re-points', () => {
  reset();
  const calls = [];
  const real = { attackChord: engine.attackChord, setChordVoices: engine.setChordVoices,
                 playChord: engine.playChord, releaseChord: engine.releaseChord };
  engine.attackChord = (...a) => { calls.push('attack'); return real.attackChord.apply(engine, a); };
  engine.setChordVoices = (...a) => { calls.push('voices'); return real.setChordVoices.apply(engine, a); };
  engine.releaseChord = (...a) => { calls.push('release'); return real.releaseChord.apply(engine, a); };
  try {
    feed('L', tmpl('point'));
    settle();
    assert.ok(calls.includes('attack'), 'the first hand strikes the chord');

    calls.length = 0;
    feed('R', tmpl('peace'));
    settle();
    assert.ok(calls.includes('attack'), 'a hand joining is struck, or it is silent');

    calls.length = 0;
    clearHand('R');
    settle();
    assert.ok(calls.includes('voices'), 'the remaining chord is re-pointed');
    assert.ok(!calls.includes('attack'), 'and NOT struck again');
    assert.ok(!calls.includes('release'), 'nor released — something is still held');

    calls.length = 0;
    clearHand('L');
    settle();
    assert.ok(calls.includes('release'), 'the last hand leaving does release');
  } finally {
    Object.assign(engine, real);
  }
});

// The bank has to be big enough for what two hands can ask of it. Two
// four-note sevenths is eight notes; a bank that dropped the last four would
// make the second hand sound broken rather than quiet.
test('the voice bank fits everything two hands can name', () => {
  reset();
  chordmode.setSeventh(2, true);
  chordmode.setSeventh(6, true);
  feed('L', tmpl('asl3'));             // iii7
  feed('R', tmpl('asl7'));             // vii°7
  settle();
  const out = midiOut();
  // Whatever the two chords come to once their shared notes are counted once,
  // all of it reaches the bank.
  const want = [...new Set([...chordMidi(2), ...chordMidi(6)])];
  assert.equal(out.length, want.length, 'nothing was dropped on the way to the bank');
  assert.ok(out.length <= engine.chordVoiceCount(),
    `${out.length} notes into ${engine.chordVoiceCount()} voices`);
  // …and the bank is sized for the worst case it can be handed rather than
  // for this one: two sevenths sharing nothing is eight notes. Four voices —
  // what the bank held while only one hand could name — was not enough.
  assert.ok(engine.chordVoiceCount() >= 8,
    `${engine.chordVoiceCount()} voices cannot hold two sevenths`);
});
