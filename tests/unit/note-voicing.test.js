// Single notes: the same handshapes as chord mode, sounding one note instead
// of a chord, with the hand that is NOT naming the note saying whether it is
// natural, sharp or flat.
//
// Two things are worth pinning here. The first is the arithmetic: an
// accidental is a semitone, and a flattened note must READ as a flat — a
// player who lowered B wants "B♭", and "A♯" is the same pitch reached a
// different way. The second is the hand rule: the accidental comes from the
// off hand, so the same pair of shapes has to work whichever way round the
// hands are, and must not leak into chord voicing, where there is no such
// thing as a sharp chord degree.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chordmode, DEFAULT_KEY, DEFAULT_ACCIDENTAL_GESTURES,
         accidentalSign } from '../../src/chordmode.js';
import { diatonicNote, pitchName, NATURAL, SHARP, FLAT } from '../../src/chords.js';
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

// `thumbsdown` is the real default for ♭ and deliberately untestable here: it
// is classifier-only and has no measured template, so there is no feature
// vector to feed. `gun` stands in — which also exercises the fact that the
// accidental shapes are settings rather than constants.
const FLAT_HANDSHAPE = 'gun';

const reset = ({ voicing = 'note' } = {}) => {
  engine.setTuning({ enabled: false, root: 'C', scale: 'chromatic' });
  chordmode.load({ enabled: true, key: { ...DEFAULT_KEY }, assignments: {} });
  chordmode.setKey({ ...DEFAULT_KEY });
  chordmode.setVoicing(voicing);
  chordmode.setAccidentalGestures({ sharp: 'thumbs', flat: FLAT_HANDSHAPE });
  clearHand('L'); clearHand('R');
  gesture.tick();
};

// What is actually sounding, as MIDI — the one answer that cannot be faked by
// a label. `point` is ASL 1 and holds degree I by default.
const soundingMidi = () => chordmode.currentChord()?.midi ?? [];

// ── The arithmetic ───────────────────────────────────────────────────────

test('a degree sounds its own root, and an accidental is one semitone', () => {
  const nat = diatonicNote('C', 4, 'major (ionian)', 0, NATURAL);
  assert.equal(nat.midi, 60, 'I in C4 is middle C');
  assert.equal(diatonicNote('C', 4, 'major (ionian)', 0, SHARP).midi, 61);
  assert.equal(diatonicNote('C', 4, 'major (ionian)', 0, FLAT).midi, 59);
  // …and it is one pitch, not a list of them: middle C is 261.6 Hz.
  assert.ok(Number.isFinite(nat.freq), `${nat.freq}`);
  assert.ok(nat.freq > 261 && nat.freq < 262, `${nat.freq}`);
});

test('a flattened note reads as a flat, not as the sharp beside it', () => {
  // vii in C is B. Lower it and a player has played B♭, not A♯.
  assert.equal(diatonicNote('C', 4, 'major (ionian)', 6, FLAT).name, 'B♭4');
  assert.equal(diatonicNote('C', 4, 'major (ionian)', 0, SHARP).name, 'C♯4');
  // Both spellings are the same pitch — only the reading differs.
  assert.equal(pitchName(70, FLAT), 'B♭4');
  assert.equal(pitchName(70, SHARP), 'A♯4');
});

test('an accidental onto a white key is just that white key', () => {
  // Flatting C gives B, and naming that "C♭" would be correct on paper and
  // unreadable on a panel. Sharping iii (E) gives F for the same reason.
  assert.equal(diatonicNote('C', 4, 'major (ionian)', 0, FLAT).name, 'B3');
  assert.equal(diatonicNote('C', 4, 'major (ionian)', 2, SHARP).name, 'F4');
});

test('a nonsense accidental clamps to a semitone either way', () => {
  assert.equal(diatonicNote('C', 4, 'major (ionian)', 0, 99).midi, 61);
  assert.equal(diatonicNote('C', 4, 'major (ionian)', 0, -99).midi, 59);
  assert.equal(diatonicNote('C', 4, 'major (ionian)', 0, NaN).midi, 60);
});

test('the accidental sign is a sign, and natural has none', () => {
  assert.equal(accidentalSign(SHARP), '♯');
  assert.equal(accidentalSign(FLAT), '♭');
  assert.equal(accidentalSign(NATURAL), '');
});

// ── The voicing ──────────────────────────────────────────────────────────

test('chords are the default, so every setup saved before notes existed keeps playing chords', () => {
  reset({ voicing: 'chord' });
  assert.equal(chordmode.getVoicing(), 'chord');
  // A save with no voicing at all is an old save.
  chordmode.setVoicing('note');
  chordmode.load({ enabled: true, assignments: {} });
  assert.equal(chordmode.getVoicing(), 'chord');
  assert.deepEqual(chordmode.accidentalGestures(), DEFAULT_ACCIDENTAL_GESTURES);
});

test('the voicing survives a save/load round trip', () => {
  reset();
  chordmode.setAccidentalGestures({ sharp: 'horns', flat: 'asl0' });
  const saved = chordmode.serialize();
  chordmode.setVoicing('chord');
  chordmode.load(saved);
  assert.equal(chordmode.getVoicing(), 'note');
  assert.deepEqual(chordmode.accidentalGestures(), { sharp: 'horns', flat: 'asl0' });
});

test('the same handshape names the same degree in either voicing', () => {
  reset({ voicing: 'chord' });
  assert.equal(chordmode.chordFor('point').numeral, 'I');
  reset();
  assert.equal(chordmode.noteFor('point').numeral, 'I');
  assert.equal(chordmode.noteFor('point').midi, chordmode.chordAt(0).midi[0],
    'the note is the chord’s own root — the shapes did not have to be relearned');
});

test('one shape cannot mean both sharp and flat', () => {
  reset();
  chordmode.setAccidentalGestures({ flat: 'thumbs' });   // already the sharp
  const a = chordmode.accidentalGestures();
  assert.equal(a.flat, 'thumbs', 'the shape just set wins');
  assert.equal(a.sharp, null, 'and the other goes free rather than shadowing it');
});

// ── The hand rule ────────────────────────────────────────────────────────

test('the naming hand plays the degree and the off hand bends it', () => {
  reset();
  feed('L', tmpl('point'));            // names I
  settle();
  assert.deepEqual(soundingMidi(), [60], 'I in C4, natural');

  feed('R', tmpl('thumbs'));           // off hand says sharp
  settle();
  assert.deepEqual(soundingMidi(), [61], 'the same shape, a semitone up');
  assert.equal(chordmode.currentAccidental(), SHARP);

  feed('R', tmpl(FLAT_HANDSHAPE));         // …and now flat
  settle();
  assert.deepEqual(soundingMidi(), [59]);
  assert.equal(chordmode.currentAccidental(), FLAT);

  clearHand('R');                      // no shape at all is natural
  settle();
  assert.deepEqual(soundingMidi(), [60]);
  assert.equal(chordmode.currentAccidental(), NATURAL);
});

test('which hand names and which bends is decided by what is held, not by a setting', () => {
  reset();
  // The mirror image of the test above: degree on the right, accidental left.
  feed('R', tmpl('point'));
  feed('L', tmpl('thumbs'));
  settle();
  assert.deepEqual(soundingMidi(), [61]);
});

test('an accidental shape alone plays nothing — it says how, never what', () => {
  reset();
  feed('L', tmpl('thumbs'));
  settle();
  assert.equal(chordmode.currentChord(), null);
  assert.equal(chordmode.currentLabel(), '');
});

// The indicator earns its place by answering "is my thumb being seen?" BEFORE
// a note is committed to — which is exactly when neither hand is yet the off
// hand, so it has to read either of them.
test('the accidental reads before a note is named, from whichever hand holds it', () => {
  reset();
  feed('R', tmpl('thumbs'));
  settle();
  assert.equal(chordmode.currentChord(), null, 'nothing is sounding yet');
  assert.equal(chordmode.currentAccidental(), SHARP);
  clearHand('R');
  feed('L', tmpl('thumbs'));
  settle();
  assert.equal(chordmode.currentAccidental(), SHARP, 'the other hand reads the same');
});

test('chord voicing has no accidental to report', () => {
  reset({ voicing: 'chord' });
  feed('R', tmpl('thumbs'));
  settle();
  assert.equal(chordmode.currentAccidental(), NATURAL);
});

test('the readout names the note and the accidental that reached it', () => {
  reset();
  feed('L', tmpl('peace'));            // ASL 2 → ii, which is D in C major
  feed('R', tmpl(FLAT_HANDSHAPE));
  settle();
  assert.match(chordmode.currentLabel(), /ii♭ · D♭4$/, chordmode.currentLabel());
});

test('accidentals do not leak into chord voicing', () => {
  reset({ voicing: 'chord' });
  feed('L', tmpl('point'));
  feed('R', tmpl('thumbs'));
  settle();
  // Still the whole triad, still on the key's own notes: there is no such
  // thing as a sharpened degree when the degree is sounding as a chord.
  assert.deepEqual(soundingMidi(), [60, 64, 67]);
  assert.equal(chordmode.currentAccidental(), NATURAL);
});

test('the key still transposes the notes, accidental and all', () => {
  reset();
  feed('L', tmpl('point'));
  feed('R', tmpl('thumbs'));
  settle();
  assert.deepEqual(soundingMidi(), [61]);
  chordmode.setKey({ root: 'E', follow: false });
  settle();
  assert.deepEqual(soundingMidi(), [65], 'I♯ in E is E♯, i.e. F4');
});

test('switching voicing under a held shape does not leave the old sound ringing', () => {
  reset({ voicing: 'chord' });
  feed('L', tmpl('point'));
  settle();
  assert.equal(soundingMidi().length, 3);
  chordmode.setVoicing('note');
  // The bank is handed over: nothing is held until the next tick re-reads the
  // hands, and then it is one note rather than a triad with a note under it.
  assert.equal(chordmode.currentChord(), null);
  settle();
  assert.deepEqual(soundingMidi(), [60]);
});

// The off hand cannot be in two places at once: in 'other hand — openness'
// expression it is already playing the note's loudness, and reading a shape
// off it as well would mean asking for a specific openness, i.e. a specific
// volume. The panel says so; this pins that it is true.
test('accidentals stand down when the off hand is already playing the volume', () => {
  reset();
  chordmode.setExpression({ mode: 'hand', hand: 'R', control: 'volume' });
  feed('L', tmpl('point'));            // left names the note
  feed('R', tmpl('thumbs'));           // right would say sharp, but it is expressing
  settle();
  assert.equal(chordmode.currentAccidental(), NATURAL);
  assert.deepEqual(soundingMidi(), [60], 'natural, not sharp');
});

test('eyebrow expression leaves both hands free, so the accidental still works', () => {
  reset();
  chordmode.setExpression({ mode: 'brow', control: 'volume' });
  bus.register('brow_raise', { min: 0, max: 1 });
  bus.update('brow_raise', 0.55);
  feed('R', tmpl('point'));
  feed('L', tmpl('thumbs'));
  settle();
  assert.deepEqual(soundingMidi(), [61]);
});
