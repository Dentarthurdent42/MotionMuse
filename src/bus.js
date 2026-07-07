// Central registry for all biosignal sources.
// To add a new source: call bus.register() for each signal in your
// source's init(), then call bus.update(key, value) each sample.
//
// Signals registered with `adapt: true` self-calibrate to the user: the bus
// tracks the observed min/max and norm() maps that observed range to 0–1
// (e.g. an elbow that only flexes 40°–170° still spans the full control
// range). Calibration engages once at least `adaptSpan` of range has been
// seen — before that, norm() falls back to the static min/max — and the
// bounds slowly relax toward the live value so a one-off glitch (or a
// previous user's range) fades out over roughly a minute.
export const bus = (() => {
  const signals = new Map(); // key → { value, min, max, label, group, source, … }

  const RELAX = 5e-4; // per-update bound decay (~60 s time constant at 30 fps)

  return {
    signals,

    register(key, meta) {
      signals.set(key, { value: meta.min ?? 0, min: 0, max: 1, lo: null, hi: null, ...meta });
    },

    update(key, value) {
      const s = signals.get(key);
      if (!s) return;
      s.value = isNaN(value) ? s.min : Math.max(s.min, Math.min(s.max, value));
      if (s.adapt) {
        if (s.lo === null) {
          s.lo = s.hi = s.value;
        } else {
          s.lo = Math.min(s.lo, s.value);
          s.hi = Math.max(s.hi, s.value);
          s.lo += (s.value - s.lo) * RELAX;
          s.hi -= (s.hi - s.value) * RELAX;
        }
      }
    },

    norm(key) {
      const s = signals.get(key);
      if (!s) return 0;
      if (s.adapt && s.lo !== null
          && s.hi - s.lo >= (s.adaptSpan ?? (s.max - s.min) * 0.15)) {
        return Math.min(1, Math.max(0, (s.value - s.lo) / (s.hi - s.lo)));
      }
      if (s.max === s.min) return 0;
      return (s.value - s.min) / (s.max - s.min);
    },

    decay(key, factor = 0.88) {
      const s = signals.get(key);
      if (s) s.value *= factor;
    },
  };
})();
