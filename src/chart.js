// Chart transforms for play-along: putting a song into the instrument's key,
// and setting how many notes sound at once.
//
// Both exist because the game used to work the other way round on each count,
// and both were reported as "play-along is broken":
//
//   • The KEY. A stored chart carried its own root and scale, and starting a
//     round FORCED the quantiser to them — so picking Ode to Joy while the
//     instrument sat in D dorian silently moved the instrument to C major.
//     In the degree modes that is worse than surprising: the lanes are scale
//     DEGREES, so a chart in one key and an instrument in another disagree
//     about what "IV" is. The song is the thing that should move. Every note
//     is re-read as a degree of the song's own key and re-rendered as the same
//     degree of the instrument's — the tune keeps its shape and lands, note
//     for note, on pitches the instrument can actually reach.
//
//   • The DIFFICULTY. `easy` used to DROP notes — bar downbeats and long notes
//     only, which is why half of a tune went missing — and `hard` was the
//     whole chart, faster. That makes difficulty a property of the chart
//     rather than of the playing. Here it is polyphony: SINGLE gives one note
//     at a time, MULTI stacks the key's chord under each one, which is a
//     thing you need two hands (or a hand and a face) to play. Nothing is ever
//     dropped.
//
// Pure functions over plain chart objects, so all of it is unit-testable
// without an AudioContext — see tests/unit/chart.test.js.

import { SCALES, NOTE_NAMES } from './scale.js';
import { diatonicChord, isDegreeScale, degreeCountOf } from './chords.js';

const mod = (a, b) => ((a % b) + b) % b;

// A MIDI note read as a position in a key: which scale degree it is, which
// octave it sits in, and how far it sits off the degree (0 for a diatonic
// note; ±1 for a chromatic passing tone).
//
// `octave` counts key-root octaves from MIDI 0, so C4 (60) in C reads octave
// 5 — the same convention writeDegree consumes. It is an internal coordinate,
// not a display value: what matters is that read and write are exact
// inverses, which the round-trip test pins over three keys and three octaves.
//
// The offset is kept rather than rounded away because a melody's chromatics
// are part of its tune. It is re-applied in the target key, where it may not
// be diatonic either — which is correct: it was not diatonic in the source.
export function readDegree(midi, root, scale) {
  const degrees = SCALES[scale] ?? SCALES['major (ionian)'];
  const n = degrees.length;
  const rootPc = Math.max(0, NOTE_NAMES.indexOf(root));
  const rel = midi - rootPc;                 // semitones above the key's C-octave root
  const oct = Math.floor(rel / 12);
  const pc = mod(rel, 12);
  // Nearest degree at or below the note, so a chromatic reads as "the degree
  // under it, sharpened" — how a passing tone is heard.
  let idx = 0;
  for (let i = 0; i < n; i++) if (degrees[i] <= pc) idx = i;
  return { degree: idx, octave: oct, offset: pc - degrees[idx] };
}

// …and the inverse, in whatever key you hand it. A degree beyond the target
// scale's count (a 7-degree tune over a 5-degree key) wraps, carrying the
// octave with it, so a pentatonic target still gets a rising line rather than
// a flattened one.
export function writeDegree({ degree, octave, offset = 0 }, root, scale) {
  const degrees = SCALES[scale] ?? SCALES['major (ionian)'];
  const n = degrees.length;
  const rootPc = Math.max(0, NOTE_NAMES.indexOf(root));
  const wrapped = mod(degree, n);
  const carry = Math.floor(degree / n);
  return rootPc + degrees[wrapped] + 12 * (octave + carry) + offset;
}

// Move a whole chart into `key`. Degree charts (which carry `deg` per note)
// need no pitch work — their lanes ARE degrees, and the degree of a lane does
// not change with the key — but their guide pitches do, so the guide melody
// sings the progression in the key you are actually playing in.
export function transposeChart(song, key) {
  const toRoot = key?.root ?? song.root;
  const toScale = isDegreeScale(key?.mode) ? key.mode : song.scale;
  if (toRoot === song.root && toScale === song.scale) return song;

  const octave = key?.octave ?? 4;
  const isDegreeChart = song.notes.some(n => n.deg !== undefined);
  const notes = song.notes.map(n => {
    if (n.deg !== undefined) {
      // Re-voice the guide to this key's chord for that degree, and drop a
      // lane the target key does not have (7-degree chart, 5-degree key):
      // a lane nothing can select is a note nobody can hit.
      const c = diatonicChord(toRoot, octave, toScale, n.deg);
      return { ...n, m: c.midi[0] };
    }
    return { ...n, m: writeDegree(readDegree(n.m, song.root, song.scale), toRoot, toScale) };
  }).filter(n => n.deg === undefined || n.deg < degreeCountOf(toScale));

  const out = { ...song, root: toRoot, scale: toScale, notes };
  if (isDegreeChart) {
    const cnt = degreeCountOf(toScale);
    out.laneCount = cnt;
    out.laneLabels = Array.from({ length: cnt }, (_, i) =>
      diatonicChord(toRoot, octave, toScale, i).numeral);
  }
  return out;
}

// ── Difficulty is polyphony ───────────────────────────────────────────────

export const LEVELS = [
  { id: 'single', name: 'single note',   voices: 1 },
  { id: 'multi',  name: 'multiple notes', voices: 3 },
];
export const isLevel = id => LEVELS.some(l => l.id === id);
export const levelOf = id => LEVELS.find(l => l.id === id) ?? LEVELS[0];

// Every chart note gains a `notes` array: the MIDI it takes to satisfy it.
// SINGLE is the note itself. MULTI is the key's chord on that note's degree —
// so a melody becomes the harmony under it, and a degree chart becomes the
// chord that degree already stood for.
//
// Nothing is added or removed from the TIMELINE either way: the same hits at
// the same moments, with more or fewer notes in each. That is the whole point
// of the change — a difficulty that drops notes is a different song.
export function voiceChart(song, levelId, key) {
  const level = levelOf(levelId);
  const root = key?.root ?? song.root;
  const scale = isDegreeScale(key?.mode) ? key.mode : song.scale;
  const octave = key?.octave ?? 4;
  return {
    ...song,
    level: level.id,
    notes: song.notes.map(n => {
      if (level.voices <= 1) return { ...n, notes: [n.m] };
      const deg = n.deg !== undefined
        ? n.deg
        : readDegree(n.m, root, scale).degree;
      const c = diatonicChord(root, octave, scale, deg);
      // A melody note keeps its own octave: the chord is built under the note
      // being sung, not parked wherever the key's default octave happens to
      // be, or the harmony wanders away from the tune.
      const shift = n.deg !== undefined ? 0
        : 12 * Math.round((n.m - c.midi[0]) / 12);
      return { ...n, notes: c.midi.map(m => m + shift) };
    }),
  };
}

// Does a set of sounding MIDI notes satisfy a chart note?
//
// `pcMatch` compares pitch CLASSES, which is what octave-agnostic means — and
// what Shepard mode forces, because a Shepard tone is a stack of octaves with
// its octave deliberately discarded (see shepard.js). Asking a player to hit
// an octave the instrument is not expressing would be a test of nothing.
//
// MULTI is satisfied by covering every note asked for; extra notes sounding
// are not penalised, because a chord voicing with a doubled root is still
// that chord.
export function covers(sounding, wanted, { pcMatch = false } = {}) {
  if (!wanted?.length) return false;
  const key = m => (pcMatch ? mod(m, 12) : m);
  const have = new Set((sounding ?? []).filter(Number.isFinite).map(key));
  return wanted.every(m => have.has(key(m)));
}
