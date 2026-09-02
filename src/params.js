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

// [category, keys, owning node id]
export const PARAM_CATS = () => [
  ['Oscillators', Array.from({ length: engine.getOscCount() }, (_, i) =>
    [`osc${i + 1}_freq`, `osc${i + 1}_detune`, `osc${i + 1}_volume`]).flat(), 'panel:oscillators'],
  ['Filter',       ['filter_type', 'filter_freq', 'filter_q', 'osc_volume', 'lfo_rate', 'lfo_depth'], 'panel:filter'],
  ['Chord Filter', ['chord_filter_type', 'chord_filter_freq', 'chord_filter_q', 'chord_volume'], 'panel:chord-filter'],
  ['Gesture Mode', ['arp_on', 'arp_pattern', 'arp_rate', 'arp_gate', 'arp_sustain'], 'panel:gesture-mode'],
  ['Pitch Quantize',  ['quant_on', 'key_root', 'key_scale'], 'panel:pitch-quantize'],
  ['Volume Quantize', ['vq_on', 'vq_gate'], 'panel:volume-quantize'],
  ['Metronome',    ['metro_on', 'metro_bpm'], 'panel:metronome'],
  ['Output',       ['volume', 'reverb_mix', 'loop_volume'], 'panel:output'],
  // The function nodes' input sockets — as many as there are nodes.
  ['Graph Nodes',  graph.inputKeys(), null],
];

// The node that carries a parameter's input socket.
export function paramOwner(key) {
  const fn = /^fn_(\d+)_/.exec(key);
  if (fn) return `fn:${fn[1]}`;
  for (const [, keys, owner] of PARAM_CATS()) if (keys.includes(key)) return owner;
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
