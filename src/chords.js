// Chord construction — pure helpers mapping a root note + quality to
// frequencies. 12-TET anchored at A4 = 440 Hz, matching scale.js's math.

import { NOTE_NAMES, SCALES } from './scale.js';

// Quality → semitone offsets from the root (ascending).
export const QUALITIES = {
  'major':  [0, 4, 7],
  'minor':  [0, 3, 7],
  'dim':    [0, 3, 6],
  'aug':    [0, 4, 8],
  'sus2':   [0, 2, 7],
  'sus4':   [0, 5, 7],
  'maj7':   [0, 4, 7, 11],
  'min7':   [0, 3, 7, 10],
  'dom7':   [0, 4, 7, 10],
  'min6':   [0, 3, 7, 9],
  'add9':   [0, 4, 7, 14],
};

const mtof = m => 440 * 2 ** ((m - 69) / 12);

// MIDI of a root pitch class at a given octave (C4 = 60).
export const rootMidi = (root, octave = 4) =>
  12 * (octave + 1) + Math.max(0, NOTE_NAMES.indexOf(root));

// Frequencies (Hz) of a chord, lowest note first.
export function chordFreqs(root, octave = 4, quality = 'major') {
  const base = rootMidi(root, octave);
  const offs = QUALITIES[quality] ?? QUALITIES.major;
  return offs.map(o => mtof(base + o));
}

export const chordName = (root, quality) => `${root} ${quality}`;

// ── Diatonic chords: degrees of a key, not absolute roots ────────────────
//
// Naming a chord by its scale degree ("the V") instead of its pitch ("G major")
// means changing key transposes every assignment at once, and every chord is
// guaranteed to belong to the key. Qualities are *derived*, never tabulated:
// stack every other scale tone and read the intervals back. That way any
// 7-note mode works — harmonic minor's V comes out major and its vii° dim
// with no special cases.

// The modes roman numerals are meaningful over: exactly the 7-note scales.
export const DIATONIC_SCALES =
  Object.keys(SCALES).filter(k => SCALES[k].length === 7);

export const isDiatonic = scale => SCALES[scale]?.length === 7;

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// Semitone offsets of a triad/seventh built on degree `i`, relative to the
// chord's own root. `degrees` is a scale's semitone list (scale.js SCALES).
export function diatonic(degrees, i, { seventh = false } = {}) {
  const n = degrees.length;
  const deg = ((Math.round(i) % n) + n) % n;
  // Scale tone `k`, allowed to run past the octave (wraps, adding 12 per lap).
  const at = k => degrees[((k % n) + n) % n] + 12 * Math.floor(k / n);
  const steps = seventh ? [0, 2, 4, 6] : [0, 2, 4];
  const offs  = steps.map(s => at(deg + s) - at(deg));
  return {
    degree: deg,
    root: at(deg),              // semitones above the key's root
    offs,
    numeral: numeralFor(deg, offs, n),
    quality: qualityFor(offs),
  };
}

// Roman numeral read off the actual intervals: case from the third,
// °/+ from the fifth, and the seventh's flavour appended.
function numeralFor(deg, offs, n) {
  if (n !== 7) return `${deg + 1}`;         // numerals only mean something over 7 tones
  const [, third, fifth, sev] = offs;
  const minor = third === 3;
  let s = minor ? ROMAN[deg].toLowerCase() : ROMAN[deg];
  if (third !== 3 && third !== 4) s += 'sus';   // e.g. a 2nd or 4th in place of the third
  if (fifth === 6) s += '°';
  else if (fifth === 8) s += '+';
  if (sev !== undefined) {
    if (fifth === 6 && sev === 9)       s = s.replace('°', '') + '°7';
    else if (fifth === 6 && sev === 10) s = s.replace('°', '') + 'ø7';
    else if (sev === 11)                s += 'maj7';
    else                                s += '7';
  }
  return s;
}

// Name the interval set by matching it against the quality table, so the
// readout says "dom7" rather than "[0,4,7,10]". Unmatched sets (possible in
// exotic modes) fall back to listing the intervals.
function qualityFor(offs) {
  for (const [q, o] of Object.entries(QUALITIES)) {
    if (o.length === offs.length && o.every((v, i) => v === offs[i])) return q;
  }
  return offs.join('-');
}

// Everything the UI and engine need for one degree of one key.
// `octave` sets where the chord's root sits (C4 = 60).
export function diatonicChord(keyRoot = 'C', octave = 4, scale = 'major (ionian)',
                              degree = 0, seventh = false) {
  const degrees = SCALES[scale]?.length === 7 ? SCALES[scale] : SCALES['major (ionian)'];
  const d = diatonic(degrees, degree, { seventh });
  const base = rootMidi(keyRoot, octave) + d.root;
  return {
    ...d,
    midi: d.offs.map(o => base + o),
    freqs: d.offs.map(o => mtof(base + o)),
    // Pitch-class name of the chord's own root, for the readout ("G dom7").
    rootName: NOTE_NAMES[((base % 12) + 12) % 12],
  };
}

// ── Single notes: a degree, plus an accidental ───────────────────────────
//
// The same degree addressing as the chords above, sounding only the degree's
// own root — and then raised or lowered a semitone. The accidental is what
// puts the five notes BETWEEN the scale degrees within reach: seven shapes
// name seven degrees, and a hand saying ♯ or ♭ reaches the rest of the
// chromatic scale without a shape for each.

export const NATURAL = 0;
export const SHARP = 1;
export const FLAT = -1;

// Both spellings of every pitch class. Which one to show is not cosmetic: a
// player who flattened a note wants to read the flat they played, and
// "A♯" for it reads as a different note reached a different way.
const SHARP_SPELLING = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_SPELLING  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

/**
 * Name a pitch, spelled to match how it was reached.
 *
 * Only the black keys have two spellings, so this is exactly "flats read as
 * flats": flattening B gives B♭, while flattening C gives plain B — naming
 * that C♭ would be correct on paper and unreadable on a panel.
 */
export const pitchName = (midi, accidental = NATURAL) =>
  (accidental < 0 ? FLAT_SPELLING : SHARP_SPELLING)[((midi % 12) + 12) % 12]
  + (Math.floor(midi / 12) - 1);

/**
 * One degree of one key as a single note.
 *
 * `accidental` is -1, 0 or +1 semitones. Deliberately not clamped to the key:
 * the whole point of a sharp is to leave it.
 */
export function diatonicNote(keyRoot = 'C', octave = 4, scale = 'major (ionian)',
                             degree = 0, accidental = NATURAL) {
  const c = diatonicChord(keyRoot, octave, scale, degree);
  const acc = Math.max(-1, Math.min(1, Math.round(Number(accidental) || 0)));
  const midi = c.midi[0] + acc;
  return {
    degree: c.degree,
    numeral: c.numeral,
    accidental: acc,
    midi,
    freq: mtof(midi),
    name: pitchName(midi, acc),
  };
}
