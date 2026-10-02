// The setup tag (src/densecode.js): a code read out of screenshots and
// recordings, so the tests are about what a screenshot does to it.
//
// Everything here decodes the tag from a BITMAP — the encoder's output drawn
// to pixels, then scaled, smudged, embedded in a busy picture and damaged —
// never from the encoder's own cell array. A reader that only ever saw perfect
// input would prove only that the two halves agree with each other.
//
// What a real recording does (H.264, 4:2:0, a feed's resolution) is measured
// by tests/tag-recording, which needs ffmpeg; the numbers that chose the cell
// size come from there and are written up in the README.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeTag, rasterize, readTag, rsCorrect, blocksFor } from '../../src/densecode.js';
import { rsRemainder } from '../../src/qr.js';

// A seeded generator: a failure has to be reproducible to be fixable.
const rng = (seed = 1) => () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 2 ** 32;
};
const bytes = (n, r) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

// Bilinear resampling by `f` — what a screenshot of a scaled video frame, or a
// browser's own zoom, does to the pixels.
function scale(img, f) {
  const W = Math.round(img.width * f), H = Math.round(img.height * f);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = (x + 0.5) / f - 0.5, sy = (y + 0.5) / f - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
      const ax = Math.min(1, Math.max(0, sx - x0)), ay = Math.min(1, Math.max(0, sy - y0));
      for (let c = 0; c < 4; c++) {
        const g = (xx, yy) => img.data[(yy * img.width + xx) * 4 + c];
        out[(y * W + x) * 4 + c] = (g(x0, y0) * (1 - ax) + g(x1, y0) * ax) * (1 - ay)
                                 + (g(x0, y1) * (1 - ax) + g(x1, y1) * ax) * ay;
      }
    }
  }
  return { width: W, height: H, data: out };
}

// The tag pasted into a busy, dark, noisy frame at an odd offset — a camera
// picture is the background it actually sits on.
function inFrame(img, r, pad = 160) {
  const W = img.width + 2 * pad, H = img.height + pad;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = 20 + r() * 90;
    data[i * 4] = v + 20; data[i * 4 + 1] = v; data[i * 4 + 2] = v * 0.6; data[i * 4 + 3] = 255;
  }
  const ox = pad + 7, oy = Math.floor(pad / 2) + 3;
  for (let y = 0; y < img.height; y++) {
    data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((oy + y) * W + ox) * 4);
  }
  return { width: W, height: H, data };
}

// ── Reed–Solomon ──────────────────────────────────────────────────────────

test('Reed–Solomon corrects up to half its parity in errors, anywhere in the block', () => {
  const r = rng(7);
  for (let t = 0; t < 300; t++) {
    const k = 5 + Math.floor(r() * 180), e = 2 * (1 + Math.floor(r() * 30));
    if (k + e > 255) continue;
    const data = bytes(k, r);
    const cw = new Uint8Array(k + e);
    cw.set(data);
    cw.set(rsRemainder(data, e), k);
    const errs = Math.floor(r() * (e / 2 + 1));
    const at = new Set();
    while (at.size < errs) at.add(Math.floor(r() * cw.length));
    for (const p of at) cw[p] ^= 1 + Math.floor(r() * 255);
    assert.ok(rsCorrect(cw, e), `${errs} errors in ${k}+${e}`);
    assert.ok(same(cw.subarray(0, k), data), `${errs} errors in ${k}+${e} corrected to the original`);
  }
});

test('the block structure follows from the codeword count alone', () => {
  // The reader rebuilds it from the grid it measured, with no header to read.
  for (const total of [9, 100, 255, 256, 600, 1500]) {
    const blocks = blocksFor(total);
    assert.equal(blocks.reduce((s, b) => s + b.n, 0), total);
    for (const b of blocks) {
      assert.ok(b.n <= 255, 'a block fits the field');
      assert.ok(b.ecc >= b.n * 0.2, 'at least a fifth of every block is parity');
    }
  }
});

// ── Pixels ────────────────────────────────────────────────────────────────

test('a tag reads back from its own pixels, at every cell size down to one pixel', () => {
  const r = rng(3);
  {
    for (const n of [0, 1, 40, 300, 1200]) {
      const payload = bytes(n, r);
      const tag = encodeTag(payload);
      for (const cell of [1, 2, 3, 4, 6]) {
        // At one pixel a cell, an empty tag is a 7px smudge — shorter than the
        // shortest run the reader will consider a bottom edge. No setup is
        // that small.
        if (cell === 1 && n < 40) continue;
        assert.ok(same(readTag(rasterize(tag, cell)), payload), `${n} bytes, ${cell}px`);
      }
    }
  }
});

test('and from a busy picture around it, after a fractional resample', () => {
  // Cells of three pixels and up: the size the app draws them at.
  const r = rng(11);
  const payload = bytes(280, r);
  const tag = encodeTag(payload);
  for (const cell of [3, 4, 6]) {
    for (const f of [0.5, 0.75, 0.92, 1, 1.37, 2.5]) {
      const img = inFrame(scale(rasterize(tag, cell), f), r);
      assert.ok(same(readTag(img), payload), `${cell}px × ${f}`);
    }
  }
});

test('the app’s tag — three pixels a cell — survives a downscale to half and noise on every pixel', () => {
  const r = rng(5);
  const payload = bytes(300, r);
  const img = scale(rasterize(encodeTag(payload), 3), 0.5);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 40;
    for (let c = 0; c < 3; c++) img.data[i + c] += n;
  }
  assert.ok(same(readTag(inFrame(img, r)), payload));
});

test('a smudge across part of the tag is corrected, not fatal', () => {
  // A band of flat grey three rows tall straight through the data: a few
  // dozen bytes in a row, destroyed. Interleaving spreads them across every
  // block, which is what lets the parity absorb them.
  const r = rng(9);
  const payload = bytes(300, r);
  const tag = encodeTag(payload);
  const cell = 4;
  const img = rasterize(tag, cell);
  const y0 = (3 + Math.floor(tag.rows / 2)) * cell;
  for (let y = y0; y < y0 + 3 * cell; y++) {
    for (let x = 4 * cell; x < img.width - 4 * cell; x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 128;
    }
  }
  assert.ok(same(readTag(img), payload));
});

test('nothing is found where there is no tag', () => {
  const r = rng(13);
  const blank = { width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4).fill(255) };
  assert.equal(readTag(blank), null);
  assert.equal(readTag(inFrame(blank, r)), null);
  // An L of the right kind with nothing behind it: the finder alone is not a tag.
  const l = { width: 200, height: 120, data: new Uint8ClampedArray(200 * 120 * 4).fill(255) };
  for (let y = 10; y < 100; y++) for (let x = 10; x < 180; x++) {
    if (x < 14 || y > 95) { const o = (y * 200 + x) * 4; l.data[o] = l.data[o + 1] = l.data[o + 2] = 0; }
  }
  assert.equal(readTag(l), null);
});

test('the grid is odd on both sides, so both clocks end on a dark corner', () => {
  for (const n of [0, 10, 100, 500]) {
    const t = encodeTag(new Uint8Array(n));
    assert.equal(t.cols % 2, 1);
    assert.equal(t.rows % 2, 1);
  }
});

test('a typical setup’s tag is small', () => {
  // ~250 bytes is a lightly edited non-default patch in the 'b' packing.
  const t = encodeTag(new Uint8Array(250));
  assert.ok(t.cols * t.rows < 3600, `${t.cols}×${t.rows} cells`);
  assert.ok(t.cols <= 2.6 * t.rows, `a strip, not a ribbon: ${t.cols}×${t.rows}`);
});

// ── Tags already out there ───────────────────────────────────────────────
//
// A tag in a posted recording is frozen exactly like a printed QR code. These
// are tags made by past versions of the encoder; they are never regenerated.
// If one stops reading, the reader changed — put it back.
const TAGS = JSON.parse(readFileSync(new URL('fixtures/setup-tags.json', import.meta.url), 'utf8'));

for (const fx of TAGS) {
  test(`a tag made by ${fx.made_by} still reads (${fx.note})`, () => {
    const rows = fx.rows.length, cols = fx.rows[0].length;
    const cells = Uint8Array.from(fx.rows.join(''), ch => Number(ch));
    const bytesOut = readTag(rasterize({ cols, rows, cells }, 3));
    assert.ok(bytesOut, 'found and decoded');
    assert.equal(String.fromCharCode(bytesOut[0]), 'b', 'it carries a b-packed setup');
  });
}
