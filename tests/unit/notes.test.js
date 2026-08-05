import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mtof, midiName, parseNote } from '../../src/scale.js';
import { midiAtPoint, KBD_LO, KBD_HI } from '../../src/ui/keyboard.js';

test('parseNote: names, sharps, flats, case, negative octaves', () => {
  assert.equal(parseNote('A4'), 69);
  assert.equal(parseNote('C4'), 60);
  assert.equal(parseNote('C#3'), 49);
  assert.equal(parseNote('Db4'), 61);     // flat = semitone below D4
  assert.equal(parseNote('c4'), 60);      // case-insensitive
  assert.equal(parseNote('g#2'), 44);
  assert.equal(parseNote('B-1'), 11);
  assert.equal(parseNote(' A4 '), 69);    // whitespace tolerated
});

test('parseNote: rejects garbage', () => {
  assert.equal(parseNote('H4'), null);
  assert.equal(parseNote('C'), null);
  assert.equal(parseNote('4'), null);
  assert.equal(parseNote('440'), null);
  assert.equal(parseNote(''), null);
  assert.equal(parseNote('C##4'), null);
});

test('midiName round-trips with parseNote for sharps', () => {
  for (const n of ['C4', 'C#4', 'F#2', 'A5', 'G#3', 'B6']) {
    assert.equal(midiName(parseNote(n)), n);
  }
  assert.equal(midiName(60), 'C4');
  assert.equal(midiName(69), 'A4');
});

test('mtof: A4=440, octave doubling', () => {
  assert.ok(Math.abs(mtof(69) - 440) < 1e-9);
  assert.ok(Math.abs(mtof(81) - 880) < 1e-9);
  assert.ok(Math.abs(mtof(60) - 261.626) < 0.01);
});

test('midiAtPoint: white keys, black keys, edges', () => {
  const W = 360, H = 56;   // 36 white keys → ww = 10
  assert.equal(midiAtPoint(W, H, 5, 50), KBD_LO);        // C2, below black band
  assert.equal(midiAtPoint(W, H, 10, 5), KBD_LO + 1);    // C#2 straddles first boundary
  assert.equal(midiAtPoint(W, H, 15, 50), KBD_LO + 2);   // D2 under the black band
  assert.equal(midiAtPoint(W, H, W - 1, 50), KBD_HI);    // rightmost white = C7
  assert.equal(midiAtPoint(W, H, -5, 30), KBD_LO);       // clamped left
});
