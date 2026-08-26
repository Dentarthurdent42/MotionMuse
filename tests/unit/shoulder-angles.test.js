// A shoulder is a ball joint, and one number cannot describe where a ball
// joint is pointing. Reaching straight forward and lifting straight out to the
// side raise the arm by exactly the same amount; an elbow angle says nothing
// about either, since it only reports how far the forearm is folded. So the
// arm's direction is carried as two angles, and what is worth pinning is that
// they are read against the TORSO rather than the camera: the same pose has to
// measure the same when the player turns, leans, or steps closer.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { torsoFrame, shoulderAngles } from '../../src/math.js';

// A person facing the camera, squared up. MediaPipe's axes: x right across the
// image, y downward, z away from the camera — so their LEFT shoulder, which
// appears on the right of the image, sits at the larger x.
const upright = () => ({
  ls: { x: 0.6, y: 0.3, z: 0 }, rs: { x: 0.4, y: 0.3, z: 0 },
  lh: { x: 0.58, y: 0.7, z: 0 }, rh: { x: 0.42, y: 0.7, z: 0 },
});
const frameOf = p => torsoFrame(p.ls, p.rs, p.lh, p.rh);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(1)} vs ${b}`);

// ── Elevation: how far the arm is lifted ─────────────────────────────────

test('elevation runs from arm-down to arm-up, with horizontal in the middle', () => {
  const p = upright(), f = frameOf(p);
  const at = elbow => shoulderAngles('L', p.ls, elbow, f).elevation;
  near(at({ x: 0.6, y: 0.6, z: 0 }), 0,   1, 'hanging by the side');
  near(at({ x: 0.9, y: 0.3, z: 0 }), 90,  1, 'straight out to the side');
  near(at({ x: 0.6, y: 0.0, z: 0 }), 180, 1, 'straight overhead');
});

test('reaching forward lifts the arm as much as reaching sideways', () => {
  // The whole reason one angle is not enough: these are the same elevation.
  const p = upright(), f = frameOf(p);
  const side    = shoulderAngles('L', p.ls, { x: 0.9, y: 0.3, z: 0 },    f);
  const forward = shoulderAngles('L', p.ls, { x: 0.6, y: 0.3, z: -0.3 }, f);
  near(side.elevation, forward.elevation, 1, 'same lift');
  assert.ok(Math.abs(side.azimuth - forward.azimuth) > 45,
    'and the azimuth is what tells them apart');
});

// ── Azimuth: where it points once the lift is taken out ──────────────────

test('azimuth reads 0 out to the side, +90 forward, -90 behind', () => {
  const p = upright(), f = frameOf(p);
  const at = elbow => shoulderAngles('L', p.ls, elbow, f).azimuth;
  near(at({ x: 0.9, y: 0.3, z: 0 }),     0,   1, 'out to the side');
  near(at({ x: 0.6, y: 0.3, z: -0.3 }),  90,  1, 'reaching forward');
  near(at({ x: 0.6, y: 0.3, z: 0.3 }),  -90,  1, 'reaching behind');
  near(Math.abs(at({ x: 0.3, y: 0.3, z: 0 })), 180, 1, 'folded across the chest');
});

test('both shoulders read the same pose the same way', () => {
  // 0° means "out to YOUR side", so the lateral axis has to flip with the
  // side — otherwise one arm's abduction would read as the other's adduction.
  const p = upright(), f = frameOf(p);
  const left  = shoulderAngles('L', p.ls, { x: 0.9,  y: 0.3, z: 0 }, f);
  const right = shoulderAngles('R', p.rs, { x: 0.1,  y: 0.3, z: 0 }, f);
  near(left.azimuth, right.azimuth, 1, 'mirrored arms, same reading');
  const lFwd = shoulderAngles('L', p.ls, { x: 0.6, y: 0.3, z: -0.3 }, f);
  const rFwd = shoulderAngles('R', p.rs, { x: 0.4, y: 0.3, z: -0.3 }, f);
  near(lFwd.azimuth, rFwd.azimuth, 1, 'both reach forward at +90');
});

// ── Torso-relative, not camera-relative ──────────────────────────────────

test('stepping closer to the camera changes nothing', () => {
  // Scaling every landmark about the body's centre is what moving nearer does
  // to a normalized frame. Angles do not care; a distance would.
  const p = upright(), f = frameOf(p);
  const before = shoulderAngles('L', p.ls, { x: 0.75, y: 0.15, z: -0.1 }, f);
  const grow = (q, k) => ({ x: 0.5 + (q.x - 0.5) * k, y: 0.5 + (q.y - 0.5) * k, z: q.z * k });
  const big = { ls: grow(p.ls, 2), rs: grow(p.rs, 2), lh: grow(p.lh, 2), rh: grow(p.rh, 2) };
  const after = shoulderAngles('L', big.ls, grow({ x: 0.75, y: 0.15, z: -0.1 }, 2), frameOf(big));
  near(after.elevation, before.elevation, 0.5, 'elevation');
  near(after.azimuth,   before.azimuth,   0.5, 'azimuth');
});

test('leaning sideways does not fake a swing', () => {
  // The frame is built from the player's own spine, so tilting the whole torso
  // carries the arm with it rather than reading as the arm having moved.
  const p = upright(), f = frameOf(p);
  const straight = shoulderAngles('L', p.ls, { x: 0.9, y: 0.3, z: 0 }, f);
  // Rotate the trunk and the arm together about the body centre, in the image
  // plane — a lean, not a reach.
  const rot = (q, deg) => {
    const t = deg * Math.PI / 180, cx = 0.5, cy = 0.5;
    const dx = q.x - cx, dy = q.y - cy;
    return { x: cx + dx * Math.cos(t) - dy * Math.sin(t), y: cy + dx * Math.sin(t) + dy * Math.cos(t), z: q.z };
  };
  const L = { ls: rot(p.ls, 20), rs: rot(p.rs, 20), lh: rot(p.lh, 20), rh: rot(p.rh, 20) };
  const leaned = shoulderAngles('L', L.ls, rot({ x: 0.9, y: 0.3, z: 0 }, 20), frameOf(L));
  near(leaned.elevation, straight.elevation, 1, 'elevation survives the lean');
  near(leaned.azimuth,   straight.azimuth,   1, 'so does azimuth');
});

test('a collapsed arm reports zeroes rather than NaN', () => {
  // The elbow landing exactly on the shoulder is degenerate, and it reaches the
  // audio graph — a NaN here would ride out as a silent, unfixable note.
  const p = upright(), f = frameOf(p);
  const a = shoulderAngles('L', p.ls, { ...p.ls }, f);
  assert.ok(Number.isFinite(a.elevation) && Number.isFinite(a.azimuth), JSON.stringify(a));
  // Straight up has no direction to swing towards; it must not produce NaN.
  const up = shoulderAngles('L', p.ls, { x: 0.6, y: 0.0, z: 0 }, f);
  assert.ok(Number.isFinite(up.azimuth), 'overhead azimuth');
});
