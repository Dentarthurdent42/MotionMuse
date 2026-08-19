// The gesture stage's model: where things are, how they move, what a fling
// or a force-pull does to them. Pure and DOM-free — ui/stage-ui.js owns the
// elements and calls these with plain numbers, so the physics is testable
// with node --test and the same step drives any number of cards.
//
// Coordinates are viewport px (the stage covers the fullscreen camera view).
// Items are plain objects: { id, kind: 'orb'|'card', x, y, vx, vy, scale,
// held, slot, anim } — this module mutates x/y/vx/vy/anim and reports what
// happened; it never creates or removes items itself.

export const STAGE = {
  DAMP: 0.98,          // velocity retained per 60fps frame (dt-normalized)
  CULL_PAD: 400,       // px beyond the viewport at which a flung card dies
  ORBIT_LERP: 10,      // orbs chase their slot at this rate (fraction/s)
  ORBIT_R: 180,        // orbit radius around the ring, px (scaled to viewport)
  FLY_MS: 320,         // force-pull flight time
  FLY_BOW: 0.12,       // arc height as a share of flight distance…
  FLY_BOW_MAX: 90,     // …capped, px
  STRETCH_MIN: 0.4,    // two-hand scale clamp
  STRETCH_MAX: 2.5,
  PICK_MIN: 160,       // a force-pull target must be at least this far, px
  PICK_CONE: 0.25,     // perp ≤ proj × this (≈14° half-angle)
  STOP_SPEED: 8,       // below this px/s a card just stops
};

// Fanned positions for n orbs around (cx, cy). The fan opens upward — the
// ring sits low-center, the orbs bloom above it like a hand of cards.
export function orbitSlots(cx, cy, r, n) {
  const out = [];
  if (n === 1) return [{ x: cx, y: cy - r }];
  const span = Math.min(Math.PI * 0.9, Math.PI * 0.28 * (n - 1));
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 - span / 2 + (span * i) / (n - 1);
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

// Force-pull flight: ease-in (it tears free slowly, then rips) with a sine
// arc so it flies rather than slides. p in 0..1; to is re-read every frame,
// so the flight chases a moving hand.
export function flightPos(from, to, p) {
  const e = p * p;
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const bow = Math.sin(Math.PI * p) * Math.min(STAGE.FLY_BOW_MAX, dist * STAGE.FLY_BOW);
  // Bow perpendicular to the path, biased upward so it reads as an arc.
  const nx = -dy / dist, ny = dx / dist;
  const sign = ny < 0 ? 1 : -1;
  return {
    x: from.x + dx * e + nx * bow * sign,
    y: from.y + dy * e + ny * bow * sign,
  };
}

export const stretchScale = (s0, d0, d) =>
  Math.min(STAGE.STRETCH_MAX, Math.max(STAGE.STRETCH_MIN, s0 * (d / (d0 || 1))));

// Which item a claw ray takes: inside the aim cone, far enough away that it
// reads as "across the room", nearest along the ray wins.
export function pickTarget(ray, items, { minDist = STAGE.PICK_MIN, cone = STAGE.PICK_CONE } = {}) {
  let best = null, bestProj = Infinity;
  for (const it of items) {
    const ex = it.x - ray.ox, ey = it.y - ray.oy;
    const proj = ex * ray.dx + ey * ray.dy;
    if (proj <= minDist) continue;
    const perp = Math.abs(ex * ray.dy - ey * ray.dx);
    if (perp > proj * cone) continue;
    if (proj < bestProj) { best = it; bestProj = proj; }
  }
  return best;
}

// One physics step. Mutates items; returns events:
//   {type:'culled', it}   — a flung card left the stage
//   {type:'arrived', it}  — a force-pulled card reached the hand
export function stepPhysics(items, dtMs, now, vw, vh) {
  const events = [];
  const damp = Math.pow(STAGE.DAMP, dtMs / (1000 / 60));
  for (const it of items) {
    if (it.anim) {                                  // force-pull flight
      const p = Math.min(1, (now - it.anim.t0) / STAGE.FLY_MS);
      const pos = flightPos(it.anim.from, it.anim.to, p);
      it.x = pos.x; it.y = pos.y;
      it.vx = it.vy = 0;
      if (p >= 1) { it.anim = null; events.push({ type: 'arrived', it }); }
      continue;
    }
    if (it.held) continue;                          // a hand owns it
    if (it.slot) {                                  // orbs chase their slot
      const k = Math.min(1, (dtMs / 1000) * STAGE.ORBIT_LERP);
      it.x += (it.slot.x - it.x) * k;
      it.y += (it.slot.y - it.y) * k;
      continue;
    }
    if (it.vx || it.vy) {                           // free flight after a fling
      it.x += it.vx * (dtMs / 1000);
      it.y += it.vy * (dtMs / 1000);
      it.vx *= damp; it.vy *= damp;
      if (Math.hypot(it.vx, it.vy) < STAGE.STOP_SPEED) it.vx = it.vy = 0;
      if (it.x < -STAGE.CULL_PAD || it.x > vw + STAGE.CULL_PAD
       || it.y < -STAGE.CULL_PAD || it.y > vh + STAGE.CULL_PAD) {
        events.push({ type: 'culled', it });
      }
    }
  }
  return events;
}
