// ── Musical scale + tuning quantiser ─────────────────────────────────────
//
// Snaps a continuous frequency (Hz) onto the nearest pitch of a chosen scale,
// root and tuning system. Tunings are defined as 12 frequency ratios spanning
// one octave (degree 0 = unison … degree 11 = major seventh); a scale selects
// which of those 12 degrees are playable. This factoring lets any scale be
// rendered in any tuning — e.g. C minor in just intonation, or major
// pentatonic in Pythagorean.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Scale → semitone degrees from the root, within one octave.
export const SCALES = {
  'chromatic':        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'major (ionian)':   [0, 2, 4, 5, 7, 9, 11],
  'natural minor':    [0, 2, 3, 5, 7, 8, 10],
  'harmonic minor':   [0, 2, 3, 5, 7, 8, 11],
  'dorian':           [0, 2, 3, 5, 7, 9, 10],
  'phrygian':         [0, 1, 3, 5, 7, 8, 10],
  'mixolydian':       [0, 2, 4, 5, 7, 9, 10],
  'major pentatonic': [0, 2, 4, 7, 9],
  'minor pentatonic': [0, 3, 5, 7, 10],
  'blues':            [0, 3, 5, 6, 7, 10],
  'whole tone':       [0, 2, 4, 6, 8, 10],
};

// Tuning → ratio of each of the 12 semitone degrees to the root (octave = 2/1).
export const TUNINGS = {
  'equal (12-TET)':  Array.from({ length: 12 }, (_, i) => 2 ** (i / 12)),
  'just intonation': [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 16 / 9, 15 / 8],
  'pythagorean':     [1, 256 / 243, 9 / 8, 32 / 27, 81 / 64, 4 / 3, 729 / 512, 3 / 2, 128 / 81, 27 / 16, 16 / 9, 243 / 128],
};

const A4 = 440;

// ── Pure note/frequency helpers (12-TET) ─────────────────────────────────
export const mtof = m => A4 * 2 ** ((m - 69) / 12);

// MIDI → display name, e.g. 60 → "C4", 61 → "C#4".
export const midiName = m =>
  NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

// "A4", "C#3", "Db4", "g#2" → MIDI, or null when unparseable.
// Flats resolve to the semitone below (Db4 === C#4).
export function parseNote(str) {
  const m = /^([A-Ga-g])([#♯b♭]?)(-?\d)$/.exec(String(str).trim());
  if (!m) return null;
  const pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()]
           + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0);
  return 12 * (parseInt(m[3], 10) + 1) + pc;
}

// Frequency of a root pitch class at octave 0 (C0 ≈ 16.35 Hz), 12-TET anchored.
// The tuning system defines intervals *relative to* this root, so the root
// itself keeps a fixed pitch regardless of the chosen temperament.
const rootAnchorHz = root => {
  const p = Math.max(0, NOTE_NAMES.indexOf(root));
  return A4 * 2 ** ((p - 57) / 12);
};

export function makeQuantizer({ root = 'C', scale = 'chromatic', tuning = 'equal (12-TET)' } = {}) {
  const degrees = SCALES[scale]   ?? SCALES['chromatic'];
  const ratios  = TUNINGS[tuning] ?? TUNINGS['equal (12-TET)'];
  const anchor  = rootAnchorHz(root);

  // Pre-compute every playable frequency across the audible octave range.
  const freqs = [];
  for (let k = 0; k <= 9; k++) {
    const base = anchor * 2 ** k;
    for (const d of degrees) freqs.push(base * ratios[d]);
  }
  freqs.sort((a, b) => a - b);

  const quantize = f => {
    if (!(f > 0)) return f;
    if (f <= freqs[0]) return freqs[0];
    if (f >= freqs[freqs.length - 1]) return freqs[freqs.length - 1];
    let lo = 0, hi = freqs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (freqs[mid] < f) lo = mid + 1; else hi = mid - 1;
    }
    // `lo` is the first index ≥ f; pick whichever neighbour is closer.
    return (f - freqs[lo - 1] <= freqs[lo] - f) ? freqs[lo - 1] : freqs[lo];
  };

  // Nearest 12-TET note name for display (e.g. "C3", "G#4").
  const noteName = f => {
    if (!(f > 0)) return '–';
    return midiName(Math.round(69 + 12 * Math.log2(f / A4)));
  };

  return { quantize, noteName, freqs };
}
