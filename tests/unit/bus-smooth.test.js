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

test('bus: decay resets the filter so re-acquire snaps cleanly', () => {
  bus.register('t_reset', { min: 0, max: 1, smooth: true });
  for (let i = 0; i < 60; i++) bus.update('t_reset', 0.9, i * 33.3);
  bus.decay('t_reset');                     // tracking lost
  bus.update('t_reset', 0.1, 60 * 33.3);    // re-acquired somewhere else
  assert.equal(bus.signals.get('t_reset').value, 0.1);
});
