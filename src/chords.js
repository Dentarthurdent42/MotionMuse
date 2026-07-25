// Chord construction — pure helpers mapping a root note + quality to
// frequencies. 12-TET anchored at A4 = 440 Hz, matching scale.js's math.

import { NOTE_NAMES } from './scale.js';

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
