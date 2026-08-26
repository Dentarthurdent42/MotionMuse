// The pedal's edge detection.
//
// One nod is one press. The failure modes are both bad and both silent: a
// pedal that fires twice records a loop nobody asked for, and one that fires on
// the way back up closes the take you were still playing.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { bus } = await import('../../src/bus.js');
const { makePedal, PEDAL_SOURCES, DEFAULT_PEDAL, DEFAULT_SENSITIVITY } =
  await import('../../src/pedal.js');

// The pedal reads the bus directly, so the test drives the bus. Registered wide
// enough that the clamp in bus.update never truncates the spikes below.
for (const s of Object.values(PEDAL_SOURCES)) bus.register(s.key, { min: -20, max: 20 });
const set = (which, v) => bus.update(PEDAL_SOURCES[which].key, v);

test('the default pedal needs no face model', () => {
  assert.equal(PEDAL_SOURCES[DEFAULT_PEDAL].group, 'pose',
    'a pedal that only works with FACE on is a pedal most people never find');
});

test('both sources read a velocity, not a position', () => {
  // The whole reason a brow flick can coexist with brow_raise driving pitch.
  for (const s of Object.values(PEDAL_SOURCES))
    assert.ok(s.key.endsWith('_vel'), `${s.key} should be a rate of change`);
});

test('one sharp nod is one press', () => {
  const p = makePedal();
  let t = 0;
  const step = v => { set('nod', v); return p.tick(t += 33); };
  assert.equal(step(0.1), false);
  assert.equal(step(2.0), true, 'the stab fires');
  assert.equal(step(2.4), false, 'still the same nod');
  assert.equal(step(1.8), false);
});

test('the head coming back up is not a second press', () => {
  const p = makePedal();
  let t = 0;
  const step = v => { set('nod', v); return p.tick(t += 33); };
  step(2.0);
  // The return stroke is an equal spike the other way. A detector that took
  // magnitude would call this a press and close the take being recorded.
  assert.equal(step(-2.5), false);
  assert.equal(step(-1.0), false);
});

test('a second nod fires once the movement has settled and the window has passed', () => {
  const p = makePedal();
  let t = 0;
  const step = v => { set('nod', v); return p.tick(t += 33); };
  step(2.0);
  step(0.0);                          // re-armed
  for (let i = 0; i < 25; i++) step(0.0);   // ~800 ms
  assert.equal(step(2.0), true);
});

test('a fast double nod inside the refractory window counts once', () => {
  const p = makePedal();
  let t = 0;
  const step = v => { set('nod', v); return p.tick(t += 20); };
  assert.equal(step(2.0), true);
  step(0.0);
  assert.equal(step(2.0), false, 'a bounce is not a second press');
});

test('ordinary playing does not press it', () => {
  const p = makePedal();
  let t = 0;
  // Head drifting as somebody leans into a phrase: real movement, well under
  // the threshold a stab reaches.
  for (let i = 0; i < 200; i++) {
    set('nod', Math.sin(i / 7) * (DEFAULT_SENSITIVITY * 0.4));
    assert.equal(p.tick(t += 33), false, `fired on frame ${i}`);
  }
});

test('sensitivity moves the bar in both directions', () => {
  const twitchy = makePedal({ sensitivity: 0.3 });
  const stoic   = makePedal({ sensitivity: 5 });
  set('nod', 0.6);
  assert.equal(twitchy.tick(1000), true);
  assert.equal(stoic.tick(1000), false);
});

test('the reading says how close a movement came', () => {
  const p = makePedal({ sensitivity: 2 });
  set('nod', 1);
  assert.equal(p.reading(), 0.5);
  set('nod', 4);
  assert.equal(p.reading(), 1, 'clamped, so a meter cannot overflow its box');
  set('nod', -4);
  assert.equal(p.reading(), 0, 'the wrong direction is not progress toward a press');
});

test('the brow source is read independently of the nod source', () => {
  const p = makePedal({ source: 'brow' });
  set('nod', 9);
  assert.equal(p.tick(1000), false, 'a nod must not work the brow pedal');
  set('brow', 2);
  assert.equal(p.tick(2000), true);
});

test('reset re-arms a pedal that was mid-nod', () => {
  const p = makePedal();
  set('nod', 2);
  assert.equal(p.tick(1000), true);
  p.reset();
  assert.equal(p.tick(2000), true, 'after a reset the next crossing counts again');
});
