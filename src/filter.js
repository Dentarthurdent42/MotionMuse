// One-Euro filter (Casiez et al., CHI 2012) — the standard low-latency jitter
// filter for pointing/tracking UIs. A low-pass whose cutoff adapts to speed:
// slow movements get heavy smoothing (kills jitter on a held pose), fast
// movements get light smoothing (no perceptible lag when playing).
//
// Pure and DOM-free so it's unit-testable; time is injected in seconds.

const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export function makeOneEuro({ minCutoff = 1.5, beta = 0.05, dCutoff = 1 } = {}) {
  let x = null;   // filtered value
  let dx = 0;     // filtered derivative
  let t = null;   // last timestamp (s)
  return {
    filter(v, tSec) {
      if (x === null || tSec <= t) { x = v; t = tSec; dx = 0; return v; }
      const dt = tSec - t;
      t = tSec;
      dx += alpha(dCutoff, dt) * ((v - x) / dt - dx);
      x  += alpha(minCutoff + beta * Math.abs(dx), dt) * (v - x);
      return x;
    },
    reset() { x = null; dx = 0; t = null; },
  };
}
