// The pitch tracker, against signals whose frequency we already know.
//
// A pitch detector is the kind of code that looks right, runs without error and
// is wrong by an octave — the exact failure autocorrelation is chosen to avoid,
// so the harmonic cases below are the point of the file rather than padding.

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch } from '../../src/mic.js';

const SR = 44100, N = 2048;

// Build one buffer from a list of [harmonic, amplitude] pairs.
const tone = (hz, parts = [[1, 1]]) => {
  const b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (const [mult, amp] of parts) v += amp * Math.sin(2 * Math.PI * hz * mult * i / SR);
    b[i] = v * 0.4;
  }
  return b;
};
const cents = (a, b) => 1200 * Math.log2(a / b);

test('finds the fundamental of a pure tone across the range', () => {
  for (const hz of [82.41, 220, 440, 880, 1760]) {   // E2 … A6
    const { hz: got, clarity } = detectPitch(tone(hz), SR);
    assert.ok(Math.abs(cents(got, hz)) < 25,
      `${hz}Hz → ${got.toFixed(1)}Hz (${cents(got, hz).toFixed(0)} cents off)`);
    assert.ok(clarity > 0.5, `a pure tone should read as clearly pitched, got ${clarity.toFixed(2)}`);
  }
});

test('does not octave-jump when the 2nd harmonic is louder than f0', () => {
  // A vowel or a bowed string routinely does this, and it is what breaks naive
  // FFT peak-picking: the loudest bin is 440, but the note is 220.
  const { hz } = detectPitch(tone(220, [[1, 0.4], [2, 1.0], [3, 0.6]]), SR);
  assert.ok(Math.abs(cents(hz, 220)) < 40,
    `expected ~220Hz, got ${hz.toFixed(1)}Hz — that is the octave error`);
});

test('reports no pitch for silence and for noise', () => {
  assert.equal(detectPitch(new Float32Array(N), SR).hz, 0, 'silence has no pitch');

  // Deterministic pseudo-noise, so the test cannot flake.
  const noise = new Float32Array(N);
  let seed = 12345;
  for (let i = 0; i < N; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = (seed / 0x3fffffff - 1) * 0.5;
  }
  assert.ok(detectPitch(noise, SR).clarity < 0.5,
    'noise must not read as a confident pitch — mic_pitch is gated on clarity');
});

test('a quiet signal is treated as silence rather than guessed at', () => {
  const faint = tone(440);
  for (let i = 0; i < N; i++) faint[i] *= 0.005;
  assert.equal(detectPitch(faint, SR).hz, 0);
});
