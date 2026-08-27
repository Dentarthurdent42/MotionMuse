// Hand-cursor UI control — the "Jarvis" modality. An armed hand drives an
// on-screen cursor: pinch to press, release quickly for a tap, drag to move
// or scroll, and (later, on the stage) fling to throw. The other hand keeps
// playing the instrument.
//
// This module is a *consumer* of the tracking pipeline, a sibling of
// chordmode.js: cv.js feeds it raw landmarks every hand frame, and the main
// RAF loop calls tick(). It owns no DOM — visual feedback lives in
// ui/uicontrol-ui.js and the element-driving lives in ui/uidriver.js, both
// injected, so everything here is unit-testable with synthetic landmarks.
//
// Contention with the instrument is resolved by *claiming* a hand: while a
// side is armed (or briefly after a clap), cv.js routes it through its
// existing hand-absent branch — positional signals decay, pinch reads 1
// (fail-quiet), the gesture matcher releases, gesture mode sees nothing. One
// suppression point, and neither gesture.js nor chordmode.js knows this
// modality exists.
//
// Arming is a ritual, not a shape: CLAP (palms together, fingers up, from
// apart), then hold up the hand(s) to toggle inside a short selection
// window. A clap is unmistakably deliberate, works when both hands are busy,
// and cannot be a chord handshape. With only one hand tracked a clap is
// impossible, so a long raised-open dwell toggles that hand instead.
//
// The gesture gates reimplement the interaction design of the Barehands
// project (github.com/jaredrhod/barehands) from its documented behaviour and
// tuned threshold values — measurements, not code. Every shape gate is a
// ratio of the hand's own span (wrist→middle-MCP), so recognition holds at
// any distance from the camera. Travel and speed are the exception — they
// are inherently screen-relative — so they are written as fractions of the
// SCREEN (converted from thresholds fitted at a ~1920px window) and the
// measured camera-space values are multiplied by the reach gain before
// comparison, which keeps "still" meaning the same thing at every CURSOR
// REACH setting and every window size.

import { handOpenness, dist3 } from './math.js';
import { makeOneEuro }         from './filter.js';
import { lsGet, lsSet }        from './storage.js';

// ── Thresholds ───────────────────────────────────────────────────────────
// One table, exported for the tests. px→fraction conversions are /1920.
export const UIC = {
  // Pinch gate. r = thumbtip↔indextip ÷ span.
  PINCH_ENTER:         0.32,   // gap ceiling, frontal palm
  PINCH_ENTER_PROFILE: 0.38,   // rotated palm reads narrower
  PINCH_EXIT:          0.55,   // must read clearly open to release…
  PINCH_EXIT_FAST:     0.70,   // …and *more* clearly while moving fast
  SIG_DELTA:  0.18,            // index arch must contrast the back three by this
  SIG_BACK:   1.30,            // and the back three must be a wall (not a fist)
  PROFILE_ASPECT: 2.0,         // below this the palm is rotated: judge by thumb
  SIG_TREL:   0.95,            // thumb clear of the knuckle row (profile regime)
  EMA_KEEP:   0.70,            // signature confidence EMA retention
  EMA_TRUST:  0.55,            // trust the EMA above this (~3 clean frames)
  ASPECT_INSANE: 6,            // no real hand is this shape — drop everything
  PROBATION_MS:  400,          // a fresh pinch must keep its signature this long
  PROBATION_BAD: 4,            // consecutive signature-dead frames that revoke it

  // Speeds, in camera-width fractions per second (fitted px/s ÷ 1920).
  FAST_HAND:  0.42,            // 800 px/s — speed-aware release bar kicks in
  GHOST_BORN: 0.47,            // 900 — a pinch born this fast is motion blur
  GHOST_HEAL: 0.26,            // 500 — …and self-heals once the hand settles
  PROB_SKIP:  0.31,            // 600 — probation doesn't apply mid-swing

  // Release classification. A press that never travels is a TAP however long
  // it was held — the duration+stillness pair this replaced (300 ms / 26 px)
  // was fitted to a mouse-grade pointer and unreachable by a hand: a hand
  // drifts further than that just closing its fingers, so every deliberate
  // pinch classified as a drop and no click ever fired.
  TAP_SLOP:  0.05,             // travel (screen fractions) that makes it a drag
  FLING_MIN_GRIP: 120,         // a blur-phantom grip can't throw
  FLING_PEAK:   0.68,          // 1300 px/s peak over the last…
  PEAK_WIN:     220,           // …ms of history…
  FLING_FOLLOW: 0.4,           // …carried ≥40% into the release (follow-through)
  HIST: 10,                    // samples of cursor history kept per hand

  // Clap ("prayer law"): both hands fingers-up, open, converging from apart.
  // Fitted for THIS pipeline, not Barehands': hand inference alternates with
  // pose (~15–22Hz), so a natural clap's contact frame is often skipped and
  // the touching palms merge into one detection. The contact gate is
  // therefore looser than the original, and the trajectory fallback below
  // carries the cases the sampling rate physically cannot see.
  CLAP_WRIST: 0.14,            // wrist distance at contact (frame fraction)
  CLAP_MCP:   0.12,            // knuckle distance at contact
  CLAP_APART: 0.18,            // hands must have been this far apart…
  CLAP_APART_MS: 800,          // …this recently (a clap is a movement)
  CLAP_UP:   0.60,             // (wrist.y − mcp.y)/span — within ~53° of vertical
  CLAP_OPEN: 0.70,             // openness floor, and gap ratio floor
  CLAP_OPEN_GRACE: 400,        // open within this window still counts (~6 frames)
  CLAP_PINCH_BLOCK: 800,       // a hand that pinched this recently disqualifies
  CLAP_COOLDOWN: 1500,
  CLAP_VANISH_MS: 200,         // detections merged/lost at contact: a recent
  CLAP_TRAJ_D:  0.30,          // qualified sample this close, converging fast
  CLAP_TRAJ_MS: 120,           // enough to project contact this soon, fires
  CLAP_MISS_D:  0.22,          // converged this far with a qualifier failing
                               // = a near-miss worth coaching
  MISS_TOAST_MS: 3000,         // coaching rate limit

  // Selection window (after a clap): hold up the hand(s) to toggle.
  WINDOW_MS: 2750,
  DWELL_MS:  800,              // raised-open hold that flips a hand
  DWELL_DRAIN: 2,              // dwell drains at 2× when the hand drops
  RAISE_Y:    0.50,            // hand height (1 = top of frame) — mid-frame is
                               // enough; a hand raised high crops out of view
  RAISE_OPEN: 0.70,            // openness
  SINGLE_DWELL: 1200,          // one-hand fallback: long raised hold to toggle
  SINGLE_COOLDOWN: 2000,
  LONE_MS: 1500,               // only one hand seen this recently = alone
  DOUBLE_CLAP_MS: 1200,        // second clap inside this = cancel (stage: sweep)
  HOLD_AFTER_CLAP: 400,        // both hands claimed briefly so the landing
                               // drains through the decay path, not the synth

  // Cursor.
  MARGIN: 0.15,                // inner (1−2m) of the frame maps to the screen
  STALE_MS: 500,               // a hand unseen this long drops its grip

  // Claw / force-pull (stage only). Every shape term is a strict-enter /
  // loose-hold hysteresis pair, applied via clawGate's inClaw flag.
  CLAW_R_LO:   [0.80, 0.68],   // mouth open at least this…
  CLAW_R_HI:   [1.45, 1.80],   // …but still a mouth, not a splay
  CLAW_C8:     [0.60, 0.80],   // index folded (3D curl dot: straight ≈ +0.9)
  CLAW_C12:    [0.35, 0.60],   // middle ALWAYS folded — the tightest term
  CLAW_C16:    [0.55, 0.75],   // ring votes with the others
  CLAW_CMEAN:  [0.30, 0.55],
  CLAW_C20:    [0.10, -0.35],  // the pinky stays OUT (a fold means a fist)
  CLAW_ASPECT: [1.05, 0.85],   // not pointed straight at the lens
  CLAW_HOOK:   [1.50, 1.60],   // tips hooked back toward the wrist
  CLAW_ARM:    14,             // pose-streak frames to arm (~0.5s)
  CLAW_COACH:  20,             // streak at which a stale open earns coaching
  CLAW_STREAK_DN: 5,           // a bad frame costs 5 — decay, not reset
  CLAW_OPEN_MS: 900,           // the open-palm flash must be this recent:
                               // a claw is a movement, not a shape
  CLAW_LOST_MS: 300,           // shape lost this long releases the lock
  CLAW_SNAP_R:   0.34,         // plunge: mouth slammed absolutely shut…
  CLAW_SNAP_DROP: 0.22,        // …or collapsed this much within…
  CLAW_SNAP_WIN:  280,         // …this window (of a 400ms rolling buffer)
  CLAW_SNAP_SOFT: 0.48,
  CLAW_STRAIN_MS: 2000,        // the snap is honored only after the strain
  CLAW_RAMP_MS:   4000,        // visual strain ramp
};

const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ── Per-frame hand metrics ───────────────────────────────────────────────
// From raw image landmarks. All ratios of span, so they survive any camera
// distance. `up` is positive when the fingers point up (image y grows down).
export function handMetrics(lm) {
  const span = d2(lm[0], lm[9]) || 1e-6;
  const fR = (t, m) => d2(lm[0], lm[t]) / (d2(lm[0], lm[m]) || 1e-6);
  return {
    span,
    r:        d2(lm[4], lm[8]) / span,
    aspect:   span / (d2(lm[5], lm[17]) || 1e-6),
    tRel:     d2(lm[4], lm[13]) / span,
    f8:       fR(8, 5),
    backMean: (fR(12, 9) + fR(16, 13) + fR(20, 17)) / 3,
    up:       (lm[0].y - lm[9].y) / span,
    open:     handOpenness(lm),
  };
}

// The pinch *signature* — what separates a deliberate OK-sign pinch from a
// fist, a curl, or noise. Frontal: the index arch collapses while the back
// three fingers stay tall (the contrast is the signal). Rotated palm: the
// arches are foreshortened into garbage, so judge by the thumb standing
// clear of the knuckle row instead.
export function pinchSignature(m) {
  return (m.backMean - m.f8 > UIC.SIG_DELTA && m.backMean > UIC.SIG_BACK)
      || (m.aspect < UIC.PROFILE_ASPECT && m.tRel > UIC.SIG_TREL);
}

// ── Pinch state machine ──────────────────────────────────────────────────
export function makePinchState() {
  return {
    pinched: false,
    okEma: 0,        // signature confidence
    sigPrev: false,  // signature held last frame (2-frame instant path)
    openPrev: false, // read open last frame (fast-release confirmation)
    ghost: false,    // born too fast to trust — pinched but not gripping
    pressAt: 0,
    probBad: 0,      // consecutive signature-dead probation frames
    probKill: false, // probation revoked the grip — mute the tap
  };
}

// One step of the gate. Returns 'press' | 'release' | 'drop' | null.
// `holding` exempts a hand that is already gripping something from the
// signature test — a carried grip closes into a fist and that is fine.
export function pinchStep(st, m, now, hspd, holding = false) {
  if (m.aspect > UIC.ASPECT_INSANE) {          // hallucinated hand
    st.sigPrev = st.openPrev = false;
    if (st.pinched) { st.pinched = st.ghost = false; return 'drop'; }
    return null;
  }
  const sig = pinchSignature(m);
  st.okEma = UIC.EMA_KEEP * st.okEma + (1 - UIC.EMA_KEEP) * (sig ? 1 : 0);
  const okNow = sig && st.sigPrev;             // 2 consecutive frames (~fast path)
  st.sigPrev = sig;

  if (st.pinched) {
    // Probation: a fresh, slow, empty pinch must keep its signature or it was
    // never a pinch. Skipped mid-swing (blur kills the signature legitimately)
    // and while holding (see above).
    if (!holding && !st.ghost
        && now - st.pressAt < UIC.PROBATION_MS && hspd < UIC.PROB_SKIP) {
      st.probBad = sig ? 0 : st.probBad + 1;
      if (st.probBad >= UIC.PROBATION_BAD) {
        st.pinched = st.ghost = false;
        st.probKill = true;
        return 'drop';
      }
    }
    // Release: must read clearly open — and at speed, clearly open twice in a
    // row, because a fast-moving hand's gap measurement is the least
    // trustworthy thing on screen.
    const openRead = m.r >= (hspd > UIC.FAST_HAND ? UIC.PINCH_EXIT_FAST : UIC.PINCH_EXIT);
    const rel = openRead && (hspd <= UIC.FAST_HAND || st.openPrev);
    st.openPrev = openRead;
    if (rel) {
      const wasGhost = st.ghost;
      st.pinched = st.ghost = false;
      return wasGhost ? 'drop' : 'release';
    }
    // A ghost heals once the hand settles: the pinch was real, only its birth
    // was unreadable — grab now without demanding a re-pinch.
    if (st.ghost && hspd < UIC.GHOST_HEAL) {
      st.ghost = false;
      st.pressAt = now;
      st.probBad = 0;
      return 'press';
    }
    return null;
  }

  const ceil = m.aspect < UIC.PROFILE_ASPECT ? UIC.PINCH_ENTER_PROFILE : UIC.PINCH_ENTER;
  if (m.r < ceil && (okNow || st.okEma > UIC.EMA_TRUST || holding)) {
    st.pinched = true;
    st.pressAt = now;
    st.probBad = 0;
    st.probKill = false;
    st.openPrev = false;
    if (hspd > UIC.GHOST_BORN && !holding) {   // motion-blur phantom
      st.ghost = true;
      return null;
    }
    return 'press';
  }
  return null;
}

// ── Release classification ───────────────────────────────────────────────
// Peak speed over the last PEAK_WIN ms plus the final-segment velocity, from
// the cursor history ring. Fractions of frame width per second.
export function histVel(hist, now) {
  let peak = 0, lastS = 0, vx = 0, vy = 0;
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1], b = hist[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    const s = Math.hypot(b.x - a.x, b.y - a.y) / dt;
    if (now - b.t <= UIC.PEAK_WIN) peak = Math.max(peak, s);
    if (i === hist.length - 1) { lastS = s; vx = (b.x - a.x) / dt; vy = (b.y - a.y) / dt; }
  }
  return { peak, lastS, vx, vy };
}

// A grip that hit real speed *and carried it into the release* is a fling
// (follow-through is what separates a throw from a stop). Otherwise a grip
// that never left its starting point is a TAP — holding still is the whole
// signal, and how long you held is not the app's business. Anything that
// travelled and then stopped is just letting go.
//
// `trav`, `peak` and `lastS` arrive in SCREEN fractions (the caller applies
// the reach gain), so these numbers mean the same thing at every CURSOR
// REACH setting.
export function classifyRelease({ trav, gripMs, peak, lastS, probKill }) {
  if (probKill) return 'drop';
  if (gripMs >= UIC.FLING_MIN_GRIP && peak > UIC.FLING_PEAK
      && lastS > peak * UIC.FLING_FOLLOW) return 'fling';
  if (trav < UIC.TAP_SLOP) return 'tap';
  return 'drop';
}

// Camera travel → screen travel. The cursor maps the inner (1−2·margin) of
// the frame onto the whole screen, so a hand movement covers more screen
// than frame; every distance and speed threshold is written in screen terms
// and measured in camera terms, and this is the conversion between them.
export const speedScale = margin => 1 / Math.max(0.1, 1 - 2 * margin);

// ── Cursor mapping ───────────────────────────────────────────────────────
// Mirrored-normalized camera coords → viewport px. The inner (1−2·margin) of
// the frame maps to the full screen, so the corners are reachable without
// the hand leaving the picture. Input x is already mirrored (selfie space).
export function cursorMap(nx, ny, margin, vw, vh) {
  const span = 1 - 2 * margin;
  const cl = v => Math.min(1, Math.max(0, (v - margin) / span));
  return { x: cl(nx) * vw, y: cl(ny) * vh };
}

// ── Clap detector ────────────────────────────────────────────────────────
export function makeClapState() {
  return {
    hist: [],                    // {t, wristD, apart, q} while both hands seen
    lastOpenT: { L: 0, R: 0 },   // soft-open memory (grace window)
    lastBothT: 0,
    lastFire: 0,
  };
}

// One step. `h` per side: {present, wx, wy, mcpx, mcpy, up, open, r,
// pinched, lastPinchT}; positions in mirrored-normalized frame coords.
// Returns 'clap' | null.
export function clapStep(st, L, R, now, grabbed = false) {
  const soft = h => h.open > UIC.CLAP_OPEN && h.r > UIC.CLAP_OPEN;
  for (const [s, h] of [['L', L], ['R', R]]) {
    if (h.present && soft(h)) st.lastOpenT[s] = now;
  }
  st.hist = st.hist.filter(e => now - e.t < UIC.CLAP_APART_MS + 100);

  const cool = now - st.lastFire > UIC.CLAP_COOLDOWN;
  const noPinch = h => !h.pinched && now - h.lastPinchT > UIC.CLAP_PINCH_BLOCK;

  if (L.present && R.present) {
    st.lastBothT = now;
    const wristD = Math.hypot(L.wx - R.wx, L.wy - R.wy);
    const mcpD   = Math.hypot(L.mcpx - R.mcpx, L.mcpy - R.mcpy);
    const bothUp   = L.up > UIC.CLAP_UP && R.up > UIC.CLAP_UP;
    const bothOpen = ['L', 'R'].every(s => now - st.lastOpenT[s] < UIC.CLAP_OPEN_GRACE);
    const wasApart = st.hist.some(e => e.apart && now - e.t < UIC.CLAP_APART_MS);
    const qualified = bothUp && bothOpen && wasApart && cool
                   && !grabbed && noPinch(L) && noPinch(R);
    // Closing speed vs the previous both-present sample (fractions/s) — what
    // lets the trajectory fallback tell a clap from a drift-together.
    const prev = st.hist[st.hist.length - 1];
    const closing = prev && prev.wristD > wristD
      ? ((prev.wristD - wristD) / Math.max(1, now - prev.t)) * 1000
      : 0;
    st.hist.push({ t: now, wristD, apart: wristD > UIC.CLAP_APART,
                   q: qualified, closing });
    if (qualified && wristD < UIC.CLAP_WRIST && mcpD < UIC.CLAP_MCP) {
      st.lastFire = now;
      return 'clap';
    }
    return null;
  }

  // Trajectory fallback: at contact the palms merge into one detection (or
  // none), and at this sampling rate the contact frame itself is often never
  // seen at all. If a detection just vanished while the hands were qualified
  // and converging fast enough that contact was imminent, that WAS the clap.
  if ((!L.present || !R.present) && now - st.lastBothT < UIC.CLAP_VANISH_MS) {
    const q = st.hist[st.hist.length - 1];
    if (q?.q && now - q.t < UIC.CLAP_VANISH_MS
        && q.wristD < UIC.CLAP_TRAJ_D && q.closing > 0
        && (q.wristD / q.closing) * 1000 <= UIC.CLAP_TRAJ_MS) {
      st.lastFire = now;
      st.hist = [];
      return 'clap';
    }
  }
  return null;
}

// Why a converged-but-refused clap was refused — the coaching that Barehands
// puts in a debug overlay and a silent gate cannot give. Call it AFTER
// clapStep on the same frame (it reads the state clapStep just updated).
// Returns 'up' | 'open' | 'apart' | 'pinch' | null.
export function clapNearMiss(st, L, R, now) {
  if (!L.present || !R.present) return null;
  const wristD = Math.hypot(L.wx - R.wx, L.wy - R.wy);
  if (wristD > UIC.CLAP_MISS_D) return null;
  if (!(L.up > UIC.CLAP_UP && R.up > UIC.CLAP_UP)) return 'up';
  if (!['L', 'R'].every(s => now - st.lastOpenT[s] < UIC.CLAP_OPEN_GRACE)) return 'open';
  if (!st.hist.some(e => e.apart && now - e.t < UIC.CLAP_APART_MS)) return 'apart';
  if (L.pinched || R.pinched
      || now - L.lastPinchT <= UIC.CLAP_PINCH_BLOCK
      || now - R.lastPinchT <= UIC.CLAP_PINCH_BLOCK) return 'pinch';
  return null;
}

// ── Selection window ─────────────────────────────────────────────────────
export function raisedQualify(yUp, open) {
  return yUp > UIC.RAISE_Y && open > UIC.RAISE_OPEN;
}

// Which half of the raise a visible-but-unqualified hand is missing, for the
// window prompt's coaching line. 'raise' | 'open' | null (= qualifying).
export function raiseReason(yUp, open) {
  if (yUp <= UIC.RAISE_Y) return 'raise';
  if (open <= UIC.RAISE_OPEN) return 'open';
  return null;
}

export function makeSelectState(now) {
  return { until: now + UIC.WINDOW_MS, dwell: { L: 0, R: 0 }, toggled: { L: false, R: false } };
}

// Advance the window by dtMs. `raised` = {L,R} booleans. Returns the sides
// whose dwell completed this step (each toggles once per window).
export function selectStep(st, raised, now, dtMs) {
  if (now > st.until) return [];
  const out = [];
  for (const s of ['L', 'R']) {
    if (st.toggled[s]) continue;
    st.dwell[s] = raised[s]
      ? Math.min(UIC.DWELL_MS, st.dwell[s] + dtMs)
      : Math.max(0, st.dwell[s] - dtMs * UIC.DWELL_DRAIN);
    if (st.dwell[s] >= UIC.DWELL_MS) { st.toggled[s] = true; out.push(s); }
  }
  if (st.toggled.L && st.toggled.R) st.until = 0;   // both flipped — done
  return out;
}

// ── Claw / force-pull (stage) ────────────────────────────────────────────
// 3D finger curls and hooks — the shape terms the 2D metrics can't see.
export function clawMetrics(lm) {
  const v = (a, b) => {
    const d = [b.x - a.x, b.y - a.y, (b.z || 0) - (a.z || 0)];
    const n = Math.hypot(...d) || 1e-6;
    return [d[0] / n, d[1] / n, d[2] / n];
  };
  const dot  = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const curl = (m, p, d, t) => dot(v(lm[m], lm[p]), v(lm[d], lm[t]));
  const hook = (t, p) => dist3(lm[0], lm[t]) / (dist3(lm[0], lm[p]) || 1e-6);
  return {
    c8: curl(5, 6, 7, 8), c12: curl(9, 10, 11, 12),
    c16: curl(13, 14, 15, 16), c20: curl(17, 18, 19, 20),
    h8: hook(8, 6), h12: hook(12, 10), h16: hook(16, 14),
  };
}

// The ten-term shape gate. `inClaw` picks the loose half of every hysteresis
// pair, so a lock survives the wobble that would never have earned it.
export function clawGate(cm, m, inClaw) {
  const P = pair => pair[inClaw ? 1 : 0];
  const cMean = (cm.c8 + cm.c12 + cm.c16) / 3;
  return m.r > P(UIC.CLAW_R_LO) && m.r < P(UIC.CLAW_R_HI)
      && cm.c8  < P(UIC.CLAW_C8)  && cm.c12 < P(UIC.CLAW_C12)
      && cm.c16 < P(UIC.CLAW_C16) && cMean  < P(UIC.CLAW_CMEAN)
      && cm.c20 > P(UIC.CLAW_C20)
      && m.aspect > P(UIC.CLAW_ASPECT)
      && cm.h8 < P(UIC.CLAW_HOOK) && cm.h12 < P(UIC.CLAW_HOOK)
      && cm.h16 < P(UIC.CLAW_HOOK);
}

export function makeClawState() {
  return { pose: 0, on: false, lost: 0, coached: false, rh: [] };
}

// One step. Returns 'arm' | 'hold' | 'snap' | 'drop' | 'coach' | null.
// The 2-second strain law is NOT here: whether a lit target has strained
// long enough is scene knowledge, so the stage enforces it and answers a
// premature snap with its own "too soon".
export function clawStep(st, cm, m, now, { openRecent = false, holding = false } = {}) {
  st.rh.push({ t: now, r: m.r });
  while (st.rh.length && now - st.rh[0].t > 400) st.rh.shift();
  const claw = clawGate(cm, m, st.on);

  if (!st.on) {
    st.pose = claw ? st.pose + 1 : Math.max(0, st.pose - UIC.CLAW_STREAK_DN);
    if (st.pose >= UIC.CLAW_ARM && openRecent && !holding) {
      st.on = true;
      st.lost = 0;
      st.coached = false;
      return 'arm';
    }
    // Held the shape long enough with a stale open: coach once, don't arm —
    // the flash-open-first rule is what keeps a resting claw from grabbing.
    if (st.pose >= UIC.CLAW_COACH && !st.coached && !holding) {
      st.coached = true;
      return 'coach';
    }
    return null;
  }

  // The plunge: mouth slammed absolutely shut, or collapsed fast from its
  // recent peak. Either reads as SNAP even when blur ate the exact frame.
  let rPeak = 0;
  for (const e of st.rh) if (now - e.t <= UIC.CLAW_SNAP_WIN) rPeak = Math.max(rPeak, e.r);
  if (m.r < UIC.CLAW_SNAP_R
      || (m.r < UIC.CLAW_SNAP_SOFT && rPeak - m.r > UIC.CLAW_SNAP_DROP)) {
    st.on = false;
    st.pose = 0;
    return 'snap';
  }
  if (!claw) {
    if (!st.lost) st.lost = now;
    if (now - st.lost > UIC.CLAW_LOST_MS) {
      st.on = false;
      st.pose = 0;
      st.lost = 0;
      return 'drop';
    }
  } else {
    st.lost = 0;
  }
  return 'hold';
}

// The aim ray, in mirrored-normalized frame coords: perpendicular to the
// thumbtip↔indextip line — the claw mouth's normal — signed away from the
// palm center, so it points where the mouth faces.
export function clawRay(lm) {
  const tx = 1 - lm[4].x, ty = lm[4].y;
  const ix = 1 - lm[8].x, iy = lm[8].y;
  const ox = (tx + ix) / 2, oy = (ty + iy) / 2;
  const px = 1 - (lm[5].x + lm[17].x) / 2, py = (lm[5].y + lm[17].y) / 2;
  let dx = -(iy - ty), dy = ix - tx;
  const n = Math.hypot(dx, dy) || 1e-6;
  dx /= n; dy /= n;
  if (dx * (ox - px) + dy * (oy - py) < 0) { dx = -dx; dy = -dy; }
  return { ox, oy, dx, dy };
}

// ── The singleton ────────────────────────────────────────────────────────
const LS_KEY = 'motionmuse-uicontrol';
const EURO = { minCutoff: 1.0, beta: 0.4 };   // pointing wants steadier than pinch

const mkHand = () => ({
  present: false, lastT: 0,
  x: 0.5, y: 0.5,                       // filtered cursor, mirrored-normalized
  fx: makeOneEuro(EURO), fy: makeOneEuro(EURO),
  hist: [],
  m: null,                              // last handMetrics
  lm: null,                             // last raw landmarks (claw needs 3D)
  wx: 0, wy: 0, mcpx: 0, mcpy: 0, yUp: 0,
  pinch: makePinchState(),
  claw: makeClawState(),
  lastPinchT: 0, lastOpenT: 0,
  pressX: 0, pressY: 0, pressT: 0, trav: 0,
});

export const uicontrol = (() => {
  let cfg = { enabled: false, margin: UIC.MARGIN };
  try { cfg = { ...cfg, ...JSON.parse(lsGet(LS_KEY) || '{}') }; } catch { /* defaults */ }
  const persist = () => lsSet(LS_KEY, JSON.stringify(cfg));

  const hands = { L: mkHand(), R: mkHand() };
  const armed = { L: false, R: false };
  const clap  = makeClapState();
  let stageActive = false;   // the fullscreen stage claims both hands
  let sel = null;            // active selection window, or null
  let lastClapT = 0;
  let lastMissT = 0;         // near-miss coaching rate limit
  let lastUnarmedT = 0;      // "you pinched an unarmed hand" rate limit
  let holdBothUntil = 0;     // post-clap claim of both hands
  let singleDwell = 0;       // one-hand fallback arming accumulator
  let singleCoolUntil = 0;
  let lastTickT = 0;
  let driver = null;         // ui/uidriver.js — press/move/release/isHolding
  let onSweep = null;        // Phase 2: stage sweep hook
  let singleSide = () => null;   // injected: 'L'/'R' when only one tracker is on
  const watchers = [];

  const emit = ev => watchers.forEach(fn => { try { fn(ev); } catch { /* not fatal */ } });

  // The hand to arm when there is only one to choose from: whichever side is
  // actually in frame on its own, or the one side the trackers are set to.
  const seen = (s, now) =>
    hands[s].present && now - hands[s].lastT < UIC.LONE_MS;
  const loneHand = now => {
    const hinted = singleSide();
    if (hinted) return hinted;
    const L = seen('L', now), R = seen('R', now);
    return L !== R ? (L ? 'L' : 'R') : null;
  };

  const setArmed = (s, on) => {
    if (armed[s] === on) return;
    armed[s] = on;
    if (!on) dropGrip(s);
    emit({ type: 'armed', side: s, on });
  };

  const dropGrip = s => {
    const h = hands[s];
    if (h.pinch.pinched && !h.pinch.ghost) driver?.release(s, { kind: 'drop' });
    h.pinch = makePinchState();
  };

  return {
    UIC,

    get enabled() { return cfg.enabled; },
    get margin()  { return cfg.margin; },
    armedOn(s)    { return armed[s]; },
    anyArmed()    { return armed.L || armed.R; },

    setEnabled(on) {
      if (cfg.enabled === !!on) return;
      cfg.enabled = !!on;
      persist();
      if (!on) this.disarmAll();
      emit({ type: 'enabled', on: cfg.enabled });
    },
    setMargin(m) {
      cfg.margin = Math.min(0.3, Math.max(0, +m || 0));
      persist();
    },

    setDriver(d)      { driver = d; },
    setSweep(fn)      { onSweep = fn; },
    setSingleSide(fn) { singleSide = fn; },
    onEvent(fn)       { watchers.push(fn); return fn; },

    disarmAll() {
      ['L', 'R'].forEach(s => setArmed(s, false));
      sel = null;
      singleDwell = 0;
    },

    // The bound key / the header button: disarm-everything when anything is
    // armed (the panic path must be one action, always), otherwise open the
    // selection window as if a clap had fired.
    hotkey() {
      if (!cfg.enabled) { emit({ type: 'denied', reason: 'disabled' }); return; }
      if (this.anyArmed()) { this.disarmAll(); emit({ type: 'panic' }); return; }
      sel = makeSelectState(performance.now());
      emit({ type: 'window', open: true, source: 'key' });
    },

    // Should cv.js treat this side as absent? True while the side is armed
    // (the cursor owns it) and briefly after a clap (so the landing drains
    // through the decay path instead of jolting the synth).
    claims(s) {
      return (cfg.enabled && (armed[s] || performance.now() < holdBothUntil))
          || stageActive;
    },

    // The cursor deserves the frame budget: cv.js tilts the hand/pose
    // alternation toward hands while this is true. Crucially that includes
    // the moment BEFORE arming when both hands are up — the clap approach is
    // exactly when 15Hz sampling loses the contact — without permanently
    // taxing pose while the modality merely sits enabled.
    wantsPriority() {
      if (stageActive) return true;
      if (!cfg.enabled) return false;
      if (armed.L || armed.R) return true;
      // Both hands up = a clap may be coming, and that is exactly when the
      // sampling rate matters. `seen` rather than a bare recency check: a
      // hand that has never been fed must not read as present.
      const now = performance.now();
      return seen('L', now) && seen('R', now);
    },

    // The fullscreen stage: both hands become cursors (and are claimed from
    // the instrument) for as long as it is up, whatever the armed flags say.
    get stage() { return stageActive; },
    setStageActive(on) {
      if (stageActive === !!on) return;
      stageActive = !!on;
      if (!on) ['L', 'R'].forEach(s => { if (!armed[s]) dropGrip(s); });
      emit({ type: 'stage', on: stageActive });
    },

    // Called from cv.js each hand frame, BEFORE the claims gate — the cursor
    // must see armed hands precisely because the bus no longer does.
    feedHands(found, foundWorld, tMs) {
      for (const s of ['L', 'R']) {
        const h = hands[s], lm = found[s];
        if (!lm) { h.present = false; continue; }
        h.present = true;
        h.lastT = tMs;
        const mx = 1 - (lm[4].x + lm[8].x) / 2;      // mirror: selfie space
        const my = (lm[4].y + lm[8].y) / 2;
        h.x = h.fx.filter(mx, tMs / 1000);
        h.y = h.fy.filter(my, tMs / 1000);
        h.hist.push({ x: h.x, y: h.y, t: tMs });
        if (h.hist.length > UIC.HIST) h.hist.shift();
        h.m = handMetrics(lm);
        h.lm = lm;
        h.wx = 1 - lm[0].x;  h.wy = lm[0].y;
        h.mcpx = 1 - lm[9].x; h.mcpy = lm[9].y;
        h.yUp = 1 - lm[0].y;
        // Soft-open memory: the claw's transition law wants a recent flash of
        // an open hand, because a claw is a movement, not a shape.
        if (h.m.open > UIC.CLAP_OPEN && h.m.r > UIC.CLAP_OPEN) h.lastOpenT = tMs;
      }
    },

    tick() {
      const now = performance.now();
      const dt = lastTickT ? Math.min(100, now - lastTickT) : 16;
      lastTickT = now;
      if (!cfg.enabled && !stageActive) return;

      // ── Clap → selection window (or double-clap: cancel / stage sweep) ──
      const snap = s => {
        const h = hands[s];
        return {
          present: h.present && now - h.lastT < UIC.STALE_MS,
          wx: h.wx, wy: h.wy, mcpx: h.mcpx, mcpy: h.mcpy,
          up: h.m?.up ?? 0, open: h.m?.open ?? 0, r: h.m?.r ?? 1,
          pinched: h.pinch.pinched, lastPinchT: h.lastPinchT,
        };
      };
      const grabbed = ['L', 'R'].some(s => driver?.isHolding?.(s));
      const sL = snap('L'), sR = snap('R');
      if (clapStep(clap, sL, sR, now, grabbed) === 'clap') {
        holdBothUntil = now + UIC.HOLD_AFTER_CLAP;
        const double = sel !== null || now - lastClapT < UIC.DOUBLE_CLAP_MS;
        lastClapT = now;
        if (stageActive) {
          // On the stage both hands already are cursors, so a lone clap has
          // nothing to arm — only the double-clap SWEEP means anything.
          if (double && onSweep?.()) emit({ type: 'sweep' });
        } else if (double) {
          sel = null;
          if (onSweep?.()) emit({ type: 'sweep' });
          else emit({ type: 'window', open: false });
        } else {
          sel = makeSelectState(now);
          emit({ type: 'window', open: true, source: 'clap' });
        }
      } else if (!sel && !stageActive && now - lastMissT > UIC.MISS_TOAST_MS) {
        // A converged-but-refused clap gets told WHY, or the gate is a wall.
        const reason = clapNearMiss(clap, sL, sR, now);
        if (reason) {
          lastMissT = now;
          emit({ type: 'clap-miss', reason });
        }
      }

      // ── Selection window: raised hands toggle their armed state ──────────
      if (sel) {
        if (now > sel.until) {
          sel = null;
          emit({ type: 'window', open: false });
        } else {
          const raised = {};
          for (const s of ['L', 'R']) {
            const h = hands[s];
            raised[s] = h.present && now - h.lastT < UIC.STALE_MS
                     && raisedQualify(h.yUp, h.m?.open ?? 0);
          }
          for (const s of selectStep(sel, raised, now, dt)) setArmed(s, !armed[s]);
          if (sel && sel.until === 0) { sel = null; emit({ type: 'window', open: false }); }
        }
      } else {
        // One-hand fallback: a clap needs two hands, so when only one is
        // available a long raised-open dwell toggles that hand instead.
        //
        // "Available" has to mean what the CAMERA sees, not what the tracking
        // toggles say. Keying this off the toggles made arming impossible in
        // the most ordinary setup there is — a tablet held in one hand, both
        // toggles on, one hand permanently out of frame: no clap was possible
        // and the fallback never engaged, so the cursor could never be armed
        // at all while its idle ring cheerfully followed the free hand.
        const only = loneHand(now);
        if (only && now > singleCoolUntil) {
          const h = hands[only];
          const up = h.present && now - h.lastT < UIC.STALE_MS
                  && raisedQualify(h.yUp, h.m?.open ?? 0);
          singleDwell = up
            ? singleDwell + dt
            : Math.max(0, singleDwell - dt * UIC.DWELL_DRAIN);
          if (singleDwell >= UIC.SINGLE_DWELL) {
            singleDwell = 0;
            singleCoolUntil = now + UIC.SINGLE_COOLDOWN;
            setArmed(only, !armed[only]);
          }
        } else {
          singleDwell = 0;
        }
      }

      // ── Armed cursors (on the stage, every hand is one) ─────────────────
      for (const s of ['L', 'R']) {
        const h = hands[s];
        if (!armed[s] && !stageActive) {
          if (h.pinch.pinched) dropGrip(s);
          // Pinching a hand that is not armed does nothing at all, and the
          // idle ring following that hand is a strong suggestion that it
          // should. Say so rather than letting it read as a broken click.
          if (h.present && now - h.lastT < UIC.STALE_MS && h.m
              && h.m.r < UIC.PINCH_ENTER_PROFILE
              && now - lastUnarmedT > UIC.MISS_TOAST_MS) {
            lastUnarmedT = now;
            emit({ type: 'unarmed-pinch', side: s, lone: loneHand(now) === s });
          }
          continue;
        }
        if (!h.present || now - h.lastT > UIC.STALE_MS) {
          if (h.pinch.pinched) dropGrip(s);
          continue;
        }
        if (h.pinch.pinched) h.lastPinchT = now;

        // The claw runs only on the stage, and never on a hand that is
        // pinching or carrying — a grip is already a commitment.
        if (stageActive && h.lm && !h.pinch.pinched && !driver?.isHolding?.(s)) {
          const ev = clawStep(h.claw, clawMetrics(h.lm), h.m, now, {
            openRecent: now - h.lastOpenT < UIC.CLAW_OPEN_MS,
            holding: false,
          });
          if (ev) emit({ type: 'claw', side: s, phase: ev,
                         ray: ev === 'coach' ? null : clawRay(h.lm) });
        } else if (h.claw.on || h.claw.pose) {
          h.claw = makeClawState();
        }

        const gain = speedScale(cfg.margin);
        const { lastS } = histVel(h.hist, now);
        const holding = driver?.isHolding?.(s) ?? false;
        const ev = pinchStep(h.pinch, h.m, now, lastS * gain, holding);

        if (ev === 'press') {
          h.pressX = h.x; h.pressY = h.y; h.pressT = now; h.trav = 0;
          driver?.press(s, h.x, h.y);
        } else if (h.pinch.pinched && !h.pinch.ghost) {
          h.trav = Math.max(h.trav, Math.hypot(h.x - h.pressX, h.y - h.pressY));
        }
        driver?.move(s, h.x, h.y, h.pinch.pinched && !h.pinch.ghost);
        if (ev === 'release') {
          const v = histVel(h.hist, now);
          const kind = classifyRelease({
            gripMs: now - h.pressT, trav: h.trav * gain,
            peak: v.peak * gain, lastS: v.lastS * gain,
            probKill: h.pinch.probKill,
          });
          driver?.release(s, { kind, vx: v.vx, vy: v.vy });
          // A click you cannot see is indistinguishable from a click that did
          // not happen — which is exactly how the broken tap rule read.
          if (kind === 'tap') emit({ type: 'tap', side: s, x: h.x, y: h.y });
        } else if (ev === 'drop') {
          driver?.release(s, { kind: 'drop' });
        }
      }
    },

    // Snapshot for the overlay — read-only, no DOM here.
    view() {
      const now = performance.now();
      const hs = {};
      for (const s of ['L', 'R']) {
        const h = hands[s];
        hs[s] = {
          present: h.present && now - h.lastT < UIC.STALE_MS,
          x: h.x, y: h.y,
          pinched: h.pinch.pinched && !h.pinch.ghost,
          ghost: h.pinch.ghost,
          armed: armed[s] || stageActive,
          clawOn: h.claw.on,
          yUp: h.yUp,
          up: h.m?.up ?? 0,
          open: h.m?.open ?? 0,
          r: h.m?.r ?? null,
        };
      }
      const wristD = hs.L.present && hs.R.present
        ? Math.hypot(hands.L.wx - hands.R.wx, hands.L.wy - hands.R.wy) : null;
      return {
        enabled: cfg.enabled || stageActive,
        stage: stageActive,
        wristD,
        margin: cfg.margin,
        armed: { ...armed },
        hands: hs,
        window: sel ? { until: sel.until, dwell: { ...sel.dwell }, now } : null,
        singleDwell,
        lone: loneHand(now),        // the hand a one-handed raise would arm
      };
    },
  };
})();
