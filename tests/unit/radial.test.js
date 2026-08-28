// Radial joint menu: section resolution on the closed circle, boundary
// hysteresis, entry-speed → attack strength, and the two ring geometries —
// the parts that decide what a pointing arm actually plays, driven without a
// camera or an AudioContext.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeRadialTracker, ringBasis, wristGeometry, shoulderGeometry,
         JOINTS, FINGERS, V_FLOOR, MIN_TILT, radial } from '../../src/radial.js';
import { chordmode } from '../../src/chordmode.js';
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
  // The same fingertip swung sideways is square to the axis: full reach.
  const across = wristGeometry(hand({ x: 0.38, y: 0.5 }), [0, -0.3, 0], 1);
  assert.ok(across.pointer.r > 1.0, `across the axis reaches the ring (${across.pointer.r})`);
  assert.ok(across.pointer.r > JOINTS.wrist.rIn);
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

test('enabling the radial menu parks gesture mode and defaults to Shepard tones', () => {
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
