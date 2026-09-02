// Controls that a cable can drive, beyond the audio parameters.
//
// The engine's PARAMS are continuous audio values — a frequency, a gain — and
// a cable writes one every frame. But an instrument has switches and choices
// too: which filter, which key, how fast the metronome, whether the gate or
// the arpeggiator is on. Each of those is registered here as a parameter like
// any other — a label, a range, a value — with an `apply` hook the engine
// calls whenever the value is set, so the same cable machinery (curve, range,
// steps, invert) reaches them: wire a hand's height into KEY ROOT and the
// scale transposes as you rise; wire a pulse into ARP ON and it switches.
//
// A choice is an INDEX into its options, so a cable's `steps` set to the
// number of options quantises it cleanly; `apply` rounds regardless, and only
// acts when the rounded value actually changes — the mapper writes every
// frame, and rebuilding the tuning sixty times a second is not a feature.
//
// Nothing here knows the DOM. The panels read their state on render, and
// subscribe through onChange() to follow a cable live.

import { engine }    from './engine.js';
import { metronome, BPM_MIN, BPM_MAX } from './metronome.js';
import { arpvoice }  from './arpvoice.js';
import { ARP_PATTERNS } from './arp.js';
import { SCALES, NOTE_NAMES } from './scale.js';

export const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch'];
export const SCALE_NAMES = Object.keys(SCALES);

const cbs = [];
export const onControlChange = cb => { cbs.push(cb); };
const notify = key => cbs.forEach(cb => cb(key));

// A hook that acts only when the rounded value moves.
const onIndex = (fn) => {
  let last = null;
  return v => { const i = Math.round(v); if (i === last) return; last = i; fn(i); };
};
const onNumber = (fn, digits = 0) => {
  let last = null;
  return v => { const r = +v.toFixed(digits); if (r === last) return; last = r; fn(r); };
};

// key → definition. `options` labels a choice; `toggle` marks an on/off.
export const CONTROLS = {
  filter_type: {
    label: 'Filter Type', min: 0, max: FILTER_TYPES.length - 1, options: FILTER_TYPES,
    read: () => FILTER_TYPES.indexOf(engine.getFilterType()),
    apply: onIndex(i => { engine.setFilterType(FILTER_TYPES[i] ?? FILTER_TYPES[0]); notify('filter_type'); }),
  },
  chord_filter_type: {
    label: 'Chord Filter Type', min: 0, max: FILTER_TYPES.length - 1, options: FILTER_TYPES,
    read: () => FILTER_TYPES.indexOf(engine.getChordFilterType()),
    apply: onIndex(i => { engine.setChordFilterType(FILTER_TYPES[i] ?? FILTER_TYPES[0]); notify('chord_filter_type'); }),
  },
  quant_on: {
    label: 'Pitch Quantize', min: 0, max: 1, toggle: true,
    read: () => (engine.getTuning().enabled ? 1 : 0),
    apply: onIndex(i => { engine.setTuning({ enabled: i >= 1 }); notify('quant_on'); }),
  },
  key_root: {
    label: 'Key Root', min: 0, max: NOTE_NAMES.length - 1, options: NOTE_NAMES,
    read: () => Math.max(0, NOTE_NAMES.indexOf(engine.getTuning().root)),
    apply: onIndex(i => { engine.setTuning({ root: NOTE_NAMES[i] ?? NOTE_NAMES[0] }); notify('key_root'); }),
  },
  key_scale: {
    label: 'Key Scale', min: 0, max: SCALE_NAMES.length - 1, options: SCALE_NAMES,
    read: () => Math.max(0, SCALE_NAMES.indexOf(engine.getTuning().scale)),
    apply: onIndex(i => { engine.setTuning({ scale: SCALE_NAMES[i] ?? SCALE_NAMES[0] }); notify('key_scale'); }),
  },
  vq_on: {
    label: 'Volume Quantize', min: 0, max: 1, toggle: true,
    read: () => (engine.getVolStep().enabled ? 1 : 0),
    apply: onIndex(i => { engine.setVolStep({ enabled: i >= 1 }); notify('vq_on'); }),
  },
  vq_gate: {
    label: 'Gate', min: 0, max: 1, toggle: true,
    read: () => (engine.getVolStep().gate ? 1 : 0),
    apply: onIndex(i => { engine.setVolStep({ gate: i >= 1 }); notify('vq_gate'); }),
  },
  metro_on: {
    label: 'Metronome', min: 0, max: 1, toggle: true,
    read: () => (metronome.on ? 1 : 0),
    apply: onIndex(i => { metronome.setOn(i >= 1); notify('metro_on'); }),
  },
  metro_bpm: {
    label: 'Tempo', min: BPM_MIN, max: BPM_MAX, unit: 'bpm',
    read: () => metronome.config().bpm,
    apply: onNumber(v => { metronome.setBpm(v); notify('metro_bpm'); }),
  },
  arp_on: {
    label: 'Arp', min: 0, max: 1, toggle: true,
    read: () => (arpvoice.enabled ? 1 : 0),
    apply: onIndex(i => { arpvoice.set({ enabled: i >= 1 }); notify('arp_on'); }),
  },
  arp_pattern: {
    label: 'Arp Pattern', min: 0, max: ARP_PATTERNS.length - 1, options: ARP_PATTERNS,
    read: () => Math.max(0, ARP_PATTERNS.indexOf(arpvoice.state().pattern)),
    apply: onIndex(i => { arpvoice.set({ pattern: ARP_PATTERNS[i] ?? ARP_PATTERNS[0] }); notify('arp_pattern'); }),
  },
};

export const CONTROL_KEYS = Object.keys(CONTROLS);
export const isControl = key => key in CONTROLS;

// Register every control as an engine parameter. Once, at startup, before
// anything restores a saved patch: a snapshot carries these values under
// `params`, and restore() replays them through set() → apply.
let registered = false;
export function registerControls() {
  if (registered) return;
  registered = true;
  const defs = {};
  for (const [key, c] of Object.entries(CONTROLS)) {
    defs[key] = { label: c.label, min: c.min, max: c.max, val: c.read(), unit: c.unit,
                  control: true, options: c.options, toggle: c.toggle, apply: c.apply };
  }
  engine.registerParams(defs);
}

// Pull the live state back into the parameter values — after a panel's own
// buttons changed a setting, or a saved state was restored, so the value a
// cable editor or a slider reads is the one the instrument is actually in.
export function syncControls() {
  for (const [key, c] of Object.entries(CONTROLS)) {
    const p = engine.PARAMS[key];
    if (p) p.val = c.read();
  }
}

// What a control's value means, for readouts: the option's name, ON/OFF, or
// the number.
export function controlLabel(key, v = engine.PARAMS[key]?.val) {
  const c = CONTROLS[key];
  if (!c) return String(v);
  if (c.options) return String(c.options[Math.round(v)] ?? c.options[0]).toUpperCase();
  if (c.toggle) return Math.round(v) >= 1 ? 'ON' : 'OFF';
  return `${Math.round(v)}${c.unit ? ' ' + c.unit : ''}`;
}
