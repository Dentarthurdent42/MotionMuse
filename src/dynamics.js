// ── Volume articulation: a perceptual (dB) step ladder ───────────────────
//
// A continuous gesture → gain is unplayable. The hand never holds perfectly
// still and never lands on exactly zero, so loudness is always drifting and
// "quiet" is a persistent low-level tone rather than silence — notes can't be
// separated or re-attacked.
//
// Snapping the gain onto discrete equal-loudness rungs fixes that indirectly:
// once the value is quantised, changes become *rare events*, so the engine can
// fire ONE envelope per change and let it complete, instead of re-smoothing
// toward a moving target every frame. The stepping is the enabler; the
// completed envelope is what you actually hear as a crisp attack and a real
// gap. The bottom rung is exact silence, which is what makes a gap possible
// at all.
//
// Rungs are equally spaced in DECIBELS, not linear gain: hearing is
// logarithmic, so linear rungs would bunch every audible difference into the
// top of the range. Because all distances are measured on that dB ladder,
// `hysteresis` is a plain fraction of one step.
//
// Pure and DOM-free, like scale.js — unit-tested in tests/unit/dynamics.test.js.

// Attack / release / gate-close times in ms. `gateMs` is deliberately the
// slowest: a drop to true silence reads as a damped release rather than a
// chop. (The gate sits after the reverb send, so it cuts the tail too.)
export const EDGES = {
  pluck: { attackMs:  6, releaseMs:  40, gateMs:  70 },
  key:   { attackMs: 12, releaseMs:  90, gateMs: 160 },
  bow:   { attackMs: 40, releaseMs: 220, gateMs: 380 },
};
export const EDGE_KEYS  = Object.keys(EDGES);
export const STEP_OPTS  = [2, 3, 4, 5, 6, 8, 10, 12];
// How far up the first step (in step units) the silence rung reaches when the
// gate is on. See quantize() for why silence gets a bigger target than any
// other rung.
export const GATE_CAPTURE = 0.65;
export const FLOOR_OPTS = [-12, -18, -24, -30, -36, -48];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Round to the nearest integer, but only leave `prevIdx` once `x` is more than
// (0.5 + hyst) steps away. This is gesture.js's sticky-match rule (threshold +
// HYSTERESIS to *keep* the current match) expressed in index space, and it's
// what stops a jittery control from chattering across a boundary.
export function stickyStep(x, prevIdx = null, hyst = 0.3) {
  if (!Number.isFinite(x)) return Number.isFinite(prevIdx) ? prevIdx : 0;
  const i = Math.round(x);
  if (!Number.isFinite(prevIdx)) return i;
  return Math.abs(x - prevIdx) > 0.5 + Math.max(0, hyst) ? i : prevIdx;
}

// `floorDb` is the bottom of the ladder: the silence anchor when `gate` is on,
// or the quietest audible rung when it's off. `levels.length` always equals
// `steps`, and the top rung is always exactly 1.0 (0 dB).
// `?? fallback` on a finite check, not `|| fallback` — `steps: 0` and
// `floorDb: 0` are falsy but must still clamp into range, not silently
// become the default.
const num = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;

export function makeDynamics({ steps = 6, floorDb = -30, gate = true, hysteresis = 0.3 } = {}) {
  const n  = clamp(Math.round(num(steps, 6)), 2, 12);
  const fl = clamp(num(floorDb, -30), -72, -3);
  const stepDb = -fl / (n - 1);
  const g8 = !!gate;
  const hyst = Math.max(0, num(hysteresis, 0.3));

  // The top rung is pinned to exactly 0 dB / gain 1 rather than computed:
  // fl + (n-1)*stepDb accumulates float error (at 12 steps it lands on 4e-15,
  // giving 0.9999999999999996), and full scale needs to be exact.
  const dbAt = i => (clamp(i, 0, n - 1) === n - 1) ? 0 : fl + clamp(i, 0, n - 1) * stepDb;
  const levels = Array.from({ length: n }, (_, i) =>
    (g8 && i === 0) ? 0 : i === n - 1 ? 1 : 10 ** (dbAt(i) / 20));

  // Continuous rung position of a linear gain, in step units (0 … n-1).
  const posOf = v =>
    (clamp(Number.isFinite(v) && v > 0 ? 20 * Math.log10(v) : fl, fl, 0) - fl) / stepDb;

  const indexOf = v => clamp(Math.round(posOf(v)), 0, n - 1);

  // Silence is the articulation anchor — the rung a player must be able to
  // hit to separate notes — so when the gate is on, rung 0 gets a bigger
  // capture zone than any other rung, and an asymmetric one. Symmetric
  // rounding put the 0/1 boundary at pos 0.5 and the sticky hysteresis then
  // demanded pos < 0.2 to *enter* silence from rung 1 — through the default
  // pinch mapping that meant holding 81% pinch strength, which real hands
  // rarely reach. Now: enter silence anywhere below GATE_CAPTURE (from any
  // rung, immediately), leave it only above GATE_CAPTURE + hysteresis. The
  // 0.65…0.95 dead band means no chatter at the edge in either direction.
  const quantize = (v, prevIdx = null) => {
    const prev = Number.isFinite(prevIdx) ? clamp(Math.round(prevIdx), 0, n - 1) : null;
    const pos = posOf(v);
    let idx;
    if (g8 && prev === 0) {
      idx = pos > GATE_CAPTURE + hyst ? clamp(Math.max(1, Math.round(pos)), 0, n - 1) : 0;
    } else if (g8 && pos < GATE_CAPTURE) {
      idx = 0;
    } else {
      idx = clamp(stickyStep(pos, prev, hyst), 0, n - 1);
    }
    return { idx, gain: levels[idx] };
  };

  return { levels, steps: n, floorDb: fl, stepDb, gate: g8, hysteresis: hyst,
           dbAt, indexOf, quantize };
}
