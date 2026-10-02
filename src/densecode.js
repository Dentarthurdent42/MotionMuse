// The setup tag — a small, dense 2D code made to be read back out of a
// SCREENSHOT, not through a camera.
//
// A QR code is designed for the hardest case: a phone held at an angle across
// a room, a printed sticker that is creased, dirty and badly lit. Every module
// of finder pattern, alignment pattern and error-correction headroom it spends
// is spent on that case, and it is why a whole setup came out 129px square at
// one pixel per module — too big to leave on the picture (see the README).
//
// A screenshot of the screen, or a frame grabbed from a screen recording, is a
// far easier case, and this format spends nothing on what it never meets:
//
//   • no rotation and no perspective. A screenshot is axis-aligned. So the
//     finder is the cheapest one there is — Data Matrix's: a solid line down
//     the left and along the bottom (the "L"), and alternating "clock" cells
//     along the top and the right that give the grid's pitch. One cell of
//     border per side, against QR's three 7×7 finder squares;
//   • no URL. The tag carries the setup's raw bytes, not a link with base64 in
//     it: a third fewer bits before anything else is done;
//   • small cells. A camera across a room needs modules it can resolve at a
//     distance; a screenshot holds the pixels themselves, and the cell can be
//     as small as what a RECORDING of the screen still resolves.
//
// What it has to survive is real, though: a screen recording is resampled
// (the phone's 1170px to a feed's 1080, or 720, or 540) and compressed (H.264,
// 4:2:0). So the tag is pure black and white (colour is the first thing chroma
// subsampling throws away), the reader samples cell CENTRES on a grid it fits
// to the clock tracks (so a fractional scale smearing the edges costs nothing),
// and every byte is Reed–Solomon protected with a quarter of each block spent
// on correction.
//
// Black and white, not greys, was measured rather than assumed. Four grey
// levels carry two bits a cell, so a grey tag at four pixels a cell is the
// same size as a black-and-white one at three. Through the same real H.264
// recordings (tests/tag-recording) the grey one failed two cases the
// black-and-white one read — a 540px-wide feed at CRF 33, and 1080 at CRF 40 —
// and read none it missed. Compression blurs edges, which costs a binary cell
// little; it also shifts levels, which costs a grey cell everything.
//
// Layout of a tag of C columns × R rows (both odd, so both clock tracks end on
// a dark corner):
//
//     row 0      ■ □ ■ □ ■ □ ■ … □ ■     top clock: dark on even columns
//     row 1..    ■ d d d d d d … d □     right clock: dark on even rows
//                ■ d d d d d d … d ■       counted from the bottom
//                ■ d d d d d d … d □
//     row R-1    ■ ■ ■ ■ ■ ■ ■ … ■ ■     the L: left column, bottom row
//
// with a light quiet zone around it. The interior cells `d` carry, in reading
// order, the interleaved Reed–Solomon codewords XORed with a fixed whitening
// sequence (so padding is not a field of identical cells).
//
// The codewords hold: one MAGIC byte (which is also the format's version),
// a two-byte length, the payload, then padding.

import { GF_EXP, GF_LOG, gfMul, rsRemainder } from './qr.js';

// ── Format constants ──────────────────────────────────────────────────────
//
// These are the format. A tag in a recording that was posted somewhere is
// frozen exactly like a printed QR code is, so none of them can change under
// the same MAGIC: a new layout takes a new MAGIC byte, and the reader keeps
// understanding the old one.
const MAGIC = 0xA1;
const HEADER = 3;                 // MAGIC + 16-bit length
// The share of each Reed–Solomon block spent on correction. A quarter
// corrects one byte in eight anywhere in the block.
const ECC_SHARE = 0.25;
const MAX_BLOCK = 255;

// ── Reed–Solomon decoding ─────────────────────────────────────────────────
//
// qr.js only ever writes codes, so it has only the encoder. Reading needs the
// other half: syndromes, Berlekamp–Massey for the error locator, a Chien
// search for its roots, Forney for the magnitudes. Same field (0x11D) and the
// same generator (roots α^0…α^(n-1)) as qr.js's rsRemainder, which is what
// makes the encoder's output something this can correct.
//
// `cw` is one block, data then parity, highest-degree coefficient first (the
// order rsRemainder produces). Corrected in place; returns false when there are
// more errors than the parity can locate.
const gfPow = e => GF_EXP[((e % 255) + 255) % 255];
const gfInv = a => GF_EXP[255 - GF_LOG[a]];

function polyEvalLowFirst(p, x) {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i--) y = gfMul(y, x) ^ p[i];
  return y;
}

export function rsCorrect(cw, nsym) {
  const n = cw.length;
  // Syndromes S_j = r(α^j), r(x) = Σ cw[k] x^(n-1-k).
  const S = new Uint8Array(nsym);
  let clean = true;
  for (let j = 0; j < nsym; j++) {
    const x = gfPow(j);
    let y = 0;
    for (let k = 0; k < n; k++) y = gfMul(y, x) ^ cw[k];
    S[j] = y;
    if (y) clean = false;
  }
  if (clean) return true;

  // Berlekamp–Massey: the shortest LFSR Λ(x) (lowest degree first) that
  // generates the syndromes. Its degree is the number of errors.
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let i = 0; i < nsym; i++) {
    let d = S[i];
    for (let k = 1; k <= L; k++) d ^= gfMul(C[k] ?? 0, S[i - k]);
    if (d === 0) { m++; continue; }
    const coef = gfMul(d, gfInv(b));
    const next = C.slice();
    while (next.length < B.length + m) next.push(0);
    for (let k = 0; k < B.length; k++) next[k + m] ^= gfMul(coef, B[k]);
    if (2 * L <= i) {
      B = C; L = i + 1 - L; b = d; m = 1;
    } else m++;
    C = next;
  }
  while (C.length > 1 && C[C.length - 1] === 0) C.pop();
  if (C.length - 1 !== L || 2 * L > nsym) return false;

  // Chien search: an error at power p (array index n-1-p) is a root α^-p.
  const powers = [];
  for (let p = 0; p < n; p++) if (polyEvalLowFirst(C, gfPow(-p)) === 0) powers.push(p);
  if (powers.length !== L) return false;

  // Forney, for a generator whose first root is α^0:
  //   e = X · Ω(X⁻¹) / Λ'(X⁻¹),  Ω = S·Λ mod x^nsym.
  const omega = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    let v = 0;
    for (let k = 0; k <= i && k < C.length; k++) v ^= gfMul(C[k], S[i - k]);
    omega[i] = v;
  }
  for (const p of powers) {
    const X = gfPow(p), Xi = gfInv(X);
    let dl = 0;   // Λ'(Xi): only the odd terms survive in characteristic 2
    for (let k = 1; k < C.length; k += 2) dl ^= gfMul(C[k], gfPow(-p * (k - 1)));
    if (dl === 0) return false;
    const e = gfMul(X, gfMul(polyEvalLowFirst(omega, Xi), gfInv(dl)));
    cw[n - 1 - p] ^= e;
  }
  return true;
}

// ── Codeword layout ───────────────────────────────────────────────────────
//
// Everything below follows from ONE number, the codeword count, so the reader
// can rebuild the block structure from the grid it measured without a header
// that would itself need protecting.
export function blocksFor(total) {
  const nb = Math.ceil(total / MAX_BLOCK);
  const out = [];
  for (let i = 0; i < nb; i++) {
    const n = Math.floor(total / nb) + (i < total % nb ? 1 : 0);
    const ecc = Math.max(2, 2 * Math.round(n * ECC_SHARE / 2));
    out.push({ n, ecc, data: n - ecc });
  }
  return out;
}

const dataCapacity = total => blocksFor(total).reduce((s, b) => s + Math.max(0, b.data), 0);

// A fixed pseudo-random byte stream (xorshift32 from a constant seed) XORed
// over the codewords. Padding and long runs of equal bytes would otherwise be
// long runs of equal cells, and a flat featureless field is exactly what a video
// encoder smooths away first.
function whitening(len) {
  const out = new Uint8Array(len);
  let s = 0x9E3779B9;
  for (let i = 0; i < len; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out[i] = s & 0xFF;
  }
  return out;
}

// Interleave: byte i of every block, then byte i+1 of every block… so damage
// confined to one part of the tag is spread across all the blocks rather than
// spent on one.
function interleave(blocks) {
  const out = [];
  const longest = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  return out;
}

function deinterleave(stream, layout) {
  const blocks = layout.map(l => new Uint8Array(l.n));
  const longest = Math.max(...layout.map(l => l.n));
  let k = 0;
  for (let i = 0; i < longest; i++) {
    for (let j = 0; j < layout.length; j++) if (i < layout[j].n) blocks[j][i] = stream[k++];
  }
  return blocks;
}

const interior = (cols, rows) => (cols - 2) * (rows - 2);
const codewordsFor = (cols, rows) => Math.floor(interior(cols, rows) / 8);

// ── Encoding ──────────────────────────────────────────────────────────────

// The smallest odd grid that holds `need` data bytes within a fifth of
// `aspect` (columns per row) either way — the tag's place is a corner, so it
// should be a predictable shape, not a ribbon one day and a square the next. Searched
// rather than solved: the block structure's rounding makes capacity a
// staircase, not a formula.
function pickGrid(need, aspect) {
  let best = null, fallback = null;
  for (let rows = 7; rows <= 199; rows += 2) {
    let cols = 7;
    while (cols < 999 && dataCapacity(codewordsFor(cols, rows)) < need) cols += 2;
    if (cols >= 999) continue;
    const g = { cols, rows, area: cols * rows };
    if (!fallback || g.area < fallback.area) fallback = g;
    const ratio = cols / rows / aspect;
    if (ratio >= 0.8 && ratio <= 1.2 && (!best || g.area < best.area)) best = g;
    // Taller than wide: every grid after this is only bigger.
    if (cols < rows) break;
  }
  if (!fallback) throw new Error('too much to fit in a setup tag');
  return best ?? fallback;
}

// bytes → { cols, rows, cells } where `cells` holds 1 for each dark cell and
// 0 for each light one, row-major, frame included. `aspect` is the columns per
// row the grid is kept near.
export function encodeTag(payload, { aspect = 2 } = {}) {
  const data = Uint8Array.from(payload);
  if (data.length > 0xFFFF) throw new Error('too much to fit in a setup tag');
  const need = HEADER + data.length;
  const { cols, rows } = pickGrid(need, aspect);
  const total = codewordsFor(cols, rows);
  const layout = blocksFor(total);

  const stream = new Uint8Array(layout.reduce((s, b) => s + b.data, 0));
  stream[0] = MAGIC;
  stream[1] = data.length >> 8;
  stream[2] = data.length & 0xFF;
  stream.set(data, HEADER);

  const blocks = [];
  let at = 0;
  for (const l of layout) {
    const d = stream.subarray(at, at + l.data);
    at += l.data;
    const block = new Uint8Array(l.n);
    block.set(d);
    block.set(rsRemainder(d, l.ecc), l.data);
    blocks.push(block);
  }
  const words = interleave(blocks);
  const mask = whitening(words.length);
  for (let i = 0; i < words.length; i++) words[i] ^= mask[i];

  const cells = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dark = c === 0 || r === rows - 1
        || (r === 0 && c % 2 === 0)
        || (c === cols - 1 && (rows - 1 - r) % 2 === 0);
      if (dark) cells[r * cols + c] = 1;
    }
  }
  // Interior, reading order, one bit a cell from the codeword stream, MSB
  // first. 1 is dark — ink is the "set" bit, as on every barcode. Cells past
  // the last codeword stay light.
  const totalBits = words.length * 8;
  let bit = 0;
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++, bit++) {
      if (bit < totalBits) cells[r * cols + c] = (words[bit >> 3] >> (7 - (bit & 7))) & 1;
    }
  }
  return { cols, rows, cells };
}

// Cells of light margin on every side. Three, not two: at two, a tag shrunk
// to a 720px feed has under four pixels of margin, and the compressor blurs
// the dark picture around it into them until the bar's bottom edge no longer
// has light beneath it.
export const QUIET = 3;

// The tag as an RGBA bitmap at `cell` pixels per cell — what a canvas's
// putImageData wants, and what the tests decode without a browser.
export function rasterize(tag, cell = 3, quiet = QUIET) {
  const width = (tag.cols + 2 * quiet) * cell;
  const height = (tag.rows + 2 * quiet) * cell;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let r = 0; r < tag.rows; r++) {
    for (let c = 0; c < tag.cols; c++) {
      if (!tag.cells[r * tag.cols + c]) continue;
      for (let y = 0; y < cell; y++) {
        let o = (((r + quiet) * cell + y) * width + (c + quiet) * cell) * 4;
        for (let x = 0; x < cell; x++, o += 4) {
          data[o] = 0; data[o + 1] = 0; data[o + 2] = 0;
        }
      }
    }
  }
  return { width, height, data };
}

// Paint a tag into a canvas at a whole number of device pixels per cell.
// Whole, for the reason src/ui/share.js gives for the QR: a canvas CSS has to
// resample is a canvas whose cell edges land between pixels. The reader here
// samples centres and so tolerates it far better than a QR reader does, but
// the screen is the one place the tag can be perfect, and a recording only
// ever makes it worse.
export function drawTag(canvas, tag, cell = 3) {
  const img = rasterize(tag, cell);
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(img.width, img.height);
  out.data.set(img.data);
  ctx.putImageData(out, 0, 0);
  return { width: img.width, height: img.height };
}

// ── Reading ───────────────────────────────────────────────────────────────
//
// image: { width, height, data } — RGBA, as from getImageData. Returns the
// payload bytes of the first tag found, or null.
//
// The search: every row is scanned for a long dark run with light directly
// beneath it — the bottom edge of the L. From its left end the reader climbs
// the left column to the top-left corner, measures one cell there, and then
// FITS the grid: for every plausible column count it samples the top clock
// track at the implied cell centres and keeps the count that alternates best,
// and the same for the rows on the right track. Fitting rather than counting
// transitions is what makes it indifferent to a recording's fractional scale,
// where one cell is two pixels wide and the next is three.
export function readTag(image) {
  const { width: W, height: H, data } = image;
  const Y = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < Y.length; i++, j += 4) {
    Y[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  }
  const dark = (x, y) => Y[y * W + x] < 128;
  const tried = new Set();

  for (let y = H - 2; y >= 6; y--) {
    let x = 0;
    while (x < W) {
      if (!dark(x, y)) { x++; continue; }
      let x1 = x;
      while (x1 + 1 < W && dark(x1 + 1, y)) x1++;
      const len = x1 - x + 1;
      if (len >= 14) {
        const key = `${x >> 2},${x1 >> 2},${y >> 2}`;
        if (!tried.has(key) && lightBelow(dark, x, x1, y, H)) {
          tried.add(key);
          const found = tryAt(Y, W, H, x, x1, y);
          if (found) return found;
        }
      }
      x = x1 + 1;
    }
  }
  return null;
}

// Mostly light directly beneath — or one row further down. A compressed or resampled
// edge is a row that is neither: part of the bar, part of the margin, its
// dark pixels in broken runs. The last whole row of the bar has that row
// under it, and the margin under that.
function lightBelow(dark, x0, x1, y, H) {
  for (const dy of [1, 2]) {
    if (y + dy >= H) return false;
    let d = 0;
    for (let x = x0; x <= x1; x++) if (dark(x, y + dy)) d++;
    if (d <= (x1 - x0 + 1) * 0.2) return true;
  }
  return false;
}

function tryAt(Y, W, H, x0, x1, yb) {
  const px = (x, y) => Y[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  const isDark = (x, y) => px(Math.round(x), Math.round(y)) < 128;
  // Bilinear: a cell centre on a resampled image falls between pixels, and
  // the nearest one can be the edge.
  const at = (x, y) => {
    const fx = x - 0.5, fy = y - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
    return (px(ix, iy) * (1 - ax) + px(ix + 1, iy) * ax) * (1 - ay)
         + (px(ix, iy + 1) * (1 - ax) + px(ix + 1, iy + 1) * ax) * ay;
  };
  // Cell height: the bottom bar's thickness where nothing dark sits on top of
  // it. Data cells above the bar are dark about half the time, so the thinnest
  // of a dozen measurements along it is the bar alone.
  let ch = Infinity;
  for (let i = 1; i <= 12; i++) {
    const x = x0 + Math.round((x1 - x0) * i / 13);
    let t = 0;
    while (t < 64 && yb - t >= 0 && isDark(x, yb - t)) t++;
    ch = Math.min(ch, t);
  }
  if (!Number.isFinite(ch) || ch < 1 || ch >= 64) return null;
  // The bar's ends, re-measured along its middle rather than its edge row,
  // where the blur is least.
  {
    const ym = yb - Math.floor((ch - 1) / 2);
    const mid = (x0 + x1) >> 1;
    if (!isDark(mid, ym)) return null;
    let a = mid, z = mid;
    while (a - 1 >= 0 && isDark(a - 1, ym)) a--;
    while (z + 1 < W && isDark(z + 1, ym)) z++;
    x0 = a; x1 = z;
  }

  // The left column: climb it from the middle of its width.
  const xl = x0 + Math.max(0, Math.floor(ch / 2));
  let yt = yb - Math.floor(ch / 2);
  if (!isDark(xl, yt)) return null;
  while (yt - 1 >= 0 && isDark(xl, yt - 1)) yt--;
  const hpx = yb - yt + 1, wpx = x1 - x0 + 1;
  if (hpx < 7 * ch * 0.7) return null;
  // The quiet zone: light to the left of the column, all the way up. Two
  // pixels out, not one: in a resampled image the pixel on the edge is a blend
  // of the column and the margin, and which side of the threshold it lands on
  // changes from row to row.
  let lightLeft = 0;
  for (let i = 0; i < 8; i++) {
    const y = yt + Math.round(hpx * (i + 0.5) / 8);
    if (x0 - 2 >= 0 && !isDark(x0 - 2, y)) lightLeft++;
  }
  if (lightLeft < 7) return null;
  // One cell's width, from the top-left corner: dark, then the clock's first
  // light cell. Only a hint — it breaks ties in the clock fit below — so when
  // a blurred edge pixel reads light and the run comes out empty, the cell's
  // height stands in for it rather than the tag being given up on.
  const ty = yt + ch / 2;
  let cw = 0;
  while (cw < 64 && isDark(x0 + cw, ty)) cw++;
  if (cw < 1) cw = ch;

  const cols = fitClock(wpx, cw,
    (n, i) => at(x0 + (i + 0.5) * wpx / n, ty), i => i % 2 === 0);
  if (!cols) return null;
  const rows = fitClock(hpx, ch,
    (n, j) => at(x0 + (cols - 0.5) * wpx / cols, yt + (j + 0.5) * hpx / n), j => j % 2 === 0);
  if (!rows) return null;

  // The grid's sub-pixel phase. The edges above were found by thresholding,
  // which on a blurred edge is off by up to half a pixel — nothing on a 4px
  // cell, a third of a cell on a recording that has squeezed three pixels to
  // one and a half. So the start and pitch along each axis are nudged to
  // whatever makes that axis's clock track alternate most strongly. Columns,
  // rows, then columns again: each axis's clock is read at the other's centre.
  const even = i => i % 2 === 0;
  let gx = refine(x0, wpx / cols, cols, x => at(x, ty), even);
  const gy = refine(yt, hpx / rows, rows, y => at(gx.start + (cols - 0.5) * gx.pitch, y), even);
  gx = refine(gx.start, gx.pitch, cols, x => at(x, gy.start + 0.5 * gy.pitch), even);
  const pw = gx.pitch, ph = gy.pitch;

  // Reference levels from the frame itself: the L for black, the clocks'
  // light cells for white. The recording's own contrast, not an assumption.
  const sample = (c, r) => {
    const cx = gx.start + (c + 0.5) * pw, cy = gy.start + (r + 0.5) * ph;
    const rx2 = Math.max(0, Math.floor(pw * 0.2)), ry2 = Math.max(0, Math.floor(ph * 0.2));
    let s = 0, n = 0;
    for (let dy = -ry2; dy <= ry2; dy++) for (let dx = -rx2; dx <= rx2; dx++) { s += at(cx + dx, cy + dy); n++; }
    return s / n;
  };
  const blacks = [], whites = [];
  for (let r = 0; r < rows; r++) blacks.push(sample(0, r));
  for (let c = 1; c < cols; c += 2) whites.push(sample(c, 0));
  const lo = median(blacks), hi = median(whites);
  if (hi - lo < 60) return null;

  // Each cell against the midpoint of THIS tag's black and white, as the
  // recording rendered them — a dim, washed-out frame moves both.
  const mid = (lo + hi) / 2;
  const dark = [];
  for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) dark.push(sample(c, r) < mid ? 1 : 0);
  return decodeCells(dark, cols, rows);
}

// The count `n` (odd, ≥ 7) whose implied cell centres alternate best along a
// clock track. EVERY count down to a pitch of one pixel is tried, not just the
// ones near the measured cell: one cell measured on a resampled image can be
// off by a pixel, which on a 3px cell is a third — a window around it would
// miss. A wrong count samples the track at effectively random phases and
// scores near one half, so the true one stands out; the measured cell only
// breaks ties.
function fitClock(span, cell, sampleAt, expectDark) {
  const hi = Math.min(999, Math.floor(span));
  let best = null;
  for (let n = 7; n <= hi; n += 2) {
    // Against the track's own midpoint rather than a fixed 128: a light cell
    // squeezed between two dark ones by a downscale never gets back to white.
    const v = Array.from({ length: n }, (_, i) => sampleAt(n, i));
    const mid = (Math.min(...v) + Math.max(...v)) / 2;
    let ok = 0;
    for (let i = 0; i < n; i++) if ((v[i] < mid) === expectDark(i)) ok++;
    const score = ok / n;
    const near = Math.abs(span / n - cell);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && near < best.near)) {
      best = { n, score, near };
    }
  }
  return best && best.score >= 0.9 ? best.n : null;
}

// Nudge a track's start (±half a cell) and pitch (±1%) to maximise its
// contrast against the alternation it should have.
function refine(start, pitch, n, sampleAt, expectDark) {
  let best = { start, pitch, score: -Infinity };
  for (let k = -3; k <= 3; k++) {
    const p = pitch * (1 + k * 0.0033);
    for (let d = -5; d <= 5; d++) {
      const s0 = start + d * 0.1 * pitch;
      const v = Array.from({ length: n }, (_, i) => sampleAt(s0 + (i + 0.5) * p));
      const mid = (Math.min(...v) + Math.max(...v)) / 2;
      let score = 0;
      for (let i = 0; i < n; i++) score += expectDark(i) ? mid - v[i] : v[i] - mid;
      if (score > best.score) best = { start: s0, pitch: p, score };
    }
  }
  return best;
}

const median = a => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

function decodeCells(dark, cols, rows) {
  const total = codewordsFor(cols, rows);
  if (total < HEADER + 2) return null;
  const words = new Uint8Array(total);
  for (let bit = 0; bit < total * 8; bit++) words[bit >> 3] |= dark[bit] << (7 - (bit & 7));
  const mask = whitening(total);
  for (let i = 0; i < total; i++) words[i] ^= mask[i];

  const layout = blocksFor(total);
  const blocks = deinterleave(words, layout);
  const stream = [];
  for (let i = 0; i < layout.length; i++) {
    if (layout[i].data < 1 || !rsCorrect(blocks[i], layout[i].ecc)) return null;
    for (let k = 0; k < layout[i].data; k++) stream.push(blocks[i][k]);
  }
  if (stream[0] !== MAGIC) return null;
  const len = (stream[1] << 8) | stream[2];
  if (HEADER + len > stream.length) return null;
  return Uint8Array.from(stream.slice(HEADER, HEADER + len));
}
