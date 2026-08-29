// The MIDI importer: bytes → play-along chart. The fixtures are built by
// hand, byte by byte, because the parser under test is exactly the thing we
// cannot use to make them.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMidi, songFromMidi, guessKey } from '../../src/midifile.js';

// ── Fixture builder ───────────────────────────────────────────────────────
const varlen = v => {
  const out = [v & 0x7f];
  while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
  return out;
};
const u32 = v => [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255];
const u16 = v => [v >>> 8 & 255, v & 255];
const track = events => {
  const body = events.flat();
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
};
const smf = (tracks, division = 480) => new Uint8Array([
  0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(tracks.length > 1 ? 1 : 0),
  ...u16(tracks.length), ...u16(division), ...tracks.flat()]);

const on  = (dt, m, ch = 0, vel = 100) => [...varlen(dt), 0x90 | ch, m, vel];
const off = (dt, m, ch = 0) => [...varlen(dt), 0x80 | ch, m, 64];
const tempoMeta = us => [0, 0xff, 0x51, 3, us >> 16 & 255, us >> 8 & 255, us & 255];
const sigMeta = (nn, dd) => [0, 0xff, 0x58, 4, nn, dd, 24, 8];
const eot = [0, 0xff, 0x2f, 0];

// C4 E4 G4 C5, one quarter each, at 120 BPM in 3/4.
const simple = () => smf([track([
  tempoMeta(500000), sigMeta(3, 2),
  on(0, 60), off(480, 60),
  on(0, 64), off(480, 64),
  on(0, 67), off(480, 67),
  on(0, 72), off(480, 72),
  eot,
])]);

test('a simple file becomes the chart it spells', () => {
  const song = songFromMidi(simple(), { name: 'test' });
  assert.equal(song.bpm, 120);
  assert.equal(song.beatsPerBar, 3);
  assert.deepEqual(song.notes.map(n => ({ b: n.b, m: n.m, d: n.d })), [
    { b: 0, m: 60, d: 1 }, { b: 1, m: 64, d: 1 }, { b: 2, m: 67, d: 1 }, { b: 3, m: 72, d: 1 },
  ]);
  assert.equal(song.root, 'C');
});

test('stacked notes reduce to the top voice', () => {
  const song = songFromMidi(smf([track([
    tempoMeta(500000),
    // A C-major triad struck together: only the G survives.
    on(0, 60), on(0, 64), on(0, 67),
    off(480, 60), off(0, 64), off(0, 67),
    on(0, 72), off(480, 72),
    eot,
  ])]));
  // The register may be re-centred by octaves, so compare pitch classes.
  assert.deepEqual(song.notes.map(n => ((n.m % 12) + 12) % 12), [7, 0],
    'the G of the triad survives, then the C above it');
});

test('drums are rhythm, not melody — channel 10 stays out', () => {
  const song = songFromMidi(smf([
    track([tempoMeta(500000), on(0, 60), off(480, 60), eot]),
    // A busier drum track must NOT win the melody pick.
    track([on(0, 36, 9), off(120, 36, 9), on(0, 38, 9), off(120, 38, 9),
           on(0, 36, 9), off(120, 36, 9), on(0, 38, 9), off(120, 38, 9), eot]),
  ]));
  assert.deepEqual(song.notes.map(n => n.m), [60]);
});

test('running status and a dangling note-on both parse', () => {
  // Second note reuses the first's status byte; the last note never gets an
  // off — it still counts, one beat long.
  const song = songFromMidi(smf([track([
    tempoMeta(500000),
    [...varlen(0), 0x90, 60, 100],
    [...varlen(480), 60, 0],            // running status: note-on vel 0 = off
    [...varlen(0), 62, 100],
    [...varlen(480), 62, 0],
    [...varlen(0), 64, 100],            // never released
    eot,
  ])]));
  assert.equal(song.notes.length, 3);
  assert.equal(song.notes[2].m, 64);
  assert.equal(song.notes[2].d, 1, 'a dangling note is given a beat');
});

test('an out-of-reach register is brought home by whole octaves', () => {
  const song = songFromMidi(smf([track([
    tempoMeta(500000),
    on(0, 24), off(480, 24), on(0, 28), off(480, 28), on(0, 31), off(480, 31),
    eot,
  ])]));
  for (const n of song.notes) assert.ok(n.m >= 36 && n.m <= 96);
  assert.equal(song.notes[0].m % 12, 0, 'transposition is by octave — the note names survive');
});

test('what is not a MIDI file says so', () => {
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /MThd/);
  assert.throws(() => songFromMidi(smf([track([tempoMeta(500000), eot])])), /No melodic notes/);
  // SMPTE division: bit 15 set.
  const smpte = smf([track([eot])]);
  smpte[12] = 0xe7; smpte[13] = 0x28;
  assert.throws(() => parseMidi(smpte), /SMPTE/);
});

test('the key guess hears a scale for what it is', () => {
  const dMajor = [62, 64, 66, 67, 69, 71, 73, 74].map(m => ({ m, d: 1 }));
  assert.deepEqual(guessKey(dMajor), { root: 'D', scale: 'major (ionian)' });
  const aMinor = [57, 59, 60, 62, 64, 65, 67, 69].map((m, i) => ({ m, d: i === 0 || i === 7 ? 2 : 1 }));
  const k = guessKey(aMinor);
  assert.ok(
    (k.root === 'A' && k.scale === 'natural minor') || (k.root === 'C' && k.scale === 'major (ionian)'),
    `relative pair accepted, got ${k.root} ${k.scale}`);
});
