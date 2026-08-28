// Radial joint menu: section resolution, boundary hysteresis, entry-speed →
// attack strength, and the two joint geometries — the parts that decide what
// a pointing arm actually plays, driven without a camera or an AudioContext.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeRadialTracker, wristGeometry, shoulderGeometry,
         JOINTS, V_FLOOR, radial } from '../../src/radial.js';
import { chordmode } from '../../src/chordmode.js';
import { engine }    from '../../src/engine.js';

// A seven-section fan, 140° wide: 20° per section, edges at ±70.
const fan = (over = {}) => makeRadialTracker({
  sections: 7, spanDeg: 140, rIn: 1.5, rOut: 2.2,
  hystR: 0.15, hystDeg: 4, vRef: 10,
  ...over,
});

// Feed a path of {relDeg, r} samples 30 ms apart, collecting events.
const run = (t, path, dt = 0.03) => {
  const out = [];
  path.forEach((p, i) => {
    const ev = t.feed({ ...p, t: i * dt });
    if (ev) out.push(ev);
  });
  return out;
};

test('equal-angle sections: each 20° slice answers to its own degree', () => {
  for (let i = 0; i < 7; i++) {
    const t = fan();
    const mid = -70 + 20 * i + 10;
    const evs = run(t, [{ relDeg: mid, r: 1.0 }, { relDeg: mid, r: 1.8 }]);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].type, 'attack');
    assert.equal(evs[0].section, i, `${mid}° lands on section ${i}`);
  }
});

test('outside the fan or inside the inner radius is nowhere', () => {
  const t = fan();
  assert.equal(t.feed({ relDeg: -75, r: 1.8, t: 0 }), null, 'past the low edge');
  assert.equal(t.feed({ relDeg: 75, r: 1.8, t: 0.03 }), null, 'past the high edge');
  assert.equal(t.feed({ relDeg: 0, r: 1.0, t: 0.06 }), null, 'retracted');
});

test('entering fast attacks hard, entering slow attacks soft', () => {
  // Fast: r jumps 0.8 joint units in 30 ms ≈ 27 units/s — over vRef, so 1.
  const hard = run(fan(), [{ relDeg: 0, r: 1.0 }, { relDeg: 0, r: 1.8 }]);
  assert.equal(hard[0].strength, 1);

  // Slow: creep in at ~0.7 units/s. Still a note — at the floor, not zero.
  const creep = Array.from({ length: 40 }, (_, i) => ({ relDeg: 0, r: 1.0 + i * 0.02 }));
  const soft = run(fan(), creep);
  assert.equal(soft.length, 1);
  assert.ok(soft[0].strength < 0.45, `soft entry stays soft (${soft[0].strength})`);
  assert.ok(soft[0].strength >= V_FLOOR, 'but never below the floor');
});

test('staying inside the section sustains — no events at all', () => {
  const t = fan();
  run(t, [{ relDeg: 10, r: 1.0 }, { relDeg: 10, r: 1.8 }]);
  const evs = run(t, Array.from({ length: 30 }, (_, i) =>
    ({ relDeg: 10 + Math.sin(i) * 3, r: 1.8 + Math.cos(i) * 0.1 })));
  assert.deepEqual(evs, []);
});

test('the inner edge is sticky: releases only past the hysteresis margin', () => {
  const t = fan();
  run(t, [{ relDeg: 0, r: 1.0 }, { relDeg: 0, r: 1.7 }]);
  assert.equal(t.feed({ relDeg: 0, r: 1.42, t: 1 }), null, 'resting ON the edge holds');
  const ev = t.feed({ relDeg: 0, r: 1.3, t: 1.03 });
  assert.equal(ev.type, 'release');
  // …and coming back is a fresh attack.
  assert.equal(t.feed({ relDeg: 0, r: 1.8, t: 1.06 }).type, 'attack');
});

test('section boundaries are sticky the same way', () => {
  const t = fan();
  run(t, [{ relDeg: 8, r: 1.0 }, { relDeg: 8, r: 1.8 }]);   // section 3 (center)
  // Jitter across the 10° boundary by less than hystDeg: held.
  assert.equal(t.feed({ relDeg: 12, r: 1.8, t: 1 }), null);
  // A real move re-attacks in the neighbour — one event, the new section.
  const ev = t.feed({ relDeg: 17, r: 1.8, t: 1.03 });
  assert.equal(ev.type, 'attack');
  assert.equal(ev.section, 4);
});

test('sliding out past the fan edge releases', () => {
  const t = fan();
  run(t, [{ relDeg: 60, r: 1.0 }, { relDeg: 60, r: 1.8 }]);
  assert.equal(t.feed({ relDeg: 80, r: 1.8, t: 1 }).type, 'release');
});

// ── Wrist geometry ────────────────────────────────────────────────────────

// A synthetic hand pointing straight up in the frame: wrist at centre, palm
// one 0.1-unit long, middle fingertip extended 1.9 palm units.
const hand = tip => {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  lm[0] = { x: 0.5, y: 0.5 };
  lm[9] = { x: 0.5, y: 0.4 };
  lm[12] = tip;
  return lm;
};

test('wrist fan rides the forearm and measures in palm units', () => {
  const elbow = { x: 0.5, y: 0.8 };                       // forearm points up
  const g = wristGeometry(hand({ x: 0.5, y: 0.31 }), elbow, 1);
  assert.equal(g.axisDeg, -90);
  assert.ok(Math.abs(g.pointer.fanDeg) < 1e-9, 'straight ahead is the fan centre');
  assert.ok(Math.abs(g.pointer.r - 1.9) < 1e-9, 'radius in palm units');

  // Tilt the forearm and the fan tilts with it: same hand, elbow moved.
  const g2 = wristGeometry(hand({ x: 0.5, y: 0.31 }), { x: 0.8, y: 0.8 }, 1);
  assert.ok(g2.axisDeg < -90, 'axis followed the elbow');
  assert.ok(Math.abs(g2.pointer.fanDeg) > 10, 'the pointer now aims off-centre');
});

test('wrist fan reads low-to-high left-to-right in the mirrored view', () => {
  const elbow = { x: 0.5, y: 0.8 };
  // Tip tilted toward raw −x, which the mirrored canvas shows on the RIGHT:
  // that side must be the high end (positive fan coordinate).
  const g = wristGeometry(hand({ x: 0.4, y: 0.42 }), elbow, 1);
  assert.ok(g.pointer.fanDeg > 0, `raw-left tilt is fan-positive (${g.pointer.fanDeg})`);
});

test('a curled finger is out of the ring an extended one is inside', () => {
  const { rIn } = JOINTS.wrist;
  const curled  = wristGeometry(hand({ x: 0.5, y: 0.42 }), null, 1);   // r = 0.8
  const pointed = wristGeometry(hand({ x: 0.5, y: 0.31 }), null, 1);   // r = 1.9
  assert.ok(curled.pointer.r < rIn);
  assert.ok(pointed.pointer.r > rIn);
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

test('shoulder fan: hanging arm is the low edge, raised arm the high edge — both sides', () => {
  const down = pose({ 14: { x: 0.4, y: 0.55 }, 16: { x: 0.4, y: 0.7 } });
  const up   = pose({ 14: { x: 0.4, y: 0.55 }, 16: { x: 0.4, y: 0.1 } });
  const gDown = shoulderGeometry('R', down, 1);
  const gUp   = shoulderGeometry('R', up, 1);
  assert.ok(Math.abs(gDown.pointer.fanDeg - -90) < 1e-6, 'hanging = -90 (low edge)');
  assert.ok(Math.abs(gUp.pointer.fanDeg - 90) < 1e-6, 'overhead = +90 (high edge)');

  const gDownL = shoulderGeometry('L',
    pose({ 13: { x: 0.6, y: 0.55 }, 15: { x: 0.6, y: 0.7 } }), 1);
  assert.ok(Math.abs(gDownL.pointer.fanDeg - -90) < 1e-6, 'same reading for the left arm');
});

test('shoulder radius is the arm’s own reach', () => {
  const straight = pose({ 14: { x: 0.4, y: 0.55 }, 16: { x: 0.4, y: 0.7 } });
  const bent     = pose({ 14: { x: 0.4, y: 0.55 }, 16: { x: 0.47, y: 0.44 } });
  const gs = shoulderGeometry('R', straight, 1);
  const gb = shoulderGeometry('R', bent, 1);
  assert.ok(Math.abs(gs.pointer.r - 1) < 1e-6, 'straight arm reaches its full length');
  assert.ok(gb.pointer.r < JOINTS.shoulder.rIn, 'a bent elbow retracts out of the ring');
});

test('missing landmarks mean no fan, not a broken one', () => {
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
                spans: { wrist: 120, shoulder: 200 }, shepAuto: false });
  const snap = radial.serialize();
  radial.load({ enabled: false });          // stomp with defaults
  radial.load(snap);
  assert.deepEqual(radial.serialize(), snap);
  const cfg = radial.config();
  assert.equal(cfg.joint, 'shoulder');
  assert.equal(cfg.side, 'L');
  assert.equal(cfg.voicing, 'chord');
  assert.equal(cfg.span, 200);
  radial.load({ enabled: false });          // leave the module on defaults
});

test('junk in a loaded snapshot falls back instead of wedging', () => {
  radial.load({ enabled: false, joint: 'elbow??', side: 'both', voicing: 'loud',
                spans: { wrist: 'wide', shoulder: 9999 } });
  const cfg = radial.config();
  assert.equal(cfg.joint, 'wrist');
  assert.equal(cfg.side, 'R');
  assert.equal(cfg.voicing, 'note');
  assert.equal(cfg.span, JOINTS.wrist.span);
  assert.equal(radial.serialize().spans.shoulder, 300, 'clamped, not swallowed');
  radial.load({ enabled: false });
});
