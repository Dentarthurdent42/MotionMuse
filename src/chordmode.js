// Chord mode — maps recognized gestures to sustained chords. While enabled,
// holding an assigned gesture plays its chord through the engine's chord
// voice bank; dropping the gesture releases it (hold-to-sound).
//
// Chords are addressed by *scale degree in a key* (I…vii), not by absolute
// root pitch. Changing the key transposes every assignment at once, every
// chord is guaranteed to be in the key, and one degree select replaces the
// old root/octave/quality trio — which is what makes a long gesture list
// (e.g. the ASL numbers) manageable.

import { engine }                     from './engine.js';
import { gesture }                    from './gesture.js';
import { diatonicChord, isDiatonic }  from './chords.js';
import { NOTE_NAMES }                 from './scale.js';
import { devmode }                    from './devmode.js';

export const DEFAULT_KEY = {
  root: 'C',
  mode: 'major (ionian)',
  octave: 4,
  follow: true,        // take root/mode from Pitch Quantize when it's diatonic
};

// gestureId → { degree 0..6, seventh }. Starter assignments walking a
// familiar progression so the mode makes sound out of the box.
const DEFAULT_ASSIGNMENTS = {
  fist:   { degree: 0, seventh: false },   // I
  palm:   { degree: 3, seventh: false },   // IV
  peace:  { degree: 4, seventh: true  },   // V7
  point:  { degree: 5, seventh: false },   // vi
  thumbs: { degree: 1, seventh: false },   // ii
  horns:  { degree: 2, seventh: true  },   // iii7
};

// Old-format assignments stored an absolute { root, octave, quality }. Map the
// root onto the nearest degree of the current key so an existing user's setup
// keeps playing something recognisable instead of silently resetting.
export function degreeFromRoot(root, keyRoot, mode, quality) {
  const scale = isDiatonic(mode) ? mode : DEFAULT_KEY.mode;
  const want = ((NOTE_NAMES.indexOf(root) - NOTE_NAMES.indexOf(keyRoot)) % 12 + 12) % 12;
  let best = 0, bestD = 99;
  for (let i = 0; i < 7; i++) {
    const d = Math.abs(diatonicChord(keyRoot, 4, scale, i).root - want);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { degree: best, seventh: /7/.test(quality ?? '') };
}

const normAssign = a => ({
  degree:  Math.min(6, Math.max(0, Math.round(Number(a?.degree) || 0))),
  seventh: !!a?.seventh,
});

export const chordmode = (() => {
  let enabled = false;
  let key = { ...DEFAULT_KEY };
  let assignments = { ...DEFAULT_ASSIGNMENTS };
  let playing = null;   // gestureId currently sounding

  // The key actually used to build chords. With `follow` on, Pitch Quantize
  // drives it so chords land in the same key the melody snaps to — but only
  // when that scale has seven notes; roman numerals are meaningless over a
  // pentatonic or whole-tone scale, so those fall back to the panel's own mode.
  const effectiveKey = () => {
    if (!key.follow) return { root: key.root, mode: key.mode, octave: key.octave };
    const t = engine.getTuning?.() ?? {};
    return {
      root:   t.enabled ? (t.root ?? key.root) : key.root,
      mode:   t.enabled && isDiatonic(t.scale) ? t.scale : key.mode,
      octave: key.octave,
    };
  };

  const chordFor = id => {
    const a = assignments[id];
    if (!a) return null;
    const k = effectiveKey();
    return diatonicChord(k.root, k.octave, k.mode, a.degree, a.seventh);
  };

  return {
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) { engine.releaseChord(); playing = null; }
    },

    key: () => ({ ...key }),
    effectiveKey,
    // True only when Pitch Quantize is actually overriding the panel's key —
    // with quantise off, FOLLOW is armed but inert, so the manual selects stay
    // live rather than being greyed out for no reason.
    isFollowing: () => !!key.follow && !!engine.getTuning?.().enabled,
    setKey(partial) {
      key = { ...key, ...partial };
      if (playing) this._sound(playing);      // live-transpose a held chord
    },

    assignments: () => ({ ...assignments }),
    chordFor,
    assign(gestureId, chord) {
      assignments[gestureId] = normAssign({ ...assignments[gestureId], ...chord });
      if (playing === gestureId) this._sound(gestureId);   // live-update a held chord
    },
    unassign(gestureId) {
      delete assignments[gestureId];
      if (playing === gestureId) { engine.releaseChord(); playing = null; }
    },

    // Human-readable "gesture → chord" for the live readout ('' when silent).
    currentLabel() {
      const c = playing && chordFor(playing);
      if (!c) return '';
      const g = gesture.list().find(x => x.id === playing);
      return `${g?.name ?? playing} → ${c.numeral} · ${c.rootName} ${c.quality}`;
    },

    _sound(id) {
      const c = chordFor(id);
      if (c) engine.playChord(c.freqs);
    },

    tick() {
      // Chord mode is an under-construction feature — only active in dev mode.
      if (!enabled || !engine.started || !devmode.enabled) {
        if (playing) { engine.releaseChord(); playing = null; }
        return;
      }
      // First currently-held gesture that has a chord assigned wins.
      const id = gesture.current().find(g => assignments[g]) ?? null;
      if (id === playing) return;
      if (id) this._sound(id);
      else engine.releaseChord();
      playing = id;
    },

    serialize() { return { enabled, key: { ...key }, assignments: { ...assignments } }; },

    load(data) {
      if (!data) return;
      key = { ...DEFAULT_KEY, ...(data.key ?? {}) };
      if (data.assignments) {
        // Merge over the defaults rather than replacing them, so gestures added
        // in a later version still arrive with a chord for existing users.
        const merged = { ...DEFAULT_ASSIGNMENTS };
        for (const [id, a] of Object.entries(data.assignments)) {
          merged[id] = a && a.degree === undefined && a.root !== undefined
            ? degreeFromRoot(a.root, key.root, key.mode, a.quality)   // pre-degree format
            : normAssign(a);
        }
        assignments = merged;
      }
      this.setEnabled(!!data.enabled);
    },
  };
})();
