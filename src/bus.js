// Central registry for all biosignal sources.
// To add a new source: call bus.register() for each signal in your
// source's init(), then call bus.update(key, value) each sample.
export const bus = (() => {
  const signals = new Map(); // key → { value, min, max, label, group, source }

  return {
    signals,

    register(key, meta) {
      signals.set(key, { value: meta.min ?? 0, min: 0, max: 1, ...meta });
    },

    update(key, value) {
      const s = signals.get(key);
      if (!s) return;
      s.value = isNaN(value) ? s.min : Math.max(s.min, Math.min(s.max, value));
    },

    norm(key) {
      const s = signals.get(key);
      if (!s || s.max === s.min) return 0;
      return (s.value - s.min) / (s.max - s.min);
    },

    decay(key, factor = 0.88) {
      const s = signals.get(key);
      if (s) s.value *= factor;
    },
  };
})();
