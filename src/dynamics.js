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
// Dead band before the gate re-opens, in **dB**. Step units are the wrong unit
// here: a step is 2.7 dB on a 12-rung ladder but the whole 30 dB range on a
// 2-rung one, so a "0.3 step" band that's imperceptible when fine becomes a
// 9 dB chasm when coarse — at 2 steps the gate refused to open until the
// signal passed 0.84 linear. Expressed in dB it means the same thing at every
// step count. Also capped by the ladder's own hysteresis so it can never
// exceed the general rung stickiness.
export const GATE_HYST_DB = 2;
export const FLOOR_OPTS = [-12, -18, -24, -30, -36, -48];

// Where the gate switches, as a position between silence (0) and the first
// audible rung (1). 0.5 — the midpoint — is what the ladder implies and stays
// the default, but "implied by the ladder" and "where a player wants the
// switch" are different questions: at 2 steps the midpoint is -15 dB, so a
// linear cable flips to silence at 18% of its travel when what you'd expect
// from an on/off control is halfway. Higher values move the switch later
// (0.8 ≈ half of full scale at 2 steps).
//
// Deliberately NOT a threshold on the whole ladder. Anything above rung 1
// wouldn't move the gate, it would delete rungs — at 12 steps a "silent below
// half volume" threshold would swallow eight of them while the slider notches
// went on advertising levels that could no longer be selected.
export const GATE_AT_OPTS = [0.25, 0.5, 0.65, 0.8];
export const GATE_AT_DEFAULT = 0.5;

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

export function makeDynamics({ steps = 6, floorDb = -30, gate = true, hysteresis = 0.3,
                               gateAt = GATE_AT_DEFAULT } = {}) {
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

  // Silence is the articulation anchor — the rung a player must be able to hit
  // to separate notes — so the gate is *asymmetric*: entering costs nothing,
  // leaving costs a dead band. Entering used to be penalised by the ordinary
  // rung stickiness, which demanded pos < 0.2 (0.5 boundary minus 0.3
  // hysteresis) and, through the default pinch mapping, ~81% pinch strength
  // held steady — so the bottom rung read as "quiet" rather than silent.
  //
  // The dead band is sized in dB (GATE_HYST_DB), not step units, so it stays
  // the same perceptual width whether the ladder has 2 rungs or 12.
  const gateHyst = Math.min(hyst, GATE_HYST_DB / stepDb);

  // Where the switch sits, and where it releases. `gateAt` is bounded well
  // below rung 1 so that the release point stays under full scale: at 2 steps
  // the top rung IS pos 1, and an open point at or above it means the gate can
  // never re-open — which is precisely the bug this control exists to tune
  // away from, so it must not be reachable through the control itself. The
  // second term is the hard guarantee, independent of the clamp above it.
  const gatePos  = clamp(num(gateAt, GATE_AT_DEFAULT), 0.05, 0.8);
  const gateOpen = Math.min(gatePos + gateHyst, (n - 1) - 0.02);

  // Linear gain at a continuous rung position — the raw ladder formula, not
  // `dbAt`, which pins the top rung to exactly 0 dB and so can't describe a
  // point between rungs. Lets the UI state the thresholds in the units the
  // player actually reads off a cable.
  const gainAtPos = p => p <= 0 ? 0 : 10 ** ((fl + Math.min(p, n - 1) * stepDb) / 20);

  const quantize = (v, prevIdx = null) => {
    const prev = Number.isFinite(prevIdx) ? clamp(Math.round(prevIdx), 0, n - 1) : null;
    const pos = posOf(v);
    let idx;
    if (g8 && prev === 0) {
      // Held silent: re-open only past the dead band, and never back into 0.
      idx = pos > gateOpen ? clamp(Math.max(1, Math.round(pos)), 0, n - 1) : 0;
    } else if (g8 && pos < gatePos) {
      // Falling into silence from any rung: immediate, no stickiness to fight.
      idx = 0;
    } else {
      idx = clamp(stickyStep(pos, prev, hyst), 0, n - 1);
      // Rung 0 belongs to the gate branch alone. Otherwise, with `gateAt` set
      // below the ordinary stickiness, the sticky path drops to silence *above*
      // the gate's own threshold — so the gate would close higher than it
      // opens, an inverted dead band that chatters instead of holding.
      if (g8 && idx === 0) idx = 1;
    }
    return { idx, gain: levels[idx] };
  };

  return { levels, steps: n, floorDb: fl, stepDb, gate: g8, hysteresis: hyst,
           gateAt: gatePos, gateGain: gainAtPos(gatePos), gateOpenGain: gainAtPos(gateOpen),
           dbAt, indexOf, quantize };
}
