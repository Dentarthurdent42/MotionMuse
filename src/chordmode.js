// Chord mode — maps recognized gestures to sustained chords. While enabled,
// holding an assigned gesture plays its chord through the engine's chord
// voice bank; dropping the gesture releases it (hold-to-sound).

import { engine }              from './engine.js';
import { gesture }             from './gesture.js';
import { chordFreqs, chordName } from './chords.js';

export const chordmode = (() => {
  let enabled = false;
  // gestureId → { root, octave, quality }. Sensible starter assignments for
  // the built-ins so the mode makes sound out of the box.
  let assignments = {
    fist:   { root: 'C', octave: 4, quality: 'major' },
    palm:   { root: 'F', octave: 4, quality: 'major' },
    peace:  { root: 'G', octave: 4, quality: 'dom7'  },
    point:  { root: 'A', octave: 3, quality: 'minor' },
    thumbs: { root: 'D', octave: 4, quality: 'minor' },
    horns:  { root: 'E', octave: 4, quality: 'min7'  },
  };
  let playing = null;   // gestureId currently sounding

  return {
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) { engine.releaseChord(); playing = null; }
    },

    assignments: () => ({ ...assignments }),
    assign(gestureId, chord) {
      assignments[gestureId] = { ...(assignments[gestureId] ?? { root: 'C', octave: 4, quality: 'major' }), ...chord };
      if (playing === gestureId) this._sound(gestureId);   // live-update a held chord
    },
    unassign(gestureId) {
      delete assignments[gestureId];
      if (playing === gestureId) { engine.releaseChord(); playing = null; }
    },

    // Human-readable "gesture → chord" for the live readout ('' when silent).
    currentLabel() {
      if (!playing || !assignments[playing]) return '';
      const a = assignments[playing];
      const g = gesture.list().find(x => x.id === playing);
      return `${g?.name ?? playing} → ${chordName(a.root, a.quality)}`;
    },

    _sound(id) {
      const a = assignments[id];
      engine.playChord(chordFreqs(a.root, a.octave, a.quality));
    },

    tick() {
      if (!enabled || !engine.started) return;
      // First currently-held gesture that has a chord assigned wins.
      const id = gesture.current().find(g => assignments[g]) ?? null;
      if (id === playing) return;
      if (id) this._sound(id);
      else engine.releaseChord();
      playing = id;
    },

    serialize() { return { enabled, assignments: { ...assignments } }; },
    load(data) {
      if (!data) return;
      if (data.assignments) assignments = { ...data.assignments };
      this.setEnabled(!!data.enabled);
    },
  };
})();
