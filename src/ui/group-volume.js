// Group volume: every group on the canvas is a fader over the sound of what
// is inside it.
//
// The canvas knows groups and who is in them (workspace.js M.gainOf gives a
// node's product of enclosing faders); the engine knows sound sources and
// has a trim gain on each (engine.setSourceTrim). This module is the one
// place that knows which node IS which source, and keeps the trims in step
// with the faders and with membership as nodes are dragged in and out.
//
// A source is attributed to the node that owns its sound, not to the nodes
// that steer it: Gesture Mode and Radial Mode play the chord bank, but the
// chord bank's level is Chord Voice's, so it is Chord Voice's group that
// fades it. Processors (Filter, the reverb in Output) and nodes that only
// shape other sounds (Sound Kit) carry no source of their own.

import { engine } from '../engine.js';
import * as WS from './workspace.js';

export const SOURCE_OF = {
  'panel:oscillators': 'lead',
  'panel:chord-voice': 'chord',
  'panel:metronome':   'click',
  'panel:looper':      'loop',
  'panel:play-along':  'playalong',
};

export function syncGroupGains() {
  for (const [id, src] of Object.entries(SOURCE_OF)) engine.setSourceTrim(src, WS.gainOf(id));
}

export function initGroupVolume() {
  WS.setAudibleTest(id => id in SOURCE_OF);
  WS.onGroupGains(syncGroupGains);
  syncGroupGains();
}
