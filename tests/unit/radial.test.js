// Radial joint menu: section resolution on the closed circle, boundary
// hysteresis, entry-speed → attack strength, and the two ring geometries —
// the parts that decide what a pointing arm actually plays, driven without a
// camera or an AudioContext.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeRadialTracker, makeRingSmoother, ringBasis, wristGeometry,
         shoulderGeometry, JOINTS, FINGERS, V_FLOOR, MIN_TILT, RING_THICKNESS,
         HYST_DEG, radial } from '../../src/radial.js';
import { chordmode, EXPRESSION_RANGE } from '../../src/chordmode.js';
import { bus } from '../../src/bus.js';
import { engine }    from '../../src/engine.js';

// A seven-section ring: ~51.4° per section, section 0 CENTRED on 0°.
const ring = (over = {}) => makeRadialTracker({
  sections: 7, rIn: 1.5, rOut: 2.2,
  hystR: 0.15, hystDeg: 4, vRef: 10,
  ...over,
});

// Feed a path of {deg, r} samples 30 ms apart, collecting events.
const run = (t, path, dt = 0.03) => {
  const out = [];
  path.forEach((p, i) => {
    const ev = t.feed({ ...p, t: i * dt });
    if (ev) out.push(ev);
  });
  return out;
};

test('the circle divides into equal sections, section 0 centred on 0°', () => {
  const w = 360 / 7;
  for (let i = 0; i < 7; i++) {
    const t = ring();
    const mid = i * w;      // each section's centre
    const evs = run(t, [{ deg: mid, r: 1.0 }, { deg: mid, r: 1.8 }]);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].type, 'attack');
    assert.equal(evs[0].section, i, `${mid}° lands on section ${i}`);
  }
});

test('the circle is closed: angles wrap, and the seam is just another boundary', () => {
  const w = 360 / 7;
  // Just past section 0's start boundary, approached from below zero.
  const t = ring();
  const evs = run(t, [{ deg: -w / 2 - 3, r: 1.0 }, { deg: -w / 2 - 3, r: 1.8 }]);
  assert.equal(evs[0].section, 6, 'just below the seam is the last section');
  // …and 360° away is the same place.
  const t2 = ring();
  assert.equal(run(t2, [{ deg: 357 - 360 * 2, r: 1.8 }])[0].section, 0);
});

test('inside the inner radius is nowhere — the only outside is radial', () => {
  const t = ring();
  assert.equal(t.feed({ deg: 0, r: 1.0, t: 0 }), null, 'retracted');
  assert.equal(t.feed({ deg: 180, r: 1.0, t: 0.03 }), null, 'any angle, still retracted');
});

test('entering fast attacks hard, entering slow attacks soft', () => {
  // Fast: r jumps 0.8 joint units in 30 ms ≈ 27 units/s — over vRef, so 1.
  const hard = run(ring(), [{ deg: 0, r: 1.0 }, { deg: 0, r: 1.8 }]);
  assert.equal(hard[0].strength, 1);

  // Slow: creep in at ~0.7 units/s. Still a note — at the floor, not zero.
  const creep = Array.from({ length: 40 }, (_, i) => ({ deg: 0, r: 1.0 + i * 0.02 }));
  const soft = run(ring(), creep);
  assert.equal(soft.length, 1);
  assert.ok(soft[0].strength < 0.45, `soft entry stays soft (${soft[0].strength})`);
  assert.ok(soft[0].strength >= V_FLOOR, 'but never below the floor');
});

test('staying inside the section sustains — no events at all', () => {
  const t = ring();
  run(t, [{ deg: 10, r: 1.0 }, { deg: 10, r: 1.8 }]);
  const evs = run(t, Array.from({ length: 30 }, (_, i) =>
    ({ deg: 10 + Math.sin(i) * 3, r: 1.8 + Math.cos(i) * 0.1 })));
  assert.deepEqual(evs, []);
});

test('the inner edge is sticky: releases only past the hysteresis margin', () => {
  const t = ring();
  run(t, [{ deg: 0, r: 1.0 }, { deg: 0, r: 1.7 }]);
  assert.equal(t.feed({ deg: 0, r: 1.42, t: 1 }), null, 'resting ON the edge holds');
  const ev = t.feed({ deg: 0, r: 1.3, t: 1.03 });
  assert.equal(ev.type, 'release');
  // …and coming back is a fresh attack.
  assert.equal(t.feed({ deg: 0, r: 1.8, t: 1.06 }).type, 'attack');
});

test('section boundaries are sticky the same way — across the seam too', () => {
  const w = 360 / 7;
  const t = ring();
  run(t, [{ deg: 0, r: 1.0 }, { deg: 0, r: 1.8 }]);        // section 0
  // Jitter across the boundary by less than hystDeg: held.
  assert.equal(t.feed({ deg: w / 2 + 2, r: 1.8, t: 1 }), null);
  // A real move re-attacks in the neighbour — one event, the new section.
  const ev = t.feed({ deg: w / 2 + 6, r: 1.8, t: 1.03 });
  assert.equal(ev.type, 'attack');
  assert.equal(ev.section, 1);
  // Sweep the other way, across 0's start boundary into the LAST section:
  // the seam is a neighbour like any other.
  const t2 = ring();
  run(t2, [{ deg: 0, r: 1.0 }, { deg: 0, r: 1.8 }]);
  assert.equal(t2.feed({ deg: -w / 2 - 2, r: 1.8, t: 1 }), null, 'sticky at the seam');
  assert.equal(t2.feed({ deg: -w / 2 - 6, r: 1.8, t: 1.03 }).section, 6);
});

// ── Ring basis ────────────────────────────────────────────────────────────

// Component-wise closeness — cross products produce −0s deepEqual rejects.
const near = (got, want, msg) =>
  got.forEach((c, i) => assert.ok(Math.abs(c - want[i]) < 1e-9, `${msg} [${i}]: ${c}`));

test('with no axis the ring faces the camera and reads like a clock', () => {
  const { n, u, v } = ringBasis(null);
  near(n, [0, 0, -1], 'normal');
  near(v, [0, -1, 0], '0° points up the image');
  near(u, [-1, 0, 0], '90° points raw-left — screen-right in the mirror');
});

test('the normal is canonicalised and tilt-floored', () => {
  // An axis pointing away from the camera flips toward it, so the section
  // order on screen cannot mirror when the arm tilts through the image plane.
  assert.ok(ringBasis([0, 0, 1]).n[2] < 0);
  // An axis lying in the image plane keeps MIN_TILT of depth, so the drawn
  // ellipse never collapses to a line.
  const { n } = ringBasis([0, -1, 0]);
  assert.ok(Math.abs(-n[2] - MIN_TILT) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-9, 'still unit length');
});

// ── Wrist geometry ────────────────────────────────────────────────────────

// A synthetic hand: wrist at centre, palm 0.1 units long pointing up, and a
// fingertip wherever the test puts it.
const hand = (tip, at = FINGERS.index) => {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  lm[0] = { x: 0.5, y: 0.5 };
  lm[9] = { x: 0.5, y: 0.4 };
  lm[at] = tip;
  return lm;
};

test('the wrist ring measures perpendicular reach in palm units', () => {
  // Camera-facing ring (no forearm): a tip 0.18 up from the wrist is 1.8
  // palm units out, at the top of the clock.
  const g = wristGeometry(hand({ x: 0.5, y: 0.32 }), null, 1);
  assert.ok(Math.abs(g.pointer.r - 1.8) < 1e-9);
  assert.ok(Math.abs(g.pointer.deg) < 1e-9, 'up is 0° — the top of the clock');
});

test('the clock ascends clockwise in the mirrored view', () => {
  // Tip toward raw-left, which the mirrored canvas shows on the RIGHT: a
  // quarter-turn clockwise from the top.
  const g = wristGeometry(hand({ x: 0.32, y: 0.5 }), null, 1);
  assert.ok(Math.abs(g.pointer.deg - 90) < 1e-9);
  const g2 = wristGeometry(hand({ x: 0.5, y: 0.68 }), null, 1);
  assert.ok(Math.abs(Math.abs(g2.pointer.deg) - 180) < 1e-9, 'down is the bottom');
});

test('the ring rides the forearm: reach is measured square to it', () => {
  // Forearm pointing up the image. A fingertip extended straight along it
  // sits ON the axis — almost no perpendicular reach, however long it is.
  const along = wristGeometry(hand({ x: 0.5, y: 0.31 }), [0, -0.3, 0], 1);
  assert.ok(along.pointer.r < 0.7, `along the axis is retracted (${along.pointer.r})`);
  // The same fingertip swung square to the axis reaches the band. 0.15 of a
  // frame on a 0.1 palm is 1.5 palm units out — past rIn, which sits at two
  // thirds of rOut, so entering asks for a real bend rather than a twitch.
  const across = wristGeometry(hand({ x: 0.35, y: 0.5 }), [0, -0.3, 0], 1);
  assert.ok(across.pointer.r > JOINTS.wrist.rIn,
    `across the axis reaches the ring (${across.pointer.r} vs ${JOINTS.wrist.rIn})`);
});

test('every joint wears the same band: a third of the outer radius', () => {
  for (const [name, j] of Object.entries(JOINTS)) {
    assert.ok(Math.abs((j.rOut - j.rIn) / j.rOut - RING_THICKNESS) < 1e-9,
      `${name} band is ${((j.rOut - j.rIn) / j.rOut).toFixed(3)} of its outer radius`);
    assert.ok(j.hystR < j.rOut - j.rIn,
      `${name}: the release margin must be smaller than the band it guards`);
  }
});

test('the pointer is the chosen fingertip — index by default', () => {
  const middleOnly = hand({ x: 0.5, y: 0.32 }, FINGERS.middle);
  const gDefault = wristGeometry(middleOnly, null, 1);
  assert.ok(gDefault.pointer.r < 0.1, 'the index did not move, so the default did not either');
  const gMiddle = wristGeometry(middleOnly, null, 1, FINGERS.middle);
  assert.ok(Math.abs(gMiddle.pointer.r - 1.8) < 1e-9);
});

// ── Shoulder geometry ─────────────────────────────────────────────────────

// A torso facing the camera: subject's left side at larger raw x.
const pose = over => {
  const lm = Array.from({ length: 33 }, () => null);
  lm[11] = { x: 0.6, y: 0.4 };   // L shoulder
  lm[12] = { x: 0.4, y: 0.4 };   // R shoulder
  lm[23] = { x: 0.58, y: 0.7 };  // L hip
  lm[24] = { x: 0.42, y: 0.7 };  // R hip
  return Object.assign(lm, over);
};

test('shoulder ring: hanging arm is 0°, ascending toward out and overhead — both sides', () => {
  const mk = (side, wrist) => shoulderGeometry(side, pose(side === 'R'
    ? { 14: { x: 0.4, y: 0.55 }, 16: wrist }
    : { 13: { x: 0.6, y: 0.55 }, 15: wrist }), 1);
  assert.ok(Math.abs(mk('R', { x: 0.4, y: 0.7 }).pointer.deg) < 1e-6, 'hanging = 0°');
  assert.ok(Math.abs(mk('R', { x: 0.1, y: 0.4 }).pointer.deg - 90) < 1e-6, 'out to the side = 90°');
  assert.ok(Math.abs(Math.abs(mk('R', { x: 0.4, y: 0.1 }).pointer.deg) - 180) < 1e-6, 'overhead = 180°');
  assert.ok(Math.abs(mk('L', { x: 0.6, y: 0.7 }).pointer.deg) < 1e-6, 'same reading for the left arm');
  assert.ok(Math.abs(mk('L', { x: 0.9, y: 0.4 }).pointer.deg - 90) < 1e-6, 'out is out on either side');
});

test('shoulder radius is in-plane reach: a forward-pointing arm is retracted', () => {
  const straight = pose({ 14: { x: 0.4, y: 0.55 }, 16: { x: 0.4, y: 0.7 } });
  const gs = shoulderGeometry('R', straight, 1);
  assert.ok(Math.abs(gs.pointer.r - 1) < 1e-6, 'straight arm in the torso plane reaches fully');

  const bent = pose({ 14: { x: 0.4, y: 0.55 }, 16: { x: 0.47, y: 0.44 } });
  assert.ok(shoulderGeometry('R', bent, 1).pointer.r < JOINTS.shoulder.rIn,
    'a bent elbow retracts out of the ring');

  // The whole arm pointing at the camera lies along the ring's normal:
  // almost no in-plane reach, so pointing forward is how you let go.
  const forward = pose({ 14: { x: 0.4, y: 0.55, z: -0.15 }, 16: { x: 0.4, y: 0.55, z: -0.3 } });
  assert.ok(shoulderGeometry('R', forward, 1).pointer.r < JOINTS.shoulder.rIn,
    'an arm along the normal is retracted');
});

test('missing landmarks mean no ring, not a broken one', () => {
  assert.equal(shoulderGeometry('R', null, 1), null);
  assert.equal(shoulderGeometry('R', pose({}), 1), null, 'no arm landmarks');
  assert.equal(wristGeometry(null, null, 1), null);
});

// ── The instrument glue ───────────────────────────────────────────────────

test('enabling radial mode parks gesture mode and defaults to Shepard tones', () => {
  chordmode.setEnabled(true);
  engine.setShepard({ chord: false });
  radial.setEnabled(true);
  assert.equal(chordmode.enabled, false, 'one instrument on the chord bank at a time');
  assert.equal(engine.getShepard().chord, true, 'Shepard is the mode’s default voice');
  radial.setEnabled(false);
});

test('the Shepard default stands down once the player overrules it', () => {
  radial.load({ enabled: false });          // resets shepAuto to its default
  radial.setEnabled(true);
  radial.toggleShepard();                   // player turns it off, from this panel
  assert.equal(engine.getShepard().chord, false);
  radial.setEnabled(false);
  radial.setEnabled(true);
  assert.equal(engine.getShepard().chord, false, 're-enabling honours the choice');
  radial.setEnabled(false);
});

test('settings round-trip through serialize/load', () => {
  radial.load({ enabled: false, joint: 'shoulder', side: 'L', voicing: 'chord',
                finger: 'middle', shepAuto: false });
  const snap = radial.serialize();
  radial.load({ enabled: false });          // stomp with defaults
  radial.load(snap);
  assert.deepEqual(radial.serialize(), snap);
  const cfg = radial.config();
  assert.equal(cfg.joint, 'shoulder');
  assert.equal(cfg.side, 'L');
  assert.equal(cfg.voicing, 'chord');
  assert.equal(cfg.finger, 'middle');
  radial.load({ enabled: false });          // leave the module on defaults
});

test('junk in a loaded snapshot falls back instead of wedging', () => {
  radial.load({ enabled: false, joint: 'elbow??', side: 'both', voicing: 'loud',
                finger: 'toe' });
  const cfg = radial.config();
  assert.equal(cfg.joint, 'wrist');
  assert.equal(cfg.side, 'R');
  assert.equal(cfg.voicing, 'note');
  assert.equal(cfg.finger, 'index', 'the pointing finger is the fallback');
  radial.load({ enabled: false });
});

// ── Volume expression ─────────────────────────────────────────────────────

test('choosing a volume source re-seeds its measured range — an explicit range still wins', () => {
  radial.load({ enabled: false });
  assert.equal(radial.volumeState().mode, 'off', 'entry speed is the default');
  radial.setVolume({ mode: 'hand' });
  assert.deepEqual(radial.volumeState(), { mode: 'hand', ...EXPRESSION_RANGE.hand },
    'hand openness arrives with the openness range, as in gesture mode');
  radial.setVolume({ mode: 'brow' });
  assert.deepEqual(radial.volumeState(), { mode: 'brow', ...EXPRESSION_RANGE.brow });
  radial.setVolume({ mode: 'hand', lo: 0.3, hi: 0.8 });
  assert.deepEqual(radial.volumeState(), { mode: 'hand', lo: 0.3, hi: 0.8 });
  radial.load({ enabled: false });
});

test('the off hand’s openness maps onto travel with a silent floor', () => {
  // The ring on the RIGHT wrist reads the LEFT hand — the ring’s own off side.
  bus.register('hand_L_open', { min: 0, max: 1 });
  radial.load({ enabled: false, side: 'R', volume: { mode: 'hand' } });
  const at = raw => { bus.update('hand_L_open', raw); return radial.volumeLevel(); };
  assert.equal(at(0.90).level, 1, 'a fully open hand reaches full volume');
  assert.equal(at(0.42).level, 0, 'a fist reaches true silence…');
  assert.equal(at(0.46).level, 0, '…and does not have to be hit exactly (dead zone)');
  const mid = at(0.66);
  assert.ok(mid.level > 0.35 && mid.level < 0.5, `half-open is around half (${mid.level})`);
  assert.ok(Math.abs(mid.raw - 0.66) < 1e-9, 'the meter reports the raw value it read');
  radial.load({ enabled: false });
});

test('a signal-volume latch: sweep does not bend the note, silence re-aims it', () => {
  // "hold the last chord until the volume input releases and change the
  // note/chord when it rearticulates" — the latch. While the signal is OPEN
  // the pitch is frozen: moving the pointer, or losing the ring hand
  // entirely, changes nothing. Only silence lets the aim move, and the next
  // articulation sounds whatever was aimed at last.
  bus.register('hand_L_open', { min: 0, max: 1 });
  radial.load({ enabled: true, joint: 'wrist', side: 'R', volume: { mode: 'hand' } });
  const hand = tip => {
    const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
    lm[0] = { x: 0.5, y: 0.5 }; lm[9] = { x: 0.5, y: 0.4 }; lm[8] = tip;
    return lm;
  };
  // The ring smooths its pointer against the wall clock; back-to-back test
  // ticks share one instant, where a One-Euro moves nothing. Step time the
  // way real frames do.
  const realNow = performance.now.bind(performance);
  let skew = 0;
  performance.now = () => realNow() + skew;
  const TOP = { x: 0.5, y: 0.32 };    // section 0, straight up the ring
  const LEFT = { x: 0.32, y: 0.5 };   // 90° round — section 2 of seven
  const CURL = { x: 0.5, y: 0.45 };   // retracted, out of the band
  const step = (tip, n = 1) => {
    for (let i = 0; i < n; i++) { skew += 33; radial.feedHands({ R: hand(tip) }, null, 1); radial.tick(); }
  };
  try {
    bus.update('hand_L_open', 0.42);           // fist: silence
    step(TOP, 6);
    assert.equal(radial.soundingSection(), null, 'a closed signal is silence');
    assert.equal(radial.latchedSection(), 0, 'but the aim is taken');
    bus.update('hand_L_open', 0.9);            // open: articulate
    step(TOP);
    assert.equal(radial.soundingSection(), 0, 'the articulation sounds the latched degree');
    step(LEFT, 8);                             // sweep, still open
    assert.equal(radial.soundingSection(), 0, 'the pitch is frozen while the signal is open');
    assert.equal(radial.latchedSection(), 0, 'and so is the latch — no glissando round the ring');
    step(CURL, 8);                             // retract, still open
    assert.equal(radial.soundingSection(), 0, 'the ring only names — retracting cannot cut a held note');
    bus.update('hand_L_open', 0.42);           // close: release
    step(CURL);
    assert.equal(radial.soundingSection(), null, 'the signal is the only gate');
    step(LEFT, 8);                             // re-aim in the silence
    assert.equal(radial.latchedSection(), 2, 'silence lets the latch re-aim');
    bus.update('hand_L_open', 0.9);            // rearticulate
    step(LEFT);
    assert.equal(radial.soundingSection(), 2, 'the next articulation takes the new aim');
  } finally {
    performance.now = realNow;
    radial.load({ enabled: false });
  }
});

test('volume settings round-trip, and junk falls back instead of wedging', () => {
  radial.load({ enabled: false, volume: { mode: 'brow', lo: 0.1, hi: 0.6 } });
  const snap = radial.serialize();
  radial.load({ enabled: false });
  radial.load(snap);
  assert.deepEqual(radial.volumeState(), { mode: 'brow', lo: 0.1, hi: 0.6 });
  radial.load({ enabled: false, volume: { mode: 'loud??', lo: 'wide', hi: -3 } });
  const v = radial.volumeState();
  assert.equal(v.mode, 'off');
  assert.ok(v.hi > v.lo, 'the range stays a range');
  radial.load({ enabled: false });
});

// ── Ring smoothing ────────────────────────────────────────────────────────
//
// The ring reads raw landmarks, and hand z — the noisiest number MediaPipe
// produces — is in every one of its measurements. These pin the smoother's
// bargain: a live hand's jitter dies below the angular hysteresis, a
// deliberate move still lands within a few frames, and the seam never turns
// a wobble into a lap of the circle.

const sgeo = (deg, r) => ({ anchor: { x: 0.5, y: 0.5 }, unit: 0.1, aspect: 1,
                            basis: null, pointer: { x: 0.5, y: 0.4, r, deg } });

test('hold jitter settles under the boundary hysteresis', () => {
  const sm = makeRingSmoother();
  // ±8° / ±0.2r deterministic jitter at 30fps, held ON a section boundary —
  // the worst place to stand, and raw it would re-attack every other frame.
  let minD = 1e9, maxD = -1e9, minR = 1e9, maxR = -1e9;
  for (let i = 0; i < 90; i++) {
    const nz = (i % 2 ? 1 : -1) * 8 * (((i * 7) % 5) + 1) / 5;
    const out = sm.smooth(sgeo(26 + nz, 1.6 + ((i % 3) - 1) * 0.2), i / 30);
    if (i > 30) {
      minD = Math.min(minD, out.pointer.deg); maxD = Math.max(maxD, out.pointer.deg);
      minR = Math.min(minR, out.pointer.r);   maxR = Math.max(maxR, out.pointer.r);
    }
  }
  assert.ok(maxD - minD < HYST_DEG, `±8° of noise settles to ${(maxD - minD).toFixed(2)}° — under the ${HYST_DEG}° hysteresis`);
  assert.ok(maxR - minR < JOINTS.wrist.hystR, `±0.2r of noise settles under the release margin (${(maxR - minR).toFixed(3)})`);
});

test('a deliberate move still lands within a few frames', () => {
  const sm = makeRingSmoother();
  for (let i = 0; i < 30; i++) sm.smooth(sgeo(26, 1.6), i / 30);
  let out;
  for (let i = 0; i < 6; i++) out = sm.smooth(sgeo(116, 1.6), 1 + i / 30);
  assert.ok(Math.abs(out.pointer.deg - 116) < 10,
    `a quarter-turn arrives in six frames (${out.pointer.deg.toFixed(1)}°)`);
});

test('the seam smooths as a seam, not as a lap of the circle', () => {
  // Filtering DEGREES would average 178 and −178 to zero — the opposite side
  // of the ring. The unit-vector filter must keep the pointer at the seam.
  const sm = makeRingSmoother();
  for (let i = 0; i < 60; i++) {
    const out = sm.smooth(sgeo(i % 2 ? 178 : -178, 1.6), i / 30);
    if (i > 20) assert.ok(Math.abs(out.pointer.deg) > 170,
      `seam wobble stays at the seam (${out.pointer.deg.toFixed(1)}°)`);
  }
});

test('a reacquired hand snaps to where it is, not glides from where it was lost', () => {
  const sm = makeRingSmoother();
  for (let i = 0; i < 30; i++) sm.smooth(sgeo(26, 1.6), i / 30);
  sm.smooth(null);                    // tracking lost — filters reset
  const fresh = sm.smooth(sgeo(-150, 1.2), 2);
  assert.ok(Math.abs(fresh.pointer.deg - -150) < 1e-9, 'first sample passes through exactly');
  assert.ok(Math.abs(fresh.pointer.r - 1.2) < 1e-9);
});
