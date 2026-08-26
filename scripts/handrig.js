// The hand rig, shared by the illustration renderer and the check that the
// illustrations are faithful.
//
// It lives in its own module because those two need the SAME hand: a rig the
// renderer draws and a second rig the test measures would agree with each
// other exactly until the day someone edited one of them, and a verification
// that can silently stop verifying is worse than none.
//
// Loaded into a browser page (both callers serve it over HTTP and hand it
// three.js), never into node — there is no three.js import here so the caller
// controls which copy is in play.
//
// Proportions are in palm lengths, the same unit math.js normalizes by, so
// the model is expressed in the units of the feature vector that poses it.

import { fingerExt, handOpenness, dist3, thumbOut, thumbContact } from '../src/math.js';
import { templateDistance } from '../src/gesture.js';

export function buildRig(THREE) {
  // ── The rig ────────────────────────────────────────────────────────────
  // A palm and five fingers of three segments each. Proportions are in palm
  // lengths, the same unit math.js normalizes by, so the model is in the units
  // the feature vector is expressed in.
  const SKIN = new THREE.MeshStandardMaterial({
    color: 0x9fb4c7, roughness: 0.55, metalness: 0.05,
  });
  const capsule = (len, r) => new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), SKIN);

  // len/radius per finger, and where each knuckle sits across the palm.
  //
  // The scale below dates from when fingerExt was a base-to-tip DISTANCE
  // normalised by palm length, where a rig with short fingers could not reach
  // the extensions the templates asked for however straight it posed them.
  // Extension is a joint angle now, which does not depend on finger length at
  // all: a straight finger reads ~0.93 whatever its proportions. The scale is
  // left as it is because it also sets how the renders LOOK, and the renders
  // are under construction for reasons of thumb placement rather than reach.
  //
  // Relative proportions are anatomical and deliberately left alone.
  const SCALE = 1.295;
  const seg = a => a.map(v => +(v * SCALE).toFixed(4));
  const FINGERS = [
    { key: 'index',  x: -0.26, segs: seg([0.34, 0.22, 0.16]), r: 0.070 },
    { key: 'middle', x: -0.09, segs: seg([0.38, 0.24, 0.17]), r: 0.072 },
    { key: 'ring',   x:  0.08, segs: seg([0.35, 0.22, 0.16]), r: 0.068 },
    { key: 'pinky',  x:  0.24, segs: seg([0.27, 0.17, 0.13]), r: 0.058 },
  ];

  // A finger is a chain of hinges. `curl` 0 = straight, 1 = fully folded; the
  // joints do not bend equally — the knuckle leads, which is what makes a fist
  // read as a fist rather than a claw.
  const JOINT_SHARE = [0.9, 1.0, 0.8];

  function buildFinger(spec) {
    const root = new THREE.Group();
    let parent = root;
    const joints = [];
    spec.segs.forEach((len, i) => {
      const pivot = new THREE.Group();
      if (i > 0) pivot.position.y = spec.segs[i - 1];
      parent.add(pivot);
      const m = capsule(len, spec.r);
      m.position.y = len / 2;
      pivot.add(m);
      joints.push(pivot);
      parent = pivot;
    });
    // An empty at the end of the last segment: the fingertip landmark, which
    // is a position rather than a joint and so has no pivot of its own.
    const tip = new THREE.Group();
    tip.position.y = spec.segs[spec.segs.length - 1];
    parent.add(tip);
    root.userData.joints = joints;
    root.userData.tip = tip;
    return root;
  }

  const scene = new THREE.Scene();
  const hand = new THREE.Group();
  scene.add(hand);

  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.72, 0.20), SKIN);
  palm.geometry.translate(0, 0.36, 0);
  hand.add(palm);
  const wrist = capsule(0.22, 0.13);
  wrist.position.y = -0.12;
  hand.add(wrist);
  // Landmark 0. MediaPipe puts the wrist at the base of the palm, which is
  // this rig's origin — the palm box is translated to span y 0..0.72 from it,
  // so dist(lm[0], lm[9]) is the palm length math.js normalizes everything by.
  const origin = new THREE.Group();
  hand.add(origin);

  const fingers = {};
  for (const spec of FINGERS) {
    const f = buildFinger(spec);
    f.position.set(spec.x, 0.72, 0);
    hand.add(f);
    fingers[spec.key] = f;
  }

  // The thumb hangs off the side of the palm and needs two extra freedoms:
  // how far it swings away from the palm (thumbOut) and how far round it
  // reaches (spread / contacts).
  const thumb = buildFinger({ segs: seg([0.26, 0.20, 0.15]), r: 0.082 });
  const thumbYaw = new THREE.Group();
  const thumbSwing = new THREE.Group();
  thumbYaw.position.set(-0.30, 0.18, 0.02);
  thumbYaw.add(thumbSwing);
  thumbSwing.add(thumb);
  hand.add(thumbYaw);

  // ── Pose from the feature vector ───────────────────────────────────────
  // f = [thumb, index, middle, ring, pinky, open, spread, thumbOut, cIdx, cMid, cRing, cPinky]
  //
  // There is no inverse to invert: fingerExt is the SUM OF TWO JOINT ANGLES,
  // so many joint configurations share one value and 12 numbers cannot specify
  // 21 landmarks. What there IS, though, is a well-defined question — "which pose
  // measures most like this template?" — and that has an answer you can search
  // for rather than guess at.
  //
  // So this does not decode. It FITS: start from a cheap heuristic guess, then
  // walk the pose parameters downhill on templateDistance(features(rig), t)
  // until it stops improving. The picture is then, by construction, the pose
  // the app's own metric considers closest to what it is looking for.
  //
  // The previous version was a hand-written decode with invented constants,
  // and it was wrong in ways that took a round-trip to see: it drew `fist` as
  // a thumb-and-index pinch (it read contact channels the fist's mask
  // excludes), drew every thumb at the same 40° bend (it ran the thumb through
  // the finger extension window, and gesture.js says outright that channel is
  // useless — it spans 0.36 to 0.45 across all fourteen templates), and drew
  // ASL 0 as ASL 9 (it kept the first contact and dropped the other three).
  // None of those special cases survive here. A contact is just another
  // channel in the objective, so the fit brings the thumb to the fingertip
  // because the metric asks it to — and a MASKED contact does not, because
  // templateDistance weights it zero. The rules fall out of the metric instead
  // of being maintained beside it.
  const FULL_FOLD = 1.55;                       // radians at the knuckle

  const setFinger = (f, curl, splay) => {
    f.userData.joints.forEach((j, i) => { j.rotation.x = curl * FULL_FOLD * JOINT_SHARE[i]; });
    f.rotation.z = splay;
  };

  // The 12 channels cv.js publishes, from this rig's own joints.
  function features() {
    const lm = landmarks();
    return [
      fingerExt(lm, 0), fingerExt(lm, 1), fingerExt(lm, 2), fingerExt(lm, 3), fingerExt(lm, 4),
      handOpenness(lm),
      Math.min(1, dist3(lm[4], lm[20]) / (dist3(lm[0], lm[9]) * 2.5)),
      thumbOut(lm),
      thumbContact(lm, 1), thumbContact(lm, 2), thumbContact(lm, 3), thumbContact(lm, 4),
    ];
  }

  // Pose parameters, with the bounds that keep a fitted hand a plausible hand:
  // fingers do not bend backwards, and the thumb does not pass through the
  // palm. Without them the fit would happily find an anatomically impossible
  // pose that measures beautifully — the metric cannot tell.
  // `curl` runs past 1: 1.0 is the 240 degrees FULL_FOLD and JOINT_SHARE add up
  // to, and a real fist folds tighter than that — the tip comes back almost to
  // the knuckle. Capped at 1 the rig's curled fingers measured fingerExt 0.40
  // against a measured fist's 0.15-0.21, which is the difference between a
  // fist and a loose claw. Straight is still 0, so this widens the range
  // rather than shifting it.
  //          idx    mid    rng    pky   splay ×4            thumb  yawZ  yawY  swingX swingZ
  const LO = [0,     0,     0,     0,   -0.45, -0.45, -0.45, -0.45,  0.00, -0.60, -1.60, -1.90, -1.20];
  const HI = [1.45,  1.45,  1.45,  1.45, 0.45,  0.45,  0.45,  0.45,  1.00,  2.40,  1.00,  0.80,  1.20];

  function apply(P) {
    FINGERS.forEach((spec, i) => setFinger(fingers[spec.key], P[i], P[4 + i]));
    setFinger(thumb, P[8], 0);
    thumbYaw.rotation.z   = P[9];
    thumbYaw.rotation.y   = P[10];
    thumbSwing.rotation.x = P[11];
    // Reaching ACROSS the palm — which is what a tucked thumb and every
    // fingertip contact require — needs a roll as well as a yaw and a swing.
    // With three freedoms the thumb could point in the right direction but not
    // fold along the palm, so a fist's thumb measured a third of the way out.
    thumbSwing.rotation.z = P[12];
  }

  // A starting point in roughly the right basin. Coordinate descent is local,
  // so this is not cosmetic: a fist started from an open hand can settle into a
  // different pose that happens to measure the same, and the picture is what
  // makes that difference matter.
  const EXT_MIN = 0.16, EXT_MAX = 0.92;   // the measured range (gesture.js)
  const curlOf = ext => Math.min(1, Math.max(0, 1 - (ext - EXT_MIN) / (EXT_MAX - EXT_MIN)));
  const SPLAY = [1.0, 0.35, -0.35, -1.0];
  function guess(f) {
    const spread = f[6], out = f[7];
    return [
      curlOf(f[1]), curlOf(f[2]), curlOf(f[3]), curlOf(f[4]),
      ...SPLAY.map(s => s * spread * 0.30),
      // The thumb's BEND comes from thumbOut, not from its own extension
      // channel: 0 is tucked across the palm, 1 is carried clear.
      0.85 * (1 - out),
      0.50 + out * 0.95 + spread * 0.25,
      -0.55 + out * 0.30,
      -0.45 + (1 - out) * 0.30,
      (1 - out) * 0.60,
    ].map((v, i) => Math.min(HI[i], Math.max(LO[i], v)));
  }

  // Coordinate descent with a shrinking step. ~1500 evaluations per handshape,
  // each one a matrix update and twelve arithmetic features — cheap enough that
  // the search costs less than the PNG encode that follows it.
  // The metric is DEGENERATE — that is the whole reason an inverse does not
  // exist — so on any channel it does not constrain, the search is free to
  // pick anything, and "anything" is usually a hand nobody would recognise.
  // A weak pull back toward the heuristic guess breaks those ties toward a
  // plausible pose without moving the ones the template actually pins down.
  // Small enough (a tenth of the drift limit at full deflection) that it can
  // never trade real fidelity for tidiness.
  const PRIOR = 0.004;

  function fit(t) {
    const g0 = guess(t.f);
    const err = P => {
      apply(P);
      let reg = 0;
      for (let i = 0; i < P.length; i++) {
        const d = (P[i] - g0[i]) / (HI[i] - LO[i]);
        reg += d * d;
      }
      return templateDistance(features(), t) + PRIOR * reg;
    };
    let P = g0.slice(), best = err(P);
    let step = 0.30;
    for (let pass = 0; pass < 60 && step > 0.002; pass++) {
      let moved = false;
      for (let i = 0; i < P.length; i++) {
        const span = HI[i] - LO[i];
        for (const d of [step, -step]) {
          const q = P.slice();
          q[i] = Math.min(HI[i], Math.max(LO[i], q[i] + d * span));
          const e = err(q);
          if (e < best - 1e-6) { P = q; best = e; moved = true; }
        }
      }
      if (!moved) step *= 0.5;
    }
    apply(P);
    return best;
  }

  const pose = t => fit(t);

  // ── Landmarks ──────────────────────────────────────────────────────────
  // The 21 points MediaPipe publishes, read straight off the posed rig, in
  // MediaPipe's own order:
  //   0 wrist · 1-4 thumb CMC/MCP/IP/TIP · 5-8 index MCP/PIP/DIP/TIP
  //   9-12 middle · 13-16 ring · 17-20 pinky
  //
  // Taking them from the rig rather than from a vision model run over the
  // render is the whole point. MediaPipe was trained on photographs and finds
  // this capsule hand only sporadically, and only with the detector wide open
  // — landmarks from a 0.03-confidence detection measure nothing. The rig, on
  // the other hand, knows exactly where every joint is, so feeding these
  // through the real math.js closes the loop with no vision model in it and
  // no flakiness.
  function landmarks() {
    scene.updateMatrixWorld(true);
    const v = o => { const p = new THREE.Vector3(); o.getWorldPosition(p); return { x: p.x, y: p.y, z: p.z }; };
    const chain = f => [f.userData.joints[0], f.userData.joints[1], f.userData.joints[2], f.userData.tip].map(v);
    return [
      v(origin),
      ...chain(thumb),
      ...chain(fingers.index), ...chain(fingers.middle),
      ...chain(fingers.ring),  ...chain(fingers.pinky),
    ];
  }

  return { scene, hand, fingers, thumb, FINGERS, pose, landmarks };
}
