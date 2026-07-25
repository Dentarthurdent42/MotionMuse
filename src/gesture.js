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

const BUILTINS = [
  { id: 'fist',   name: 'Fist',      f: [0, 0, 0, 0, 0, 0, 0] },
  { id: 'palm',   name: 'Open Palm', f: [1, 1, 1, 1, 1, 1, 0.6] },
  { id: 'peace',  name: 'Peace',     f: [0, 1, 1, 0, 0, 0.5, 0.4] },
  { id: 'point',  name: 'Point',     f: [0, 1, 0, 0, 0, 0.3, 0] },
  { id: 'thumbs', name: 'Thumbs Up', f: [1, 0, 0, 0, 0, 0.3, 0] },
  { id: 'horns',  name: 'Rock Horns',f: [0, 1, 0, 0, 1, 0.4, 0.3] },
].map(g => ({ ...g, builtin: true, hand: 'any' }));

export const MATCH_THRESHOLD = 0.55;   // max Euclidean distance to count as a match
const HYSTERESIS  = 0.12;              // extra slack to *keep* the current match
const HOLD_FRAMES = 3;                 // consecutive frames before a match engages

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
  // Per-hand recognition state.
  const state = {
    L: { candidate: null, frames: 0, active: null },
    R: { candidate: null, frames: 0, active: null },
  };
  let recording = null;          // { name, hand, frames: [], onDone }

  const all = () => [...BUILTINS, ...custom];

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
        const m = f ? matchGesture(f, all(), MATCH_THRESHOLD, st.active) : null;
        if (m && m.id === st.candidate) {
          if (++st.frames >= HOLD_FRAMES) st.active = m.id;
        } else {
          st.candidate = m?.id ?? null;
          st.frames = m ? 1 : 0;
          if (!m) st.active = null;
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
      const i = custom.findIndex(g => g.id === id);
      if (i >= 0) custom.splice(i, 1);
    },

    serialize() { return custom.map(({ id, name, f, hand }) => ({ id, name, f, hand })); },
    load(arr) {
      custom = (arr ?? []).map(g => ({ ...g, builtin: false, hand: g.hand ?? 'any' }));
      // Keep ids unique for future recordings.
      nextCustom = 1 + custom.reduce((mx, g) => {
        const n = /^custom(\d+)$/.exec(g.id)?.[1];
        return n ? Math.max(mx, +n) : mx;
      }, 0);
      this.registerSignals();
    },
  };
})();
