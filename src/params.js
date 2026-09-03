// What a cable can drive, grouped by the node that owns it.
//
// Every INPUT socket on the canvas comes from this table: the audio engine's
// parameters (engine.PARAMS) and the controls (src/controls.js — switches and
// choices like the filter type, the key, the tempo), each under the panel
// node whose body holds the slider or button for it. So a parameter is in
// one place whichever way you go looking for it — on its node, in the add
// menu's search — and tests/unit/param-cats.test.js pins the table to the
// engine: a param missing from here has no socket and silently cannot be
// wired.
//
// A function, not a constant: the oscillator bank is resizable, and the
// function nodes' inputs come and go.

import { engine } from './engine.js';
import { graph }  from './graph.js';

// [category, keys, owning node id] — every key a node can carry. Some are
// registered by the module that owns their state (src/ui/looper-ui.js,
// main.js) rather than by src/controls.js; PARAM_CATS() lists only the keys
// the engine has right now, so a test page that loaded less sees less.
const ALL_CATS = () => [
  ['Camera',       ['camera_on', 'track_hands_l', 'track_hands_r', 'track_pose', 'track_face', 'track_gaze'], 'panel:camera'],
  ['Microphone',   ['mic_on'], 'panel:mic'],
  ['Output',       ['mute', 'volume', 'reverb_mix', 'loop_volume'], 'panel:output'],
  ['Oscillators', ['osc_count', 'shepard_lead', ...Array.from({ length: engine.getOscCount() }, (_, i) =>
    [`osc${i + 1}_type`, `osc${i + 1}_freq`, `osc${i + 1}_detune`, `osc${i + 1}_volume`]).flat()], 'panel:oscillators'],
  ['Filter',       ['filter_type', 'filter_freq', 'filter_q', 'osc_volume', 'lfo_rate', 'lfo_depth'], 'panel:filter'],
  ['Gesture Mode', ['chord_on', 'chord_voicing', 'chord_expr_mode', 'chord_expr_hand', 'chord_expr_control',
                    'chord_expr_lo', 'chord_expr_hi', 'chord_name_hand',
                    'chord_trig_0', 'chord_trig_1', 'chord_trig_2', 'chord_trig_3', 'chord_trig_4', 'chord_trig_5', 'chord_trig_6',
                    'chord_trig_release', 'chord_acc_sharp', 'chord_acc_flat'], 'panel:gesture-mode'],
  ['Radial Mode',  ['radial_on', 'radial_joint', 'radial_voicing', 'radial_finger', 'radial_volume',
                    'radial_vol_lo', 'radial_vol_hi'], 'panel:radial-mode'],
  ['Chord Voice',  ['chord_root', 'chord_mode', 'chord_octave', 'chord_follow',
                    'chord_attack', 'chord_decay', 'chord_sustain', 'chord_release',
                    'arp_on', 'arp_pattern', 'arp_rate', 'arp_gate', 'arp_sustain', 'shepard_chord'], 'panel:chord-voice'],
  ['Chord Filter', ['chord_filter_type', 'chord_filter_freq', 'chord_filter_q', 'chord_volume'], 'panel:chord-filter'],
  ['Metronome',    ['metro_on', 'metro_bpm', 'metro_sig', 'metro_mute'], 'panel:metronome'],
  ['Sound Kit',    ['kit'], 'panel:sound-kit'],
  ['Play Along',   ['playalong_play', 'playalong_guide'], 'panel:play-along'],
  ['Loop Pedal',   ['loop_pedal', 'loop_undo', 'loop_stop', 'loop_clear',
                    'loop_pedal_src', 'loop_pedal_on', 'loop_sensitivity'], 'panel:looper'],
  ['Pitch Quantize',  ['quant_on', 'key_root', 'key_scale', 'tuning_system'], 'panel:pitch-quantize'],
  ['Volume Quantize', ['vq_on', 'vq_steps', 'vq_floor', 'vq_edge', 'vq_gate', 'vq_gate_at',
                       'lead_env_on', 'lead_attack', 'lead_decay', 'lead_sustain', 'lead_release'], 'panel:volume-quantize'],
  // The function nodes' input sockets — as many as there are nodes.
  ['Graph Nodes',  graph.inputKeys(), null],
];
export const PARAM_CATS = () => ALL_CATS()
  .map(([cat, keys, owner]) => [cat, keys.filter(k => engine.PARAMS[k]), owner])
  .filter(([, keys]) => keys.length);

// The node that carries a parameter's input socket.
export function paramOwner(key) {
  const fn = /^fn_(\d+)_/.exec(key);
  if (fn) return `fn:${fn[1]}`;
  for (const [, keys, owner] of ALL_CATS()) if (keys.includes(key)) return owner;
  return null;
}

// The node that carries a signal's output socket, from the bus entry's
// `source`: the camera's trackers all live on the camera node.
const SOURCE_NODE = {
  cv: 'panel:camera', face: 'panel:camera', depth: 'panel:camera', gesture: 'panel:camera',
  mic: 'panel:mic', metronome: 'panel:metronome',
};
export function signalOwner(key, meta) {
  const fn = /^fn_(\d+)$/.exec(key);
  if (fn) return `fn:${fn[1]}`;
  return SOURCE_NODE[meta?.source] ?? 'panel:camera';
}
