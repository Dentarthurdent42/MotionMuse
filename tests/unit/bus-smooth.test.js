import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bus } from '../../src/bus.js';

test('bus: smooth-flagged signal damps jitter', () => {
  bus.register('t_smooth', { min: 0, max: 1, smooth: true });
  const outs = [];
  for (let i = 0; i < 120; i++) {
    bus.update('t_smooth', 0.5 + (i % 2 === 0 ? 0.05 : -0.05), i * 33.3);
    outs.push(bus.signals.get('t_smooth').value);
  }
  const tail = outs.slice(60);
  const spread = Math.max(...tail) - Math.min(...tail);
  assert.ok(spread < 0.02, `raw spread 0.10 should shrink well below 0.02, got ${spread}`);
});

test('bus: unsmoothed signal stays raw', () => {
  bus.register('t_raw', { min: 0, max: 1 });
  bus.update('t_raw', 0.55, 0);
  assert.equal(bus.signals.get('t_raw').value, 0.55);
  bus.update('t_raw', 0.45, 33);
  assert.equal(bus.signals.get('t_raw').value, 0.45);
});

test('bus: clamping happens before smoothing', () => {
  bus.register('t_clamp', { min: 0, max: 1, smooth: true });
  for (let i = 0; i < 90; i++) bus.update('t_clamp', 5, i * 33.3);   // way over max
  const v = bus.signals.get('t_clamp').value;
  assert.ok(v <= 1 && v > 0.99, `expected convergence to clamp bound 1, got ${v}`);
});

test('bus: a snappier per-signal config tracks a step within the rhythmic budget', () => {
  // pinch_R's config — volume articulation needs the note to start when the
  // fingers open, so a 0→1 step must arrive in ~3 frames, while a jittery
  // hold must still settle.
  bus.register('t_snappy', { min: 0, max: 1, smooth: { minCutoff: 2.5, beta: 0.4 } });
  bus.register('t_default', { min: 0, max: 1, smooth: true });
  const stepTo = (key, frames) => {
    let t = 0;
    bus.update(key, 0, t);
    for (let i = 0; i < frames; i++) { t += 33.3; bus.update(key, 1, t); }
    return bus.signals.get(key).value;
  };
  const snappy = stepTo('t_snappy', 3);        // 3 frames ≈ 100 ms
  const dflt   = stepTo('t_default', 3);
  assert.ok(snappy > 0.85, `step reached only ${snappy.toFixed(3)} in 3 frames`);
  // Residual lag is the meaningful comparison: the default leaves ~37% of the
  // step untravelled after 100 ms, the snappy config well under half that.
  assert.ok((1 - snappy) < (1 - dflt) / 2,
    `snappy residual ${(1 - snappy).toFixed(3)} vs default ${(1 - dflt).toFixed(3)}`);

  let t = 0;

  const held = [];
  for (let i = 0; i < 60; i++) { t += 33.3; bus.update('t_snappy', 0.5 + (i % 2 ? 0.05 : -0.05), t); held.push(bus.signals.get('t_snappy').value); }
  const tail = held.slice(30);
  assert.ok(Math.max(...tail) - Math.min(...tail) < 0.06,
    `jittery hold spread ${Math.max(...tail) - Math.min(...tail)}`);
});

test('bus: decay resets the filter so re-acquire snaps cleanly', () => {
  bus.register('t_reset', { min: 0, max: 1, smooth: true });
  for (let i = 0; i < 60; i++) bus.update('t_reset', 0.9, i * 33.3);
  bus.decay('t_reset');                     // tracking lost
  bus.update('t_reset', 0.1, 60 * 33.3);    // re-acquired somewhere else
  assert.equal(bus.signals.get('t_reset').value, 0.1);
});
