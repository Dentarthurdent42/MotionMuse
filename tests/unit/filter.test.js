import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOneEuro } from '../../src/filter.js';

const DT = 1 / 30;   // 30 fps

test('one-euro: constant input converges to the input', () => {
  const f = makeOneEuro();
  let out = 0;
  for (let i = 0; i < 90; i++) out = f.filter(0.5, i * DT);
  assert.ok(Math.abs(out - 0.5) < 1e-3, `expected ~0.5, got ${out}`);
});

test('one-euro: jitter variance is reduced by >10x', () => {
  const f = makeOneEuro();
  const raw = [], smoothed = [];
  for (let i = 0; i < 300; i++) {
    const v = 0.5 + (i % 2 === 0 ? 0.02 : -0.02);   // ±2% alternating jitter
    raw.push(v);
    smoothed.push(f.filter(v, i * DT));
  }
  const varOf = a => {
    const tail = a.slice(60);          // skip settle-in
    const m = tail.reduce((s, v) => s + v, 0) / tail.length;
    return tail.reduce((s, v) => s + (v - m) ** 2, 0) / tail.length;
  };
  assert.ok(varOf(raw) / varOf(smoothed) > 10,
    `variance ratio ${varOf(raw) / varOf(smoothed)}`);
});

test('one-euro: fast movement tracks with bounded lag', () => {
  const f = makeOneEuro();
  let out = 0;
  // Ramp 0 → 1 over one second — a fast sweep.
  for (let i = 0; i <= 30; i++) out = f.filter(i / 30, i * DT);
  assert.ok(out > 0.85, `expected close tracking on a fast ramp, got ${out}`);
});

test('one-euro: reset makes the next sample pass through', () => {
  const f = makeOneEuro();
  for (let i = 0; i < 30; i++) f.filter(0.9, i * DT);
  f.reset();
  assert.equal(f.filter(0.1, 2), 0.1);
});

test('one-euro: non-monotonic timestamps do not produce NaN', () => {
  const f = makeOneEuro();
  f.filter(0.5, 1.0);
  const out = f.filter(0.6, 0.5);    // clock went backwards
  assert.ok(Number.isFinite(out));
  assert.ok(Number.isFinite(f.filter(0.7, 0.6)));
});
