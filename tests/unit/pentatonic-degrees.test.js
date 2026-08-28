// Pentatonic keys in the degree system: five degrees that stack, number and
// transpose like the seven diatonic ones — and what happens to assignments
// and FOLLOW at the 7↔5 boundary.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diatonicChord, diatonicNote, DEGREE_SCALES, DIATONIC_SCALES,
         isDegreeScale, degreeCountOf } from '../../src/chords.js';
import { SCALES } from '../../src/scale.js';
import { chordmode, DEFAULT_KEY } from '../../src/chordmode.js';
import { engine } from '../../src/engine.js';

const reset = () => {
  engine.setTuning({ enabled: false, root: 'C', scale: 'chromatic' });
  chordmode.load({ enabled: false, key: { ...DEFAULT_KEY }, assignments: {} });
  chordmode.setKey({ ...DEFAULT_KEY });
};

test('the degree scales are the 7-note modes plus the two pentatonics', () => {
  for (const s of DIATONIC_SCALES) assert.ok(DEGREE_SCALES.includes(s));
  assert.ok(DEGREE_SCALES.includes('major pentatonic'));
  assert.ok(DEGREE_SCALES.includes('minor pentatonic'));
  assert.ok(!DEGREE_SCALES.includes('blues'), 'six degrees stack into clusters, not chords');
  assert.ok(!DEGREE_SCALES.includes('whole tone'));
  assert.ok(!DEGREE_SCALES.includes('chromatic'));
  assert.equal(degreeCountOf('major pentatonic'), 5);
  assert.equal(degreeCountOf('dorian'), 7);
  assert.equal(degreeCountOf('nonsense'), 7, 'unknown scales fall back like diatonicChord does');
});

test('pentatonic degrees build real chords from the scale’s own tones', () => {
  const tones = SCALES['major pentatonic'];             // [0, 2, 4, 7, 9]
  for (let d = 0; d < 5; d++) {
    const c = diatonicChord('C', 4, 'major pentatonic', d);
    assert.equal(c.midi.length, 3);
    assert.equal(c.numeral, `${d + 1}`, 'numbered, not roman — numerals mean 7 tones');
    // Every chord tone is a scale tone (mod 12, relative to C).
    for (const m of c.midi) assert.ok(tones.includes(((m - 60) % 12 + 12) % 12));
  }
  // Degree 0 of C major pentatonic stacks C–E–A (every other tone: 0, 4, 9).
  assert.deepEqual(diatonicChord('C', 4, 'major pentatonic', 0).midi, [60, 64, 69]);
});

test('single notes and accidentals work over five degrees too', () => {
  const n = diatonicNote('A', 4, 'minor pentatonic', 1);   // A C D E G → 2nd is C5
  assert.equal(n.name, 'C5');
  assert.equal(diatonicNote('A', 4, 'minor pentatonic', 1, 1).name, 'C♯5');
});

test('a pentatonic key offers five live degrees; the other two go dormant, not away', () => {
  reset();
  assert.equal(chordmode.degreeCount(), 7);
  // asl6 and asl7 hold degrees 5 and 6 by default.
  assert.ok(chordmode.chordFor('asl6'));
  chordmode.setKey({ mode: 'major pentatonic' });
  assert.equal(chordmode.degreeCount(), 5);
  assert.equal(chordmode.chordFor('asl6'), null, 'degree 5 is dormant over five tones');
  assert.equal(chordmode.chordFor('asl7'), null);
  assert.ok(chordmode.chordFor('palm'), 'degree 4 still plays');
  assert.equal(chordmode.noteFor('asl6'), null, 'note voicing agrees');
  // Back to seven and the assignments wake up untouched.
  chordmode.setKey({ mode: 'major (ionian)' });
  assert.equal(chordmode.chordFor('asl6').numeral, 'vi');
});

test('FOLLOW now takes a pentatonic from Pitch Quantize — and still refuses blues', () => {
  reset();
  chordmode.setKey({ follow: true });
  engine.setTuning({ enabled: true, root: 'D', scale: 'minor pentatonic' });
  assert.equal(chordmode.effectiveKey().mode, 'minor pentatonic');
  assert.equal(chordmode.effectiveKey().root, 'D');
  assert.equal(chordmode.degreeCount(), 5);
  engine.setTuning({ scale: 'blues' });
  assert.equal(chordmode.effectiveKey().mode, DEFAULT_KEY.mode,
    'six-tone scales fall back to the panel’s own mode');
  engine.setTuning({ enabled: false, root: 'C', scale: 'chromatic' });
});

test('isDegreeScale is the gate the panel and follow both use', () => {
  assert.ok(isDegreeScale('major pentatonic'));
  assert.ok(isDegreeScale('phrygian'));
  assert.ok(!isDegreeScale('blues'));
  assert.ok(!isDegreeScale(undefined));
});
