// Procedural play-along charts — one per way of playing the instrument.
//
// The bundled songs assume the pitch game: steer a quantised oscillator onto
// falling notes. But the instrument has three ways of playing now, and each
// deserves a chart in its own vocabulary: a MELODY for the pitch game, a
// DEGREE sequence for handshapes, a DEGREE sequence for the radial ring.
// Rather than hand-writing charts for each, these are generated — seeded, in
// the key the instrument is *currently set to* (the shared key both play
// modes read), sized by difficulty, and different every time you press PLAY.
//
// Two generators, one grammar each:
//   • melodies walk the scale — mostly stepwise, occasional thirds, chord
//     tones favoured on downbeats, a proper cadence onto the tonic;
//   • degree charts follow a functional-harmony walk: each degree carries
//     weights for where it likes to go (I moves anywhere, V pulls home,
//     pre-dominants pull to V), and the last two bars are always
//     dominant → tonic, so even a random progression ENDS like music.
//
// Everything is a pure function of (mode, key, difficulty, seed) — testable,
// reproducible, and honest about being generated.

import { SCALES, NOTE_NAMES } from './scale.js';
import { diatonicChord, isDegreeScale, degreeCountOf } from './chords.js';

// The three entries the song picker offers. `mode` names which input judges
// the chart: the quantised lead pitch, gesture mode's degree, or the ring's.
export const GEN_SONGS = [
  { id: 'gen-pitch',   name: '⚄ Melody · lead pitch',  mode: 'pitch'   },
  { id: 'gen-gesture', name: '⚄ Degrees · handshapes', mode: 'gesture' },
  { id: 'gen-radial',  name: '⚄ Degrees · radial ring', mode: 'radial' },
];
export const isGenSong = id => GEN_SONGS.some(s => s.id === id);
export const genModeOf = id => GEN_SONGS.find(s => s.id === id)?.mode ?? null;

// Small, seedable, good enough for music: mulberry32.
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const weighted = (rng, pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [v, w] of pairs) { roll -= w; if (roll <= 0) return v; }
  return pairs[pairs.length - 1][0];
};

// Rhythm patterns per bar (4/4), by difficulty: each entry sums to 4 beats.
const RHYTHMS = {
  easy:   [[4], [2, 2], [1, 1, 2], [2, 1, 1]],
  medium: [[2, 2], [1, 1, 2], [1, 1, 1, 1], [2, 1, 1], [1, 2, 1]],
  hard:   [[1, 1, 1, 1], [0.5, 0.5, 1, 1, 1], [1, 0.5, 0.5, 1, 1],
           [1, 1, 0.5, 0.5, 0.5, 0.5], [1.5, 0.5, 1, 1]],
};
const TEMPO = { easy: 88, medium: 100, hard: 116 };
const BARS  = { easy: 8, medium: 8, hard: 12 };

// Where each degree of a seven-note key likes to go — functional harmony as
// a weight table. Pentatonic keys reuse the same idea over five degrees.
const walkWeights = (from, n) => {
  if (n === 7) {
    const W = {
      0: [[3, 3], [4, 3], [5, 2], [1, 1], [2, 1]],      // I  → IV V vi ii iii
      1: [[4, 4], [6, 1], [0, 1]],                      // ii → V vii° I
      2: [[5, 3], [3, 2], [1, 1]],                      // iii → vi IV ii
      3: [[4, 3], [0, 2], [1, 1], [6, 1]],              // IV → V I ii vii°
      4: [[0, 4], [5, 2], [3, 1]],                      // V  → I vi IV
      5: [[1, 2], [3, 2], [4, 2], [0, 1]],              // vi → ii IV V I
      6: [[0, 4], [5, 1]],                              // vii° → I vi
    };
    return W[from] ?? [[0, 1]];
  }
  // Five degrees: neighbours and home, weighted toward movement.
  const opts = [];
  for (let d = 0; d < n; d++) if (d !== from) opts.push([d, d === 0 ? 2 : 1]);
  return opts;
};

// The degree the scale treats as its dominant — the last-but-one chord of the
// cadence. Degree 4 is the fifth scale tone in seven-note keys; in
// pentatonics degree 3 sits closest to that role.
const dominantOf = n => (n === 7 ? 4 : 3);

/**
 * Generate a chart. Returns the same shape songs.js stores, plus:
 *   mode        'pitch' | 'gesture' | 'radial'
 *   laneCount   degree modes: how many lanes the highway needs
 *   laneLabels  degree modes: what to print under each lane
 * and each degree-mode note carries `deg` beside its guide-midi `m`.
 */
export function generateSong(mode, {
  key = { root: 'C', mode: 'major (ionian)', octave: 4 },
  diffId = 'medium',
  seed = Math.floor(Math.random() * 2 ** 31),
} = {}) {
  const rng = makeRng(seed);
  const scaleName = isDegreeScale(key.mode) ? key.mode : 'major (ionian)';
  const degrees = SCALES[scaleName];
  const n = degreeCountOf(scaleName);
  const bars = BARS[diffId] ?? 8;
  const beatsPerBar = 4;
  const rootM = 12 * (key.octave + 1) + NOTE_NAMES.indexOf(key.root);
  const base = {
    id: `gen-${mode}`, mode, seed,
    name: `Generated · ${key.root} ${scaleName}`,
    bpm: TEMPO[diffId] ?? 100, beatsPerBar,
    root: key.root, scale: scaleName,
  };

  if (mode === 'pitch') {
    // A scale walk over ~1.5 octaves: steps mostly, thirds sometimes, a leap
    // to a chord tone on bar downbeats, and a cadence — the last bar is a
    // long tonic approached from a scale step above or below.
    const lo = -Math.ceil(n / 2), hi = n + Math.ceil(n / 2);  // scale indices
    const midiAt = i => rootM + degrees[((i % n) + n) % n] + 12 * Math.floor(i / n);
    const notes = [];
    let at = 0;                       // scale index of the current note
    let b = 0;
    for (let bar = 0; bar < bars; bar++) {
      const last = bar === bars - 1;
      if (last) {
        // Approach the tonic from a scale step — above if the walk sits high,
        // below if it sits low — then hold it. A generated tune that just
        // stops mid-phrase reads as a bug; one that cadences reads as a tune.
        notes.push({ b, m: midiAt(at >= 0 ? 1 : -1), d: 1 });
        notes.push({ b: b + 1, m: rootM, d: beatsPerBar - 1 });
        break;
      }
      for (const d of pick(rng, RHYTHMS[diffId] ?? RHYTHMS.medium)) {
        const step = weighted(rng, [[1, 4], [-1, 4], [2, 2], [-2, 2], [0, 1]]);
        at = Math.max(lo, Math.min(hi, at + step));
        // Downbeats prefer chord tones of the tonic: land on 0, 2 or 4 mod n.
        if (b % beatsPerBar === 0 && rng() < 0.5) {
          const tones = [0, 2 % n, 4 % n];
          at = Math.round((at - pick(rng, tones)) / n) * n + pick(rng, tones);
        }
        notes.push({ b, m: midiAt(at), d });
        b += d;
      }
    }
    return { ...base, notes };
  }

  // Degree charts: a chord walk, one lane per degree, ending V → I. Density
  // by difficulty: easy holds a bar, medium half-bars, hard mixes in single
  // beats. The guide-midi is the degree's chord root, so the guide melody
  // sings the progression.
  const durPool = diffId === 'easy' ? [4] : diffId === 'medium' ? [4, 2, 2] : [2, 2, 1, 1];
  const totalBeats = bars * beatsPerBar;
  const cadenceAt = totalBeats - 2 * beatsPerBar;
  const notes = [];
  let deg = 0, b = 0;
  while (b < cadenceAt) {
    const d = Math.min(pick(rng, durPool), cadenceAt - b);
    notes.push({ b, deg, m: 0, d });    // guide-midi filled in below
    deg = weighted(rng, walkWeights(deg, n));
    b += d;
  }
  notes.push({ b: cadenceAt, deg: dominantOf(n), m: 0, d: beatsPerBar });
  notes.push({ b: cadenceAt + beatsPerBar, deg: 0, m: 0, d: beatsPerBar });
  for (const nn of notes) {
    const c = diatonicChord(key.root, key.octave, scaleName, nn.deg);
    nn.m = c.midi[0];
  }
  const laneLabels = Array.from({ length: n }, (_, i) =>
    diatonicChord(key.root, key.octave, scaleName, i).numeral);
  return { ...base, notes, laneCount: n, laneLabels };
}
