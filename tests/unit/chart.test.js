// Chart transforms: the song moves into the instrument's key, and difficulty
// is polyphony rather than note-dropping.
//
// Both reported together as "play-along is broken": "the chosen song should
// adjust the key to whatever is in the input method, so the degrees stay
// honest", and "easy mode is missing like half the notes … the level of
// difficulty should correspond to the number of notes played simultaneously".
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readDegree, writeDegree, transposeChart, voiceChart, covers, LEVELS, levelOf }
  from '../../src/chart.js';
import { SONGS } from '../../src/songs.js';
import { NOTE_NAMES } from '../../src/scale.js';

const C_MAJ = { root: 'C', mode: 'major (ionian)', octave: 4 };
const D_DOR = { root: 'D', mode: 'dorian', octave: 4 };
const A_MIN = { root: 'A', mode: 'natural minor', octave: 4 };
const C_PENT = { root: 'C', mode: 'major pentatonic', octave: 4 };

// ── Reading and writing degrees ──

test('a note reads as the degree it is, in its own key', () => {
  // `octave` counts key-root octaves from MIDI 0, so C4 (60) is octave 5.
  const deg = m => readDegree(m, 'C', 'major (ionian)').degree;
  assert.equal(deg(60), 0);        // C = I
  assert.equal(deg(64), 2);        // E = iii
  assert.equal(deg(67), 4);        // G = V
  // An octave up is the SAME degree, one octave along — that is what makes a
  // transposed melody keep its shape.
  assert.equal(deg(72), 0);
  assert.equal(readDegree(72, 'C', 'major (ionian)').octave,
               readDegree(60, 'C', 'major (ionian)').octave + 1);
  assert.equal(deg(48), 0);
  assert.equal(readDegree(48, 'C', 'major (ionian)').octave,
               readDegree(60, 'C', 'major (ionian)').octave - 1);
});

test('a chromatic note keeps its offset instead of being rounded away', () => {
  // F#4 in C major is degree 3 (F) sharpened — a melody's chromatics are part
  // of its tune, so the offset rides along rather than being snapped off.
  const d = readDegree(66, 'C', 'major (ionian)');
  assert.equal(d.degree, 3);
  assert.equal(d.offset, 1);
});

test('write is the inverse of read, in the same key', () => {
  for (let m = 48; m <= 84; m++) {
    for (const [root, scale] of [['C', 'major (ionian)'], ['D', 'dorian'], ['A', 'natural minor']]) {
      assert.equal(writeDegree(readDegree(m, root, scale), root, scale), m,
        `${m} in ${root} ${scale}`);
    }
  }
});

test('a degree past the target scale wraps and carries its octave', () => {
  // Degree 5 of a five-degree key is degree 0 an octave up — a rising line
  // stays rising rather than folding back on itself.
  const lo = writeDegree({ degree: 4, octave: 0 }, 'C', 'major pentatonic');
  const hi = writeDegree({ degree: 5, octave: 0 }, 'C', 'major pentatonic');
  assert.ok(hi > lo, `${hi} should sit above ${lo}`);
  assert.equal(hi, writeDegree({ degree: 0, octave: 1 }, 'C', 'major pentatonic'));
});

// ── Transposing a chart ──

test('a chart moves into the instrument key, degree for degree', () => {
  const song = SONGS.find(s => s.id === 'ode-to-joy');
  const out = transposeChart(song, A_MIN);
  assert.equal(out.root, 'A');
  assert.equal(out.scale, 'natural minor');
  assert.equal(out.notes.length, song.notes.length, 'no note is lost in the move');
  // Every note lands on a pitch the target key actually contains, which is
  // the whole point: the quantiser can reach it.
  const pcs = new Set(out.notes.map(n => ((n.m % 12) + 12) % 12));
  const scalePcs = new Set([0, 2, 3, 5, 7, 8, 10].map(d => (d + NOTE_NAMES.indexOf('A')) % 12));
  for (const pc of pcs) assert.ok(scalePcs.has(pc), `pitch class ${pc} is not in A minor`);
});

test('and it keeps the tune — same contour, same degrees', () => {
  const song = SONGS.find(s => s.id === 'ode-to-joy');
  const out = transposeChart(song, D_DOR);
  const degIn = song.notes.map(n => readDegree(n.m, song.root, song.scale).degree);
  const degOut = out.notes.map(n => readDegree(n.m, 'D', 'dorian').degree);
  assert.deepEqual(degOut, degIn, 'a IV in the song is a IV in the instrument');
  // Shape survives: the direction of every interval is unchanged.
  const dir = ns => ns.slice(1).map((n, i) => Math.sign(n.m - ns[i].m));
  assert.deepEqual(dir(out.notes), dir(song.notes));
});

test('the same key is a no-op, not a rebuild', () => {
  const song = SONGS.find(s => s.id === 'twinkle');
  assert.equal(transposeChart(song, C_MAJ), song);
});

test('a degree chart re-voices its guide and relabels its lanes', () => {
  const deg = {
    id: 'g', name: 'g', bpm: 100, beatsPerBar: 4, root: 'C', scale: 'major (ionian)',
    laneCount: 7, laneLabels: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'],
    notes: [{ b: 0, deg: 0, m: 60, d: 4 }, { b: 4, deg: 4, m: 67, d: 4 }],
  };
  const out = transposeChart(deg, A_MIN);
  assert.deepEqual(out.notes.map(n => n.deg), [0, 4], 'the LANES do not move — a degree is a degree');
  assert.notDeepEqual(out.notes.map(n => n.m), [60, 67], 'but the guide sings the new key');
  assert.equal(out.laneLabels[0], 'i', 'and the labels say so');
});

test('a lane the target key does not have is dropped, not left unhittable', () => {
  const deg = {
    id: 'g', name: 'g', bpm: 100, beatsPerBar: 4, root: 'C', scale: 'major (ionian)',
    notes: [{ b: 0, deg: 0, m: 60, d: 2 }, { b: 2, deg: 6, m: 71, d: 2 }],
  };
  const out = transposeChart(deg, C_PENT);
  assert.deepEqual(out.notes.map(n => n.deg), [0], 'degree 6 has no lane in a 5-degree key');
  assert.equal(out.laneCount, 5);
});

// ── Difficulty is polyphony ──

test('there are exactly two levels, and they are about note count', () => {
  assert.deepEqual(LEVELS.map(l => l.id), ['single', 'multi']);
  assert.equal(levelOf('single').voices, 1);
  assert.ok(levelOf('multi').voices > 1);
  assert.equal(levelOf('nonsense').id, 'single', 'an unknown level falls back, it does not throw');
});

test('NO level drops a note — the bug that started this', () => {
  // `easy` used to keep only bar downbeats and long notes, which is what
  // "missing like half the notes" was. Both levels now play the whole song.
  const song = SONGS.find(s => s.id === 'ode-to-joy');
  for (const lvl of ['single', 'multi']) {
    const out = voiceChart(song, lvl, C_MAJ);
    assert.equal(out.notes.length, song.notes.length, `${lvl} kept every note`);
    assert.deepEqual(out.notes.map(n => n.b), song.notes.map(n => n.b), `${lvl} kept the timing`);
  }
});

test('single asks for one note, multi asks for a chord', () => {
  const song = SONGS.find(s => s.id === 'ode-to-joy');
  const one = voiceChart(song, 'single', C_MAJ);
  const many = voiceChart(song, 'multi', C_MAJ);
  assert.ok(one.notes.every(n => n.notes.length === 1));
  assert.ok(many.notes.every(n => n.notes.length >= 3));
  // The melody note is still in there — multi harmonises the tune, it does
  // not replace it.
  many.notes.forEach((n, i) => {
    const pcs = n.notes.map(m => ((m % 12) + 12) % 12);
    assert.ok(pcs.includes(((song.notes[i].m % 12) + 12) % 12),
      `bar ${n.b}: the tune's own note should be in its chord`);
  });
});

test("multi builds the chord under the note being sung, not in a fixed octave", () => {
  const song = {
    id: 's', name: 's', bpm: 100, beatsPerBar: 4, root: 'C', scale: 'major (ionian)',
    notes: [{ b: 0, m: 48, d: 1 }, { b: 1, m: 84, d: 1 }],
  };
  const out = voiceChart(song, 'multi', C_MAJ);
  const centre = ns => ns.reduce((s, m) => s + m, 0) / ns.length;
  assert.ok(centre(out.notes[0].notes) < centre(out.notes[1].notes),
    'the harmony follows the tune up the keyboard');
  out.notes.forEach((n, i) => {
    assert.ok(Math.abs(centre(n.notes) - song.notes[i].m) < 12,
      'and stays near the note it is under');
  });
});

// ── Satisfying a chart note ──

test('a note is covered when everything it asks for is sounding', () => {
  assert.ok(covers([60], [60]));
  assert.ok(!covers([60], [64]));
  assert.ok(covers([60, 64, 67], [60, 64, 67]));
  assert.ok(!covers([60, 64], [60, 64, 67]), 'two thirds of a triad is not the triad');
  assert.ok(covers([60, 64, 67, 72], [60, 64, 67]), 'a doubled root is still that chord');
  assert.ok(!covers([], [60]));
  assert.ok(!covers([60], []), 'a note asking for nothing is not a hit');
});

test('pitch-class matching ignores the octave — which is what Shepard means', () => {
  assert.ok(covers([72], [60], { pcMatch: true }));
  assert.ok(!covers([72], [60]));
  assert.ok(covers([48, 64, 79], [60, 64, 67], { pcMatch: true }));
});
