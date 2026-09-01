// Unit tests for the play-along game logic and bundled song charts.
// Run: npm run test:unit  (plain `node --test`, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SONGS } from '../../src/songs.js';
import { DIFF, judge, mtof, gradeOf, PERFECT_FRAC, POINTS } from '../../src/playalong.js';
import { LEVELS, voiceChart } from '../../src/chart.js';
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

// The bug this replaced a test for: difficulty used to be a note FILTER, and
// `easy` dropped everything that was not a downbeat or a long note — half the
// tune, on a setting called easy. Difficulty is polyphony now, so the one
// thing every level must do is keep the whole song.
test('no level drops a note from any bundled song', () => {
  for (const s of SONGS) {
    for (const lvl of LEVELS) {
      const out = voiceChart(s, lvl.id, { root: s.root, mode: s.scale, octave: 4 });
      assert.equal(out.notes.length, s.notes.length, `${s.id} @ ${lvl.id}`);
      assert.deepEqual(out.notes.map(n => n.b), s.notes.map(n => n.b),
        `${s.id} @ ${lvl.id}: beats moved`);
      for (const n of out.notes) {
        assert.ok(n.notes.length >= 1 && n.notes.length <= lvl.voices,
          `${s.id} @ ${lvl.id}: ${n.notes.length} voices`);
        assert.ok(n.notes.includes(n.m), `${s.id} @ ${lvl.id}: melody note dropped`);
      }
    }
  }
});

test('levels are single-note and multi-note, and only that', () => {
  assert.deepEqual(LEVELS.map(l => l.id), ['single', 'multi']);
  assert.equal(LEVELS[0].voices, 1);
  assert.ok(LEVELS[1].voices > 1);
  // Timing is a property of the game, not of how many notes it asks for. The
  // old easy bought its wider window by also deleting notes; nothing here
  // pays for polyphony with reaction time.
  assert.equal(DIFF.single.window, DIFF.multi.window);
  assert.equal(DIFF.single.fallSec, DIFF.multi.fallSec);
  for (const l of LEVELS) assert.ok(DIFF[l.id], `no timing config for ${l.id}`);
});

test('judge: exact-match windows with timing tiers', () => {
  const cfg = DIFF.single;                                  // window 200ms → perfect band ±80ms
  assert.equal(judge([64], [64], -201, 0, cfg), 'pending'); // too early to judge
  assert.equal(judge([64], [64], -199, 0, cfg), 'good');    // inside early window, outside band
  assert.equal(judge([64], [64], 199, 0, cfg), 'good');     // inside late window
  assert.equal(judge([64], [64], 0, 0, cfg), 'perfect');    // dead on
  assert.equal(judge([64], [64], 80, 0, cfg), 'perfect');   // perfect band edge (40% of 200)
  assert.equal(judge([64], [64], 81, 0, cfg), 'good');      // just past the band
  assert.equal(judge([64], [64], -80, 0, cfg), 'perfect');  // early side of the band
  assert.equal(judge([62], [64], 199, 0, cfg), 'pending');  // wrong note, window open
  assert.equal(judge([62], [64], 201, 0, cfg), 'miss');     // window expired
  assert.equal(judge([76], [64], 0, 0, cfg), 'pending');    // octave ≠ match by default
});

// Under a Shepard tone the octave is deliberately discarded (shepard.js), so
// the player is not steering one, and judging them on one would be judging
// them on a number the instrument refuses to express.
test('judge: pitch-class matching, for Shepard', () => {
  const cfg = { ...DIFF.single, pcMatch: true };
  assert.equal(judge([76], [64], 0, 0, cfg), 'perfect');    // +1 octave
  assert.equal(judge([52], [64], 0, 0, cfg), 'perfect');    // -1 octave
  assert.equal(judge([76], [64], 190, 0, cfg), 'good');     // in window, outside the band
  assert.equal(judge([65], [64], 0, 0, cfg), 'pending');    // a semitone off is still wrong
});

// MULTI asks for a chord, and a chord is only hit when the whole of it is
// held — which is exactly what gesture mode's second hand is for.
test('judge: every wanted note must be covered', () => {
  const cfg = DIFF.multi;
  assert.equal(judge([60, 64, 67], [60, 64, 67], 0, 0, cfg), 'perfect');
  assert.equal(judge([60, 64, 67, 72], [60, 64, 67], 0, 0, cfg), 'perfect',
    'extra notes do not spoil a hit');
  assert.equal(judge([60, 64], [60, 64, 67], 0, 0, cfg), 'pending', 'two thirds is not a hit');
  assert.equal(judge([60, 64], [60, 64, 67], 201, 0, cfg), 'miss');
  assert.equal(judge([], [60], 0, 0, cfg), 'pending', 'silence hits nothing');
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

test('mtof: A4=440, C4≈261.63', () => {
  assert.equal(mtof(69), 440);
  assert.ok(Math.abs(mtof(60) - 261.626) < 0.01);
});
