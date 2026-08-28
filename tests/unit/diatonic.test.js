// Diatonic chord degrees — qualities and numerals are *derived* from the
// scale, so these tests double as a check that the derivation is right for
// every mode we offer, not just major.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diatonic, diatonicChord, DIATONIC_SCALES, isDiatonic } from '../../src/chords.js';
import { SCALES } from '../../src/scale.js';

const MAJ = SCALES['major (ionian)'];
const numerals = (scale, seventh = false) =>
  Array.from({ length: 7 }, (_, i) => diatonic(SCALES[scale], i, { seventh }).numeral);

test('major triads spell I ii iii IV V vi vii°', () => {
  assert.deepEqual(numerals('major (ionian)'), ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
});

test('natural minor spells i ii° III iv v VI VII', () => {
  assert.deepEqual(numerals('natural minor'), ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII']);
});

test('harmonic minor raises the V to major and gives vii°', () => {
  // The whole point of harmonic minor: a leading tone, so V is major and
  // vii is diminished. Derived from intervals, not a lookup table.
  const n = numerals('harmonic minor');
  assert.equal(n[4], 'V', `V should be major, got ${n[4]}`);
  assert.equal(n[6], 'vii°');
  assert.equal(n[2], 'III+', `III should be augmented, got ${n[2]}`);
});

test('dorian has a major IV and mixolydian a minor v', () => {
  assert.equal(numerals('dorian')[3], 'IV');
  assert.equal(numerals('mixolydian')[4], 'v');
});

test('sevenths: major key gives Imaj7 … V7 … viiø7', () => {
  assert.deepEqual(numerals('major (ionian)', true),
    ['Imaj7', 'ii7', 'iii7', 'IVmaj7', 'V7', 'vi7', 'viiø7']);
});

test('harmonic minor vii is a fully diminished seventh', () => {
  assert.equal(numerals('harmonic minor', true)[6], 'vii°7');
});

test('qualities are named, not spelled as intervals', () => {
  assert.equal(diatonic(MAJ, 0).quality, 'major');
  assert.equal(diatonic(MAJ, 1).quality, 'minor');
  assert.equal(diatonic(MAJ, 6).quality, 'dim');
  assert.equal(diatonic(MAJ, 4, { seventh: true }).quality, 'dom7');
  assert.equal(diatonic(MAJ, 0, { seventh: true }).quality, 'maj7');
});

test('every chord tone belongs to the scale', () => {
  for (const scale of DIATONIC_SCALES) {
    const degs = SCALES[scale];
    for (let i = 0; i < 7; i++) {
      const d = diatonic(degs, i, { seventh: true });
      for (const o of d.offs) {
        const pc = (d.root + o) % 12;
        assert.ok(degs.includes(pc),
          `${scale} degree ${i}: ${pc} is not in the scale`);
      }
    }
  }
});

test('triads have 3 notes, sevenths 4, all strictly ascending', () => {
  for (const scale of DIATONIC_SCALES) {
    for (let i = 0; i < 7; i++) {
      for (const seventh of [false, true]) {
        const { offs } = diatonic(SCALES[scale], i, { seventh });
        assert.equal(offs.length, seventh ? 4 : 3);
        assert.equal(offs[0], 0);
        for (let k = 1; k < offs.length; k++) {
          assert.ok(offs[k] > offs[k - 1], `${scale} ${i} not ascending`);
        }
      }
    }
  }
});

test('degree wraps instead of throwing', () => {
  assert.equal(diatonic(MAJ, 7).degree, 0);
  assert.equal(diatonic(MAJ, -1).degree, 6);
  assert.equal(diatonic(MAJ, 1.4).degree, 1);
});

test('diatonicChord: V of C major is a G triad at the right pitches', () => {
  const c = diatonicChord('C', 4, 'major (ionian)', 4);
  assert.equal(c.rootName, 'G');
  assert.deepEqual(c.midi, [67, 71, 74]);          // G4 B4 D5
  assert.ok(Math.abs(c.freqs[0] - 392.00) < 0.5);
});

test('changing key transposes every degree by the same interval', () => {
  for (let i = 0; i < 7; i++) {
    const inC = diatonicChord('C', 4, 'major (ionian)', i, true);
    const inD = diatonicChord('D', 4, 'major (ionian)', i, true);
    inC.midi.forEach((m, k) => assert.equal(inD.midi[k] - m, 2,
      `degree ${i} note ${k} should move up a tone`));
    assert.equal(inC.numeral, inD.numeral);        // the numeral is key-invariant
  }
});

test('non-diatonic scales are excluded and fall back to major', () => {
  assert.ok(!DIATONIC_SCALES.includes('major pentatonic'));
  assert.ok(!DIATONIC_SCALES.includes('chromatic'));
  assert.ok(!DIATONIC_SCALES.includes('blues'));
  assert.equal(DIATONIC_SCALES.length, 6);
  assert.equal(isDiatonic('dorian'), true);
  assert.equal(isDiatonic('blues'), false);
  // Pentatonics are DEGREE scales now — they build their own five-tone
  // chords rather than falling back (tests/unit/pentatonic-degrees.test.js).
  // The scales the degree system genuinely cannot address still fall back.
  assert.deepEqual(diatonicChord('C', 4, 'blues', 0).midi,
                   diatonicChord('C', 4, 'major (ionian)', 0).midi);
  assert.deepEqual(diatonicChord('C', 4, 'whole tone', 0).midi,
                   diatonicChord('C', 4, 'major (ionian)', 0).midi);
});

test('octave shifts the whole chord by 12 semitones', () => {
  const a = diatonicChord('C', 3, 'major (ionian)', 2, true);
  const b = diatonicChord('C', 4, 'major (ionian)', 2, true);
  a.midi.forEach((m, k) => assert.equal(b.midi[k] - m, 12));
});
