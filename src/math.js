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

export const fingerExt = (lm, f) => {
  const bases = [2, 5, 9, 13, 17];
  const norm  = dist3(lm[0], lm[9]);
  return norm < 1e-4 ? 0 : Math.min(1, dist3(lm[bases[f]], lm[TIPS[f]]) / (norm * 1.5));
};

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
