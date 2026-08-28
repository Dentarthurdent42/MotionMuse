// Radial joint menu — play scale degrees by POINTING.
//
// A CIRCLE of equal-angle sections is worn on a joint like a bracelet: the
// ring's plane is perpendicular to a body axis, with that axis the normal
// through its centre. On the wrist the normal is the FOREARM — the elbow→
// wrist segment of the pose skeleton — so the ring rides the arm and faces
// wherever it points; the chosen fingertip (index by default) is the
// pointer, aimed around the ring by wrist flexion and deviation. On the
// shoulder the normal is the torso's own chest axis, so the ring lies flat
// on the body and the whole arm is the pointer, sweeping it from hanging
// (the first degree) through out and overhead.
//
// The sections have RADIAL THICKNESS — each is an annular sector, not a ray.
// That thickness is what makes sustain a place rather than a moment: reach
// out from the ring's axis into the ring and the note attacks, stay anywhere
// inside the section and it holds, draw back toward the axis and it
// releases. How FAST the pointer crosses into a section sets the attack
// strength, so a stab is loud and a drift is soft — the ring's inner edge is
// a drum head, not a switch.
//
// Sections are the degrees of the same key gesture mode plays in
// (chordmode.effectiveKey() — one key control, shared, following Pitch
// Quantize when that is on). A 7-note mode gives seven sections, a
// pentatonic five; the ring re-divides itself when the key changes. Notes
// sound through the chord voice bank, as single notes or whole chords (a
// voicing option, as in gesture mode), with Shepard tones on by default — a
// menu that wraps around a joint pairs naturally with a timbre that wraps
// around the octave.
//
// The maths lives in exported pure functions (makeRadialTracker, ringBasis,
// the two *Geometry builders) so the boundary behaviour — hysteresis, entry
// speed, section resolution, the 3D ring orientation — is testable without a
// camera or an AudioContext: tests/unit/radial.test.js drives them directly.

import { engine }     from './engine.js';
import { chordmode }  from './chordmode.js';
import { gesture }    from './gesture.js';
import { torsoFrame } from './math.js';
import { makeOneEuro } from './filter.js';
import { NATURAL, SHARP, FLAT } from './chords.js';

const DEG = 180 / Math.PI;

// ── Ring coordinates ──────────────────────────────────────────────────────
//
// All section maths happens in RING COORDINATES: degrees around the circle
// in its own plane, 0° at the ring's reference direction, SECTION 0 CENTRED
// on 0°. For the wrist the reference is "up" projected into the ring's
// plane, and angles ascend clockwise as seen in the mirrored camera view —
// a clock face, C at twelve. For the shoulder the reference is the torso's
// own down axis (arm hanging = the first degree) ascending toward
// out-to-your-side and overhead, whichever arm.

// ── Per-joint tuning ──────────────────────────────────────────────────────
//
// Radii are in JOINT UNITS — palm lengths for the wrist (wrist→middle-MCP),
// arm lengths for the shoulder (shoulder→elbow + elbow→wrist) — measured
// PERPENDICULAR to the ring's axis, so they are independent of hand size and
// of distance from the camera.
//
//   rIn     inner edge of the ring: where an attack fires. Wrist: an
//           extended index finger held along the forearm sits near the axis
//           (~0.2–0.35 perpendicular), a deliberately flexed or deviated
//           wrist carries it past 1.2, so 0.85 asks for a real point.
//           Shoulder: an arm reaching out in the torso's plane projects
//           ~0.9 of its own length; pointing it forward, or bending the
//           elbow, pulls it back toward the axis.
//   rOut    outer edge — drawn, and a bound on the ring, but chosen past
//           what the pointer can physically reach so play never falls off
//           the far side of a section.
//   hystR   how far back inside rIn the pointer must retract to release, so
//           a fingertip resting on the edge doesn't machine-gun the envelope.
//   vRef    entry speed (joint units/s) that earns a full-strength attack.
export const JOINTS = {
  wrist:    { rIn: 0.85, rOut: 2.0,  hystR: 0.12, vRef: 8 },
  shoulder: { rIn: 0.6,  rOut: 1.15, hystR: 0.07, vRef: 2.5 },
};

// Fingertip landmarks the wrist ring can point with. Index is the default —
// it is the finger the word "pointing" means.
export const FINGERS = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
export const DEFAULT_FINGER = 'index';

// The strength a dead-slow entry still gets: a deliberate drift into a
// section is a note meant quietly, not a note not meant.
export const V_FLOOR = 0.35;

// Angular hysteresis at section boundaries, degrees. Movement between
// sections re-attacks; this keeps a pointer resting ON a boundary from
// re-attacking every frame of jitter.
export const HYST_DEG = 4;

// The drawn — and played — ring never goes fully edge-on: the normal is
// tilted toward the camera until it keeps at least this much depth
// component, so a forearm lying in the image plane still shows a readable
// ellipse instead of a line. Applied to the maths and the picture together,
// so what you see is what is measured.
export const MIN_TILT = 0.25;

// ── The tracker: samples in, attack/release events out ────────────────────
//
// feed() takes { deg, r, t } — ring-coordinate angle, perpendicular radius
// in joint units, time in seconds — and returns one of
//   { type: 'attack',  section, strength }   entered the ring, or crossed
//                                            into a neighbouring section
//   { type: 'release' }                      retracted toward the axis
// or null. Strength ∈ [vFloor, 1] from the pointer's speed across the
// boundary it just crossed. The circle is closed: there is no angular
// outside, only the radial one.
export function makeRadialTracker({
  sections, rIn, rOut,
  hystR = 0.1, hystDeg = HYST_DEG, vRef = 6, vFloor = V_FLOOR,
} = {}) {
  const width = 360 / sections;
  let section = null;       // sounding section, or null
  let prev = null;          // { x, y, t } last sample, for entry speed

  const norm = d => ((d % 360) + 360) % 360;
  // Section 0 is centred on 0°, so its start boundary sits at −width/2.
  const sectionAt = deg => Math.min(sections - 1, Math.floor(norm(deg + width / 2) / width));

  // Speed across the last inter-sample step. Cartesian in the ring's plane,
  // so a purely angular crossing (sliding around inside the ring) is
  // measured by the same yardstick as a radial stab — arc length is
  // distance like any other.
  const speedFrom = (x, y, t) => {
    if (!prev) return 0;
    const dt = t - prev.t;
    if (dt < 0.005) return 0;              // same-millisecond duplicates
    return Math.hypot(x - prev.x, y - prev.y) / dt;
  };
  const strengthFrom = v => Math.min(1, vFloor + (1 - vFloor) * (v / vRef));

  return {
    feed({ deg, r, t }) {
      const rad = deg / DEG;
      const x = r * Math.cos(rad), y = r * Math.sin(rad);
      const v = speedFrom(x, y, t);
      prev = { x, y, t };

      if (section === null) {
        // Arming: reach the ring, no hysteresis — margins exist to keep a
        // held note from chattering, not to make entry harder.
        if (r < rIn || r > rOut) return null;
        section = sectionAt(deg);
        return { type: 'attack', section, strength: strengthFrom(v) };
      }

      // Holding: release only past the radial margins…
      if (r < rIn - hystR || r > rOut + hystR) {
        section = null;
        return { type: 'release' };
      }
      // …and the held section keeps its boundaries sticky by hystDeg,
      // wrap-aware — section N−1 and section 0 are neighbours.
      const lo = section * width - width / 2;
      if (norm(deg - lo + hystDeg) < width + 2 * hystDeg) return null;
      section = sectionAt(deg);
      return { type: 'attack', section, strength: strengthFrom(v) };
    },
    reset() { section = null; prev = null; },
    get section() { return section; },
  };
}

// ── 3D helpers ────────────────────────────────────────────────────────────
//
// MediaPipe landmarks are normalized to the FRAME — x by its width, y and z
// by comparable scales — so raw coordinates are anisotropic and an angle
// measured in them is wrong by the aspect ratio. Everything here works in
// aspect-corrected space (x·aspect, y, z·aspect), where a circle is a
// circle; `anchor` keeps the raw normalized point too, because that is what
// the overlay's own transform expects. Hand z is relative to the hand's own
// wrist and pose z to the hips — each is only ever combined with itself.

const v3 = (p, aspect) => [p.x * aspect, p.y, (p.z ?? 0) * aspect];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => { const l = len(a); return l < 1e-9 ? null : scl(a, 1 / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const reject = (a, n) => sub(a, scl(n, dot(a, n)));

/**
 * The ring's frame from its axis: unit normal n, and in-plane u/v with v
 * the reference (ring 0°) and u the 90° direction.
 *
 * Two normalisations keep the clock readable:
 * - The normal is CANONICALISED to lean toward the camera (z ≤ 0), so the
 *   section order on screen doesn't mirror-flip the moment the arm tilts
 *   through the image plane — a bracelet's far face reads backwards, and an
 *   instrument that reverses its keyboard mid-phrase is unplayable.
 * - It is TILTED to keep at least MIN_TILT of depth component, so an
 *   edge-on ring stays a readable ellipse (see MIN_TILT).
 *
 * v is "up" projected into the plane (the top of the clock); u = n × v then
 * makes angles ascend clockwise as seen in the mirrored camera view.
 */
export function ringBasis(axis, minTilt = MIN_TILT) {
  let n = axis ? unit(axis) : null;
  if (!n) n = [0, 0, -1];
  if (n[2] > 0) n = scl(n, -1);
  if (-n[2] < minTilt) {
    const xy = Math.hypot(n[0], n[1]);
    const k = xy < 1e-9 ? 0 : Math.sqrt(1 - minTilt * minTilt) / xy;
    n = [n[0] * k, n[1] * k, -minTilt];
  }
  const v = unit(reject([0, -1, 0], n)) ?? unit(reject([1, 0, 0], n));
  return { n, u: cross(n, v), v };
}

/**
 * Wrist ring: worn on the hand's own wrist, one palm-length the unit, the
 * FOREARM the normal — pass the elbow→wrist vector from pose (3D, aspect-
 * corrected), or null, which lays the ring flat to the camera instead:
 * still playable, just fixed to the frame rather than to you.
 * Pointer: the chosen fingertip. Its reach PERPENDICULAR to the forearm is
 * the radius — point away from the axis to play, fold back toward it (or
 * curl the finger) to release.
 */
export function wristGeometry(hand, forearm, aspect = 4 / 3, tip = FINGERS.index) {
  if (!hand?.[0] || !hand[9] || !hand[tip]) return null;
  const W = v3(hand[0], aspect);
  const unitLen = len(sub(v3(hand[9], aspect), W));
  if (unitLen < 1e-4) return null;
  const basis = ringBasis(forearm);
  const P = sub(v3(hand[tip], aspect), W);
  return {
    anchor: { x: hand[0].x, y: hand[0].y },
    basis,
    unit: unitLen,
    aspect,
    pointer: {
      x: hand[tip].x, y: hand[tip].y,
      r: len(reject(P, basis.n)) / unitLen,
      deg: Math.atan2(dot(P, basis.u), dot(P, basis.v)) * DEG,
    },
  };
}

/**
 * Shoulder ring: centred on the shoulder, lying in the torso's own plane
 * (the chest axis is the normal), the whole arm the pointer and its own
 * straightened length the unit. Ring 0° is the torso's down axis — arm
 * hanging is the first degree — ascending toward out-to-that-side and
 * overhead, for either arm. Straighten the arm in the body's plane to reach
 * the ring; bend the elbow, or point the arm forward, to retract.
 */
export function shoulderGeometry(side, pose, aspect = 4 / 3) {
  if (!pose) return null;
  const [ls, rs, lh, rh] = [11, 12, 23, 24].map(i => pose[i]);
  const sh = side === 'L' ? pose[11] : pose[12];
  const el = side === 'L' ? pose[13] : pose[14];
  const wr = side === 'L' ? pose[15] : pose[16];
  if (!ls || !rs || !lh || !rh || !sh || !el || !wr) return null;

  const ac = p => ({ x: p.x * aspect, y: p.y, z: (p.z ?? 0) * aspect });
  const S = v3(sh, aspect), E = v3(el, aspect), Wp = v3(wr, aspect);
  const unitLen = len(sub(E, S)) + len(sub(Wp, E));
  if (unitLen < 1e-3) return null;

  const frame = torsoFrame(ac(ls), ac(rs), ac(lh), ac(rh));
  // The chest axis, canonicalised and tilt-floored like any ring normal —
  // but u and v are the torso's own directions, not derived from it, so the
  // hanging→out→overhead order cannot flip with the normal's sign.
  const { n } = ringBasis(frame.forward);
  const v = unit(reject(frame.down, n));
  if (!v) return null;
  const lateral = side === 'L' ? frame.across : scl(frame.across, -1);
  const u = unit(reject(reject(lateral, n), v));
  if (!u) return null;

  const P = sub(Wp, S);
  return {
    anchor: { x: sh.x, y: sh.y },
    basis: { n, u, v },
    unit: unitLen,
    aspect,
    pointer: {
      x: wr.x, y: wr.y,
      r: len(reject(P, n)) / unitLen,
      deg: Math.atan2(dot(P, u), dot(P, v)) * DEG,
    },
  };
}

// ── The instrument ────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: false,
  joint: 'wrist',                    // 'wrist' | 'shoulder'
  side: 'R',
  voicing: 'note',                   // 'note' | 'chord' — as in gesture mode
  finger: DEFAULT_FINGER,            // which fingertip points, wrist only
  // Shepard tones are this mode's default timbre; auto is cleared the first
  // time the player toggles SHEPARD from the radial panel, so their choice
  // outlives enable/disable and reloads.
  shepAuto: true,
};

// Tracking feeds go stale rather than absent when the camera stops or a hand
// leaves the frame mid-note; older than this they count as gone.
const FEED_MS = 500;

export const radial = (() => {
  let enabled  = DEFAULTS.enabled;
  let joint    = DEFAULTS.joint;
  let side     = DEFAULTS.side;
  let voicing  = DEFAULTS.voicing;
  let finger   = DEFAULTS.finger;
  let shepAuto = DEFAULTS.shepAuto;

  let hands = { L: null, R: null };   // latest hand landmarks per side
  let pose = null;                    // latest pose landmarks
  // Freshness is PER SIDE: a hand the cursor has claimed stops being fed, and
  // one shared clock would let the other hand keep it forever "fresh" — a
  // frozen pointer holding a note nothing can stop.
  let handT = { L: 0, R: 0 };
  let poseT = 0, aspect = 4 / 3;

  // The forearm axis is differenced from two pose landmarks, so it carries
  // both joints' jitter — and it orients the whole ring, so its jitter is
  // every section's jitter. One-Euro per component, reset on tracking loss.
  let armFilt = null;
  const smoothForearm = (vec, tSec) => {
    if (!vec) { armFilt = null; return null; }
    if (!armFilt) armFilt = vec.map(() => makeOneEuro({ minCutoff: 1.0, beta: 0.3 }));
    return vec.map((c, i) => armFilt[i].filter(c, tSec));
  };

  let tracker = null;
  let trackerCfg = '';                // what the tracker was built for
  let geo = null;                     // last geometry, for drawing + panel
  let sounding = null;                // section index, or null
  let lastStrength = 0;               // for re-voicing without a new attack
  let lastAcc = NATURAL;

  const silence = () => {
    if (sounding === null) return;
    engine.releaseChord();
    sounding = null;
  };

  // One key, shared: the same effectiveKey gesture mode plays in.
  const sectionCount = () => chordmode.degreeCount();

  const freqsFor = (degree, acc) => {
    if (voicing === 'chord') return chordmode.chordAt(degree)?.freqs ?? null;
    const n = chordmode.noteAt(degree, acc);
    return n ? [n.freq] : null;
  };

  // The hand NOT wearing the menu bends the note, with the same two shapes
  // gesture mode uses (chordmode.accidentalGestures() — one setting, shared).
  const offSide = () => (side === 'L' ? 'R' : 'L');
  const accidentalNow = () => {
    if (voicing !== 'note') return NATURAL;
    const held = gesture.activeOn(offSide());
    if (held === null) return NATURAL;
    const acc = chordmode.accidentalGestures();
    if (held === acc.sharp) return SHARP;
    if (held === acc.flat) return FLAT;
    return NATURAL;
  };

  const computeGeometry = () => {
    const now = performance.now();
    const p = (now - poseT < FEED_MS) ? pose : null;
    if (joint === 'shoulder') {
      smoothForearm(null);
      return shoulderGeometry(side, p, aspect);
    }
    const hand = (now - handT[side] < FEED_MS) ? hands[side] : null;
    if (!hand) { smoothForearm(null); return null; }
    const el = p?.[side === 'L' ? 13 : 14] ?? null;
    const wr = p?.[side === 'L' ? 15 : 16] ?? null;
    const forearm = el && wr
      ? smoothForearm(sub(v3(wr, aspect), v3(el, aspect)), now / 1000)
      : smoothForearm(null);
    return wristGeometry(hand, forearm, aspect, FINGERS[finger] ?? FINGERS.index);
  };

  const ensureTracker = () => {
    const j = JOINTS[joint];
    const cfg = `${joint}|${sectionCount()}`;
    if (tracker && cfg === trackerCfg) return;
    // A re-divided ring (key change, joint change) invalidates the held
    // section's meaning, so the note lets go rather than drifting.
    silence();
    tracker = makeRadialTracker({
      sections: sectionCount(),
      rIn: j.rIn, rOut: j.rOut, hystR: j.hystR, vRef: j.vRef,
    });
    trackerCfg = cfg;
  };

  return {
    get enabled() { return enabled; },
    setEnabled(on) {
      const next = !!on;
      if (next === enabled) return enabled;
      enabled = next;
      if (enabled) {
        // One instrument on the chord bank at a time: the radial menu and
        // gesture mode both voice through it, and two writers is a race, not
        // a duet. (gesture-ui enforces the same rule from its side.)
        chordmode.setEnabled(false);
        // Shepard tones are the mode's default voice — unless the player has
        // already said otherwise from this panel.
        if (shepAuto && !engine.getShepard().chord) engine.setShepard({ chord: true });
      } else {
        silence();
        tracker?.reset();
        geo = null;
      }
      return enabled;
    },

    config: () => ({ joint, side, voicing, finger, shepAuto }),
    setJoint(j, s) {
      if (JOINTS[j]) joint = j;
      if (s === 'L' || s === 'R') side = s;
      ensureTracker();
    },
    setVoicing(v) {
      if (v !== 'note' && v !== 'chord') return voicing;
      if (v === voicing) return voicing;
      voicing = v;
      silence();          // a triad and a single note are two different sounds
      lastAcc = NATURAL;
      return voicing;
    },
    setFinger(f) {
      if (FINGERS[f] !== undefined) finger = f;
      return finger;
    },
    // The SHEPARD button in the radial panel: same engine flag gesture mode's
    // button drives, but touching it HERE is the player overruling the
    // mode's default, so auto stands down for good.
    toggleShepard() {
      shepAuto = false;
      engine.setShepard({ chord: !engine.getShepard().chord });
    },

    // ── Feeds (cv.js, once per processed frame) ─────────────────────────
    feedHands(found, claimed, videoAspect) {
      const now = performance.now();
      for (const s of ['L', 'R']) {
        if (claimed?.[s]) continue;       // borrowed by the hand cursor — stale out
        hands[s] = found?.[s] ?? null;
        handT[s] = now;
      }
      if (videoAspect > 0) aspect = videoAspect;
    },
    feedPose(lm, videoAspect) {
      pose = lm ?? null;
      poseT = performance.now();
      if (videoAspect > 0) aspect = videoAspect;
    },

    // ── Per-frame drive (main.js RAF loop) ──────────────────────────────
    tick() {
      if (!enabled) return;
      ensureTracker();
      geo = computeGeometry();
      if (!geo) {
        // Tracking lost mid-note fails quiet, like every other source.
        silence();
        tracker.reset();
        return;
      }
      const ev = tracker.feed({
        deg: geo.pointer.deg, r: geo.pointer.r,
        t: performance.now() / 1000,
      });
      const acc = accidentalNow();
      if (ev?.type === 'attack') {
        const freqs = freqsFor(ev.section, acc);
        if (freqs) {
          engine.playChord(freqs, { velocity: ev.strength });
          sounding = ev.section;
          lastStrength = ev.strength;
          lastAcc = acc;
        }
      } else if (ev?.type === 'release') {
        silence();
      } else if (sounding !== null && acc !== lastAcc) {
        // A thumb turning over under a held note is a new note — the same
        // re-attack a bent note gets in gesture mode, at the held strength.
        const freqs = freqsFor(sounding, acc);
        if (freqs) engine.playChord(freqs, { velocity: lastStrength });
        lastAcc = acc;
      }
    },

    // ── For the panel and the overlay ───────────────────────────────────
    geometry: () => geo,
    soundingSection: () => sounding,
    // Label of one section — the note's name in note voicing (octave
    // dropped: the arc is small and the octave is the key's), the numeral in
    // chord voicing.
    sectionLabel(i, { long = false } = {}) {
      if (voicing === 'chord') {
        const c = chordmode.chordAt(i);
        return long ? `${c.numeral} · ${c.rootName}` : c.numeral;
      }
      const n = chordmode.noteAt(i, i === sounding ? lastAcc : NATURAL);
      return long ? `${n.numeral} · ${n.name}` : n.name.replace(/-?\d+$/, '');
    },

    // ── Overlay ─────────────────────────────────────────────────────────
    //
    // Drawn onto the camera overlay canvas from cv.js, in the same pass as
    // the skeletons — lx/ly are its landmark→canvas mapping. The ring is a
    // 3D circle projected orthographically: an ellipse, foreshortened by
    // however much the forearm (or chest axis) leans out of the image
    // plane, which is what makes the orientation legible. The canvas is
    // CSS-mirrored, which the geometry inherits for free (it must line up
    // with the mirrored video); only TEXT must not, so labels counter-flip
    // around their own anchor.
    draw(ctx, lx, ly, ink) {
      if (!enabled || !geo) return;
      const j = JOINTS[joint];
      const n = sectionCount();
      const width = 360 / n;
      const { u, v } = geo.basis;
      const C = [geo.anchor.x * geo.aspect, geo.anchor.y];
      const unitPx = (ly(1) - ly(0)) * geo.unit;   // one joint unit, in px
      if (!(unitPx > 2)) return;
      const col = side === 'R' ? '#00e5cc' : '#9d5cff';   // the overlay's own hand colours

      // A point of the ring: ring angle (degrees) and radius (joint units)
      // → 3D → orthographic drop of z → canvas.
      const pt = (deg, r) => {
        const rad = deg / DEG;
        const c = Math.cos(rad), s = Math.sin(rad);
        const x = C[0] + r * geo.unit * (v[0] * c + u[0] * s);
        const y = C[1] + r * geo.unit * (v[1] * c + u[1] * s);
        return [lx(x / geo.aspect), ly(y)];
      };
      const STEPS = 8;   // per section edge — a 51° arc in 8 chords is smooth

      for (let i = 0; i < n; i++) {
        const a0 = i * width - width / 2;
        ctx.beginPath();
        for (let k = 0; k <= STEPS; k++) {
          const [x, y] = pt(a0 + (width * k) / STEPS, j.rOut);
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        for (let k = STEPS; k >= 0; k--) {
          const [x, y] = pt(a0 + (width * k) / STEPS, j.rIn);
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        if (i === sounding) { ctx.fillStyle = col + '55'; ctx.fill(); }
        else if (i === tracker?.section) { ctx.fillStyle = col + '2e'; ctx.fill(); }
        ctx.strokeStyle = ink + '55';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Label at the section's middle. The canvas is mirrored, so text
        // drawn straight would read backwards — flip it back around its
        // own anchor point.
        const [tx, ty] = pt(i * width, (j.rIn + j.rOut) / 2);
        ctx.save();
        ctx.translate(tx, ty);
        ctx.scale(-1, 1);
        ctx.font = `${Math.max(9, Math.min(14, j.rIn * unitPx * 0.28)).toFixed(0)}px "IBM Plex Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = i === sounding ? ink : ink + 'cc';
        ctx.fillText(this.sectionLabel(i), 0, 0);
        ctx.restore();
      }

      // The pointer: a line from the ring's centre and a dot at the tip, in
      // the side's colour, so what the ring is reading is never a guess.
      const cx = lx(geo.anchor.x), cy = ly(geo.anchor.y);
      const px = lx(geo.pointer.x), py = ly(geo.pointer.y);
      ctx.strokeStyle = col + '88';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
    },

    serialize() {
      return { enabled, joint, side, voicing, finger, shepAuto };
    },
    load(data) {
      if (!data) return;
      joint   = JOINTS[data.joint] ? data.joint : DEFAULTS.joint;
      side    = data.side === 'L' ? 'L' : 'R';
      voicing = data.voicing === 'chord' ? 'chord' : 'note';
      finger  = FINGERS[data.finger] !== undefined ? data.finger : DEFAULTS.finger;
      shepAuto = data.shepAuto !== false;
      tracker = null; trackerCfg = '';
      silence();
      lastStrength = 0; lastAcc = NATURAL;
      enabled = false;                  // so setEnabled(true) runs its side effects
      if (data.enabled) this.setEnabled(true);
    },
  };
})();
