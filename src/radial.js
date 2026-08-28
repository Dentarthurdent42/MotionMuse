// Radial joint menu — play scale degrees by POINTING.
//
// A fan of equal-angle arc sections is anchored to a joint with real freedom
// of direction. On the wrist the fan rides the forearm — it is drawn around
// the wrist and rotates with the elbow→wrist axis, so it faces wherever your
// arm does — and the hand is the pointer: flex or deviate the wrist and the
// extended fingers aim at a section. On the shoulder the fan is fixed to the
// torso and the whole arm is the pointer.
//
// The sections have RADIAL THICKNESS — each is an annular sector, not a ray.
// That thickness is what makes sustain a place rather than a moment: extend
// into the ring and the note attacks, stay anywhere inside the section and it
// holds, retract past the inner edge and it releases. How FAST the pointer
// crosses into a section sets the attack strength, so a stab is loud and a
// drift is soft — the radial edge is a drum head, not a switch.
//
// Sections are the degrees of the same key gesture mode plays in
// (chordmode.effectiveKey() — one key control, shared, following Pitch
// Quantize when that is on). A 7-note mode gives seven sections, a pentatonic
// five; the fan re-divides itself when the key changes. Notes sound through
// the chord voice bank, as single notes or whole chords (a voicing option, as
// in gesture mode), with Shepard tones on by default — a menu that wraps
// around a joint pairs naturally with a timbre that wraps around the octave.
//
// The maths lives in exported pure functions (makeRadialTracker, the two
// *Geometry builders) so the boundary behaviour — hysteresis, entry speed,
// section resolution — is testable without a camera or an AudioContext:
// tests/unit/radial.test.js drives them directly.

import { engine }    from './engine.js';
import { chordmode } from './chordmode.js';
import { gesture }   from './gesture.js';
import { NATURAL, SHARP, FLAT } from './chords.js';

// ── Fan-coordinate convention ─────────────────────────────────────────────
//
// All section maths happens in FAN COORDINATES: degrees from the fan's centre
// axis, section 0 starting at −span/2. The mapping back to image space is
// `imageAngle = axisDeg + orient · fanDeg`, and `orient` (±1) is where the
// two mirror problems are solved in one place:
//
//   • The camera view is mirrored (CSS scaleX(-1)), which flips the sense of
//     every angle. For the WRIST the fan should read like a keyboard in the
//     view the player actually sees — low notes on the left — so orient is a
//     constant flip for both hands.
//   • For the SHOULDER the order is bodily, not visual: arm hanging = lowest
//     degree, arm overhead = highest, whichever arm it is. The outward axis
//     points opposite ways for the two shoulders, so orient flips with side.

const DEG = 180 / Math.PI;
const wrapDeg = a => ((a % 360) + 540) % 360 - 180;   // → [-180, 180)

// ── Per-joint tuning ──────────────────────────────────────────────────────
//
// Radii are in JOINT UNITS — palm lengths for the wrist (wrist→middle-MCP),
// arm lengths for the shoulder (shoulder→elbow + elbow→wrist) — so they are
// independent of hand size and distance from the camera.
//
//   rIn     inner edge of the ring: where an attack fires. Wrist: an extended
//           middle fingertip reaches ~1.9 palm units, a curled one ~0.7–1.0,
//           so 1.55 asks for deliberately extended fingers. Shoulder: a
//           straightened arm projects ~0.9 of its own length in the image
//           plane, a hand pulled to the chest ~0.45.
//   rOut    outer edge — drawn, and a bound on the ring, but chosen past what
//           the pointer can physically reach so play never falls off the far
//           side of a section.
//   hystR   how far back INSIDE rIn the pointer must retract to release, so a
//           fingertip resting on the edge doesn't machine-gun the envelope.
//   vRef    entry speed (joint units/s) that earns a full-strength attack.
//   span    default fan width, degrees. Wrist flexion+deviation sweeps about
//           ±75° in the image plane; a shoulder sweeps a full half-turn.
export const JOINTS = {
  wrist:    { rIn: 1.55, rOut: 2.2, hystR: 0.15, vRef: 10,  span: 150 },
  shoulder: { rIn: 0.68, rOut: 1.1, hystR: 0.07, vRef: 2.5, span: 180 },
};

// The strength a dead-slow entry still gets: a deliberate drift into a
// section is a note meant quietly, not a note not meant.
export const V_FLOOR = 0.35;

// Angular hysteresis at section boundaries, degrees. Movement between
// sections re-attacks; this keeps a pointer resting ON a boundary from
// re-attacking every frame of jitter.
export const HYST_DEG = 4;

// ── The tracker: samples in, attack/release events out ────────────────────
//
// feed() takes { relDeg, r, t } — fan-coordinate angle, radius in joint
// units, time in seconds — and returns one of
//   { type: 'attack',  section, strength }   entered the ring, or crossed
//                                            into a neighbouring section
//   { type: 'release' }                      retracted, or left the fan
// or null. Strength ∈ [V_FLOOR, 1] from the pointer's speed across the
// boundary it just crossed.
export function makeRadialTracker({
  sections, spanDeg, rIn, rOut,
  hystR = 0.1, hystDeg = HYST_DEG, vRef = 6, vFloor = V_FLOOR,
} = {}) {
  const width = spanDeg / sections;
  let section = null;       // sounding section, or null
  let prev = null;          // { x, y, t } last sample, for entry speed

  const sectionAt = relDeg =>
    (relDeg < -spanDeg / 2 || relDeg >= spanDeg / 2) ? null
      : Math.min(sections - 1, Math.floor((relDeg + spanDeg / 2) / width));

  // Speed across the last inter-sample step. Cartesian, so a purely angular
  // crossing (sliding along inside the ring) is measured by the same yard-
  // stick as a radial stab — arc length is distance like any other.
  const speedFrom = (x, y, t) => {
    if (!prev) return 0;
    const dt = t - prev.t;
    if (dt < 0.005) return 0;              // same-millisecond duplicates
    return Math.hypot(x - prev.x, y - prev.y) / dt;
  };
  const strengthFrom = v => Math.min(1, vFloor + (1 - vFloor) * (v / vRef));

  return {
    feed({ relDeg, r, t }) {
      const rad = relDeg / DEG;
      const x = r * Math.cos(rad), y = r * Math.sin(rad);
      const v = speedFrom(x, y, t);
      prev = { x, y, t };

      if (section === null) {
        // Arming: the ring plus the fan, no hysteresis — margins exist to
        // keep a held note from chattering, not to make entry harder.
        const s = (r >= rIn && r <= rOut) ? sectionAt(relDeg) : null;
        if (s === null) return null;
        section = s;
        return { type: 'attack', section, strength: strengthFrom(v) };
      }

      // Holding: release only past the margins…
      if (r < rIn - hystR || r > rOut + hystR) {
        section = null;
        return { type: 'release' };
      }
      // …and the held section keeps its boundaries sticky by hystDeg.
      const lo = -spanDeg / 2 + section * width;
      if (relDeg >= lo - hystDeg && relDeg < lo + width + hystDeg) return null;
      const s = sectionAt(relDeg);
      if (s === null) { section = null; return { type: 'release' }; }
      section = s;
      return { type: 'attack', section, strength: strengthFrom(v) };
    },
    reset() { section = null; prev = null; },
    get section() { return section; },
  };
}

// ── Geometry: landmarks → anchor, axis and pointer ────────────────────────
//
// MediaPipe landmarks are normalized to the FRAME — x by its width, y by its
// height — so raw coordinates are anisotropic and an angle measured in them
// is wrong by the aspect ratio. Everything here works in aspect-corrected
// space (x · aspect, y), where a circle is a circle; `anchor` keeps the raw
// normalized point too, because that is what the overlay's own transform
// expects. `unit` comes out in y-normalized units, which is exactly the
// scale the overlay canvas draws in.

const ac = (p, aspect) => ({ x: p.x * aspect, y: p.y });
const angleOf = (from, to) => Math.atan2(to.y - from.y, to.x - from.x) * DEG;
const distOf  = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Wrist fan: anchored on the hand's own wrist, one palm-length the unit.
 * The axis is the forearm (pose elbow → hand wrist), so the fan rotates with
 * the arm; with no pose the fan stays upright in the frame instead — still
 * playable, just fixed to the camera rather than to you.
 * Pointer: the middle fingertip. Extending the fingers reaches into the
 * ring; curling them retracts and releases.
 */
export function wristGeometry(hand, elbow, aspect = 4 / 3) {
  if (!hand?.[0] || !hand[9] || !hand[12]) return null;
  const anchor = ac(hand[0], aspect);
  const unit = distOf(anchor, ac(hand[9], aspect));
  if (unit < 1e-4) return null;
  const axisDeg = elbow ? angleOf(ac(elbow, aspect), anchor) : -90;
  const tip = ac(hand[12], aspect);
  return {
    anchor: { x: hand[0].x, y: hand[0].y },
    axisDeg,
    orient: -1,                       // mirror view: low notes to the left
    unit,
    pointer: {
      x: hand[12].x, y: hand[12].y,
      r: distOf(anchor, tip) / unit,
      fanDeg: -wrapDeg(angleOf(anchor, tip) - axisDeg),
    },
  };
}

/**
 * Shoulder fan: anchored on the shoulder, the whole arm the pointer, its own
 * straightened length the unit. The axis points out from the body — the
 * torso's own across-axis, so it leans when you do — and the fan spans from
 * arm-hanging (lowest degree) to arm-overhead (highest), whichever arm.
 * Pointer: the pose wrist. Straighten the arm to reach the ring; bend the
 * elbow to retract and release.
 */
export function shoulderGeometry(side, pose, aspect = 4 / 3) {
  if (!pose) return null;
  const [ls, rs, lh, rh] = [11, 12, 23, 24].map(i => pose[i]);
  const sh = side === 'L' ? pose[11] : pose[12];
  const el = side === 'L' ? pose[13] : pose[14];
  const wr = side === 'L' ? pose[15] : pose[16];
  if (!ls || !rs || !lh || !rh || !sh || !el || !wr) return null;

  const shoulder = ac(sh, aspect), elbow = ac(el, aspect), wrist = ac(wr, aspect);
  const unit = distOf(shoulder, elbow) + distOf(elbow, wrist);
  if (unit < 1e-3) return null;

  // Torso frame in the image plane: down the spine, and outward = the
  // perpendicular that points from the body's midline through this shoulder.
  const sMid = ac({ x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 }, aspect);
  const hMid = ac({ x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 }, aspect);
  const down = { x: hMid.x - sMid.x, y: hMid.y - sMid.y };
  const dLen = Math.hypot(down.x, down.y);
  if (dLen < 1e-4) return null;
  let out = { x: -down.y / dLen, y: down.x / dLen };
  if (out.x * (shoulder.x - sMid.x) + out.y * (shoulder.y - sMid.y) < 0) {
    out = { x: -out.x, y: -out.y };
  }
  const axisDeg = Math.atan2(out.y, out.x) * DEG;

  // Down-to-up ordering needs the fan coordinate to grow as the arm rises;
  // "rising" turns opposite ways in image angle on the two sides.
  const orient = side === 'L' ? -1 : 1;
  return {
    anchor: { x: sh.x, y: sh.y },
    axisDeg,
    orient,
    unit,
    pointer: {
      x: wr.x, y: wr.y,
      r: distOf(shoulder, wrist) / unit,
      fanDeg: orient * wrapDeg(angleOf(shoulder, wrist) - axisDeg),
    },
  };
}

// ── The instrument ────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: false,
  joint: 'wrist',                    // 'wrist' | 'shoulder'
  side: 'R',
  voicing: 'note',                   // 'note' | 'chord' — as in gesture mode
  spans: { wrist: JOINTS.wrist.span, shoulder: JOINTS.shoulder.span },
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
  let spans    = { ...DEFAULTS.spans };
  let shepAuto = DEFAULTS.shepAuto;

  let hands = { L: null, R: null };   // latest hand landmarks per side
  let pose = null;                    // latest pose landmarks
  // Freshness is PER SIDE: a hand the cursor has claimed stops being fed, and
  // one shared clock would let the other hand keep it forever "fresh" — a
  // frozen pointer holding a note nothing can stop.
  let handT = { L: 0, R: 0 };
  let poseT = 0, aspect = 4 / 3;

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
    if (joint === 'shoulder') return shoulderGeometry(side, p, aspect);
    const hand = (now - handT[side] < FEED_MS) ? hands[side] : null;
    if (!hand) return null;
    const elbow = p?.[side === 'L' ? 13 : 14] ?? null;
    return wristGeometry(hand, elbow, aspect);
  };

  const ensureTracker = () => {
    const j = JOINTS[joint];
    const cfg = `${joint}|${sectionCount()}|${spans[joint]}`;
    if (tracker && cfg === trackerCfg) return;
    // A re-divided fan (key change, joint change, span drag) invalidates the
    // held section's meaning, so the note lets go rather than drifting.
    silence();
    tracker = makeRadialTracker({
      sections: sectionCount(), spanDeg: spans[joint],
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

    config: () => ({ joint, side, voicing, span: spans[joint], shepAuto }),
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
    setSpan(deg) {
      const v = Math.round(Number(deg));
      if (Number.isFinite(v)) spans[joint] = Math.max(60, Math.min(300, v));
      ensureTracker();
      return spans[joint];
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
        relDeg: geo.pointer.fanDeg, r: geo.pointer.r,
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
    // the skeletons — lx/ly are its landmark→canvas mapping. The canvas is
    // CSS-mirrored, which the fan geometry inherits for free (it must line
    // up with the mirrored video); only TEXT must not, so labels counter-
    // flip around their own anchor.
    draw(ctx, lx, ly, ink) {
      if (!enabled || !geo) return;
      const j = JOINTS[joint];
      const span = spans[joint];
      const n = sectionCount();
      const width = span / n;
      const unitPx = (ly(1) - ly(0)) * geo.unit;   // one joint unit, in px
      if (!(unitPx > 2)) return;
      const cx = lx(geo.anchor.x), cy = ly(geo.anchor.y);
      const rIn = j.rIn * unitPx, rOut = j.rOut * unitPx;
      const col = side === 'R' ? '#00e5cc' : '#9d5cff';   // the overlay's own hand colours
      const rad = fanDeg => (geo.axisDeg + geo.orient * fanDeg) / DEG;

      for (let i = 0; i < n; i++) {
        const a0 = rad(-span / 2 + i * width);
        const a1 = rad(-span / 2 + (i + 1) * width);
        const ccw = geo.orient < 0;
        ctx.beginPath();
        ctx.arc(cx, cy, rOut, a0, a1, ccw);
        ctx.arc(cx, cy, rIn, a1, a0, !ccw);
        ctx.closePath();
        if (i === sounding) { ctx.fillStyle = col + '55'; ctx.fill(); }
        else if (i === tracker?.section) { ctx.fillStyle = col + '2e'; ctx.fill(); }
        ctx.strokeStyle = ink + '55';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Label at the section's middle. The canvas is mirrored, so text
        // drawn straight would read backwards — flip it back around its
        // own anchor point.
        const mid = rad(-span / 2 + (i + 0.5) * width);
        const mr = (rIn + rOut) / 2;
        const tx = cx + mr * Math.cos(mid), ty = cy + mr * Math.sin(mid);
        ctx.save();
        ctx.translate(tx, ty);
        ctx.scale(-1, 1);
        ctx.font = `${Math.max(9, Math.min(14, rIn * 0.22)).toFixed(0)}px "IBM Plex Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = i === sounding ? ink : ink + 'cc';
        ctx.fillText(this.sectionLabel(i), 0, 0);
        ctx.restore();
      }

      // The pointer: a line from the anchor and a dot at the tip, in the
      // side's colour, so what the fan is reading is never a guess.
      const px = lx(geo.pointer.x), py = ly(geo.pointer.y);
      ctx.strokeStyle = col + '88';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
    },

    serialize() {
      return { enabled, joint, side, voicing, spans: { ...spans }, shepAuto };
    },
    load(data) {
      if (!data) return;
      joint   = JOINTS[data.joint] ? data.joint : DEFAULTS.joint;
      side    = data.side === 'L' ? 'L' : 'R';
      voicing = data.voicing === 'chord' ? 'chord' : 'note';
      spans   = { ...DEFAULTS.spans };
      for (const k of Object.keys(spans)) {
        const v = Math.round(Number(data.spans?.[k]));
        if (Number.isFinite(v)) spans[k] = Math.max(60, Math.min(300, v));
      }
      shepAuto = data.shepAuto !== false;
      tracker = null; trackerCfg = '';
      silence();
      lastStrength = 0; lastAcc = NATURAL;
      enabled = false;                  // so setEnabled(true) runs its side effects
      if (data.enabled) this.setEnabled(true);
    },
  };
})();
