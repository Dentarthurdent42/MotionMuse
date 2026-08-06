// Unit tests for chord construction. Gesture matching lives in
// gesture-match.test.js, diatonic degrees in diatonic.test.js.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { QUALITIES, chordFreqs, rootMidi, chordName } from '../../src/chords.js';

const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

test('rootMidi: C4 = 60, A4 = 69', () => {
  assert.equal(rootMidi('C', 4), 60);
  assert.equal(rootMidi('A', 4), 69);
});

test('chordFreqs: C major = C4 E4 G4', () => {
  const [c, e, g] = chordFreqs('C', 4, 'major');
  assert.ok(near(c, 261.63), `C ${c}`);
  assert.ok(near(e, 329.63), `E ${e}`);
  assert.ok(near(g, 392.00), `G ${g}`);
});

test('chordFreqs: A minor = A3 C4 E4', () => {
  const [a, c, e] = chordFreqs('A', 3, 'minor');
  assert.ok(near(a, 220.00), `A ${a}`);
  assert.ok(near(c, 261.63), `C ${c}`);
  assert.ok(near(e, 329.63), `E ${e}`);
});

test('seventh chords have four notes, triads three', () => {
  assert.equal(chordFreqs('C', 4, 'maj7').length, 4);
  assert.equal(chordFreqs('C', 4, 'dom7').length, 4);
  assert.equal(chordFreqs('C', 4, 'major').length, 3);
});

test('all qualities are strictly ascending semitone sets from 0', () => {
  for (const [q, offs] of Object.entries(QUALITIES)) {
    assert.equal(offs[0], 0, `${q} starts on root`);
    for (let i = 1; i < offs.length; i++) {
      assert.ok(offs[i] > offs[i - 1], `${q} ascending at ${i}`);
    }
  }
});

test('unknown quality falls back to major', () => {
  assert.deepEqual(chordFreqs('C', 4, 'bogus'), chordFreqs('C', 4, 'major'));
});

test('chordName formats root + quality', () => {
  assert.equal(chordName('C', 'maj7'), 'C maj7');
});
