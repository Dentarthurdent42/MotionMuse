import { bus }         from './bus.js';
import { engine }      from './engine.js';
import { stickyStep }  from './dynamics.js';

export const mapper = (() => {
  let mappings = [];
  let nextId = 0;

  const curves = {
    linear: t => t,
    quad:   t => t * t,
    cubic:  t => t * t * t,
    log:    t => Math.log(1 + t * 9) / Math.log(10),
    sqrt:   t => Math.sqrt(t),
    inv:    t => 1 - t,
    // Inverted *and* eased, for controls that fall to zero as the signal rises
    // (e.g. pinch → volume). Plain `inv` is linear, which leaves the quiet end
    // a knife edge; squaring the inverse widens it to ~20% of travel.
    invquad: t => (1 - t) * (1 - t),
  };

  // A patch can name oscillator params the current bank does not have: a preset
  // voiced for two oscillators loaded while one is running, or a file saved from
  // a bigger setup. Grow the bank to fit rather than dropping those cables — a
  // mapping whose parameter does not exist is a node the patchbay draws and
  // nothing drives. Never shrinks: a patch that happens to use fewer
  // oscillators is not a request to delete the rest.
  const oscSlotOf = key => +(/^osc(\d+)_/.exec(key ?? '')?.[1] ?? 0);
  const growBankFor = keys => {
    const want = keys.reduce((n, k) => Math.max(n, oscSlotOf(k)), 0);
    if (want > engine.getOscCount()) engine.setOscCount(want);
  };

  return {
    mappings,

    add(audioParam, signal = '', outMin = null, outMax = null, curve = 'linear',
        steps = 0, invert = false) {
      const p = engine.PARAMS[audioParam];
      const id = nextId++;
      mappings.push({
        id,
        audioParam: audioParam || Object.keys(engine.PARAMS)[0],
        signal,
        outMin: outMin ?? (p?.min ?? 0),
        outMax: outMax ?? (p?.max ?? 1),
        curve: curve || 'linear',
        // 0 = continuous. >=2 quantises the cable into N discrete levels.
        steps: Math.max(0, Math.min(32, Math.round(Number(steps)) || 0)),
        // Flip the direction of the connection: the input's high end drives the
        // output's low end. Independent of `curve`, so any response shape can
        // run either way round.
        invert: !!invert,
      });
      return id;
    },

    remove(id) {
      const i = mappings.findIndex(m => m.id === id);
      if (i >= 0) mappings.splice(i, 1);
    },

    // Plain-object mapping list for save/load (drops the volatile numeric id).
    serialize() {
      return mappings.map(({ audioParam, signal, outMin, outMax, curve, steps, invert }) =>
        ({ audioParam, signal, outMin, outMax, curve, steps, invert }));
    },

    load(arr) {
      mappings.length = 0;   // keep the exported array reference intact
      nextId = 0;
      growBankFor((arr || []).map(m => m?.audioParam));
      (arr || []).forEach(m =>
        this.add(m.audioParam, m.signal, m.outMin, m.outMax, m.curve, m.steps, m.invert));
    },

    tick() {
      mappings.forEach(m => {
        if (!m.signal) return;
        let t = curves[m.curve]?.(bus.norm(m.signal)) ?? bus.norm(m.signal);
        // Direction flip, after the curve so it reverses the *whole* response
        // rather than reshaping it: the curve decides how the control feels,
        // invert decides which way round it runs.
        if (m.invert) t = 1 - t;
        // Optional step quantisation, applied AFTER the curve so the levels are
        // evenly spaced in the *output* range (pair it with log/quad for
        // perceptual spacing). Sticky so a jittery signal doesn't chatter on a
        // boundary; _stepIdx is per-run state and never serialized.
        if (m.steps >= 2) {
          const n = m.steps;
          const prev = Number.isInteger(m._stepIdx) ? Math.min(n - 1, Math.max(0, m._stepIdx)) : null;
          const idx = Math.min(n - 1, Math.max(0, stickyStep(t * (n - 1), prev, 0.3)));
          m._stepIdx = idx;
          t = idx / (n - 1);
        }
        engine.set(m.audioParam, m.outMin + t * (m.outMax - m.outMin));
      });
    },

    // Replace the whole patch with a named preset (see PRESETS). Called with no
    // argument it loads the default hands patch, which is what PRESET did
    // before there were several.
    applyPreset(id = DEFAULT_PRESET) {
      const preset = PRESETS.find(p => p.id === id) ?? PRESETS[0];
      mappings.length = 0;
      nextId = 0;
      growBankFor(preset.mappings.map(a => a[0]));
      // [audioParam, signal, outMin, outMax, curve, steps, invert]
      preset.mappings.forEach(a => this.add(...a));
      return preset;
    },
  };
})();

// ── Preset library ─────────────────────────────────────────────────────────
//
// `needs` is what the user has to switch on for the preset to make sound, so
// the picker can say so up front instead of leaving them with a silent patch:
//   'camera' — the camera (hand/pose tracking)
//   'face'   — the ☺ FACE toggle
//   'gaze'   — the ◉ GAZE toggle (which also needs face landmarks)
export const PRESETS = [
  {
    id: 'hands', name: 'Hands', needs: ['camera'],
    hint: 'Left hand height = pitch, pinch = volume',
    mappings: [
      ['osc1_freq',   'hand_L_y',    80,    880, 'quad'],
      ['osc2_freq',   'hand_R_y',    80,   1320, 'quad'],
      ['filter_freq', 'hand_L_open', 300,  8000, 'quad'],
      ['osc2_volume', 'hand_R_open',   0,     1, 'linear'],
      ['lfo_depth',   'elbow_L',       0,     1, 'linear'],
      ['reverb_mix',  'hand_R_z',      0,   0.6, 'linear'],
      // pinch_R is 1 when the fingers are together, so volume has to fall as it
      // rises: open hand = loud, pinch = muted. `invquad` (not plain `inv`)
      // because the stepped silence rung otherwise occupies a mere ~4% of
      // finger travel — an unhittable knife edge; squaring widens it to ~20%.
      ['volume',      'pinch_R',       0,     1, 'invquad'],
    ],
  },
  {
    id: 'face-brow-mouth', name: 'Face · Brow & Mouth', needs: ['camera', 'face'],
    hint: 'Raise your eyebrows for pitch, open your mouth for volume',
    mappings: [
      ['osc1_freq', 'brow_raise', 160, 660, 'linear'],
      ['volume',    'mouth_open',   0,   1, 'linear'],
    ],
  },
  {
    id: 'face-expressive', name: 'Face · Expressive', needs: ['camera', 'face'],
    hint: 'Brows = pitch, mouth = volume, smile opens the filter',
    mappings: [
      ['osc1_freq',    'brow_raise',  160,  660, 'linear'],
      ['volume',       'mouth_open',    0,    1, 'linear'],
      ['filter_freq',  'smile',       400, 7000, 'quad'],
      ['osc2_detune',  'pucker',      -30,   30, 'linear'],
      ['reverb_mix',   'cheek_puff',    0,  0.7, 'linear'],
      // Tilting your head fades the second oscillator in against the first.
      ['osc2_volume',  'head_roll',     0,    1, 'linear'],
    ],
  },
  {
    id: 'gaze', name: 'Gaze · Look to Play', needs: ['camera', 'face', 'gaze'],
    hint: 'Look left/right for pitch, up/down for tone; mouth = volume',
    mappings: [
      ['osc1_freq',   'gaze_x',      160,  880, 'linear'],
      // Looking *up* should brighten, and gaze_y is +1 at the top already, so
      // no inversion here — but the filter follows a squared curve so the
      // bright end doesn't dominate the travel.
      ['filter_freq', 'gaze_y',      300, 6000, 'quad'],
      ['volume',      'mouth_open',    0,    1, 'linear'],
      ['reverb_mix',  'brow_raise',    0,  0.6, 'linear'],
    ],
  },
  {
    id: 'pose', name: 'Pose · Whole Body', needs: ['camera'],
    hint: 'Stand back — arm height and torso lean drive everything',
    mappings: [
      ['osc1_freq',   'arm_raise_R',  110,  880, 'quad'],
      ['filter_freq', 'arm_raise_L',  300, 7000, 'quad'],
      ['osc2_detune', 'torso_tilt',   -40,   40, 'linear'],
      ['lfo_rate',    'shoulder_width', 0.5,  8, 'linear'],
      ['volume',      'shoulder_y_R',   0,    1, 'linear'],
    ],
  },
];

export const DEFAULT_PRESET = 'hands';

// ── What a preset actually needs switched on ───────────────────────────────
//
// Derived from the preset's own signals rather than declared beside it. Each
// bus signal already knows its group ('hand l', 'pose', 'face', 'gaze', …), so
// the trackers a patch requires fall straight out of the cables it wires — and
// cannot drift from them the way a hand-maintained list would. Wire a face
// signal into a preset and the face model is required, because that is what
// the word "required" means here.
const GROUP_TRACKERS = {
  'hand l': ['handsL'],
  'hand r': ['handsR'],
  // A gesture is matched on whichever hand is up; the patch does not say which,
  // so it asks for both rather than silently picking one.
  gesture:  ['handsL', 'handsR'],
  pose:     ['pose'],
  depth:    ['pose'],       // hand_*_z is derived from the pose/depth pipeline
  face:     ['face'],
  gaze:     ['gaze'],
};

// { handsL, handsR, pose, face, gaze } — every tracker, so this is a complete
// statement of the patch's needs and can be applied as-is. A tracker no cable
// touches is `false`: loading "Face · Brow & Mouth" should leave hands and pose
// OFF, not merely not-required, or the patch arrives with three models running
// for nothing.
export function trackersFor(preset) {
  const want = { handsL: false, handsR: false, pose: false, face: false, gaze: false };
  for (const [, signal] of preset?.mappings ?? []) {
    const g = bus.signals.get(signal)?.group;
    for (const t of GROUP_TRACKERS[g] ?? []) want[t] = true;
  }
  return want;
}
