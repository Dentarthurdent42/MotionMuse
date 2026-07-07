// Temporal conditioning for CV landmarks.
//
// Raw MediaPipe output jitters frame-to-frame even when the subject is still,
// and occasionally hallucinates single-frame teleports or anatomically
// impossible joints. Each skeleton gets a three-stage conditioning pass:
//
//   1. acceleration gate — a joint can't teleport: each sample is checked
//      against the position predicted from its current velocity, and any
//      deviation beyond a plausible acceleration is clamped. Zero added
//      latency for humanly-possible motion, hard ceiling on impossible paths.
//   2. One Euro filter  — heavy smoothing at rest (kills jitter), cutoff
//      opens with speed so fast gestures stay low-lag (Casiez et al. 2012).
//   3. plausibility gates — pose joints below a visibility threshold hold
//      their last position instead of flailing, and bones whose length
//      suddenly departs from their running average reject the child joint.
//
// Everything is O(#landmarks) scalar math per frame (microseconds on CPU);
// the GPU-side detection models are untouched, so the compute budget of the
// pipeline is unchanged.

const AXES = ['x', 'y', 'z'];

class OneEuro1D {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff;
    this.beta      = beta;
    this.dCutoff   = dCutoff;
    this.prev      = null;
    this.dPrev     = 0;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(v, dt) {
    if (this.prev === null || dt <= 0) { this.prev = v; return v; }
    const aD = OneEuro1D.alpha(this.dCutoff, dt);
    this.dPrev = aD * ((v - this.prev) / dt) + (1 - aD) * this.dPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dPrev);
    const a = OneEuro1D.alpha(cutoff, dt);
    this.prev = a * v + (1 - a) * this.prev;
    return this.prev;
  }

  snap(v) { this.prev = v; this.dPrev = 0; }
}

export function makeSkeletonFilter({
  minCutoff = 1.0,  // Hz — jitter faster than this is smoothed away at rest
  beta      = 1.0,  // how quickly the cutoff opens with speed (responsiveness)
  dCutoff   = 3.0,  // Hz — how quickly the speed estimate itself reacts
  maxAccel  = 150,  // units/s² — deviations implying more are clamped
  bones     = [],   // [parentIdx, childIdx] pairs to length-check
  boneTol   = 0.5,  // reject child joint when length departs ±50% from average
  minVis    = 0.35, // visibility below this → joint holds its last position
  resetGap  = 0.5,  // s without detections → snap to the new positions
} = {}) {
  const joints  = new Map(); // idx → { e: OneEuro1D[3], out, prevOut }
  const lengths = new Map(); // 'p-c' → { ema, n }
  let lastT = null;

  return {
    // Filters the landmark array in place. tSec is a seconds timestamp.
    apply(lms, tSec) {
      if (!lms) return lms;
      let dt = lastT === null ? 0 : tSec - lastT;
      if (dt <= 0 || dt > resetGap) { joints.clear(); lengths.clear(); dt = 0; }
      lastT = tSec;

      const maxStep = 0.5 * maxAccel * dt * dt; // plausible deviation from prediction

      lms.forEach((pt, i) => {
        let j = joints.get(i);
        if (!j) {
          j = { e: AXES.map(() => new OneEuro1D(minCutoff, beta, dCutoff)), out: null, prevOut: null };
          joints.set(i, j);
        }
        j.prevOut = j.out;

        // Low-visibility joints (occluded / hallucinated) hold their last
        // plausible position instead of flailing.
        if (pt.visibility !== undefined && pt.visibility < minVis && j.out) {
          AXES.forEach(ax => { pt[ax] = j.out[ax]; });
          return;
        }

        AXES.forEach((ax, k) => {
          const e = j.e[k];
          let v = pt[ax] ?? 0;
          // Acceleration gate: clamp deviation from the velocity-predicted
          // position. Human motion passes untouched; teleports get clipped.
          if (e.prev !== null && dt > 0) {
            const pred = e.prev + e.dPrev * dt;
            const dev  = v - pred;
            if (Math.abs(dev) > maxStep) v = pred + Math.sign(dev) * maxStep;
          }
          pt[ax] = e.filter(v, dt);
        });
        j.out = { x: pt.x, y: pt.y, z: pt.z ?? 0 };
      });

      // Bone-length gate: a forearm can't double in length in one frame.
      // When it does, the child joint is a misdetection — hold its previous
      // position and re-anchor its filters there so the glitch can't propagate.
      bones.forEach(([p, c]) => {
        const pp = lms[p], pc = lms[c];
        if (!pp || !pc) return;
        const len = Math.hypot(pp.x - pc.x, pp.y - pc.y, (pp.z ?? 0) - (pc.z ?? 0));
        const key = `${p}-${c}`;
        const l = lengths.get(key);
        if (!l) { lengths.set(key, { ema: len, n: 1 }); return; }

        const jc = joints.get(c);
        if (l.n > 20 && Math.abs(len / l.ema - 1) > boneTol && jc?.prevOut) {
          AXES.forEach((ax, k) => {
            pc[ax] = jc.prevOut[ax];
            jc.e[k].snap(jc.prevOut[ax]);
          });
          jc.out = { ...jc.prevOut };
          // Adapt slowly even while rejecting, so a *sustained* legitimate
          // change (e.g. the arm foreshortening as it points at the camera)
          // releases the gate within ~1 s instead of freezing the joint.
          l.ema += (len - l.ema) * 0.02;
          return;
        }
        l.ema += (len - l.ema) * 0.05;
        l.n++;
      });
    },
  };
}
