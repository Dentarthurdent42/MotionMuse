// Unit tests for the play-along game logic and bundled song charts.
// Run: npm run test:unit  (plain `node --test`, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SONGS } from '../../src/songs.js';
import { DIFF, filterNotes, judge, mtof, gradeOf, PERFECT_FRAC, POINTS } from '../../src/playalong.js';
import { SCALES, NOTE_NAMES } from '../../src/scale.js';

test('charts are valid: sorted, in range, in scale', () => {
  for (const s of SONGS) {
    assert.ok(s.id && s.name && s.bpm > 0 && s.beatsPerBar > 0, s.id);
    assert.ok(SCALES[s.scale], `${s.id}: unknown scale ${s.scale}`);
    const rootPc = NOTE_NAMES.indexOf(s.root);
    assert.ok(rootPc >= 0, `${s.id}: unknown root ${s.root}`);
    const degrees = new Set(SCALES[s.scale].map(d => (rootPc + d) % 12));
    let prev = -Infinity;
    for (const n of s.notes) {
      assert.ok(n.b >= prev, `${s.id}: notes must be sorted by beat`);
      prev = n.b;
      assert.ok(n.m >= 48 && n.m <= 84, `${s.id}: note ${n.m} outside C3–C6`);
      assert.ok(n.d > 0, `${s.id}: non-positive duration`);
      assert.ok(degrees.has(((n.m % 12) + 12) % 12),
        `${s.id}: MIDI ${n.m} not in ${s.root} ${s.scale}`);
    }
  }
});

test('difficulty filtering: hard ⊇ medium ⊇ easy, all non-empty', () => {
  for (const s of SONGS) {
    const hard = filterNotes(s.notes, 'hard', s.beatsPerBar);
    const med  = filterNotes(s.notes, 'medium', s.beatsPerBar);
    const easy = filterNotes(s.notes, 'easy', s.beatsPerBar);
    assert.equal(hard.length, s.notes.length, `${s.id}: hard keeps all`);
    assert.ok(med.length <= hard.length && med.length > 0, `${s.id}: medium subset`);
    assert.ok(easy.length <= med.length && easy.length > 0, `${s.id}: easy subset`);
    // medium keeps only on-the-beat notes
    assert.ok(med.every(n => n.b % 1 === 0), `${s.id}: medium on-beat only`);
    // easy keeps only downbeats or long notes
    assert.ok(easy.every(n => n.b % s.beatsPerBar === 0 || n.d >= 2), `${s.id}: easy filter`);
  }
});

test('judge: exact-match windows with timing tiers', () => {
  const cfg = DIFF.medium;                               // window 180ms → perfect band ±72ms
  assert.equal(judge(64, 64, -181, 0, cfg), 'pending');  // too early to judge
  assert.equal(judge(64, 64, -179, 0, cfg), 'good');     // inside early window, outside perfect band
  assert.equal(judge(64, 64, 179, 0, cfg), 'good');      // inside late window
  assert.equal(judge(64, 64, 0, 0, cfg), 'perfect');     // dead on
  assert.equal(judge(64, 64, 72, 0, cfg), 'perfect');    // perfect band edge (40% of 180)
  assert.equal(judge(64, 64, 73, 0, cfg), 'good');       // just past the band
  assert.equal(judge(64, 64, -72, 0, cfg), 'perfect');   // early side of the band
  assert.equal(judge(62, 64, 179, 0, cfg), 'pending');   // wrong note, window open
  assert.equal(judge(62, 64, 181, 0, cfg), 'miss');      // window expired
  assert.equal(judge(76, 64, 0, 0, cfg), 'pending');     // octave ≠ match on medium
});

test('judge: easy is octave-agnostic', () => {
  const cfg = DIFF.easy;
  assert.equal(judge(76, 64, 0, 0, cfg), 'perfect');     // +1 octave, dead on
  assert.equal(judge(52, 64, 0, 0, cfg), 'perfect');     // -1 octave
  assert.equal(judge(76, 64, 200, 0, cfg), 'good');      // in window, outside perfect band
  assert.equal(judge(65, 64, 0, 0, cfg), 'pending');     // semitone off is not a hit
});

test('scoring constants: perfect beats good, band is a proper fraction', () => {
  assert.ok(POINTS.perfect > POINTS.good);
  assert.ok(PERFECT_FRAC > 0 && PERFECT_FRAC < 1);
});

test('gradeOf boundaries', () => {
  assert.equal(gradeOf(1), 'S');
  assert.equal(gradeOf(0.95), 'S');
  assert.equal(gradeOf(0.949), 'A');
  assert.equal(gradeOf(0.9), 'A');
  assert.equal(gradeOf(0.75), 'B');
  assert.equal(gradeOf(0.6), 'C');
  assert.equal(gradeOf(0.59), 'D');
  assert.equal(gradeOf(0), 'D');
});

test('difficulty settings are ordered', () => {
  assert.ok(DIFF.easy.window > DIFF.medium.window && DIFF.medium.window > DIFF.hard.window);
  assert.ok(DIFF.easy.fallSec > DIFF.medium.fallSec && DIFF.medium.fallSec > DIFF.hard.fallSec);
});

test('mtof: A4=440, C4≈261.63', () => {
  assert.equal(mtof(69), 440);
  assert.ok(Math.abs(mtof(60) - 261.626) < 0.01);
});
