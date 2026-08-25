// QR code encoder — byte mode, all 40 versions, four error-correction levels.
//
// Written rather than pulled in because this app is a build-less static PWA
// that has to work offline: a CDN script is a runtime dependency on a network
// the user may not have, and there is no bundler to inline one. It is a
// self-contained ~300 lines with no imports, and the output is verified by
// decoding it with a real decoder (jsQR) in tests/unit/qr.test.js — a
// round-trip, not a "looks like a QR code" eyeball.
//
// Byte mode only. The payload is a URL with base64url data in it, which
// contains lowercase letters, `-` and `_`; alphanumeric mode covers none of
// those, so the denser mode would not apply anyway.
//
// Reference: ISO/IEC 18004. The capacity and block-structure tables below are
// from the standard and are data, not decisions.

// ── Galois field GF(256), primitive polynomial 0x11D ──────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

// Generator polynomial for `degree` error-correction codewords:
// (x - a^0)(x - a^1)...(x - a^(degree-1)) over GF(256).
//
// Returned HIGHEST-degree-first, which is the order rsRemainder below indexes
// it in. The recurrence naturally builds it lowest-first, so it is reversed on
// the way out — getting this backwards produces valid-looking EC codewords that
// no decoder accepts, which is exactly what it did.
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = Array.from({ length: poly.length + 1 }, () => 0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse();
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ── Standard tables ───────────────────────────────────────────────────────
// Index 0 is unused so version numbers read directly.
const ECC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
// Format-info bit pattern per level, in the standard's own order (M, L, H, Q).
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const ECC_CODEWORDS_PER_BLOCK = [
  // ver: 0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  /*L*/ [0,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  /*M*/ [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  /*Q*/ [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  /*H*/ [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_EC_BLOCKS = [
  /*L*/ [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  /*M*/ [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  /*Q*/ [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  /*H*/ [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// Total module count available for data + EC, before the 8-bit split.
function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const totalCodewords = ver => Math.floor(rawDataModules(ver) / 8);
const dataCodewords = (ver, ecc) => totalCodewords(ver)
  - ECC_CODEWORDS_PER_BLOCK[ECC_LEVELS[ecc]][ver] * NUM_EC_BLOCKS[ECC_LEVELS[ecc]][ver];

// Alignment pattern centre coordinates.
function alignPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const last = ver * 4 + 10;
  const step = (ver === 32) ? 26 : Math.ceil((last - 6) / (n * 2 - 2)) * 2;
  const pos = [6];
  for (let p = last; pos.length < n; p -= step) pos.unshift(p);
  return pos;
}

// Character-count-indicator width for byte mode.
const countBits = ver => ver < 10 ? 8 : 16;

// ── Bit stream ────────────────────────────────────────────────────────────
class Bits {
  constructor() { this.bits = []; }
  push(value, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
}

// ── Encode ────────────────────────────────────────────────────────────────
/**
 * @param {string|Uint8Array} input  text (encoded UTF-8) or raw bytes
 * @param {{ecc?: 'L'|'M'|'Q'|'H', minVersion?: number}} opts
 * @returns {{size: number, version: number, ecc: string, modules: Uint8Array}}
 *          modules is row-major, 1 = dark.
 */
export function encodeQR(input, { ecc = 'M', minVersion = 1 } = {}) {
  // `=== undefined`, not falsy: level L is index 0.
  if (ECC_LEVELS[ecc] === undefined) throw new Error(`unknown ECC level ${ecc}`);
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);

  // Smallest version that fits. The count indicator widens at version 10, so
  // capacity is checked against the version actually being tried.
  let ver = -1;
  for (let v = Math.max(1, minVersion); v <= 40; v++) {
    const cap = dataCodewords(v, ecc) * 8;
    if (4 + countBits(v) + bytes.length * 8 <= cap) { ver = v; break; }
  }
  if (ver < 0) {
    throw new Error(`payload of ${bytes.length} bytes does not fit any QR version at ECC ${ecc}`);
  }

  const bs = new Bits();
  bs.push(0b0100, 4);                       // byte mode
  bs.push(bytes.length, countBits(ver));
  for (const b of bytes) bs.push(b, 8);

  const capacity = dataCodewords(ver, ecc) * 8;
  bs.push(0, Math.min(4, capacity - bs.length));       // terminator
  bs.push(0, (8 - bs.length % 8) % 8);                 // pad to a byte
  // Alternating pad bytes, per the standard.
  for (let pad = 0xEC; bs.length < capacity; pad ^= 0xEC ^ 0x11) bs.push(pad, 8);

  const data = new Uint8Array(capacity / 8);
  for (let i = 0; i < data.length; i++)
    for (let j = 0; j < 8; j++) data[i] |= bs.bits[i * 8 + j] << (7 - j);

  const codewords = interleave(data, ver, ecc);
  const modules = draw(ver, ecc, codewords);
  return { size: ver * 4 + 17, version: ver, ecc, modules };
}

// Split into blocks, append each block's EC codewords, then interleave — the
// standard's spreading, so a burst of damage lands across many blocks rather
// than destroying one.
function interleave(data, ver, ecc) {
  const lvl = ECC_LEVELS[ecc];
  const numBlocks = NUM_EC_BLOCKS[lvl][ver];
  const ecLen = ECC_CODEWORDS_PER_BLOCK[lvl][ver];
  const total = totalCodewords(ver);
  const shortLen = Math.floor(total / numBlocks) - ecLen;
  const numShort = numBlocks - total % numBlocks;

  const blocks = [], ecBlocks = [];
  for (let i = 0, off = 0; i < numBlocks; i++) {
    const len = shortLen + (i < numShort ? 0 : 1);
    const block = data.subarray(off, off + len);
    off += len;
    blocks.push(block);
    ecBlocks.push(rsRemainder(block, ecLen));
  }

  const out = new Uint8Array(total);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++)
    for (let b = 0; b < numBlocks; b++)
      if (i < blocks[b].length) out[k++] = blocks[b][i];
  for (let i = 0; i < ecLen; i++)
    for (let b = 0; b < numBlocks; b++) out[k++] = ecBlocks[b][i];
  return out;
}

// ── Matrix ────────────────────────────────────────────────────────────────
function draw(ver, ecc, codewords) {
  const size = ver * 4 + 17;
  const m = new Uint8Array(size * size);        // 1 = dark
  const fixed = new Uint8Array(size * size);    // 1 = function pattern, not maskable
  const at = (x, y) => y * size + x;
  const set = (x, y, dark) => { m[at(x, y)] = dark ? 1 : 0; fixed[at(x, y)] = 1; };

  // Finder patterns + separators.
  for (const [fx, fy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = fx + dx, y = fy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        set(x, y, d !== 2 && d <= 3);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping the three finder corners.
  const pos = alignPositions(ver);
  for (const cy of pos) {
    for (const cx of pos) {
      const corner = (cx === 6 && cy === 6)
                  || (cx === 6 && cy === size - 7)
                  || (cx === size - 7 && cy === 6);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  // Reserve format info (written after masking) and the dark module.
  for (let i = 0; i < 9; i++) { set(i, 8, false); set(8, i, false); }
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, false); set(8, size - 1 - i, false); }
  set(8, size - 8, true);        // always dark

  // Version info (7 and up), bottom-left and top-right.
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = size - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }

  // Data, zig-zagging up and down two-module columns from the bottom right.
  let bit = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;                // the vertical timing column
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - v : v;
        if (fixed[at(x, y)]) continue;
        if (bit < total) m[at(x, y)] = (codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1;
        bit++;
      }
    }
  }

  // Pick the mask with the lowest penalty, as the standard prescribes.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const cand = applyMask(m, fixed, size, mask);
    writeFormat(cand, fixed, size, ecc, mask);
    const p = penalty(cand, size);
    if (!best || p < best.p) best = { p, mask, m: cand };
  }
  return best.m;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

function applyMask(m, fixed, size, mask) {
  const out = Uint8Array.from(m);
  const fn = MASKS[mask];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (!fixed[y * size + x] && fn(x, y)) out[y * size + x] ^= 1;
  return out;
}

function writeFormat(m, fixed, size, ecc, mask) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const put = (x, y, b) => { m[y * size + x] = b; };
  // Copy 1: around the top-left finder.
  for (let i = 0; i <= 5; i++) put(8, i, (bits >>> i) & 1);
  put(8, 7, (bits >>> 6) & 1);
  put(8, 8, (bits >>> 7) & 1);
  put(7, 8, (bits >>> 8) & 1);
  for (let i = 9; i < 15; i++) put(14 - i, 8, (bits >>> i) & 1);
  // Copy 2: split between the other two finders.
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, (bits >>> i) & 1);
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, (bits >>> i) & 1);
}

// Penalty scoring, ISO/IEC 18004 §8.8.2. Lower is easier to scan.
function penalty(m, size) {
  const at = (x, y) => m[y * size + x];
  let score = 0;

  // N1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i++) {
    for (const rowwise of [true, false]) {
      let run = 1, prev = rowwise ? at(0, i) : at(i, 0);
      for (let j = 1; j < size; j++) {
        const v = rowwise ? at(j, i) : at(i, j);
        if (v === prev) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
        else { run = 1; prev = v; }
      }
    }
  }
  // N2: 2×2 blocks of one colour.
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  // N3: finder-like 1:1:3:1:1 patterns with four light modules on one side.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      let hA = true, hB = true, vA = true, vB = true;
      for (let k = 0; k < 11; k++) {
        const h = at(j + k, i), v = at(i, j + k);
        if (h !== A[k]) hA = false;
        if (h !== B[k]) hB = false;
        if (v !== A[k]) vA = false;
        if (v !== B[k]) vB = false;
      }
      if (hA) score += 40;
      if (hB) score += 40;
      if (vA) score += 40;
      if (vB) score += 40;
    }
  }
  // N4: deviation from a 50/50 light/dark balance.
  let dark = 0;
  for (let i = 0; i < m.length; i++) dark += m[i];
  const pct = dark * 100 / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// ── Rendering ─────────────────────────────────────────────────────────────
/**
 * Draw a code onto a canvas at whole-pixel module boundaries — a fractional
 * module size is what makes a QR blur and stop scanning.
 * `quiet` is the mandatory light border, in modules (the standard says 4).
 */
export function drawQR(canvas, qr, { quiet = 4, dark = '#000', light = '#fff', target = 640 } = {}) {
  const total = qr.size + quiet * 2;
  // Backing store sized independently of the CSS box, and generously: a phone
  // reading a code off another screen is working from whatever the display
  // renders, and at 2px per module a dense code is at the edge of legible.
  // Whole pixels per module, always — a fractional module is what makes a QR
  // blur into something no camera will lock onto.
  const scale = Math.max(2, Math.floor(target / total));
  const px = total * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = dark;
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.modules[y * qr.size + x])
        ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  return { px, scale };
}
