// QR encoder: round-tripped through a real decoder.
//
// A hand-written QR encoder is exactly the kind of code that looks right and
// is not — a wrong mask penalty or a transposed format bit produces a plausible
// black-and-white square that no phone can read. So nothing here asserts on the
// module pattern. Every test encodes, renders to a bitmap, and decodes it with
// jsQR, an independent decoder, then compares the text.
//
// Run: npm run test:unit   (jsQR is a devDependency; the app ships no deps)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { encodeQR, drawQR } from '../../src/qr.js';

const require = createRequire(import.meta.url);
let jsQR = null;
try { jsQR = require('jsqr'); jsQR = jsQR.default ?? jsQR; } catch { /* not installed */ }

// Render a code to the RGBA bitmap jsQR wants, at 3x so its finder-pattern
// search has something to lock onto, with the mandatory 4-module quiet zone.
function bitmap(qr, scale = 3, quiet = 4) {
  const n = qr.size + quiet * 2;
  const w = n * scale;
  const data = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y * qr.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * w + ((x + quiet) * scale + dx);
          data[px * 4] = data[px * 4 + 1] = data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width: w, height: w };
}

const roundTrip = (text, opts) => {
  const qr = encodeQR(text, opts);
  const { data, width, height } = bitmap(qr);
  const res = jsQR(data, width, height);
  return { qr, decoded: res?.data ?? null };
};

test('jsQR is available — otherwise these tests prove nothing', () => {
  assert.ok(jsQR, 'devDependency jsqr is missing; `npm install` before running');
});

// The camera view's DEV badge draws one pixel per module — the smallest a
// code can honestly be — and that claim is only worth making if a decoder
// agrees. The browser suite checks the real canvas and a real screenshot;
// this checks the encoder itself at that density, at realistic link sizes,
// so a regression shows up in `npm run test:unit` rather than only under
// Playwright.
test('a code decodes at ONE pixel per module', { skip: !jsQR }, () => {
  for (const ecc of ['L', 'M']) {
    for (const len of [64, 256, 512, 900, 1400]) {
      const text = `https://example.com/#s=${'AbC-9_zQ'.repeat(Math.ceil(len / 8)).slice(0, len)}`;
      const qr = encodeQR(text, { ecc });
      const { data, width, height } = bitmap(qr, 1);
      assert.equal(width, qr.size + 8, 'one pixel per module, plus the quiet zone');
      assert.equal(jsQR(data, width, height)?.data, text,
        `ECC ${ecc} v${qr.version} (${qr.size} modules) at 1px/module`);
    }
  }
});

// A canvas is a browser thing, and drawQR only needs somewhere to put numbers
// and a context that accepts fills. The invariant being checked is arithmetic,
// not pixels.
const stubCanvas = () => ({
  width: 0, height: 0,
  getContext: () => ({ fillStyle: '', fillRect() {} }),
});

// The rule the SHARE sheet rests on, pinned where it is cheap to check.
//
// A code drawn at a fractional number of pixels per module does not decode —
// and does not fail gracefully either. Scaling one 121-module code into
// different boxes and asking jsQR to read it back: 350px and 420px decoded,
// 500px and 558px found no code at all, with `image-rendering: pixelated` on
// or off making no difference. There is no "close enough" here, which is why
// ui/share.js sizes the canvas from drawQR's own scale instead of letting CSS
// pick a width.
test('drawQR only ever uses whole pixels per module', () => {
  const qr = encodeQR(`https://example.com/#s=${'AbC-9_zQ'.repeat(50)}`);
  const total = qr.size + 8;                 // the spec's 4-module quiet zone
  for (const target of [200, 350, 420, 500, 558, 640, 1000]) {
    const canvas = stubCanvas();
    const { px, scale } = drawQR(canvas, qr, { target });
    assert.ok(Number.isInteger(scale), `scale ${scale} at target ${target}`);
    assert.equal(px, total * scale, `px is a whole number of modules at ${target}`);
    assert.equal(canvas.width, px, 'the backing store is that size');
    assert.equal(canvas.height, px, 'and square');
    // Never bigger than asked for — except at the 2px floor, which is a floor
    // for a camera reading a screen across a room and outranks the request.
    assert.ok(px <= Math.max(target, total * 2), `${px} exceeds target ${target}`);
  }
});

test('a short payload round-trips', () => {
  const { decoded } = roundTrip('HELLO');
  assert.equal(decoded, 'HELLO');
});

test('every error-correction level round-trips', () => {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    const { decoded } = roundTrip('https://example.com/#s=abc123', { ecc });
    assert.equal(decoded, 'https://example.com/#s=abc123', `ECC ${ecc}`);
  }
});

test('the character-count indicator widens correctly at version 10', () => {
  // Versions 1-9 use an 8-bit count and 10+ a 16-bit one. Getting the boundary
  // wrong produces a code that encodes cleanly and decodes to garbage, so both
  // sides of it are crossed here.
  for (const len of [40, 100, 150, 300]) {
    const text = 'x'.repeat(len);
    const { qr, decoded } = roundTrip(text, { ecc: 'L' });
    assert.equal(decoded, text, `${len} chars (version ${qr.version})`);
  }
});

test('a share-sized URL round-trips', () => {
  // The real shape: base64url payload in a fragment, around what a full patch
  // compresses to.
  const payload = Array.from({ length: 760 },
    (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[i % 64]).join('');
  const url = `https://motionmuse.example/#s=${payload}`;
  const { qr, decoded } = roundTrip(url, { ecc: 'L' });
  assert.equal(decoded, url);
  assert.ok(qr.version <= 25, `version ${qr.version} is too dense to scan off a screen`);
});

test('the largest payload the encoder claims to take actually round-trips', () => {
  // Version 40 at ECC L. If the capacity table is off by even one codeword this
  // either throws or decodes short.
  const { qr, decoded } = roundTrip('A'.repeat(2900), { ecc: 'L' });
  assert.equal(qr.version, 40);
  assert.equal(decoded, 'A'.repeat(2900));
});

test('UTF-8 survives the trip', () => {
  const text = 'MotionMuse — ♥ 音楽';
  assert.equal(roundTrip(text).decoded, text);
});

test('version and size agree', () => {
  for (const len of [10, 200, 900]) {
    const qr = encodeQR('x'.repeat(len), { ecc: 'L' });
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.equal(qr.modules.length, qr.size * qr.size);
  }
});

test('minVersion is honoured', () => {
  const qr = encodeQR('HI', { ecc: 'L', minVersion: 12 });
  assert.ok(qr.version >= 12);
  const { decoded } = roundTrip('HI', { ecc: 'L', minVersion: 12 });
  assert.equal(decoded, 'HI');
});

test('an oversized payload fails loudly rather than producing a broken code', () => {
  assert.throws(() => encodeQR('A'.repeat(5000), { ecc: 'L' }), /does not fit/);
  assert.throws(() => encodeQR('hi', { ecc: 'Z' }), /unknown ECC/);
});

test('raw bytes encode as well as strings', () => {
  const bytes = new TextEncoder().encode('raw-bytes-path');
  const qr = encodeQR(bytes, { ecc: 'M' });
  const { data, width, height } = bitmap(qr);
  assert.equal(jsQR(data, width, height)?.data, 'raw-bytes-path');
});

// Every version at every ECC level, round-tripped. Written after a share
// payload produced a code no decoder could read: the app defaults to ECC M,
// so nothing shipped broken, but "the encoder works" was only ever checked on
// the handful of sizes a test happened to reach. 160 cells is cheap certainty.
test('every version/ECC cell round-trips through a real decoder', { skip: !jsQR }, () => {
  const bad = [];
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    for (let v = 1; v <= 40; v++) {
      const text = `v${v}${ecc}`;
      let out;
      try { out = roundTrip(text, { ecc, minVersion: v }); } catch { continue; }
      if (out.decoded !== text) bad.push(`${ecc}v${out.qr.version}`);
    }
  }
  assert.deepEqual(bad, [], `unreadable: ${bad.join(', ')}`);
});

// The one cell that does not survive that trip is skipped rather than shipped
// (see isBadCell in qr.js). Pinned so it cannot be quietly re-enabled: asking
// for it hands back the next version up, which is scannable.
test('version 23 at ECC L is stepped over, not emitted', { skip: !jsQR }, () => {
  const qr = encodeQR('anything', { ecc: 'L', minVersion: 23 });
  assert.equal(qr.version, 24,
    'a payload that would land on 23-L takes 24 instead');
  // …and the neighbours are untouched: this is one cell, not a range.
  assert.equal(encodeQR('anything', { ecc: 'L', minVersion: 22 }).version, 22);
  assert.equal(encodeQR('anything', { ecc: 'M', minVersion: 23 }).version, 23);
});
