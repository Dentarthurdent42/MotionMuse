export const push30 = (arr, v) => { arr.push(v); if (arr.length > 30) arr.shift(); };

export const dist3 = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

export const angleBetween = (a, b, c) => {
  // Angle at joint b using vectors ba and bc
  const ba = [a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)];
  const bc = [c.x - b.x, c.y - b.y, (c.z || 0) - (b.z || 0)];
  const dot = ba[0] * bc[0] + ba[1] * bc[1] + ba[2] * bc[2];
  const mag = Math.sqrt(ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2)
            * Math.sqrt(bc[0] ** 2 + bc[1] ** 2 + bc[2] ** 2);
  return mag < 1e-6 ? 0 : Math.acos(Math.min(1, Math.max(-1, dot / mag))) * (180 / Math.PI);
};

export const handOpenness = (lm) => {
  const handSize = dist3(lm[0], lm[9]);
  if (handSize < 1e-4) return 0;
  const tips = [4, 8, 12, 16, 20];
  const avg = tips.reduce((s, i) => s + dist3(lm[0], lm[i]), 0) / tips.length;
  return Math.min(1, avg / (handSize * 2.2));
};

// Pinch STRENGTH, 0..1 — 1 when the thumb and index tips are together, 0 when
// they're comfortably apart. Takes *world* landmarks (metres), so it's
// independent of how far the hand is from the camera.
//
// The window matters: landmarks sit at fingertip centres, so a firm pinch
// still measures ~3 cm apart rather than 0. Mapping raw distance straight to
// 0..1 (as this used to) both inverted the meaning — an open palm read as
// maximum "pinch" — and threw away the bottom third of the range, so a real
// pinch could never reach the ends of a mapping.
export const PINCH_CLOSED = 0.03;   // m between tips at a firm pinch
export const PINCH_OPEN   = 0.09;   // m between tips with the hand open
// Fraction of the window that saturates to full strength. The closed distance
// is a guess at fingertip-centre separation that varies by hand and camera;
// without the margin, a hand whose firm pinch measures 3.5–4 cm could never
// reach strength 1.0 — and full pinch is what has to hit the volume gate's
// silence rung, so "can't quite reach 1" audibly means "can't stop the note".
export const PINCH_SAT = 0.15;
export const pinchStrength = (thumbTip, indexTip,
                              closed = PINCH_CLOSED, open = PINCH_OPEN) => {
  const d = dist3(thumbTip, indexTip);
  if (!(open > closed)) return 0;
  const sat = closed + (open - closed) * PINCH_SAT;
  return Math.max(0, Math.min(1, (open - d) / (open - sat)));
};

export const TIPS = [4, 8, 12, 16, 20];   // thumb, index, middle, ring, pinky

// ── Finger extension, by joint angle ─────────────────────────────────────
//
// How straight a finger is, 0..1. Measured as the angle its joints make, not
// as the distance from base to tip, because distances FORESHORTEN: the same
// handshape held near the lens measures shorter fingers, since the palm is
// magnified while the fingertips angle away from it. That is not a small
// effect — the reference peace sign shot at arm's length measured 0.88 on the
// index where the same shape shot close up measured 0.58, a bigger gap than
// the one between genuinely different handshapes, which made a template
// measured at one distance useless at another.
//
// A bent joint is bent from any distance. On the same two photos the angle
// measure reads 345° and 344°.
//
// Two joints per finger, summed: the knuckle (MCP) is left out on purpose,
// because measuring it needs the wrist, which drags the palm's own geometry
// back into a number that should describe only the finger. For the thumb the
// two are its MCP and IP, which is where a thumb actually folds.
const CURL_CHAIN = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];

// The window: 160° from the tightest curl measured over the reference photos
// in tests/gesture-img, 360° from geometry — two perfectly straight joints.
//
// The ceiling is the geometric maximum on purpose rather than the ~350° a real
// straight finger measures. Ending the scale at what a hand actually reaches
// pins every extended finger to exactly 1, and a channel sitting on a rail
// carries no information: shapes that differ only in how straight a finger is
// become indistinguishable, and jitter can then only push the reading DOWN,
// which biases an open palm towards every less-open shape. Leaving the last
// few degrees unused keeps straight fingers at ~0.93 with room either side.
export const CURL_CURLED   = 160;
export const CURL_STRAIGHT = 360;

export const fingerExt = (lm, f) => {
  const c = CURL_CHAIN[f];
  if (!c || !lm?.[c[3]]) return 0;
  const sum = angleBetween(lm[c[0]], lm[c[1]], lm[c[2]])
            + angleBetween(lm[c[1]], lm[c[2]], lm[c[3]]);
  return Math.max(0, Math.min(1, (sum - CURL_CURLED) / (CURL_STRAIGHT - CURL_CURLED)));
};

// ── Shoulder geometry ────────────────────────────────────────────────────
//
// A shoulder is a ball joint: the upper arm can point anywhere on a hemisphere,
// which one number cannot describe. Reaching straight forward and lifting
// straight out to the side both raise the arm the same amount, and an elbow
// angle says nothing about either — it only reports how far the forearm is
// folded against the upper arm.
//
// So two angles, in a frame built from the torso itself rather than from the
// image, which is what keeps them meaningful when the player turns, leans, or
// steps closer to the camera:
//
//   elevation  angle between the upper arm and the torso's own downward axis.
//              0° arm hanging by the side, 90° horizontal, 180° straight up.
//   azimuth    where the arm points once elevation is taken out: 0° straight
//              out to that side, +90° reaching forward, -90° reaching behind,
//              ±180° folded across the chest.

const vsub = (a, b) => [a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vlen = a => Math.sqrt(vdot(a, a));
const vunit = a => { const l = vlen(a); return l < 1e-9 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]; };
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vmid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 });
// The part of `a` that is perpendicular to the unit vector `n`.
const vreject = (a, n) => { const k = vdot(a, n); return [a[0] - k * n[0], a[1] - k * n[1], a[2] - k * n[2]]; };

/**
 * Orthonormal frame of the trunk: down the spine, across the shoulders, and
 * out of the chest.
 *
 * `forward` comes from cross(down, across) with `across` running right
 * shoulder → left shoulder. In MediaPipe's axes (x right, y down, z away from
 * the camera) that lands on -z for someone facing the camera, i.e. out of the
 * chest rather than the back — and it stays chest-relative when they turn,
 * because every axis is built from their own landmarks.
 */
export function torsoFrame(lShoulder, rShoulder, lHip, rHip) {
  const down = vunit(vsub(vmid(lHip, rHip), vmid(lShoulder, rShoulder)));
  // Orthogonalized against `down` so a leaning torso does not skew the azimuth.
  const across = vunit(vreject(vunit(vsub(lShoulder, rShoulder)), down));
  return { down, across, forward: vunit(vcross(down, across)) };
}

/**
 * The two shoulder angles, in degrees.
 *
 * @param {'L'|'R'} side  which shoulder — the lateral axis flips with it, so
 *                        that 0° azimuth is "out to your own side" for both.
 */
export function shoulderAngles(side, shoulder, elbow, frame) {
  const arm = vsub(elbow, shoulder);
  if (vlen(arm) < 1e-9) return { elevation: 0, azimuth: 0 };
  const armU = vunit(arm);
  const elevation = Math.acos(Math.max(-1, Math.min(1, vdot(armU, frame.down)))) * (180 / Math.PI);
  const lateral = side === 'L' ? frame.across : frame.across.map(v => -v);
  const flat = vreject(armU, frame.down);
  if (vlen(flat) < 1e-6) return { elevation, azimuth: 0 };   // straight up or down
  const azimuth = Math.atan2(vdot(flat, frame.forward), vdot(flat, lateral)) * (180 / Math.PI);
  return { elevation, azimuth };
}

const unit = (d, lo, hi) => Math.max(0, Math.min(1, (hi - d) / (hi - lo)));

// ── Thumb geometry ────────────────────────────────────────────────────────
//
// `fingerExt`'s thumb channel is structurally useless for telling handshapes
// apart: measured across the reference photos it spans only 0.36–0.45, because
// the thumb's base-to-tip distance barely changes as the thumb moves. What
// actually changes is *where* the thumb goes — tucked across the palm, or
// carried clear of it. Measuring the tip against the centre of the palm
// (the middle-finger MCP) gives 0.23–0.25 tucked versus 0.91–0.99 clear:
// a real, bimodal signal, and the one that separates ASL 2 from 3, or 4 from 5.
export const THUMB_IN  = 0.22;   // × palm length — thumb folded over the palm
export const THUMB_OUT = 1.00;   // × palm length — thumb carried clear
export const thumbOut = (lm, inRatio = THUMB_IN, outRatio = THUMB_OUT) => {
  const palm = dist3(lm[0], lm[9]);
  if (palm < 1e-4) return 0;
  return 1 - unit(dist3(lm[4], lm[9]) / palm, inRatio, outRatio);
};

// Thumb-tip ↔ fingertip contact, 0..1 (1 = pads touching). `f` is 1..4 for
// index…pinky. Palm-normalised, so it's independent of hand size and camera
// distance, and computed from image landmarks like every other feature —
// world landmarks are optional in the MediaPipe result and a missing channel
// here would read as a false contact.
//
// The window is deliberately tight. A merely *curled* finger parks its tip
// near the thumb (a fist measures 0.19–0.58 palm units with nothing actually
// touching), so a loose window would make "curled" and "touching"
// indistinguishable. Genuine pad-to-pad contact sits below ~0.2.
export const CONTACT_CLOSED = 0.18;
export const CONTACT_OPEN   = 0.45;
export const thumbContact = (lm, f, closed = CONTACT_CLOSED, open = CONTACT_OPEN) => {
  const palm = dist3(lm[0], lm[9]);
  if (palm < 1e-4 || !TIPS[f]) return 0;
  return unit(dist3(lm[4], lm[TIPS[f]]) / palm, closed, open);
};
