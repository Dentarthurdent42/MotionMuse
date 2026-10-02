// The setup tag (src/densecode.js): seven colours on the hexagons of a piece of
// Gosper curve, read out of screenshots and recordings — so the tests are
// about what a screenshot does to it, the curve it is laid along, and the
// palette.
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
import { encodeTag, rasterize, readTag, rsCorrect, blocksFor, PALETTE, tagPitch, template } from '../../src/densecode.js';
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
      assert.ok(b.ecc >= b.n * 0.2, 'about three tenths of every block is parity');
    }
  }
});

// ── The palette ───────────────────────────────────────────────────────────

const toLin = (L, a, b) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
          -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
};
const srgbOf = ({ L, C, h }) => toLin(L, C * Math.cos(h * Math.PI / 180), C * Math.sin(h * Math.PI / 180))
  .map(v => Math.max(0, Math.min(1, v)) ** (1 / 2.4));

test('the palette is white and six hues exactly 60° apart in OKLCH', () => {
  assert.deepEqual(PALETTE.map(p => p.name), ['white', 'yellow', 'red', 'magenta', 'blue', 'cyan', 'green']);
  assert.equal(PALETTE[0].L, 1);
  assert.equal(PALETTE[0].C, 0);
  const hues = PALETTE.slice(1).map(p => p.h).sort((x, y) => x - y);
  for (let i = 1; i < hues.length; i++) assert.equal(hues[i] - hues[i - 1], 60);
  assert.equal(hues[0] + 360 - hues[5], 60, 'and round the wheel');
});

test('the six hues are equally light and equally vivid', () => {
  // The point: no hue is a "dark one". sRGB's blue is L 0.45 and its yellow
  // 0.97; these are all one lightness and one chroma.
  const hues = PALETTE.slice(1);
  for (const p of hues) {
    assert.equal(p.L, hues[0].L, p.name);
    assert.equal(p.C, hues[0].C, p.name);
  }
});

test('each hue is near the colour it is named for', () => {
  const named = { yellow: 109.8, red: 29.2, magenta: 328.4, blue: 264.1, cyan: 194.8, green: 142.5 };
  for (const p of PALETTE.slice(1)) {
    const d = Math.abs(((p.h - named[p.name] + 540) % 360) - 180);
    assert.ok(d < 25, `${p.name} at ${p.h}° is ${d.toFixed(1)}° from sRGB ${p.name}`);
  }
});

test('every colour is inside sRGB, and none could pass for an anchor', () => {
  for (const p of PALETTE) {
    const lin = toLin(p.L, p.C * Math.cos(p.h * Math.PI / 180), p.C * Math.sin(p.h * Math.PI / 180));
    assert.ok(lin.every(v => v >= -1e-6 && v <= 1 + 1e-6), `${p.name} in gamut: ${lin.map(v => v.toFixed(3))}`);
    // The finder looks for black by the brightest channel.
    assert.ok(Math.max(...srgbOf(p)) > 0.6, `${p.name} is bright in some channel`);
  }
});

// ── The Gosper curve ─────────────────────────────────────────────────────

test('a tag is whole 49-cell islands of the Gosper curve: distinct hexagons, each next to the last', () => {
  for (const islands of [1, 3, 10, 49]) {
    const { cells } = template(islands);
    assert.equal(cells.length, 49 * islands);
    assert.equal(new Set(cells.map(c => c.join())).size, cells.length, 'no hexagon twice');
    for (let i = 1; i < cells.length; i++) {
      const dq = cells[i][0] - cells[i - 1][0], dr = cells[i][1] - cells[i - 1][1];
      assert.equal((Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2, 1, `step ${i} is to a neighbour`);
    }
  }
});

test('the three anchors sit clear of the cells, top-left, top-right and bottom-left', () => {
  for (const islands of [1, 2, 5, 22, 49]) {
    const t = template(islands);
    const dist = (a, b) => { const dq = a[0] - b[0], dr = a[1] - b[1]; return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2; };
    for (const a of t.anchors) assert.ok(t.cells.every(c => dist(a, c) >= 3), `${islands}: anchor ${a} clear`);
    const [tl, tr, bl] = t.anchorXY;
    assert.ok(tl[0] < tr[0] && Math.abs(tl[1] - tr[1]) < 1, `${islands}: top pair level`);
    assert.ok(bl[1] > tl[1] + 3 && Math.abs(bl[0] - tl[0]) < 3, `${islands}: bottom-left below`);
  }
});

// ── Pixels ────────────────────────────────────────────────────────────────

test('a tag reads back from its own pixels, at whole and fractional pitches', () => {
  const r = rng(3);
  for (const n of [0, 40, 300]) {
    const payload = bytes(n, r);
    const tag = encodeTag(payload);
    for (const pitch of [3, 4, 4.5, 5, 7]) {
      assert.ok(same(readTag(rasterize(tag, pitch)), payload), `${n} bytes, ${pitch}px`);
    }
  }
});

test('the tag is only as many islands as the setup needs', () => {
  const r = rng(4);
  assert.equal(encodeTag(bytes(0, r)).islands, 1);
  assert.ok(encodeTag(bytes(20, r)).islands <= 3, 'a lightly edited stock patch is a small corner code');
  const big = bytes(500, r), t = encodeTag(big);
  assert.ok(t.islands > 30);
  assert.ok(same(readTag(rasterize(t, 4)), big));
  assert.throws(() => encodeTag(bytes(5000, r)), /too much/);
});

test('and from a busy picture around it, after a fractional resample', () => {
  // Resampled to cells of three pixels and up: what a feed leaves of the
  // app's pitch.
  const r = rng(11);
  const payload = bytes(280, r);
  const tag = encodeTag(payload);
  for (const pitch of [7, 8]) {
    for (const f of [0.6, 0.75, 0.92, 1, 1.37]) {
      const img = inFrame(scale(rasterize(tag, pitch), f), r);
      assert.ok(same(readTag(img), payload), `${pitch}px × ${f}`);
    }
  }
});

test('a slight rotation is fitted, not fatal', () => {
  // A screenshot is straight, but a phone photo of a screen rarely is, and
  // the anchors give rotation for free.
  const r = rng(21);
  const payload = bytes(250, r);
  const src = rasterize(encodeTag(payload), 8);
  const a = 0.06, ca = Math.cos(a), sa = Math.sin(a);
  const W = src.width + 40, H = src.height + 40;
  const out = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - W / 2, dy = y - H / 2;
      const sx = Math.round(ca * dx + sa * dy + src.width / 2), sy = Math.round(-sa * dx + ca * dy + src.height / 2);
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
      for (let c = 0; c < 3; c++) out.data[(y * W + x) * 4 + c] = src.data[(sy * src.width + sx) * 4 + c];
    }
  }
  assert.ok(same(readTag(out), payload));
});

test('the app’s tag survives a downscale to 0.62 and noise on every pixel', () => {
  // A phone's 1170px recording on a 720p feed.
  const r = rng(5);
  const payload = bytes(300, r);
  const img = scale(rasterize(encodeTag(payload), 7), 0.62);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 30;
    for (let c = 0; c < 3; c++) img.data[i + c] += n;
  }
  assert.ok(same(readTag(inFrame(img, r)), payload));
});

test('a tinted, washed-out recording still reads — the chart is measured, not assumed', () => {
  // A warm white balance and lifted blacks: every colour moves, and the
  // classifier has to learn where they went from the tag's own chart.
  const r = rng(17);
  const payload = bytes(250, r);
  const img = rasterize(encodeTag(payload), 5);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = 30 + img.data[i] * 0.85;
    img.data[i + 1] = 25 + img.data[i + 1] * 0.8;
    img.data[i + 2] = 10 + img.data[i + 2] * 0.65;
  }
  assert.ok(same(readTag(inFrame(img, r)), payload));
});

test('a smudge across part of the tag is corrected, not fatal', () => {
  // A band of flat grey through the island: a whole stretch of the curve,
  // destroyed. Interleaving spreads it across every block, and half of
  // every block is parity.
  const r = rng(9);
  const payload = bytes(300, r);
  const img = rasterize(encodeTag(payload), 5);
  const y0 = Math.round(img.height * 0.45);
  for (let y = y0; y < y0 + 12; y++) {
    for (let x = Math.round(img.width * 0.2); x < img.width * 0.8; x++) {
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
  // Three black flowers with nothing between them: the anchors alone are not a tag.
  const t = encodeTag(new Uint8Array(100));
  const img = rasterize(t, 5);
  const ink = Array.from(img.data);
  for (let i = 0; i < ink.length; i += 4) if (ink[i] || ink[i + 1] || ink[i + 2]) ink[i] = ink[i + 1] = ink[i + 2] = 255;
  assert.equal(readTag({ ...img, data: Uint8ClampedArray.from(ink) }), null);
});

test('the chart is the palette in order, at the head of the curve', () => {
  const t = encodeTag(new Uint8Array(100));
  for (let k = 0; k < 7; k++) assert.equal(t.cells[k], k);
});

test('the pitch is sized for a 720p feed of the screen it is on', () => {
  assert.equal(tagPitch(1170), 7);    // a phone, upright
  assert.equal(tagPitch(1080), 6);    // a 1080p monitor
  assert.equal(tagPitch(1440), 8);
  assert.equal(tagPitch(2160), 12);   // 4K
  assert.equal(tagPitch(600), 6);     // never under six
});

// ── Tags already out there ───────────────────────────────────────────────
//
// A tag in a posted recording is frozen exactly like a printed QR code. These
// are tags made by past versions of the encoder; they are never regenerated.
// If one stops reading, the reader changed — put it back.
const TAGS = JSON.parse(readFileSync(new URL('fixtures/setup-tags.json', import.meta.url), 'utf8'));

for (const fx of TAGS) {
  test(`a tag made by ${fx.made_by} still reads (${fx.note})`, () => {
    const cells = Uint8Array.from(fx.cells, ch => Number(ch));
    const bytesOut = readTag(rasterize({ islands: fx.islands, cells }, 7));
    assert.ok(bytesOut, 'found and decoded');
    assert.equal(String.fromCharCode(bytesOut[0]), 'c', 'it carries a c-packed setup');
  });
}
