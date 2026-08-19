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
// (fail-quiet), the gesture matcher releases, chord mode sees nothing. One
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
// any distance from the camera; only travel and speed are screen-relative,
// and those are kept in *normalized camera space* here (fractions of the
// frame, converted from thresholds fitted at a ~1920px window), so neither
// the window size nor the cursor reach-gain changes what counts as "still".

import { handOpenness }        from './math.js';
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

  // Release classification.
  TAP_MS:    300,              // shorter than this…
  TAP_TRAV:  0.014,            // …and stiller than this (26 px) = a tap
  FLING_MIN_GRIP: 120,         // a blur-phantom grip can't throw
  FLING_PEAK:   0.68,          // 1300 px/s peak over the last…
  PEAK_WIN:     220,           // …ms of history…
  FLING_FOLLOW: 0.4,           // …carried ≥40% into the release (follow-through)
  HIST: 10,                    // samples of cursor history kept per hand

  // Clap ("prayer law"): both hands fingers-up, open, converging from apart.
  CLAP_WRIST: 0.11,            // wrist distance at contact (frame fraction)
  CLAP_MCP:   0.09,            // knuckle distance at contact
  CLAP_APART: 0.18,            // hands must have been this far apart…
  CLAP_APART_MS: 800,          // …this recently (a clap is a movement)
  CLAP_UP:   0.85,             // (wrist.y − mcp.y)/span — fingers straight up
  CLAP_OPEN: 0.70,             // openness floor, and gap ratio floor
  CLAP_OPEN_GRACE: 250,        // open within this window still counts
  CLAP_PINCH_BLOCK: 800,       // a hand that pinched this recently disqualifies
  CLAP_COOLDOWN: 1500,
  CLAP_VANISH_MS: 200,         // palms merged into one detection at contact:
  CLAP_VANISH_D:  0.16,        // a qualified converging sample this recent fires

  // Selection window (after a clap): hold up the hand(s) to toggle.
  WINDOW_MS: 2750,
  DWELL_MS:  800,              // raised-open hold that flips a hand
  DWELL_DRAIN: 2,              // dwell drains at 2× when the hand drops
  RAISE_Y:    0.60,            // hand height (1 = top of frame)
  RAISE_OPEN: 0.70,            // openness
  SINGLE_DWELL: 1200,          // one-hand-tracked fallback: long raised hold
  SINGLE_COOLDOWN: 2000,
  DOUBLE_CLAP_MS: 1200,        // second clap inside this = cancel (stage: sweep)
  HOLD_AFTER_CLAP: 400,        // both hands claimed briefly so the landing
                               // drains through the decay path, not the synth

  // Cursor.
  MARGIN: 0.15,                // inner (1−2m) of the frame maps to the screen
  STALE_MS: 500,               // a hand unseen this long drops its grip
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

// A short, still grip is a tap. A grip that hit real speed *and carried it
// into the release* is a fling (follow-through is what separates a throw
// from a stop). Everything else just lets go.
export function classifyRelease({ gripMs, trav, peak, lastS, probKill }) {
  if (probKill) return 'drop';
  if (gripMs < UIC.TAP_MS && trav < UIC.TAP_TRAV) return 'tap';
  if (gripMs >= UIC.FLING_MIN_GRIP && peak > UIC.FLING_PEAK
      && lastS > peak * UIC.FLING_FOLLOW) return 'fling';
  return 'drop';
}

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
    st.hist.push({ t: now, wristD, apart: wristD > UIC.CLAP_APART,
                   q: qualified && wristD < UIC.CLAP_VANISH_D });
    if (qualified && wristD < UIC.CLAP_WRIST && mcpD < UIC.CLAP_MCP) {
      st.lastFire = now;
      return 'clap';
    }
    return null;
  }

  // Vanish fallback: at contact the two palms often merge into a single
  // detection (or none). A qualified converging sample moments ago still
  // counts as the clap it was about to be.
  if (!L.present && !R.present && now - st.lastBothT < UIC.CLAP_VANISH_MS) {
    const q = st.hist[st.hist.length - 1];
    if (q?.q && now - q.t < UIC.CLAP_VANISH_MS) {
      st.lastFire = now;
      st.hist = [];
      return 'clap';
    }
  }
  return null;
}

// ── Selection window ─────────────────────────────────────────────────────
export function raisedQualify(yUp, open) {
  return yUp > UIC.RAISE_Y && open > UIC.RAISE_OPEN;
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

// ── The singleton ────────────────────────────────────────────────────────
const LS_KEY = 'motionmuse-uicontrol';
const EURO = { minCutoff: 1.0, beta: 0.4 };   // pointing wants steadier than pinch

const mkHand = () => ({
  present: false, lastT: 0,
  x: 0.5, y: 0.5,                       // filtered cursor, mirrored-normalized
  fx: makeOneEuro(EURO), fy: makeOneEuro(EURO),
  hist: [],
  m: null,                              // last handMetrics
  wx: 0, wy: 0, mcpx: 0, mcpy: 0, yUp: 0,
  pinch: makePinchState(),
  lastPinchT: 0,
  pressX: 0, pressY: 0, pressT: 0, trav: 0,
});

export const uicontrol = (() => {
  let cfg = { enabled: false, margin: UIC.MARGIN };
  try { cfg = { ...cfg, ...JSON.parse(lsGet(LS_KEY) || '{}') }; } catch { /* defaults */ }
  const persist = () => lsSet(LS_KEY, JSON.stringify(cfg));

  const hands = { L: mkHand(), R: mkHand() };
  const armed = { L: false, R: false };
  const clap  = makeClapState();
  let sel = null;            // active selection window, or null
  let lastClapT = 0;
  let holdBothUntil = 0;     // post-clap claim of both hands
  let singleDwell = 0;       // one-hand fallback arming accumulator
  let singleCoolUntil = 0;
  let lastTickT = 0;
  let driver = null;         // ui/uidriver.js — press/move/release/isHolding
  let onSweep = null;        // Phase 2: stage sweep hook
  let singleSide = () => null;   // injected: 'L'/'R' when only one tracker is on
  const watchers = [];

  const emit = ev => watchers.forEach(fn => { try { fn(ev); } catch { /* not fatal */ } });

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
      return cfg.enabled && (armed[s] || performance.now() < holdBothUntil);
    },

    // An armed cursor deserves the frame budget: cv.js tilts the hand/pose
    // alternation toward hands while this is true.
    wantsPriority() { return cfg.enabled && (armed.L || armed.R); },

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
        h.wx = 1 - lm[0].x;  h.wy = lm[0].y;
        h.mcpx = 1 - lm[9].x; h.mcpy = lm[9].y;
        h.yUp = 1 - lm[0].y;
      }
    },

    tick() {
      const now = performance.now();
      const dt = lastTickT ? Math.min(100, now - lastTickT) : 16;
      lastTickT = now;
      if (!cfg.enabled) return;

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
      if (clapStep(clap, snap('L'), snap('R'), now, grabbed) === 'clap') {
        holdBothUntil = now + UIC.HOLD_AFTER_CLAP;
        const double = sel !== null || now - lastClapT < UIC.DOUBLE_CLAP_MS;
        lastClapT = now;
        if (double) {
          sel = null;
          if (onSweep?.()) emit({ type: 'sweep' });
          else emit({ type: 'window', open: false });
        } else {
          sel = makeSelectState(now);
          emit({ type: 'window', open: true, source: 'clap' });
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
        // One-hand fallback: a clap is impossible with a single tracker on,
        // so a long raised-open dwell toggles that hand instead.
        const only = singleSide();
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

      // ── Armed cursors ────────────────────────────────────────────────────
      for (const s of ['L', 'R']) {
        const h = hands[s];
        if (!armed[s]) {
          if (h.pinch.pinched) dropGrip(s);
          continue;
        }
        if (!h.present || now - h.lastT > UIC.STALE_MS) {
          if (h.pinch.pinched) dropGrip(s);
          continue;
        }
        if (h.pinch.pinched) h.lastPinchT = now;

        const { lastS } = histVel(h.hist, now);
        const holding = driver?.isHolding?.(s) ?? false;
        const ev = pinchStep(h.pinch, h.m, now, lastS, holding);

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
            gripMs: now - h.pressT, trav: h.trav,
            peak: v.peak, lastS: v.lastS, probKill: h.pinch.probKill,
          });
          driver?.release(s, { kind, vx: v.vx, vy: v.vy });
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
          armed: armed[s],
        };
      }
      return {
        enabled: cfg.enabled,
        margin: cfg.margin,
        armed: { ...armed },
        hands: hs,
        window: sel ? { until: sel.until, dwell: { ...sel.dwell }, now } : null,
        singleDwell,
      };
    },
  };
})();
