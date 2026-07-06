import { bus }    from './bus.js';
import { engine } from './engine.js';

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
  };

  return {
    mappings,

    add(audioParam, signal = '', outMin = null, outMax = null, curve = 'linear') {
      const p = engine.PARAMS[audioParam];
      const id = nextId++;
      mappings.push({
        id,
        audioParam: audioParam || Object.keys(engine.PARAMS)[0],
        signal,
        outMin: outMin ?? (p?.min ?? 0),
        outMax: outMax ?? (p?.max ?? 1),
        curve: curve || 'linear',
      });
      return id;
    },

    remove(id) {
      const i = mappings.findIndex(m => m.id === id);
      if (i >= 0) mappings.splice(i, 1);
    },

    // Plain-object mapping list for save/load (drops the volatile numeric id).
    serialize() {
      return mappings.map(({ audioParam, signal, outMin, outMax, curve }) =>
        ({ audioParam, signal, outMin, outMax, curve }));
    },

    load(arr) {
      mappings.length = 0;   // keep the exported array reference intact
      nextId = 0;
      (arr || []).forEach(m => this.add(m.audioParam, m.signal, m.outMin, m.outMax, m.curve));
    },

    tick() {
      mappings.forEach(m => {
        if (!m.signal) return;
        const t = curves[m.curve]?.(bus.norm(m.signal)) ?? bus.norm(m.signal);
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
      this.add('volume',      'pinch_R',        0,   0.9, 'linear');
    },
  };
})();
