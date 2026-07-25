// Hand-gesture recognition. A gesture is a template over the 7 normalized
// hand features the CV source already publishes per hand: the five finger
// extensions, openness, and spread. Recognition is nearest-template matching
// with a distance threshold, a few frames of debounce, and hysteresis so a
// held pose doesn't flicker.
//
// Built-in gestures ship as ideal-value templates; the user records custom
// ones by holding a pose while ~10 frames of live features are averaged.
// Every gesture is also published as a bus signal (`gesture_<id>`, 0/1-ish),
// so gestures can drive ordinary mappings too, not just chord mode.

import { bus } from './bus.js';

export const FEATURES = ['thumb', 'index', 'middle', 'ring', 'pinky', 'open', 'spread'];

// Feature order: [thumb, index, middle, ring, pinky, openness, spread].
// Templates are calibrated to real MediaPipe HandLandmarker output (measured
// from reference gesture photos via fingerExt/handOpenness) — the raw values
// cluster in a compressed range, not clean 0/1, so idealized templates never
// matched. Users can still record their own for a personal fit.
const BUILTINS = [
  { id: 'fist',   name: 'Fist',      f: [0.35, 0.20, 0.20, 0.15, 0.15, 0.40, 0.20] },
  { id: 'palm',   name: 'Open Palm', f: [0.50, 0.90, 0.95, 0.90, 0.85, 0.90, 0.60] },
  { id: 'peace',  name: 'Peace',     f: [0.45, 0.90, 0.92, 0.46, 0.40, 0.70, 0.30] },
  { id: 'point',  name: 'Point',     f: [0.35, 0.76, 0.25, 0.16, 0.15, 0.50, 0.25] },
  { id: 'thumbs', name: 'Thumbs Up', f: [0.42, 0.24, 0.25, 0.24, 0.20, 0.36, 0.56] },
  { id: 'horns',  name: 'Rock Horns',f: [0.38, 0.80, 0.22, 0.16, 0.80, 0.55, 0.50] },
].map(g => ({ ...g, builtin: true, hand: 'any' }));

export const MATCH_THRESHOLD = 0.6;    // max Euclidean distance to count as a match
const HYSTERESIS  = 0.15;              // extra slack to *keep* the current match
const HOLD_FRAMES = 2;                 // frames of continuous match before engaging

// Pure nearest-template match — unit-tested.
// features: number[7]; templates: [{id, f}]; returns {id, dist} or null.
export function matchGesture(features, templates, threshold = MATCH_THRESHOLD, stickyId = null) {
  let best = null;
  for (const t of templates) {
    let d2 = 0;
    for (let i = 0; i < FEATURES.length; i++) {
      const dv = features[i] - t.f[i];
      d2 += dv * dv;
    }
    const dist = Math.sqrt(d2);
    if (!best || dist < best.dist) best = { id: t.id, dist };
  }
  if (!best) return null;
  const limit = best.id === stickyId ? threshold + HYSTERESIS : threshold;
  return best.dist <= limit ? best : null;
}

export const gesture = (() => {
  let custom = [];               // user-recorded templates
  let nextCustom = 1;
  const hiddenBuiltins = new Set();   // built-in ids the user removed
  // Per-hand recognition state.
  const state = {
    L: { candidate: null, frames: 0, active: null },
    R: { candidate: null, frames: 0, active: null },
  };
  let recording = null;          // { name, hand, frames: [], onDone }

  const all = () => [...BUILTINS.filter(g => !hiddenBuiltins.has(g.id)), ...custom];

  const featuresFor = side => {
    const v = k => bus.signals.get(k)?.value ?? 0;
    // A hand that isn't currently tracked decays toward 0 — treat a
    // near-zero openness+extension sum as "no hand" to avoid ghost fists.
    const f = [
      v(`finger_${side}_thumb`), v(`finger_${side}_index`), v(`finger_${side}_middle`),
      v(`finger_${side}_ring`), v(`finger_${side}_pinky`),
      v(`hand_${side}_open`), v(`hand_${side}_spread`),
    ];
    const present = bus.signals.get(`hand_${side}_x`)?.value > 0.001 ||
                    f.reduce((s, x) => s + x, 0) > 0.05;
    return present ? f : null;
  };

  return {
    list: all,
    listCustom: () => custom.slice(),

    registerSignals() {
      all().forEach(g => bus.register(`gesture_${g.id}`, {
        label: g.name, group: 'gesture', min: 0, max: 1, source: 'gesture',
      }));
    },

    // Called every RAF. Updates per-hand matches, debounce, bus signals,
    // and an in-progress recording.
    tick() {
      // Recording captures raw features, bypassing recognition.
      if (recording) {
        const f = featuresFor(recording.hand === 'any' ? 'R' : recording.hand)
               ?? featuresFor(recording.hand === 'any' ? 'L' : recording.hand);
        if (f) recording.frames.push(f);
        if (recording.frames.length >= 10) {
          const n = recording.frames.length;
          const avg = FEATURES.map((_, i) =>
            recording.frames.reduce((s, fr) => s + fr[i], 0) / n);
          const g = {
            id: `custom${nextCustom++}`,
            name: recording.name, f: avg.map(x => +x.toFixed(3)),
            builtin: false, hand: 'any',
          };
          custom.push(g);
          bus.register(`gesture_${g.id}`, { label: g.name, group: 'gesture', min: 0, max: 1, source: 'gesture' });
          const done = recording.onDone; recording = null;
          done?.(g);
        }
        return;   // don't recognize while recording
      }

      const matched = new Set();
      for (const side of ['L', 'R']) {
        const st = state[side];
        const f = featuresFor(side);
        // Match each frame (hysteresis in matchGesture biases toward the
        // currently-held gesture). Latch to the nearest under-threshold match
        // after a couple of frames of *any* match — don't require the same
        // nearest id every frame, or normal hand jitter (templates sit close
        // together) keeps resetting the candidate and nothing ever engages.
        const m = f ? matchGesture(f, all(), MATCH_THRESHOLD, st.active) : null;
        if (m) {
          st.frames = Math.min(st.frames + 1, 9);
          if (st.frames >= HOLD_FRAMES || st.active) st.active = m.id;
        } else {
          st.frames = 0;
          st.active = null;
        }
        if (st.active) matched.add(st.active);
      }

      all().forEach(g => {
        if (matched.has(g.id)) bus.update(`gesture_${g.id}`, 1);
        else bus.decay(`gesture_${g.id}`, 0.7);
      });
    },

    // Currently engaged gesture ids (order: L then R, deduped).
    current() {
      const ids = [];
      for (const side of ['L', 'R']) {
        const a = state[side].active;
        if (a && !ids.includes(a)) ids.push(a);
      }
      return ids;
    },

    // Begin recording; resolves via callback once ~10 frames are captured.
    // Caller is responsible for checking that the camera is running.
    record(name, onDone, hand = 'any') {
      recording = { name: name || `Gesture ${nextCustom}`, hand, frames: [], onDone };
    },
    get recordingActive() { return !!recording; },
    cancelRecord() { recording = null; },

    remove(id) {
      if (BUILTINS.some(g => g.id === id)) {
        hiddenBuiltins.add(id);          // built-ins are code — hide, don't delete
      } else {
        const i = custom.findIndex(g => g.id === id);
        if (i >= 0) custom.splice(i, 1);
      }
      bus.update(`gesture_${id}`, 0);     // clear any lingering match signal
    },

    // Restore all removed built-ins (custom gestures are untouched).
    restoreBuiltins() { hiddenBuiltins.clear(); },
    hiddenCount: () => hiddenBuiltins.size,

    serialize() {
      return { custom: custom.map(({ id, name, f, hand }) => ({ id, name, f, hand })),
               hidden: [...hiddenBuiltins] };
    },
    load(data) {
      // Back-compat: older presets stored just an array of custom gestures.
      const arr = Array.isArray(data) ? data : (data?.custom ?? []);
      custom = arr.map(g => ({ ...g, builtin: false, hand: g.hand ?? 'any' }));
      hiddenBuiltins.clear();
      (Array.isArray(data) ? [] : (data?.hidden ?? [])).forEach(id => hiddenBuiltins.add(id));
      // Keep ids unique for future recordings.
      nextCustom = 1 + custom.reduce((mx, g) => {
        const n = /^custom(\d+)$/.exec(g.id)?.[1];
        return n ? Math.max(mx, +n) : mx;
      }, 0);
      this.registerSignals();
    },
  };
})();
