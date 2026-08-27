// The looper's arithmetic.
//
// Two things in this feature are easy to get subtly, unlistenably wrong: where
// an overdub lands in the bar, and how many times one nod counts as a press.
// Both are pure functions of their inputs, so both are pinned here rather than
// discovered by ear.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

// A stand-in for the AudioContext's buffer factory. The real one is a browser
// API; everything under test here is index arithmetic over Float32Arrays.
const ctx = {
  sampleRate: 48000,
  createBuffer: (channels, frames) => {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return { numberOfChannels: channels, length: frames, getChannelData: c => data[c] };
  },
};
const chunk = (...vals) => [Float32Array.from(vals)];

const { wrapIntoLoop, mixLayers, MIN_LOOP_SECONDS, MAX_LAYERS } =
  await import('../../src/looper.js');

test('a pass recorded at the top of the loop lands at the top', () => {
  const out = wrapIntoLoop(ctx, [chunk(1, 2, 3)], 6, 1, 0);
  assert.deepEqual([...out.getChannelData(0)], [1, 2, 3, 0, 0, 0]);
});

test('a pass recorded mid-bar lands mid-bar', () => {
  // The pedal went down 3 frames into a 6-frame loop, so that is where the
  // audio belongs — not at zero, which is where a naive copy would put it and
  // where every overdub would then pile up.
  const out = wrapIntoLoop(ctx, [chunk(1, 2, 3)], 6, 1, 3);
  assert.deepEqual([...out.getChannelData(0)], [0, 0, 0, 1, 2, 3]);
});

test('a pass that runs past the loop point wraps to the start', () => {
  const out = wrapIntoLoop(ctx, [chunk(1, 2, 3, 4)], 6, 1, 4);
  assert.deepEqual([...out.getChannelData(0)], [3, 4, 0, 0, 1, 2]);
});

test('a pass longer than the loop sums onto itself rather than truncating', () => {
  // Holding an overdub for two passes is a real thing to do, and both passes
  // are part of what was played.
  const out = wrapIntoLoop(ctx, [chunk(1, 1, 1, 1, 1, 1, 1, 1)], 4, 1, 0);
  assert.deepEqual([...out.getChannelData(0)], [2, 2, 2, 2]);
});

test('an offset beyond the loop length is taken modulo it', () => {
  const at3 = wrapIntoLoop(ctx, [chunk(9)], 4, 1, 3);
  const at7 = wrapIntoLoop(ctx, [chunk(9)], 4, 1, 7);
  assert.deepEqual([...at7.getChannelData(0)], [...at3.getChannelData(0)]);
});

test('a negative offset is still a real position, not an exception', () => {
  // ctx.currentTime is monotonic so this should not arise — but the offset is a
  // difference of two clock reads, and a loop that threw on one would be dead
  // until reloaded.
  const out = wrapIntoLoop(ctx, [chunk(5)], 4, 1, -1);
  assert.deepEqual([...out.getChannelData(0)], [0, 0, 0, 5]);
});

test('chunks are laid down end to end, not one on top of the other', () => {
  const out = wrapIntoLoop(ctx, [chunk(1, 2), chunk(3, 4)], 4, 1, 0);
  assert.deepEqual([...out.getChannelData(0)], [1, 2, 3, 4]);
});

test('a mono capture fills both channels of a stereo loop', () => {
  // The fallback path can hand back one channel; the loop is still stereo, and
  // silence in the right speaker is not what was played.
  const out = wrapIntoLoop(ctx, [chunk(1, 2)], 2, 2, 0);
  assert.deepEqual([...out.getChannelData(0)], [1, 2]);
  assert.deepEqual([...out.getChannelData(1)], [1, 2]);
});

test('layers sum, and an empty stack is silence rather than a crash', () => {
  const a = wrapIntoLoop(ctx, [chunk(1, 0, 1, 0)], 4, 1, 0);
  const b = wrapIntoLoop(ctx, [chunk(0, 2, 0, 2)], 4, 1, 0);
  assert.deepEqual([...mixLayers(ctx, [a, b], 4, 1).getChannelData(0)], [1, 2, 1, 2]);
  assert.deepEqual([...mixLayers(ctx, [], 4, 1).getChannelData(0)], [0, 0, 0, 0]);
});

test('a pass that captured nothing yields no buffer, rather than a zero-length one', () => {
  // The Web Audio API refuses a zero-frame buffer, so this is the difference
  // between "no loop was recorded" and an exception that leaves the transport
  // stuck in a state whose only exit is CLEAR.
  assert.equal(wrapIntoLoop(ctx, [], 0, 1, 0), null);
  assert.equal(mixLayers(ctx, [], 0, 1), null);
});

test('the limits are the ones a player would notice', () => {
  assert.ok(MIN_LOOP_SECONDS > 0 && MIN_LOOP_SECONDS < 1, 'a stab is not a phrase');
  assert.ok(MAX_LAYERS >= 4, 'fewer than four layers is not a loop pedal');
});
