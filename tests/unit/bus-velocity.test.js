import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bus, velKeyOf } from '../../src/bus.js';

// Feed a signal a straight ramp at `rate` units per second and return the
// velocity its twin settled on. Long enough for the twin's own One-Euro filter
// to converge — a velocity that reads right only in the steady state is still
// the number the player's ear is tracking.
const ramp = (key, rate, frames = 90, dtMs = 33.3) => {
  let t = 0, v = bus.signals.get(key).value;
  for (let i = 0; i < frames; i++) {
    t += dtMs;
    v += rate * (dtMs / 1000);
    bus.update(key, v, t);
  }
  return bus.signals.get(velKeyOf(key)).value;
};

test('bus: velocity: true registers a signed sibling signal', () => {
  bus.register('v_basic', { min: 0, max: 1, label: 'Basic', group: 'test', velocity: true });
  const twin = bus.signals.get('v_basic_vel');
  assert.ok(twin, 'expected a v_basic_vel sibling');
  assert.equal(twin.of, 'v_basic', 'the twin should name what it measures');
  assert.ok(twin.min < 0, 'a velocity carries direction, so it must go negative');
  assert.equal(twin.max, -twin.min, 'full scale should be symmetric about zero');
  assert.equal(twin.value, 0);
});

test('bus: a signal without velocity: true gains no sibling', () => {
  bus.register('v_none', { min: 0, max: 1 });
  assert.equal(bus.signals.get('v_none_vel'), undefined);
});

test('bus: velocities are not themselves given velocities', () => {
  bus.register('v_nonest', { min: 0, max: 1, velocity: true });
  assert.equal(bus.signals.get(velKeyOf(velKeyOf('v_nonest'))), undefined);
});

test('bus: a steady ramp reads as its rate in units per second', () => {
  bus.register('v_ramp', { min: 0, max: 10, velocity: true });
  const v = ramp('v_ramp', 1);
  assert.ok(Math.abs(v - 1) < 0.05, `1.0/s ramp read as ${v.toFixed(3)}`);
});

test('bus: direction is kept — a fall reads negative', () => {
  bus.register('v_fall', { min: -10, max: 10, velocity: true });
  bus.update('v_fall', 8, 0);
  const v = ramp('v_fall', -2);
  assert.ok(v < -1.8 && v > -2.2, `-2.0/s ramp read as ${v.toFixed(3)}`);
});

test('bus: holding still reads as roughly zero', () => {
  bus.register('v_still', { min: 0, max: 1, velocity: true });
  let t = 0;
  for (let i = 0; i < 120; i++) { t += 33.3; bus.update('v_still', 0.5, t); }
  const v = bus.signals.get('v_still_vel').value;
  assert.ok(Math.abs(v) < 0.05, `a held value should not appear to move, got ${v.toFixed(3)}`);
});

test('bus: an angle in degrees yields an angular velocity in degrees per second', () => {
  bus.register('v_angle', { min: 0, max: 180, velocity: true });
  const twin = bus.signals.get('v_angle_vel');
  assert.equal(twin.max, 180 * 4, 'full scale should be four spans of the source per second');
  // 45 frames ≈ 1.5 s, which sweeps 135° — stopping short of the 180° clamp,
  // where the signal would stop moving and the velocity would fall back to 0.
  const v = ramp('v_angle', 90, 45);
  assert.ok(Math.abs(v - 90) < 5, `90 deg/s read as ${v.toFixed(1)}`);
});

test('bus: two updates in the same instant do not report an enormous velocity', () => {
  bus.register('v_dup', { min: 0, max: 1, velocity: true });
  bus.update('v_dup', 0, 1000);
  bus.update('v_dup', 1, 1000);       // same timestamp — dt would be 0
  bus.update('v_dup', 1, 1000.2);     // and 0.2 ms is still not a measurement
  const v = bus.signals.get('v_dup_vel').value;
  assert.ok(Number.isFinite(v) && Math.abs(v) <= 4, `expected a bounded value, got ${v}`);
});

test('bus: decay zeroes the velocity and forgets when it last sampled', () => {
  bus.register('v_lost', { min: 0, max: 1, velocity: true });
  ramp('v_lost', 0.5, 30);
  assert.ok(bus.signals.get('v_lost_vel').value > 0.2, 'precondition: it was moving');
  bus.decay('v_lost', 0);
  assert.equal(bus.signals.get('v_lost_vel').value, 0);
  // Re-acquired a second later, somewhere else. Differencing across the gap
  // would read as a violent move; the first sample after a loss should not
  // produce a velocity at all.
  bus.update('v_lost', 0.9, 1e6);
  assert.equal(bus.signals.get('v_lost_vel').value, 0);
});

test('bus: a detached update() still feeds the twin', () => {
  // `bus.update` gets passed around by reference; if the twin were fed through
  // `this`, a detached call would stop producing velocities and nothing would
  // say so — the displacement would keep working perfectly.
  bus.register('v_detached', { min: 0, max: 1, velocity: true });
  const update = bus.update;
  update('v_detached', 0, 0);
  update('v_detached', 0.5, 500);
  update('v_detached', 1, 1000);
  assert.ok(bus.signals.get('v_detached_vel').value > 0.5,
    'expected a positive velocity from a detached update()');
});

test('bus: a velocity normalises to mid-scale at rest', () => {
  bus.register('v_norm', { min: 0, max: 1, velocity: true });
  // Before `adapt` has seen enough range, norm() uses the static bounds, which
  // are symmetric — so zero motion sits at 0.5, and the panel draws the bar
  // from the distance to that midpoint rather than from the raw normal.
  assert.ok(Math.abs(bus.norm('v_norm_vel') - 0.5) < 1e-9);
});
