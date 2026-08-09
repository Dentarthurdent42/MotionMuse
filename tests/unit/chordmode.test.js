// Chord mode: key handling, degree assignments, and the migration path off
// the old absolute-root format.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chordmode, degreeFromRoot, DEFAULT_KEY } from '../../src/chordmode.js';
import { engine } from '../../src/engine.js';

const reset = () => {
  engine.setTuning({ enabled: false, root: 'C', scale: 'chromatic' });
  // `{}` merges over the defaults, i.e. restores them — see load().
  chordmode.load({ enabled: false, key: { ...DEFAULT_KEY }, assignments: {} });
  chordmode.setKey({ ...DEFAULT_KEY });
};

test('default assignments spell chords in the default key', () => {
  reset();
  assert.equal(chordmode.chordFor('fist').numeral, 'I');
  assert.equal(chordmode.chordFor('palm').numeral, 'IV');
  assert.equal(chordmode.chordFor('peace').numeral, 'V7');
  assert.equal(chordmode.chordFor('peace').rootName, 'G');
});

test('changing the key transposes every assignment at once', () => {
  reset();
  const before = Object.keys(chordmode.assignments())
    .map(id => chordmode.chordFor(id).midi[0]);
  chordmode.setKey({ root: 'E' });
  const after = Object.keys(chordmode.assignments())
    .map(id => chordmode.chordFor(id).midi[0]);
  after.forEach((m, i) => assert.equal(m - before[i], 4, 'up a major third'));
});

test('the 7th toggle adds a fourth voice without changing the root', () => {
  reset();
  const triad = chordmode.chordFor('fist');
  chordmode.assign('fist', { seventh: true });
  const sev = chordmode.chordFor('fist');
  assert.equal(triad.midi.length, 3);
  assert.equal(sev.midi.length, 4);
  assert.equal(sev.midi[0], triad.midi[0]);
  assert.equal(sev.numeral, 'Imaj7');
});

test('assign clamps a nonsense degree instead of producing NaN pitches', () => {
  reset();
  chordmode.assign('fist', { degree: 99 });
  assert.equal(chordmode.assignments().fist.degree, 6);
  chordmode.assign('fist', { degree: -3 });
  assert.equal(chordmode.assignments().fist.degree, 0);
  chordmode.assign('fist', { degree: 'nope' });
  assert.ok(Number.isFinite(chordmode.chordFor('fist').freqs[0]));
});

// ── Follow Pitch Quantize ──
test('follow takes the key from Pitch Quantize when it is diatonic', () => {
  reset();
  chordmode.setKey({ follow: true });
  engine.setTuning({ enabled: true, root: 'A', scale: 'natural minor' });
  const eff = chordmode.effectiveKey();
  assert.equal(eff.root, 'A');
  assert.equal(eff.mode, 'natural minor');
  assert.equal(chordmode.chordFor('fist').numeral, 'i');   // A minor, not A major
  assert.equal(chordmode.isFollowing(), true);
});

test('follow ignores non-diatonic scales rather than spelling nonsense', () => {
  reset();
  chordmode.setKey({ follow: true, mode: 'dorian' });
  engine.setTuning({ enabled: true, root: 'F', scale: 'blues' });
  const eff = chordmode.effectiveKey();
  assert.equal(eff.root, 'F');          // root still follows
  assert.equal(eff.mode, 'dorian');     // mode falls back to the panel's own
});

test('follow is inert while quantise is off', () => {
  reset();
  chordmode.setKey({ follow: true, root: 'D' });
  engine.setTuning({ enabled: false, root: 'A', scale: 'natural minor' });
  assert.equal(chordmode.isFollowing(), false);
  assert.equal(chordmode.effectiveKey().root, 'D');
});

// ── Persistence ──
test('load merges over defaults so new gestures still get a chord', () => {
  reset();
  chordmode.load({ enabled: false, assignments: { fist: { degree: 4, seventh: true } } });
  const a = chordmode.assignments();
  assert.equal(a.fist.degree, 4);
  assert.equal(a.palm.degree, 3, 'defaults for untouched gestures survive');
});

test('old absolute-root assignments migrate to the nearest degree', () => {
  reset();
  chordmode.load({
    enabled: false,
    key: { root: 'C', mode: 'major (ionian)', octave: 4, follow: false },
    assignments: {
      fist:  { root: 'C', octave: 4, quality: 'major' },
      peace: { root: 'G', octave: 4, quality: 'dom7'  },
      point: { root: 'A', octave: 3, quality: 'minor' },
    },
  });
  const a = chordmode.assignments();
  assert.deepEqual(a.fist,  { degree: 0, seventh: false });   // C → I
  assert.deepEqual(a.peace, { degree: 4, seventh: true  });   // G7 → V7
  assert.deepEqual(a.point, { degree: 5, seventh: false });   // Am → vi
});

test('degreeFromRoot snaps an out-of-key root to the closest degree', () => {
  // Eb is not in C major; the nearest scale tones are D (ii) and E (iii).
  const d = degreeFromRoot('D#', 'C', 'major (ionian)', 'minor').degree;
  assert.ok(d === 1 || d === 2, `expected ii or iii, got ${d}`);
});

test('serialize round-trips key and assignments', () => {
  reset();
  chordmode.setKey({ root: 'F', mode: 'dorian', octave: 3, follow: false });
  chordmode.assign('horns', { degree: 6, seventh: true });
  const s = JSON.parse(JSON.stringify(chordmode.serialize()));
  reset();
  chordmode.load(s);
  assert.deepEqual(chordmode.key(), { root: 'F', mode: 'dorian', octave: 3, follow: false });
  assert.deepEqual(chordmode.assignments().horns, { degree: 6, seventh: true });
});
