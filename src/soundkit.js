// Instrument sound kit — synthesized timbre presets for the continuous
// two-oscillator engine. Each kit is a resting timbre: waveforms (including
// custom harmonic tables), filter type, and values for the timbre parameters.
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

// Kits may only set timbre keys — never osc*_freq or volume (those belong to
// the player's gestures and the master volume).
export const KIT_PARAM_KEYS = new Set([
  'osc_mix', 'osc1_detune', 'osc2_detune',
  'filter_freq', 'filter_q', 'lfo_rate', 'lfo_depth', 'reverb_mix',
]);

export const KITS = {
  synth: {
    label: 'Synth', osc1: 'sine', osc2: 'triangle', filter: 'lowpass',
    params: { osc_mix: 0, osc1_detune: 0, osc2_detune: 0, filter_freq: 3000, filter_q: 1, lfo_rate: 1, lfo_depth: 0, reverb_mix: 0.12 },
  },
  piano: {
    label: 'Piano', osc1: 'custom:piano', osc2: 'sine', filter: 'lowpass',
    params: { osc_mix: 0.25, osc1_detune: 0, osc2_detune: 4, filter_freq: 2400, filter_q: 0.8, lfo_rate: 1, lfo_depth: 0, reverb_mix: 0.25 },
  },
  organ: {
    label: 'Organ', osc1: 'custom:organ', osc2: 'sine', filter: 'lowpass',
    params: { osc_mix: 0.25, osc1_detune: 0, osc2_detune: 0, filter_freq: 6000, filter_q: 0.7, lfo_rate: 5.5, lfo_depth: 0.06, reverb_mix: 0.2 },
  },
  trumpet: {
    label: 'Trumpet', osc1: 'custom:trumpet', osc2: 'sawtooth', filter: 'lowpass',
    params: { osc_mix: 0.35, osc1_detune: 0, osc2_detune: -8, filter_freq: 1800, filter_q: 2.5, lfo_rate: 5, lfo_depth: 0.05, reverb_mix: 0.15 },
  },
  strings: {
    label: 'Strings', osc1: 'custom:strings', osc2: 'sawtooth', filter: 'lowpass',
    params: { osc_mix: 0.45, osc1_detune: -7, osc2_detune: 7, filter_freq: 2600, filter_q: 0.6, lfo_rate: 0.3, lfo_depth: 0.12, reverb_mix: 0.45 },
  },
  flute: {
    label: 'Flute', osc1: 'custom:flute', osc2: 'sine', filter: 'lowpass',
    params: { osc_mix: 0.2, osc1_detune: 0, osc2_detune: 0, filter_freq: 3500, filter_q: 0.5, lfo_rate: 5.5, lfo_depth: 0.08, reverb_mix: 0.35 },
  },
  bass: {
    label: 'Bass', osc1: 'custom:bass', osc2: 'square', filter: 'lowpass',
    params: { osc_mix: 0.3, osc1_detune: 0, osc2_detune: 0, filter_freq: 600, filter_q: 1.4, lfo_rate: 1, lfo_depth: 0, reverb_mix: 0.08 },
  },
};

let current = 'synth';

export function applyKit(id) {
  const kit = KITS[id];
  if (!kit) return false;
  engine.setOsc1Type(kit.osc1);
  engine.setOsc2Type(kit.osc2);
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
