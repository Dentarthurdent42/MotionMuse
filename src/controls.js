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
import { chordmode, VOICINGS, EXPRESSION_MODES, EXPRESSION_CONTROLS } from './chordmode.js';
import { DEGREE_KEYS, RELEASE_KEY, ACC_KEYS, CABLE_ID } from './chordcables.js';
import { radial, VOLUME_MODES, FINGERS } from './radial.js';
import { micSource } from './mic.js';
import { looper }    from './looper.js';
import { playalong } from './playalong.js';
import { KITS, applyKit, currentKit } from './soundkit.js';
import { TUNINGS }   from './scale.js';
import { DEGREE_SCALES } from './chords.js';
import { SIGNATURES } from './metronome.js';
import { STEP_OPTS, FLOOR_OPTS, EDGE_KEYS } from './dynamics.js';

export const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch'];
export const SCALE_NAMES = Object.keys(SCALES);
export const OSC_TYPES = ['sine', 'triangle', 'sawtooth', 'square'];
export const KIT_IDS = Object.keys(KITS);
export const TUNING_NAMES = Object.keys(TUNINGS);
export const JOINT_IDS = ['wrist_L', 'wrist_R', 'shoulder_L', 'shoulder_R'];
const HANDS = ['L', 'R'];
const NAMING = ['any', 'L', 'R'];
const OCTAVES = [2, 3, 4, 5];

const cbs = [];
export const onControlChange = cb => { cbs.push(cb); };
const notify = key => cbs.forEach(cb => cb(key));

// A hook that acts only when the rounded value differs from the state the
// instrument is actually in — read live, not remembered. A restored snapshot
// replays every parameter through set(), and a value that already holds must
// not rebuild anything; a cable holding a value re-asserts it, so a switch
// that is wired follows its cable like a slider does.
const onIndex = (read, fn) => v => { const i = Math.round(v); if (i === Math.round(read())) return; fn(i); };
const onNumber = (read, fn, digits = 0) => v => { const r = +v.toFixed(digits); if (r === +read().toFixed(digits)) return; fn(r); };
// The microphone is the exception: starting it can be refused, in which case
// the state never catches up with the cable — so it remembers what it last
// tried and tries again only when the cable's value changes.
const onIndexOnce = (fn) => {
  let last = null;
  return v => { const i = Math.round(v); if (i === last) return; last = i; fn(i); };
};
// A trigger: the pedal, STOP, PLAY. Acts once each time the cable rises
// past half — a pulse presses it, a held high does not keep pressing.
const onRise = (fn) => {
  let high = false;
  return v => { const now = v >= 0.5; if (now && !high) fn(); high = now; };
};
// A gate: held while the cable reads high — a degree, the release, an
// accidental, held by whatever is wired in (src/chordcables.js).
const onHold = (fn) => {
  let high = false;
  return v => { const now = v >= 0.5; if (now !== high) { high = now; fn(now); } };
};
// A choice's index, or 0 for a value the options do not name (a kit edited
// into "custom", a waveform a kit gave an oscillator).
const indexIn = (opts, v) => Math.max(0, opts.indexOf(v));

// An ADSR's four sliders, as controls: continuous (`slider`), read from and
// written through the engine's envelope setters, clamped by its ranges.
function envControls(prefix, labelPrefix, range, get, set) {
  const out = {};
  for (const k of ['attack', 'decay', 'sustain', 'release']) {
    const [lo, hi] = range()[k];
    out[`${prefix}${k}`] = {
      label: `${labelPrefix}${k[0].toUpperCase()}${k.slice(1)}`, min: lo, max: hi, slider: true,
      unit: k === 'sustain' ? '' : 's',
      read: () => get()[k],
      apply: onNumber(() => get()[k], v => set({ [k]: v }), 3),
    };
  }
  return out;
}

// key → definition. `options` labels a choice; `toggle` marks an on/off;
// `integer` a count (stepped, but with no names for its steps); `trigger` a
// button a pulse presses; `slider` a continuous value the panel draws as a
// slider row (src/ui/rows.js), which follows the cable like any other.
export const CONTROLS = {
  // The bank itself: how many oscillators the lead voice runs. A cable here
  // adds and removes voices as it rises and falls; the Oscillators node
  // redraws with the bank (engine.onOscCountChange), and cables to a slot
  // that has gone are kept, undrawn, until the slot is back.
  osc_count: {
    label: 'Oscillators', min: 0, max: engine.MAX_OSCS, integer: true, unit: 'osc',
    read: () => engine.getOscCount(),
    apply: onIndex(() => engine.getOscCount(), i => { engine.setOscCount(i); notify('osc_count'); }),
  },
  // The play modes' own switches. One instrument on the chord bank at a
  // time: switching either on parks the other, exactly as its button does.
  chord_on: {
    label: 'Gesture Mode', min: 0, max: 1, toggle: true,
    read: () => (chordmode.enabled ? 1 : 0),
    apply: onIndex(() => (chordmode.enabled ? 1 : 0), i => {
      const on = i >= 1;
      if (on) radial.setEnabled(false);
      chordmode.setEnabled(on);
      notify('chord_on');
    }),
  },
  radial_on: {
    label: 'Radial Mode', min: 0, max: 1, toggle: true,
    read: () => (radial.enabled ? 1 : 0),
    apply: onIndex(() => (radial.enabled ? 1 : 0), i => { radial.setEnabled(i >= 1); notify('radial_on'); }),
  },
  // The microphone starts asynchronously and may be refused; the panel is
  // told once it has settled either way, and reads the real state.
  mic_on: {
    label: 'Microphone', min: 0, max: 1, toggle: true,
    read: () => (micSource.active ? 1 : 0),
    apply: onIndexOnce(i => {
      const on = i >= 1;
      if (on === micSource.active) return;
      (on ? micSource.start() : Promise.resolve(micSource.stop()))
        .catch(() => {})
        .then(() => notify('mic_on'));
    }),
  },
  // ── The output ──
  mute: {
    label: 'Mute', min: 0, max: 1, toggle: true,
    read: () => (engine.muted ? 1 : 0),
    apply: onIndex(() => (engine.muted ? 1 : 0), i => { engine.setMuted(i >= 1); notify('mute'); }),
  },
  // ── The lead voice ──
  shepard_lead: {
    label: 'Shepard', min: 0, max: 1, toggle: true,
    read: () => (engine.getShepard().lead ? 1 : 0),
    apply: onIndex(() => (engine.getShepard().lead ? 1 : 0), i => { engine.setShepard({ lead: i >= 1 }); notify('shepard_lead'); }),
  },
  kit: {
    label: 'Sound Kit', min: 0, max: KIT_IDS.length - 1, options: KIT_IDS,
    read: () => indexIn(KIT_IDS, currentKit()),
    apply: onIndex(() => indexIn(KIT_IDS, currentKit()), i => { applyKit(KIT_IDS[i] ?? KIT_IDS[0]); notify('kit'); }),
  },
  tuning_system: {
    label: 'Tuning', min: 0, max: TUNING_NAMES.length - 1, options: TUNING_NAMES,
    read: () => indexIn(TUNING_NAMES, engine.getTuning().system),
    apply: onIndex(() => indexIn(TUNING_NAMES, engine.getTuning().system),
                   i => { engine.setTuning({ system: TUNING_NAMES[i] ?? TUNING_NAMES[0] }); notify('tuning_system'); }),
  },
  // ── The volume quantiser's ladder, and the lead envelope it triggers ──
  vq_steps: {
    label: 'Steps', min: 0, max: STEP_OPTS.length - 1, options: STEP_OPTS.map(n => `${n} steps`),
    read: () => indexIn(STEP_OPTS, engine.getVolStep().steps),
    apply: onIndex(() => indexIn(STEP_OPTS, engine.getVolStep().steps),
                   i => { engine.setVolStep({ steps: STEP_OPTS[i] ?? STEP_OPTS[0] }); notify('vq_steps'); }),
  },
  vq_floor: {
    label: 'Floor', min: 0, max: FLOOR_OPTS.length - 1, options: FLOOR_OPTS.map(f => `${f} dB`),
    read: () => indexIn(FLOOR_OPTS, engine.getVolStep().floorDb),
    apply: onIndex(() => indexIn(FLOOR_OPTS, engine.getVolStep().floorDb),
                   i => { engine.setVolStep({ floorDb: FLOOR_OPTS[i] ?? FLOOR_OPTS[0] }); notify('vq_floor'); }),
  },
  vq_edge: {
    label: 'Edge', min: 0, max: EDGE_KEYS.length - 1, options: EDGE_KEYS,
    read: () => indexIn(EDGE_KEYS, engine.getVolStep().edge),
    apply: onIndex(() => indexIn(EDGE_KEYS, engine.getVolStep().edge),
                   i => { engine.setVolStep({ edge: EDGE_KEYS[i] ?? EDGE_KEYS[0] }); notify('vq_edge'); }),
  },
  vq_gate_at: {
    label: 'Gate At', min: 0, max: 1, slider: true,
    read: () => Number(engine.getVolStep().gateAt) || 0,
    apply: onNumber(() => Number(engine.getVolStep().gateAt) || 0, v => engine.setVolStep({ gateAt: v }), 3),
  },
  lead_env_on: {
    label: 'ADSR', min: 0, max: 1, toggle: true,
    read: () => (engine.getLeadEnv().enabled ? 1 : 0),
    apply: onIndex(() => (engine.getLeadEnv().enabled ? 1 : 0), i => { engine.setLeadEnv({ enabled: i >= 1 }); notify('lead_env_on'); }),
  },
  ...envControls('lead_', 'Lead ', () => engine.LEAD_ENV_RANGE, () => engine.getLeadEnv(), p => engine.setLeadEnv(p)),
  // ── The chord voice: what both play modes sound through ──
  chord_root: {
    label: 'Key Root', min: 0, max: NOTE_NAMES.length - 1, options: NOTE_NAMES,
    read: () => indexIn(NOTE_NAMES, chordmode.key().root),
    apply: onIndex(() => indexIn(NOTE_NAMES, chordmode.key().root),
                   i => { chordmode.setKey({ root: NOTE_NAMES[i] ?? NOTE_NAMES[0] }); notify('chord_root'); }),
  },
  chord_mode: {
    label: 'Key Mode', min: 0, max: DEGREE_SCALES.length - 1, options: DEGREE_SCALES,
    read: () => indexIn(DEGREE_SCALES, chordmode.key().mode),
    apply: onIndex(() => indexIn(DEGREE_SCALES, chordmode.key().mode),
                   i => { chordmode.setKey({ mode: DEGREE_SCALES[i] ?? DEGREE_SCALES[0] }); notify('chord_mode'); }),
  },
  chord_octave: {
    label: 'Octave', min: 0, max: OCTAVES.length - 1, options: OCTAVES.map(String),
    read: () => indexIn(OCTAVES, chordmode.key().octave),
    apply: onIndex(() => indexIn(OCTAVES, chordmode.key().octave),
                   i => { chordmode.setKey({ octave: OCTAVES[i] ?? OCTAVES[0] }); notify('chord_octave'); }),
  },
  chord_follow: {
    label: 'Follow', min: 0, max: 1, toggle: true,
    read: () => (chordmode.key().follow ? 1 : 0),
    apply: onIndex(() => (chordmode.key().follow ? 1 : 0), i => {
      // Turning follow off keeps the key that was being followed, so the
      // sound does not jump — exactly as the button does.
      const eff = chordmode.effectiveKey();
      chordmode.setKey(i >= 1 ? { follow: true } : { follow: false, root: eff.root, mode: eff.mode });
      notify('chord_follow');
    }),
  },
  ...envControls('chord_', '', () => engine.CHORD_ENV_RANGE, () => engine.getChordEnv(), p => engine.setChordEnv(p)),
  shepard_chord: {
    label: 'Shepard', min: 0, max: 1, toggle: true,
    read: () => (engine.getShepard().chord ? 1 : 0),
    apply: onIndex(() => (engine.getShepard().chord ? 1 : 0), i => { engine.setShepard({ chord: i >= 1 }); notify('shepard_chord'); }),
  },
  // ── Gesture Mode: what names a chord and what sounds it ──
  chord_voicing: {
    label: 'Play', min: 0, max: VOICINGS.length - 1, options: VOICINGS,
    read: () => indexIn(VOICINGS, chordmode.getVoicing()),
    apply: onIndex(() => indexIn(VOICINGS, chordmode.getVoicing()),
                   i => { chordmode.setVoicing(VOICINGS[i] ?? VOICINGS[0]); notify('chord_voicing'); }),
  },
  chord_expr_mode: {
    label: 'Play With', min: 0, max: EXPRESSION_MODES.length - 1, options: EXPRESSION_MODES,
    read: () => indexIn(EXPRESSION_MODES, chordmode.expression().mode),
    apply: onIndex(() => indexIn(EXPRESSION_MODES, chordmode.expression().mode),
                   i => { chordmode.setExpression({ mode: EXPRESSION_MODES[i] ?? EXPRESSION_MODES[0] }); notify('chord_expr_mode'); }),
  },
  chord_expr_hand: {
    label: 'Playing Hand', min: 0, max: HANDS.length - 1, options: HANDS,
    read: () => indexIn(HANDS, chordmode.expression().hand),
    apply: onIndex(() => indexIn(HANDS, chordmode.expression().hand),
                   i => { chordmode.setExpression({ hand: HANDS[i] ?? 'L' }); notify('chord_expr_hand'); }),
  },
  chord_expr_control: {
    label: 'Read As', min: 0, max: EXPRESSION_CONTROLS.length - 1, options: EXPRESSION_CONTROLS,
    read: () => indexIn(EXPRESSION_CONTROLS, chordmode.expression().control),
    apply: onIndex(() => indexIn(EXPRESSION_CONTROLS, chordmode.expression().control),
                   i => { chordmode.setExpression({ control: EXPRESSION_CONTROLS[i] ?? EXPRESSION_CONTROLS[0] }); notify('chord_expr_control'); }),
  },
  chord_expr_lo: {
    label: 'Off At', min: 0, max: 1, slider: true,
    read: () => chordmode.expression().lo,
    apply: onNumber(() => chordmode.expression().lo, v => chordmode.setExpression({ lo: v }), 3),
  },
  chord_expr_hi: {
    label: 'Full At', min: 0, max: 1, slider: true,
    read: () => chordmode.expression().hi,
    apply: onNumber(() => chordmode.expression().hi, v => chordmode.setExpression({ hi: v }), 3),
  },
  chord_name_hand: {
    label: 'Named By', min: 0, max: NAMING.length - 1, options: NAMING,
    read: () => indexIn(NAMING, chordmode.namingHand()),
    apply: onIndex(() => indexIn(NAMING, chordmode.namingHand()),
                   i => { chordmode.setNamingHand(NAMING[i] ?? 'any'); notify('chord_name_hand'); }),
  },
  // ── Radial Mode: the ring and what plays it ──
  radial_joint: {
    label: 'Joint', min: 0, max: JOINT_IDS.length - 1, options: JOINT_IDS,
    read: () => { const c = radial.config(); return indexIn(JOINT_IDS, `${c.joint}_${c.side}`); },
    apply: onIndex(() => { const c = radial.config(); return indexIn(JOINT_IDS, `${c.joint}_${c.side}`); },
                   i => { const [j, side] = (JOINT_IDS[i] ?? JOINT_IDS[0]).split('_'); radial.setJoint(j, side); notify('radial_joint'); }),
  },
  radial_voicing: {
    label: 'Play', min: 0, max: VOICINGS.length - 1, options: VOICINGS,
    read: () => indexIn(VOICINGS, radial.config().voicing),
    apply: onIndex(() => indexIn(VOICINGS, radial.config().voicing),
                   i => { radial.setVoicing(VOICINGS[i] ?? VOICINGS[0]); notify('radial_voicing'); }),
  },
  radial_finger: {
    label: 'Finger', min: 0, max: Object.keys(FINGERS).length - 1, options: Object.keys(FINGERS),
    read: () => indexIn(Object.keys(FINGERS), radial.config().finger),
    apply: onIndex(() => indexIn(Object.keys(FINGERS), radial.config().finger),
                   i => { radial.setFinger(Object.keys(FINGERS)[i] ?? 'index'); notify('radial_finger'); }),
  },
  radial_volume: {
    label: 'Volume Mode', min: 0, max: VOLUME_MODES.length - 1, options: VOLUME_MODES,
    read: () => indexIn(VOLUME_MODES, radial.volumeState().mode),
    apply: onIndex(() => indexIn(VOLUME_MODES, radial.volumeState().mode),
                   i => { radial.setVolume({ mode: VOLUME_MODES[i] ?? VOLUME_MODES[0] }); notify('radial_volume'); }),
  },
  radial_vol_lo: {
    label: 'Off At', min: 0, max: 1, slider: true,
    read: () => radial.volumeState().lo,
    apply: onNumber(() => radial.volumeState().lo, v => radial.setVolume({ lo: v }), 3),
  },
  radial_vol_hi: {
    label: 'Full At', min: 0, max: 1, slider: true,
    read: () => radial.volumeState().hi,
    apply: onNumber(() => radial.volumeState().hi, v => radial.setVolume({ hi: v }), 3),
  },
  // ── The metronome ──
  metro_sig: {
    label: 'Time', min: 0, max: SIGNATURES.length - 1, options: SIGNATURES,
    read: () => indexIn(SIGNATURES, metronome.config().sig),
    apply: onIndex(() => indexIn(SIGNATURES, metronome.config().sig),
                   i => { metronome.setSig(SIGNATURES[i] ?? SIGNATURES[0]); notify('metro_sig'); }),
  },
  metro_mute: {
    label: 'Mute Click', min: 0, max: 1, toggle: true,
    read: () => (metronome.config().muted ? 1 : 0),
    apply: onIndex(() => (metronome.config().muted ? 1 : 0), i => { metronome.setMuted(i >= 1); notify('metro_mute'); }),
  },
  // ── The loop pedal's transport: pulses press the buttons ──
  loop_pedal: { label: 'Pedal', min: 0, max: 1, trigger: true, read: () => 0, apply: onRise(() => { looper.pedal(); }) },
  loop_stop:  { label: 'Stop',  min: 0, max: 1, trigger: true, read: () => 0, apply: onRise(() => looper.stop()) },
  loop_undo:  { label: 'Undo',  min: 0, max: 1, trigger: true, read: () => 0, apply: onRise(() => looper.undo()) },
  loop_clear: { label: 'Clear', min: 0, max: 1, trigger: true, read: () => 0, apply: onRise(() => looper.clear()) },
  // ── Play along ──
  playalong_guide: {
    label: 'Guide', min: 0, max: 1, toggle: true,
    read: () => (playalong.guide ? 1 : 0),
    apply: onIndex(() => (playalong.guide ? 1 : 0), i => { playalong.setGuide(i >= 1); notify('playalong_guide'); }),
  },
  filter_type: {
    label: 'Filter Type', min: 0, max: FILTER_TYPES.length - 1, options: FILTER_TYPES,
    read: () => FILTER_TYPES.indexOf(engine.getFilterType()),
    apply: onIndex(() => FILTER_TYPES.indexOf(engine.getFilterType()), i => { engine.setFilterType(FILTER_TYPES[i] ?? FILTER_TYPES[0]); notify('filter_type'); }),
  },
  chord_filter_type: {
    label: 'Chord Filter Type', min: 0, max: FILTER_TYPES.length - 1, options: FILTER_TYPES,
    read: () => FILTER_TYPES.indexOf(engine.getChordFilterType()),
    apply: onIndex(() => FILTER_TYPES.indexOf(engine.getChordFilterType()), i => { engine.setChordFilterType(FILTER_TYPES[i] ?? FILTER_TYPES[0]); notify('chord_filter_type'); }),
  },
  quant_on: {
    label: 'Pitch Quantize', min: 0, max: 1, toggle: true,
    read: () => (engine.getTuning().enabled ? 1 : 0),
    apply: onIndex(() => (engine.getTuning().enabled ? 1 : 0), i => { engine.setTuning({ enabled: i >= 1 }); notify('quant_on'); }),
  },
  key_root: {
    label: 'Key Root', min: 0, max: NOTE_NAMES.length - 1, options: NOTE_NAMES,
    read: () => Math.max(0, NOTE_NAMES.indexOf(engine.getTuning().root)),
    apply: onIndex(() => Math.max(0, NOTE_NAMES.indexOf(engine.getTuning().root)), i => { engine.setTuning({ root: NOTE_NAMES[i] ?? NOTE_NAMES[0] }); notify('key_root'); }),
  },
  key_scale: {
    label: 'Key Scale', min: 0, max: SCALE_NAMES.length - 1, options: SCALE_NAMES,
    read: () => Math.max(0, SCALE_NAMES.indexOf(engine.getTuning().scale)),
    apply: onIndex(() => Math.max(0, SCALE_NAMES.indexOf(engine.getTuning().scale)), i => { engine.setTuning({ scale: SCALE_NAMES[i] ?? SCALE_NAMES[0] }); notify('key_scale'); }),
  },
  vq_on: {
    label: 'Volume Quantize', min: 0, max: 1, toggle: true,
    read: () => (engine.getVolStep().enabled ? 1 : 0),
    apply: onIndex(() => (engine.getVolStep().enabled ? 1 : 0), i => { engine.setVolStep({ enabled: i >= 1 }); notify('vq_on'); }),
  },
  vq_gate: {
    label: 'Gate', min: 0, max: 1, toggle: true,
    read: () => (engine.getVolStep().gate ? 1 : 0),
    apply: onIndex(() => (engine.getVolStep().gate ? 1 : 0), i => { engine.setVolStep({ gate: i >= 1 }); notify('vq_gate'); }),
  },
  metro_on: {
    label: 'Metronome', min: 0, max: 1, toggle: true,
    read: () => (metronome.on ? 1 : 0),
    apply: onIndex(() => (metronome.on ? 1 : 0), i => { metronome.setOn(i >= 1); notify('metro_on'); }),
  },
  metro_bpm: {
    label: 'Tempo', min: BPM_MIN, max: BPM_MAX, unit: 'bpm',
    read: () => metronome.config().bpm,
    apply: onNumber(() => metronome.config().bpm, v => { metronome.setBpm(v); notify('metro_bpm'); }),
  },
  arp_on: {
    label: 'Arp', min: 0, max: 1, toggle: true,
    read: () => (arpvoice.enabled ? 1 : 0),
    apply: onIndex(() => (arpvoice.enabled ? 1 : 0), i => { arpvoice.set({ enabled: i >= 1 }); notify('arp_on'); }),
  },
  arp_pattern: {
    label: 'Arp Pattern', min: 0, max: ARP_PATTERNS.length - 1, options: ARP_PATTERNS,
    read: () => Math.max(0, ARP_PATTERNS.indexOf(arpvoice.state().pattern)),
    apply: onIndex(() => Math.max(0, ARP_PATTERNS.indexOf(arpvoice.state().pattern)), i => { arpvoice.set({ pattern: ARP_PATTERNS[i] ?? ARP_PATTERNS[0] }); notify('arp_pattern'); }),
  },
};

// Gesture mode's degrees, release and accidentals: each an input a cable
// holds (src/chordcables.js). A handshape's cable is the assignment, read by
// chord mode's own detection; any other cable holds the slot while high.
const DEGREE_NAMES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
DEGREE_KEYS.forEach((key, i) => {
  CONTROLS[key] = { label: `Degree ${DEGREE_NAMES[i] ?? i + 1}`, min: 0, max: 1, trigger: true, read: () => 0,
                    apply: onHold(on => chordmode.setCableHeld(CABLE_ID(i), on)) };
});
CONTROLS[RELEASE_KEY] = { label: 'Release Shape', min: 0, max: 1, trigger: true, read: () => 0,
                          apply: onHold(on => chordmode.setCableHeld(CABLE_ID('release'), on)) };
CONTROLS[ACC_KEYS.sharp] = { label: 'Sharp', min: 0, max: 1, trigger: true, read: () => 0,
                             apply: onHold(on => chordmode.setCableHeld(CABLE_ID('sharp'), on)) };
CONTROLS[ACC_KEYS.flat]  = { label: 'Flat', min: 0, max: 1, trigger: true, read: () => 0,
                             apply: onHold(on => chordmode.setCableHeld(CABLE_ID('flat'), on)) };

export const CONTROL_KEYS = Object.keys(CONTROLS);
export const isControl = key => key in CONTROLS;

// A module that owns a control's state — the panel that holds the loop
// pedal's gesture, main.js with the camera's trackers — defines it here.
// Before start-up it joins the table registerControls() registers; after,
// it is registered on the spot.
export function defineControls(defs) {
  Object.assign(CONTROLS, defs);
  if (registered) engine.registerParams(defsOf(defs));
}

const defsOf = controls => {
  const defs = {};
  for (const [key, c] of Object.entries(controls)) {
    defs[key] = { label: c.label, min: c.min, max: c.max, val: c.read(), unit: c.unit,
                  control: true, options: c.options, toggle: c.toggle, integer: c.integer,
                  trigger: c.trigger, slider: c.slider, apply: c.apply };
  }
  return defs;
};

// One waveform choice per oscillator in the bank: registered with the bank
// and gone with it, like the slot's own parameters.
const oscTypeControls = () => {
  const out = {};
  for (let i = 1; i <= engine.getOscCount(); i++) {
    const key = `osc${i}_type`;
    out[key] = {
      label: `Osc${i} Wave`, min: 0, max: OSC_TYPES.length - 1, options: OSC_TYPES,
      read: () => indexIn(OSC_TYPES, engine.getOscType(i - 1)),
      apply: onIndex(() => indexIn(OSC_TYPES, engine.getOscType(i - 1)),
                     j => { engine.setOscType(i - 1, OSC_TYPES[j] ?? OSC_TYPES[0]); notify(key); }),
    };
  }
  return out;
};
function syncBank() {
  const want = oscTypeControls();
  const gone = Object.keys(CONTROLS).filter(k => /^osc\d+_type$/.test(k) && !(k in want));
  gone.forEach(k => delete CONTROLS[k]);
  engine.unregisterParams(gone);
  Object.assign(CONTROLS, want);
  engine.registerParams(defsOf(want));
}

// Register every control as an engine parameter. Once, at startup, before
// anything restores a saved patch: a snapshot carries these values under
// `params`, and restore() replays them through set() → apply.
let registered = false;
export function registerControls() {
  if (registered) return;
  registered = true;
  engine.registerParams(defsOf(CONTROLS));
  syncBank();
  engine.onOscCountChange(syncBank);
}

// Pull the live state back into the parameter values — after a panel's own
// buttons changed a setting, or a saved state was restored, so the value a
// cable editor or a slider reads is the one the instrument is actually in.
export function syncControls() {
  for (const [key, c] of Object.entries(CONTROLS)) {
    const p = engine.PARAMS[key];
    if (p && !c.trigger) p.val = c.read();
  }
}

// What a control's value means, for readouts: the option's name, ON/OFF, or
// the number.
export function controlLabel(key, v = engine.PARAMS[key]?.val) {
  const c = CONTROLS[key];
  if (!c) return String(v);
  if (c.trigger) return v >= 0.5 ? 'PRESSED' : '—';
  if (c.slider) return `${Number(v).toFixed(2)}${c.unit ? ' ' + c.unit : ''}`;
  if (c.options) return String(c.options[Math.round(v)] ?? c.options[0]).toUpperCase();
  if (c.toggle) return Math.round(v) >= 1 ? 'ON' : 'OFF';
  return `${Math.round(v)}${c.unit ? ' ' + c.unit : ''}`;
}
