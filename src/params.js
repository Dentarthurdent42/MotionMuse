// Output parameters grouped into meaningful categories — for the add-node
// menu, the PARAMETERS node and anything else that lists what a cable can
// drive. Shared, so a parameter is in the same place whichever way you go
// looking for it; DOM-free, so tests/unit/param-cats.test.js can pin the
// table to the engine without a browser: a param key missing from here
// silently vanishes from the add-node menu.
//
// A function, not a constant: the oscillator bank is resizable, so its keys
// are only knowable at call time. Everything below the bank is fixed.

import { engine } from './engine.js';
import { graph }  from './graph.js';

export const PARAM_CATS = () => [
  ['Oscillators', Array.from({ length: engine.getOscCount() }, (_, i) =>
    [`osc${i + 1}_freq`, `osc${i + 1}_detune`, `osc${i + 1}_volume`]).flat()],
  ['Filter',      ['filter_freq', 'filter_q', 'osc_volume']],
  ['Gesture Mode', ['chord_filter_freq', 'chord_filter_q', 'chord_volume',
                    'arp_rate', 'arp_gate', 'arp_sustain']],
  ['LFO',         ['lfo_rate', 'lfo_depth']],
  ['Output',      ['reverb_mix', 'volume', 'loop_volume']],
  // The function nodes' input sockets — as many as there are nodes, so this
  // row is as runtime-sized as the oscillators above.
  ['Graph Nodes', graph.inputKeys()],
];
