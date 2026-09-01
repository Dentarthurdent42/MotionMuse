// Which hand is allowed to name a chord.
//
// Reported from playing: "I'm trying to use my left hand openness to adjust
// filter, but it keeps getting read as an open palm gesture." An open hand
// held out to drive a cable IS an open palm, whether or not it was meant as
// one — and outside `hand` expression mode chord mode scanned both hands, so
// a hand doing continuous work could not help also naming chords.
//
// 'any' is the old behaviour and the default, so nothing that worked before
// starts behaving differently.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { chordmode } = await import('../../src/chordmode.js');
const { gesture } = await import('../../src/gesture.js');

// Drive the one thing chord mode reads: which shape each hand is holding.
let held = { L: null, R: null };
gesture.activeOn = side => held[side];

const reset = (naming = 'any') => {
  held = { L: null, R: null };
  chordmode.setNamingHand(naming);
  chordmode.setExpression({ mode: 'gesture' });
};

// `point` is ASL 1 and holds degree I by default; `peace` is 2 → ii.
test('EITHER reads both hands — the behaviour that shipped', () => {
  reset('any');
  held.L = 'point';
  assert.ok(chordmode.chordFor('point'), 'the shape has a degree to name');
  assert.equal(chordmode.namedNow()?.side, 'L');
  reset('any');
  held.R = 'point';
  assert.equal(chordmode.namedNow()?.side, 'R');
});

test('naming the RIGHT hand makes the left inaudible as a shape', () => {
  reset('R');
  held.L = 'point';
  assert.equal(chordmode.namedNow(), null,
    'the left hand is free to hold an open palm at a filter');
  held.R = 'peace';
  assert.equal(chordmode.namedNow()?.id, 'peace', 'the right hand still names');
});

test('and naming the LEFT hand is the mirror of that', () => {
  reset('L');
  held.R = 'point';
  assert.equal(chordmode.namedNow(), null);
  held.L = 'point';
  assert.equal(chordmode.namedNow()?.side, 'L');
});

test('with one hand naming, the OTHER hand’s shape never wins', () => {
  // Both hands holding a degree shape at once is the case that would expose a
  // scan that ignored the setting: 'L' must not fall through to R.
  reset('L');
  held.L = 'point';
  held.R = 'peace';
  assert.equal(chordmode.namedNow()?.id, 'point');
  reset('R');
  held.L = 'point';
  held.R = 'peace';
  assert.equal(chordmode.namedNow()?.id, 'peace');
});

test('the setting survives a save and reload, and junk reads as EITHER', () => {
  reset('R');
  const saved = chordmode.serialize();
  assert.equal(saved.namingHand, 'R');
  chordmode.setNamingHand('any');
  chordmode.load(saved);
  assert.equal(chordmode.getNamingHand(), 'R');

  chordmode.setNamingHand('nonsense');
  assert.equal(chordmode.getNamingHand(), 'any');
});

test('a setup saved before this existed loads as EITHER', () => {
  chordmode.setNamingHand('L');
  const old = chordmode.serialize();
  delete old.namingHand;
  chordmode.load(old);
  assert.equal(chordmode.getNamingHand(), 'any',
    'which is exactly what those setups were doing');
});
