// Unit tests for chord construction and gesture matching.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { QUALITIES, chordFreqs, rootMidi, chordName } from '../../src/chords.js';
import { matchGesture, FEATURES } from '../../src/gesture.js';

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

// ── Gesture matching ──
const T = [
  { id: 'fist', f: [0, 0, 0, 0, 0, 0, 0] },
  { id: 'palm', f: [1, 1, 1, 1, 1, 1, 0.6] },
];

test('matchGesture: identical features match at distance 0', () => {
  const m = matchGesture([0, 0, 0, 0, 0, 0, 0], T);
  assert.equal(m.id, 'fist');
  assert.ok(m.dist < 1e-9);
});

test('matchGesture: nearest template wins', () => {
  const m = matchGesture([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.5], T);
  assert.equal(m.id, 'palm');
});

test('matchGesture: ambiguous mid pose exceeds threshold → null', () => {
  // Halfway between fist and palm is far from both.
  const m = matchGesture([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.3], T, 0.55);
  assert.equal(m, null);
});

test('matchGesture: feature vector length is 7', () => {
  assert.equal(FEATURES.length, 7);
});
