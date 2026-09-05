// Procedural play-along charts: seeded, in the current key, one grammar per
// way of playing. What is pinned: determinism (same seed, same chart), the
// musical invariants each grammar promises (in-scale melodies that cadence
// onto the tonic; degree walks that end dominant → tonic with no gaps), and
// the lane metadata the degree highway renders from.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateSong, makeRng, GEN_SONGS, isGenSong, genModeOf } from '../../src/songgen.js';
import { SCALES } from '../../src/scale.js';

const KEY = { root: 'D', mode: 'major (ionian)', octave: 4 };

test('the same seed makes the same chart; different seeds differ', () => {
  const a = generateSong('pitch', { key: KEY, diffId: 'medium', seed: 42 });
  const b = generateSong('pitch', { key: KEY, diffId: 'medium', seed: 42 });
  const c = generateSong('pitch', { key: KEY, diffId: 'medium', seed: 43 });
  assert.deepEqual(a.notes, b.notes, 'seeded means reproducible');
  assert.notDeepEqual(a.notes, c.notes, 'and a new seed is a new tune');
});

test('melodies stay in the key and cadence onto the tonic', () => {
  for (const seed of [1, 7, 99, 1234]) {
    const s = generateSong('pitch', { key: KEY, diffId: 'hard', seed });
    const pcs = new Set(SCALES[KEY.mode].map(d => (2 + d) % 12));   // D root = pc 2
    for (const n of s.notes) {
      assert.ok(pcs.has(((n.m % 12) + 12) % 12), `note ${n.m} is in D major (seed ${seed})`);
      assert.ok(n.m >= 36 && n.m <= 96, 'and on the keyboard');
    }
    const last = s.notes[s.notes.length - 1];
    assert.equal(((last.m % 12) + 12) % 12, 2, `ends on D (seed ${seed})`);
    const sorted = [...s.notes].sort((x, y) => x.b - y.b);
    assert.deepEqual(s.notes, sorted, 'notes come out in time order');
  }
});

test('degree charts walk without gaps and end dominant → tonic', () => {
  for (const seed of [3, 17, 400]) {
    const s = generateSong('gesture', { key: KEY, diffId: 'medium', seed });
    assert.equal(s.laneCount, 7);
    assert.equal(s.laneLabels.length, 7);
    for (let i = 0; i < s.notes.length; i++) {
      const n = s.notes[i];
      assert.ok(n.deg >= 0 && n.deg < 7, `degree ${n.deg} in range`);
      assert.ok(Number.isFinite(n.m), 'every note carries a guide pitch');
      if (i > 0) {
        const prev = s.notes[i - 1];
        assert.ok(Math.abs(prev.b + prev.d - n.b) < 1e-9, 'no gap, no overlap');
      }
    }
    const [pen, last] = s.notes.slice(-2);
    assert.equal(pen.deg, 4, 'the last-but-one chord is the dominant');
    assert.equal(last.deg, 0, 'and it resolves home');
  }
});

test('a pentatonic key gets five lanes, and every degree fits them', () => {
  const s = generateSong('radial', {
    key: { root: 'A', mode: 'minor pentatonic', octave: 4 }, diffId: 'easy', seed: 5,
  });
  assert.equal(s.laneCount, 5);
  for (const n of s.notes) assert.ok(n.deg >= 0 && n.deg < 5);
});

test('difficulty buys density', () => {
  const easy = generateSong('gesture', { key: KEY, diffId: 'easy', seed: 11 });
  const hard = generateSong('gesture', { key: KEY, diffId: 'hard', seed: 11 });
  assert.ok(hard.notes.length > easy.notes.length,
    `hard (${hard.notes.length}) outnumbers easy (${easy.notes.length})`);
});

test('the picker entries and their ids agree', () => {
  assert.equal(GEN_SONGS.length, 3, 'one chart per way of playing');
  for (const g of GEN_SONGS) {
    assert.ok(isGenSong(g.id));
    assert.equal(genModeOf(g.id), g.mode);
  }
  assert.equal(isGenSong('ode-to-joy'), false);
  assert.equal(genModeOf('user-abc'), null);
});

test('the rng is a stream, not a constant', () => {
  const rng = makeRng(123);
  const seen = new Set(Array.from({ length: 100 }, rng));
  assert.ok(seen.size > 90, 'values vary');
  for (const v of seen) assert.ok(v >= 0 && v < 1);
});
