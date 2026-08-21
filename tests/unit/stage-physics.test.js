// The stage model: orbs orbit, cards fly, flings damp out or cull, pulls
// arrive in the hand. Pure math, so it runs under node --test.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGE, orbitSlots, flightPos, stretchScale, pickTarget, stepPhysics }
  from '../../src/stage.js';

test('orbitSlots: one orb sits straight above; a fan is symmetric', () => {
  const [solo] = orbitSlots(400, 300, 100, 1);
  assert.deepEqual(solo, { x: 400, y: 200 });
  const fan = orbitSlots(400, 300, 100, 3);
  assert.equal(fan.length, 3);
  assert.ok(Math.abs((fan[0].x - 400) + (fan[2].x - 400)) < 1e-9, 'ends mirror');
  assert.ok(Math.abs(fan[1].x - 400) < 1e-9 && fan[1].y < 300, 'middle on top');
  fan.forEach(s => assert.ok(s.y < 300, 'the fan opens upward'));
});

test('flightPos: starts at from, ends exactly at to', () => {
  const from = { x: 0, y: 0 }, to = { x: 300, y: 100 };
  assert.deepEqual(flightPos(from, to, 0), { x: 0, y: 0 });
  const end = flightPos(from, to, 1);
  assert.ok(Math.abs(end.x - 300) < 1e-9 && Math.abs(end.y - 100) < 1e-9);
  // Mid-flight it has left the straight line (the bow).
  const mid = flightPos(from, to, 0.5);
  const online = { x: 300 * 0.25, y: 100 * 0.25 };    // ease-in: p²=0.25
  assert.ok(Math.hypot(mid.x - online.x, mid.y - online.y) > 5, 'it arcs');
});

test('stretchScale clamps both ends', () => {
  assert.equal(stretchScale(1, 100, 100), 1);
  assert.equal(stretchScale(1, 100, 1000), STAGE.STRETCH_MAX);
  assert.equal(stretchScale(1, 100, 1), STAGE.STRETCH_MIN);
});

test('pickTarget: in the cone, beyond the minimum, nearest wins', () => {
  const ray = { ox: 0, oy: 0, dx: 1, dy: 0 };
  const ahead    = { id: 'a', x: 400, y: 20 };        // ~3° off-axis
  const nearer   = { id: 'n', x: 250, y: 10 };
  const behind   = { id: 'b', x: -300, y: 0 };
  const offCone  = { id: 'o', x: 300, y: 200 };       // ~34° — outside
  const tooClose = { id: 'c', x: 100, y: 0 };
  assert.equal(pickTarget(ray, [ahead, behind, offCone, tooClose])?.id, 'a');
  assert.equal(pickTarget(ray, [ahead, nearer])?.id, 'n');
  assert.equal(pickTarget(ray, [behind, offCone, tooClose]), null);
});

test('stepPhysics: a fling damps toward rest', () => {
  const it = { id: 'card', x: 400, y: 300, vx: 1000, vy: 0 };
  for (let t = 0; t < 6000; t += 16) stepPhysics([it], 16, t, 5000, 5000);
  assert.equal(it.vx, 0, 'came to rest (STOP_SPEED snap)');
  assert.ok(it.x > 400, 'travelled first');
});

test('stepPhysics: leaving the stage culls', () => {
  const it = { id: 'card', x: 700, y: 300, vx: 4000, vy: 0 };
  let culled = false;
  for (let t = 0; t < 2000 && !culled; t += 16) {
    culled = stepPhysics([it], 16, t, 800, 600).some(e => e.type === 'culled');
  }
  assert.ok(culled);
});

test('stepPhysics: orbs chase their slot; held items sit still', () => {
  const orb  = { id: 'orb', x: 0, y: 0, vx: 0, vy: 0, slot: { x: 100, y: 100 } };
  const held = { id: 'h', x: 5, y: 5, vx: 500, vy: 500, held: 'L' };
  for (let t = 0; t < 1000; t += 16) stepPhysics([orb, held], 16, t, 800, 600);
  assert.ok(Math.hypot(orb.x - 100, orb.y - 100) < 2, 'orb settled on its slot');
  assert.deepEqual([held.x, held.y], [5, 5], 'a held item ignores physics');
});

test('stepPhysics: a pull flight arrives, once', () => {
  const it = { id: 'card', x: 0, y: 0, vx: 0, vy: 0,
               anim: { t0: 1000, from: { x: 0, y: 0 }, to: { x: 300, y: 200 } } };
  const evs = [];
  for (let t = 1000; t <= 1000 + STAGE.FLY_MS + 50; t += 16) {
    evs.push(...stepPhysics([it], 16, t, 800, 600));
  }
  assert.equal(evs.filter(e => e.type === 'arrived').length, 1);
  assert.ok(Math.abs(it.x - 300) < 1e-6 && Math.abs(it.y - 200) < 1e-6);
  assert.equal(it.anim, null);
});
