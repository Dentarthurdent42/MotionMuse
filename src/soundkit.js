// Instrument sound kit — synthesized timbre presets for the continuous
// oscillator bank. Each kit is a resting timbre: how many oscillators it wants,
// their waveforms (including custom harmonic tables) and levels, the filter
// type, and values for the shared timbre parameters.
// Gesture mappings keep modulating on top — the kit sets where a parameter
// rests, not a ceiling. Names are honest approximations: "Piano" ≈ tine
// e-piano, "Trumpet" ≈ bright brass — synthesis, not samples.

import { engine } from './engine.js';

// Harmonic tables (imag = sine partial amplitudes; real defaults to zeros).
const WAVES = {
  piano:   { imag: [0, 1, 0.25, 0.08, 0.1, 0.04, 0.06], real: [0, 0, 0.2] },
  organ:   { imag: [0, 1, 0.55, 0.35, 0.25, 0, 0.18, 0, 0.12] },
  trumpet: { imag: [0, 1, 0.75, 0.62, 0.48, 0.36, 0.25, 0.16, 0.1] },
  strings: { imag: [0, 1, 0.5, 0.33, 0.25, 0.2, 0.16, 0.14, 0.12, 0.1] },
  flute:   { imag: [0, 1, 0.08, 0.18, 0.04] },
  bass:    { imag: [0, 1, 0.35, 0.18, 0.28, 0.05] },
};
for (const [name, w] of Object.entries(WAVES)) engine.defineWave(name, w);

// Kits may only set timbre keys — never osc*_freq or the main volume (those
// belong to the player's gestures and to the player). Per-oscillator detune and
// level ARE timbre, but they are declared per slot in `oscs` below rather than
// listed here, since which slots exist is now a runtime value.
export const KIT_PARAM_KEYS = new Set([
  'filter_freq', 'filter_q', 'lfo_rate', 'lfo_depth', 'reverb_mix',
]);

// A kit's oscillator slots. Each kit names two, because each is voiced as a
// pair — but applying one no longer resizes the bank or sets levels: see
// applyKit. `level` is kept in the table as the intended balance, and is what
// a future "apply kit as a full patch" would use; nothing reads it today.
const KIT_OSC_DEFAULT = { detune: 0, level: 1 };

export const KITS = {
  synth: {
    label: 'Synth', filter: 'lowpass',
    oscs: [{ wave: 'sine', detune: 0, level: 1.0 },
           { wave: 'triangle', detune: 0, level: 0.0 }],
    params: { filter_freq: 3000, filter_q: 1, lfo_rate: 1, lfo_depth: 0, reverb_mix: 0.12 },
  },
  piano: {
    label: 'Piano', filter: 'lowpass',
    oscs: [{ wave: 'custom:piano', detune: 0, level: 0.75 },
           { wave: 'sine', detune: 4, level: 0.25 }],
    params: { filter_freq: 2400, filter_q: 0.8, lfo_rate: 1, lfo_depth: 0, reverb_mix: 0.25 },
  },
  organ: {
    label: 'Organ', filter: 'lowpass',
    oscs: [{ wave: 'custom:organ', detune: 0, level: 0.75 },
           { wave: 'sine', detune: 0, level: 0.25 }],
    params: { filter_freq: 6000, filter_q: 0.7, lfo_rate: 5.5, lfo_depth: 0.06, reverb_mix: 0.2 },
  },
  trumpet: {
    label: 'Trumpet', filter: 'lowpass',
    oscs: [{ wave: 'custom:trumpet', detune: 0, level: 0.65 },
           { wave: 'sawtooth', detune: -8, level: 0.35 }],
    params: { filter_freq: 1800, filter_q: 2.5, lfo_rate: 5, lfo_depth: 0.05, reverb_mix: 0.15 },
  },
  strings: {
    label: 'Strings', filter: 'lowpass',
    oscs: [{ wave: 'custom:strings', detune: -7, level: 0.55 },
           { wave: 'sawtooth', detune: 7, level: 0.45 }],
    params: { filter_freq: 2600, filter_q: 0.6, lfo_rate: 0.3, lfo_depth: 0.12, reverb_mix: 0.45 },
  },
  flute: {
    label: 'Flute', filter: 'lowpass',
    oscs: [{ wave: 'custom:flute', detune: 0, level: 0.8 },
           { wave: 'sine', detune: 0, level: 0.2 }],
    params: { filter_freq: 3500, filter_q: 0.5, lfo_rate: 5.5, lfo_depth: 0.08, reverb_mix: 0.35 },
  },
  bass: {
    label: 'Bass', filter: 'lowpass',
    oscs: [{ wave: 'custom:bass', detune: 0, level: 0.7 },
           { wave: 'square', detune: 0, level: 0.3 }],
    params: { filter_freq: 600, filter_q: 1.4, lfo_rate: 1, lfo_depth: 0, reverb_mix: 0.08 },
  },
};

let current = 'synth';

export function applyKit(id) {
  const kit = KITS[id];
  if (!kit) return false;

  // TIMBRE ONLY. A kit used to resize the bank and set every level too, so
  // picking "Strings" switched on an oscillator you had deliberately removed
  // and overwrote the balance you had dialled in. How many voices you play and
  // how loud each one is, is your arrangement; a kit describes the tone.
  //
  // Waveforms cycle if the bank is bigger than the kit describes — with four
  // oscillators and a two-voice kit, slots 3 and 4 repeat slots 1 and 2 rather
  // than falling back to a default that belongs to no instrument. With ONE
  // oscillator you get the kit's lead wave, which is the timbre the name is
  // really about. Slot 1's wave also sets the chord voices' tone (see
  // engine.setOscType), so chords follow the kit without it touching their
  // level either.
  const n = engine.getOscCount();
  for (let i = 0; i < n; i++) {
    const spec = { ...KIT_OSC_DEFAULT, ...kit.oscs[i % kit.oscs.length] };
    engine.setOscType(i, spec.wave);
    engine.set(`osc${i + 1}_detune`, spec.detune);
  }
  // A bank of zero still has chord voices to tone, and setOscType(0) is what
  // carries the waveform to them.
  if (n === 0) engine.setOscType(0, { ...KIT_OSC_DEFAULT, ...kit.oscs[0] }.wave);

  engine.setFilterType(kit.filter);
  for (const [k, v] of Object.entries(kit.params)) {
    if (KIT_PARAM_KEYS.has(k)) engine.set(k, v);
  }
  current = id;
  return true;
}

export function currentKit()       { return current; }
export function markCustom()       { current = 'custom'; }
// Restore the selection label after a preset load, without re-stomping the
// exact parameter values the preset just applied.
export function setCurrentLabel(id) { current = KITS[id] ? id : 'custom'; }
