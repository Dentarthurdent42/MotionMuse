// The iOS Ring/Silent switch workaround: who gets it, and what it plays.
//
// The element itself needs a browser, so the browser half is in
// tests/audio-launch. What is checkable here is the part that would be
// silently wrong rather than visibly broken: a WAV whose header disagrees
// with its payload plays as noise on the one device this exists for, and a
// platform test that misses iPadOS leaves exactly the users it is for
// without it.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { needsPlaybackSession, silentWav } from '../../src/audiosession.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// iPadOS asks for desktop sites by default: no "iPad" in the agent string,
// and a platform that reads exactly like a Mac.
const IPADOS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC    = IPADOS;
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test('iOS gets the workaround', () => {
  assert.equal(needsPlaybackSession(IPHONE, 'iPhone', 5), true);
  assert.equal(needsPlaybackSession(IPADOS, 'MacIntel', 5), true,
    'iPadOS hides behind a Mac platform string; touch points give it away');
});

test('nothing else does — it costs the user’s music to hold', () => {
  assert.equal(needsPlaybackSession(MAC, 'MacIntel', 0), false,
    'a Mac has no touchscreen and no Ring/Silent switch');
  assert.equal(needsPlaybackSession(ANDROID, 'Linux armv8l', 5), false,
    'Android would just lose audio focus for nothing');
  assert.equal(needsPlaybackSession('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0), false);
});

test('the silence is a well-formed WAV', () => {
  const w = new DataView(silentWav());
  const ascii = (at, n) => String.fromCharCode(...new Uint8Array(w.buffer, at, n));
  const dataBytes = 8000 * 2 * 0.5;              // 8 kHz, 16-bit, half a second

  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(ascii(36, 4), 'data');
  assert.equal(w.getUint16(20, true), 1, 'PCM');
  assert.equal(w.getUint16(22, true), 1, 'mono');
  assert.equal(w.getUint32(24, true), 8000, 'sample rate');
  assert.equal(w.getUint16(34, true), 16, 'bits per sample');
  // The three lengths have to agree with the buffer, or a decoder reads past
  // the end of one chunk and into the next.
  assert.equal(w.byteLength, 44 + dataBytes);
  assert.equal(w.getUint32(4, true), 36 + dataBytes, 'RIFF size');
  assert.equal(w.getUint32(40, true), dataBytes, 'data size');
  assert.equal(w.getUint32(28, true), 8000 * 2, 'byte rate = rate × block align');
  assert.equal(w.getUint16(32, true), 2, 'block align');
});

test('and is actually silent — 16-bit, so silence is zero', () => {
  const buf = silentWav();
  const samples = new Int16Array(buf, 44);
  assert.equal(samples.length, 4000);
  assert.ok(samples.every(s => s === 0), 'every sample is zero');
  // The reason for 16-bit over 8-bit: at 8 bits this same all-zero buffer
  // would be full-scale DC rather than silence.
  assert.notEqual(new DataView(buf).getUint16(34, true), 8);
});
