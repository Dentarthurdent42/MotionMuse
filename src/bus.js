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
//
// Signals registered with `smooth: true` (or `smooth: {minCutoff, beta}`) are
// run through a One-Euro filter on every update — this is where camera
// jitter dies, before mappers or gesture matching ever see the value.
import { makeOneEuro } from './filter.js';

// ── Velocity ──────────────────────────────────────────────────────────────
//
// A signal says where something IS. Its velocity says how fast that is
// changing, and the two play completely differently: a displacement is a
// slider you hold, a velocity is a gesture you throw. An eyebrow held raised
// is a sustained value; the same eyebrow FLICKED is a transient — one landmark,
// and only one of the two was reachable before.
//
// A velocity is registered as an ordinary sibling signal (`<key>_vel`), not as
// a special case, so everything that already walks the bus picks it up for
// free: the patchbay's input pickers, the signals panel, saved patches.
const VEL_SUFFIX = '_vel';
export const velKeyOf = key => `${key}${VEL_SUFFIX}`;

// Full scale, in spans of the source signal per second. Hand openness covers
// its whole range in about a quarter-second when you mean it, so four spans a
// second is a brisk-but-reachable end of the scale — and `adapt` moves it to
// whatever the player actually does soon after.
const VEL_FULL = 4;

export const bus = (() => {
  const signals = new Map(); // key → { value, min, max, label, group, source, … }

  const RELAX = 5e-4; // per-update bound decay (~60 s time constant at 30 fps)

  // Named rather than returned as a literal so update() can recurse into
  // itself for the velocity twin without going through `this` — a detached
  // `const u = bus.update` would otherwise stop feeding velocities silently.
  const api = {
    signals,

    register(key, meta) {
      signals.set(key, { value: meta.min ?? 0, min: 0, max: 1, lo: null, hi: null, ...meta });
      if (!meta.velocity) return;
      // Angles included: the velocity of `elbow_L` is an angular velocity, and
      // it needs no separate machinery — degrees per second is spans per
      // second like anything else.
      const span = (meta.max ?? 1) - (meta.min ?? 0) || 1;
      signals.set(velKeyOf(key), {
        value: 0, lo: null, hi: null,
        // Signed: which WAY something is moving is half of what it tells you.
        min: -span * VEL_FULL, max: span * VEL_FULL,
        label: `${meta.label ?? key} Δ`,
        group: meta.group, source: meta.source,
        // How fast a particular person moves is not something a constant can
        // know, and the range differs more between players than the
        // displacement does. Adapt, with a low bar to engage.
        adapt: true, adaptSpan: span * VEL_FULL * 0.08,
        // Differencing amplifies whatever jitter survived the source's own
        // filter, so this gets its own — heavier, because a velocity that
        // flickers is unusable as a control even when it is accurate.
        smooth: { minCutoff: 1.2, beta: 0.25 },
        of: key,
      });
    },

    // Remove a signal (and its velocity twin) from the registry — for sources
    // whose signals are created and destroyed at runtime, like the patchbay's
    // function nodes. Anything still holding the key reads undefined, which
    // norm() treats as 0 — absent, not wedged.
    unregister(key) {
      signals.delete(key);
      signals.delete(velKeyOf(key));
    },

    update(key, value, tMs) {
      const s = signals.get(key);
      if (!s) return;
      let v = isNaN(value) ? s.min : Math.max(s.min, Math.min(s.max, value));
      if (s.smooth) {
        if (!s._filt) s._filt = makeOneEuro(s.smooth === true ? undefined : s.smooth);
        // Filter in unit span so one set of defaults suits 0–1 and 0–180°.
        const span = s.max - s.min || 1;
        const tSec = (tMs ?? performance.now()) / 1000;
        v = s.min + s._filt.filter((v - s.min) / span, tSec) * span;
      }
      const prev = s.value;
      s.value = v;
      // Feed the velocity twin, if this signal has one. Rate of change is
      // measured against the wall clock rather than per frame, so a dropped
      // frame reports a slower move rather than a bigger one.
      const twin = s.of ? null : signals.get(velKeyOf(key));
      if (twin) {
        const now = tMs ?? performance.now();
        if (s._vt !== undefined) {
          const dt = (now - s._vt) / 1000;
          // Guard the divide: two updates inside the same millisecond would
          // otherwise report an enormous velocity, which `adapt` would then
          // take as the new full scale and never let go of.
          if (dt >= 0.005) { api.update(velKeyOf(key), (v - prev) / dt, now); s._vt = now; }
        } else s._vt = now;
      }
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
      if (s) {
        s.value *= factor;
        s._filt?.reset();   // tracking lost — snap cleanly on re-acquire
        // A velocity decays to zero with what it measures, and forgets when it
        // last saw it: the gap while tracking was lost is not a slow movement,
        // and differencing across it would read as a violent one.
        const twin = signals.get(velKeyOf(key));
        if (twin) { twin.value *= factor; twin._filt?.reset(); s._vt = undefined; }
      }
    },
  };
  return api;
})();
