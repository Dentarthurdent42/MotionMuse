// Standard MIDI File → play-along chart. No dependencies: an SMF is a small
// binary format, and a parser we own is one we can shape to exactly what the
// game needs — one melody line, in beats, in a key.
//
// What survives the trip:
//   • the note stream of the busiest non-drum track (drums are channel 10 —
//     a kick pattern is rhythm, not a melody to pitch-match);
//   • reduced to ONE line: where notes stack, the top voice wins — the top
//     line is the melody in almost all keyboard writing — and a note is
//     trimmed where its successor starts;
//   • timed in BEATS (quarter notes), which is the chart's native unit. The
//     first tempo becomes the song's tempo; later tempo changes flatten out,
//     so a ritardando plays steady. A practice chart wants a grid anyway;
//   • transposed by whole octaves until the melody's middle sits on the
//     game's keyboard (C3–C6);
//   • a key guess (Krumhansl-style pitch-class profile match, major and
//     minor), so the quantiser can hold the player to the song's own scale.

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  u8()  { return this.b[this.i++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return (this.u16() * 65536) + this.u16(); }
  str(n) { let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(this.u8()); return s; }
  skip(n) { this.i += n; }
  varlen() {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return v;
  }
  get done() { return this.i >= this.b.length; }
}

/**
 * Parse an SMF into raw notes per track (ticks, not beats) plus the tempo and
 * time-signature metas. Throws with a human-readable message on anything that
 * is not a readable MIDI file — the importer surfaces it as a toast.
 */
export function parseMidi(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const r = new Reader(bytes);
  if (r.str(4) !== 'MThd') throw new Error('Not a MIDI file (no MThd header)');
  const hlen = r.u32();
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.skip(hlen - 6);
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  if (format > 2) throw new Error(`Unknown MIDI format ${format}`);

  const tracks = [];
  let tempo = null;            // first tempo meta: microseconds per quarter
  let timeSig = null;          // { nn, dd } from the first time-signature meta

  for (let t = 0; t < ntrks && !r.done; t++) {
    if (r.str(4) !== 'MTrk') throw new Error('Corrupt MIDI file (missing MTrk)');
    const len = r.u32();
    const end = r.i + len;
    const open = new Map();    // "ch:note" → { tick, m, ch }
    const notes = [];
    let name = '';
    let tick = 0;
    let status = 0;

    while (r.i < end) {
      tick += r.varlen();
      let b0 = r.u8();
      if (b0 < 0x80) { r.i--; b0 = status; } else status = b0;

      if (b0 === 0xff) {                     // meta
        const type = r.u8();
        const mlen = r.varlen();
        if (type === 0x03) name = r.str(mlen);
        else if (type === 0x51 && mlen === 3) {
          const us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
          tempo ??= us;
        } else if (type === 0x58 && mlen >= 2) {
          const nn = r.u8(), dd = r.u8();
          r.skip(mlen - 2);
          timeSig ??= { nn, dd };
        } else r.skip(mlen);
        continue;
      }
      if (b0 === 0xf0 || b0 === 0xf7) { r.skip(r.varlen()); continue; }   // sysex

      const kind = b0 & 0xf0, ch = b0 & 0x0f;
      if (kind === 0x90 || kind === 0x80) {
        const m = r.u8(), vel = r.u8();
        const key = `${ch}:${m}`;
        if (kind === 0x90 && vel > 0) {
          open.set(key, { tick, m, ch });
        } else {
          const on = open.get(key);
          if (on) {
            open.delete(key);
            notes.push({ tick: on.tick, durTick: Math.max(1, tick - on.tick), m, ch });
          }
        }
      } else if (kind === 0xc0 || kind === 0xd0) r.skip(1);
      else r.skip(2);                        // Ax Bx Ex — two data bytes
    }
    r.i = end;                               // trust the length over the walk
    // A note the file never switched off still happened; give it a beat.
    for (const on of open.values()) notes.push({ tick: on.tick, durTick: division, m: on.m, ch: on.ch });
    tracks.push({ name, notes });
  }
  return { format, division, tracks, tempo, timeSig };
}

// Best-fit key over the melody's pitch classes, weighted by duration.
export function guessKey(notes) {
  const hist = Array(12).fill(0);
  for (const n of notes) hist[((n.m % 12) + 12) % 12] += n.d;
  const score = (profile, rot) => {
    let s = 0;
    for (let pc = 0; pc < 12; pc++) s += hist[(pc + rot) % 12] * profile[pc];
    return s;
  };
  let best = { s: -1, root: 'C', scale: 'major (ionian)' };
  for (let rot = 0; rot < 12; rot++) {
    const maj = score(MAJOR_PROFILE, rot);
    const min = score(MINOR_PROFILE, rot);
    if (maj > best.s) best = { s: maj, root: NOTE_NAMES[rot], scale: 'major (ionian)' };
    if (min > best.s) best = { s: min, root: NOTE_NAMES[rot], scale: 'natural minor' };
  }
  return { root: best.root, scale: best.scale };
}

// The chart caps out well before localStorage does; a five-movement sonata
// truncates rather than refusing.
export const MAX_CHART_NOTES = 1200;

/**
 * The whole trip: bytes → play-along song ({ name, bpm, beatsPerBar, root,
 * scale, notes: [{ b, m, d }] }). `name` comes from the caller — usually the
 * filename, which players recognize where an internal track name ("Piano",
 * "Track 3") mostly would not.
 */
export function songFromMidi(buffer, { name = 'Imported song' } = {}) {
  const { division, tracks, tempo, timeSig } = parseMidi(buffer);

  // The busiest non-drum track carries the tune more often than any cleverer
  // rule does. Channel 10 (index 9) is percussion by the General MIDI map.
  const melodic = tracks
    .map(t => ({ ...t, notes: t.notes.filter(n => n.ch !== 9) }))
    .filter(t => t.notes.length);
  if (!melodic.length) throw new Error('No melodic notes found in this file');
  const src = melodic.reduce((a, b) => (b.notes.length > a.notes.length ? b : a));

  // Ticks → beats, then one line: sort, take the TOP note of anything
  // simultaneous (within a 32nd), trim each note at its successor.
  const raw = src.notes
    .map(n => ({ b: n.tick / division, m: n.m, d: n.durTick / division }))
    .sort((x, y) => x.b - y.b || y.m - x.m);
  const line = [];
  for (const n of raw) {
    const last = line[line.length - 1];
    if (last && n.b - last.b < 0.125) continue;       // stacked: top voice won
    if (last && last.b + last.d > n.b) last.d = n.b - last.b;
    line.push({ ...n });
  }
  const notes = line.slice(0, MAX_CHART_NOTES);

  // Rebase to beat 0 and quantize onto a 16th grid: the charts are grids, and
  // a note 0.02 beats early is performance, not composition.
  const t0 = notes[0].b;
  for (const n of notes) {
    n.b = Math.round((n.b - t0) * 4) / 4;
    n.d = Math.max(0.25, Math.round(n.d * 4) / 4);
  }

  // Whole-octave transpose until the melody's middle sits on the keyboard.
  const sorted = notes.map(n => n.m).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const shift = Math.round((64 - median) / 12) * 12;
  if (shift) for (const n of notes) n.m += shift;
  for (const n of notes) n.m = Math.max(36, Math.min(96, n.m));

  const bpm = Math.max(40, Math.min(240, tempo ? Math.round(60e6 / tempo) : 120));
  const beatsPerBar = timeSig
    ? Math.max(2, Math.min(12, Math.round(timeSig.nn * (4 / 2 ** timeSig.dd)))) : 4;

  return { name, bpm, beatsPerBar, ...guessKey(notes), notes };
}
