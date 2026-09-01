// The oscilloscope normalises its amplitude.
//
// Reported from playing, with a screenshot: "the oscilloscope should normalize
// the amplitude (currently, it's an almost completely flat line with some tiny
// squiggly bits)". The trace was drawn at the signal's raw amplitude, and the
// master fader sits well below 1 — so the shape a scope exists to show was
// squashed into a line.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { followPeak, scopeScale, SCOPE_FLOOR } from '../../src/ui/viz.js';

test('the follower rises instantly — a transient is on screen the frame it happens', () => {
  assert.equal(followPeak(0.01, 0.8), 0.8);
  assert.equal(followPeak(0, 1), 1);
});

test('…and falls slowly, so a dying note shrinks instead of being pumped back up', () => {
  let p = 1;
  const first = followPeak(p, 0);
  assert.ok(first > 0.9, `one quiet frame should barely move it, got ${first}`);
  for (let i = 0; i < 200; i++) p = followPeak(p, 0);
  assert.ok(p < 0.01, `but it does get there eventually, got ${p}`);
});

test('a quiet signal is scaled up to fill the screen', () => {
  const gain = scopeScale(0.02);
  assert.ok(gain > 1, 'a 2%-amplitude signal must be amplified');
  assert.ok(Math.abs(0.02 * gain - 0.92) < 1e-9, 'to very near full height');
});

test('a loud signal is scaled DOWN rather than clipped off the top', () => {
  const gain = scopeScale(1);
  assert.ok(gain < 1);
  assert.ok(Math.abs(1 * gain - 0.92) < 1e-9);
});

test('silence stays silent — the normaliser does not draw a waveform out of dither', () => {
  assert.equal(scopeScale(0), 0);
  assert.equal(scopeScale(SCOPE_FLOOR / 2), 0);
  assert.equal(scopeScale(-1), 0, 'a nonsense peak is silence, not a negative gain');
  assert.equal(scopeScale(NaN), 0);
});

test('and a real-but-tiny signal is capped, so quiet still looks quieter than loud', () => {
  // Above the floor (it is a real signal) but far enough down that the gain
  // cap binds before full height — the band between "silence" and "fills the
  // screen", which is where a very quiet passage should live.
  const p = 0.005;
  assert.ok(p > SCOPE_FLOOR, 'this is a real signal, not dither');
  const gain = scopeScale(p);
  assert.ok(gain > 0, 'it is drawn…');
  assert.equal(gain, 50, '…at the cap, not at whatever reaches full height');
  assert.ok(p * gain < 0.92, 'so it stays visibly quieter than a loud signal');
});

test('the gain is monotonic: a louder signal never draws smaller', () => {
  let prev = Infinity;
  for (const p of [0.002, 0.01, 0.05, 0.2, 0.5, 1]) {
    const height = p * scopeScale(p);
    assert.ok(scopeScale(p) <= prev, 'gain falls as level rises');
    prev = scopeScale(p);
    assert.ok(height > 0 && height <= 0.92 + 1e-9, `${p} → ${height}`);
  }
});
