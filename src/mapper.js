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

  return {
    mappings,

    add(audioParam, signal = '', outMin = null, outMax = null, curve = 'linear', steps = 0) {
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
      });
      return id;
    },

    remove(id) {
      const i = mappings.findIndex(m => m.id === id);
      if (i >= 0) mappings.splice(i, 1);
    },

    // Plain-object mapping list for save/load (drops the volatile numeric id).
    serialize() {
      return mappings.map(({ audioParam, signal, outMin, outMax, curve, steps }) =>
        ({ audioParam, signal, outMin, outMax, curve, steps }));
    },

    load(arr) {
      mappings.length = 0;   // keep the exported array reference intact
      nextId = 0;
      (arr || []).forEach(m => this.add(m.audioParam, m.signal, m.outMin, m.outMax, m.curve, m.steps));
    },

    tick() {
      mappings.forEach(m => {
        if (!m.signal) return;
        let t = curves[m.curve]?.(bus.norm(m.signal)) ?? bus.norm(m.signal);
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

    applyPreset() {
      mappings.length = 0;
      nextId = 0;
      this.add('osc1_freq',   'hand_L_y',    80,    880, 'quad');
      this.add('osc2_freq',   'hand_R_y',    80,   1320, 'quad');
      this.add('filter_freq', 'hand_L_open', 300,  8000, 'quad');
      this.add('osc_mix',     'hand_R_open',   0,     1, 'linear');
      this.add('lfo_depth',   'elbow_L',       0,     1, 'linear');
      this.add('reverb_mix',  'hand_R_z',      0,   0.6, 'linear');
      // pinch_R is 1 when the fingers are together, so volume has to fall as
      // it rises: open hand = loud, pinch = muted. `invquad` (not plain `inv`)
      // because the stepped silence rung otherwise occupies a mere ~4% of
      // finger travel — an unhittable knife edge; squaring widens it to ~20%.
      this.add('volume',      'pinch_R',        0,     1, 'invquad');
    },
  };
})();
