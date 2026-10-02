// The setup tag — a small colour 2D code made to be read back out of a
// SCREENSHOT, not through a camera, in the shape of a piece of Gosper curve.
//
// A QR code is designed for the hardest case: a phone held at an angle across
// a room, a printed sticker that is creased, dirty and badly lit. Every module
// of finder pattern, alignment pattern and error-correction headroom it spends
// is spent on that case, and it is why a whole setup came out 129px square at
// one pixel per module — too big to leave on the picture (see the README).
// A screenshot of the screen, or a frame grabbed from a screen recording, is
// an easier case, and this format is built for it:
//
//   • SEVEN COLOURS ON A HEXAGONAL LATTICE. Every cell is a hexagon — the
//     densest packing for cells whose blur is round, which a resampled,
//     compressed picture's is — and every hexagon is one of seven colours:
//     white, and six hues exactly 60° apart in OKLCH at one lightness and one
//     chroma (PALETTE below). Five cells are 7⁵ = 16 807 combinations, of
//     which 16 384 carry fourteen bits: 2.8 bits a cell, all but the last
//     sliver of what seven colours can hold.
//   • THE GOSPER CURVE. The cells are the hexagons the Gosper curve (the
//     "flowsnake") visits, in order, and the data runs along it. The curve is
//     made of sevens all the way down — seven hexagons make a flower, seven
//     flowers an island of 49 — and a tag is as many of those 49-cell islands,
//     taken in the curve's own order, as the setup needs: one for a lightly
//     edited stock patch, three or four for a busy one. Every piece of the
//     curve is compact, so the tag stays a blob rather than a ribbon.
//   • NO URL. The tag carries the setup's raw bytes, not a link with base64 in
//     it, and only what differs from the default (src/share.js's 'b').
//
// A piece of Gosper curve has no straight edge to hang a frame on, so the
// finder is three black flowers — seven hexagons each — off three corners of
// it, the way a QR code has three finder squares: top-left, top-right and
// bottom-left, so the triangle they make also says which way up the tag is.
// Black is theirs alone: no data colour is dark, so the reader can find them
// by brightness and take scale, position and even a slight rotation from
// their three centres.
//
// What it has to survive is real: a screen recording is resampled (a phone's
// 1170px to a feed's 1080 or 720) and compressed with its colour subsampled
// (H.264, 4:2:0 — chroma at half the resolution of brightness). So the reader
// never trusts a colour as drawn: the first seven cells along the curve are
// the palette in order — a colour chart, read off the recording — and the
// classifier refines every colour's centroid from all the cells that chose it.
//
// The codewords hold one MAGIC byte (which is also the format's version), a
// two-byte length, the payload, then padding.

import { GF_EXP, GF_LOG, gfMul, rsRemainder } from './qr.js';
import { oklchToHex, srgbToOklab } from './okcolor.js';

// ── Format constants ──────────────────────────────────────────────────────
//
// These are the format. A tag in a recording that was posted somewhere is
// frozen exactly like a printed QR code is, so none of them can change under
// the same MAGIC: a new layout takes a new MAGIC byte.
const MAGIC = 0xA4;
const HEADER = 3;                 // MAGIC + 16-bit length
// The share of each Reed–Solomon block spent on correction. Three tenths
// corrects one byte in seven anywhere in the block — and a misread cell
// costs at most two bytes, since five cells make fourteen bits.
const ECC_SHARE = 0.3;
const MAX_BLOCK = 255;
const ISLAND = 49;                // cells in one order-2 Gosper island
const MAX_ISLANDS = 49;           // an order-4 curve: 2401 cells, ~600 bytes
const ROW = Math.sqrt(3) / 2;

// The seven colours, as OKLCH. White, and six hues EXACTLY 60° apart in
// OKLCH hue, all at the same lightness and the same chroma — equally light and
// equally vivid to the eye, which no set of sRGB primaries is (their blue is
// L 0.45 and their yellow 0.97). The lightness and chroma are the most
// saturated the screen can show all six at once: 0.745 and 1% inside the
// common gamut. The rotation puts each hue nearest the colour it is named for
// — red 28°, yellow 88°, green 148°, cyan 208°, blue 268°, magenta 328°.
// Order is the symbol value, 0–6, and the order of the calibration chart.
const HUE_L = 0.745;
const HUE_C = 0.1268;
export const PALETTE = Object.freeze([
  { name: 'white',   L: 1,     C: 0,     h: 0 },
  { name: 'yellow',  L: HUE_L, C: HUE_C, h: 88 },
  { name: 'red',     L: HUE_L, C: HUE_C, h: 28 },
  { name: 'magenta', L: HUE_L, C: HUE_C, h: 328 },
  { name: 'blue',    L: HUE_L, C: HUE_C, h: 268 },
  { name: 'cyan',    L: HUE_L, C: HUE_C, h: 208 },
  { name: 'green',   L: HUE_L, C: HUE_C, h: 148 },
]);
const SYMBOLS = PALETTE.length;
const RGB = PALETTE.map(({ L, C, h }) => {
  const hx = oklchToHex(L, C, h);
  return [1, 3, 5].map(i => parseInt(hx.slice(i, i + 2), 16));
});
// The hues differ only in hue, so lightness carries nothing between them; it
// is what tells white from all six.
const L_WEIGHT = 1;

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

// ── The Gosper curve ──────────────────────────────────────────────────────
//
// The flowsnake as an L-system — A → A−B−−B+A++AA+B−, B → +A−BB−−B−A++A+B,
// turning 60° — walked one lattice step per A or B. Every vertex is a
// hexagon centre; an order-n walk visits 7ⁿ+1 of them, all distinct, and the
// first 7ⁿ are the order-n Gosper island. Hexagons are addressed in axial
// coordinates (q, r); on the plane a step of 1 is one cell pitch:
// x = q + r/2, y = r·√3/2.
const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const planeX = (q, r) => q + r / 2;
const planeY = r => r * ROW;
const hexDist = (a, b) => {
  const dq = a[0] - b[0], dr = a[1] - b[1];
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
};

function gosperCells(order) {
  let s = 'A';
  for (let i = 0; i < order; i++) s = s.replace(/[AB]/g, c => (c === 'A' ? 'A-B--B+A++AA+B-' : '+A-BB--B-A++A+B'));
  let q = 0, r = 0, h = 0;
  const out = [[0, 0]];
  for (const c of s) {
    if (c === '+') h = (h + 1) % 6;
    else if (c === '-') h = (h + 5) % 6;
    else if (out.length < 7 ** order) {
      q += DIRS[h][0]; r += DIRS[h][1];
      out.push([q, r]);
    }
  }
  return out;
}

// The cells, the three anchor flowers, and the plate they sit on — all a
// function of the number of islands alone, so the reader can rebuild it from
// nothing. Each anchor is the lattice point nearest a corner of the cells'
// bounding box that leaves at least one white hexagon between its flower and
// the cells.
let CURVE = null;
const templates = new Map();
export function template(islands) {
  if (templates.has(islands)) return templates.get(islands);
  CURVE ??= gosperCells(4);
  const cells = CURVE.slice(0, islands * ISLAND);
  const xs = cells.map(([q, r]) => planeX(q, r)), ys = cells.map(([, r]) => planeY(r));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const anchors = [[x0, y0], [x1, y0], [x0, y1]].map(([tx, ty]) => {
    const tr = Math.round(ty / ROW), tq = Math.round(tx - tr / 2);
    let best = null;
    for (let rad = 0; rad < 40 && !best; rad++) {
      const ring = [];
      for (let dq = -rad; dq <= rad; dq++) {
        for (let dr = -rad; dr <= rad; dr++) {
          const p = [tq + dq, tr + dr];
          if (hexDist(p, [tq, tr]) !== rad) continue;
          if (cells.every(c => hexDist(c, p) >= 3)) ring.push(p);
        }
      }
      ring.sort((a, b) => Math.hypot(planeX(...a) - tx, planeY(a[1]) - ty)
                        - Math.hypot(planeX(...b) - tx, planeY(b[1]) - ty)
                        || a[0] - b[0] || a[1] - b[1]);
      best = ring[0] ?? null;
    }
    return best;
  });
  const flower = ([q, r]) => [[q, r], ...DIRS.map(([dq, dr]) => [q + dq, r + dr])];
  const ink = new Map();
  cells.forEach(([q, r], i) => ink.set(`${q},${r}`, i));
  for (const a of anchors) for (const [q, r] of flower(a)) ink.set(`${q},${r}`, -1);
  const all = [...ink.keys()].map(k => k.split(',').map(Number));
  const ax = all.map(([q, r]) => planeX(q, r)), ay = all.map(([, r]) => planeY(r));
  const t = {
    islands, cells, anchors, ink,
    anchorXY: anchors.map(([q, r]) => [planeX(q, r), planeY(r)]),
    box: [Math.min(...ax) - 0.5, Math.max(...ax) + 0.5, Math.min(...ay) - 0.6, Math.max(...ay) + 0.6],
  };
  templates.set(islands, t);
  return t;
}

const CHART = SYMBOLS;            // calibration cells at the head of the curve
const GROUP = 5;                  // cells per 14 bits
const groupsFor = islands => Math.floor((islands * ISLAND - CHART) / GROUP);
const codewordsFor = islands => Math.floor(groupsFor(islands) * 14 / 8);

// ── Encoding ──────────────────────────────────────────────────────────────

// bytes → { islands, cells } where `cells` holds each hexagon's symbol (0–6,
// an index into PALETTE) in the order the curve visits them, chart first.
export function encodeTag(payload) {
  const data = Uint8Array.from(payload);
  const need = HEADER + data.length;
  let islands = 1;
  while (islands <= MAX_ISLANDS && dataCapacity(codewordsFor(islands)) < need) islands++;
  if (islands > MAX_ISLANDS) throw new Error('too much to fit in a setup tag');
  const total = codewordsFor(islands);
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

  const n = islands * ISLAND;
  const cells = new Uint8Array(n);
  for (let k = 0; k < CHART; k++) cells[k] = k;
  // Fourteen bits at a time, MSB first, as five base-7 digits. Cells past the
  // last group cycle through the palette rather than sit in one colour.
  const totalBits = words.length * 8;
  const groups = groupsFor(islands);
  for (let g = 0, bit = 0; g < groups; g++) {
    let v = 0;
    for (let k = 0; k < 14; k++, bit++) {
      v = v * 2 + (bit < totalBits ? (words[bit >> 3] >> (7 - (bit & 7))) & 1 : 0);
    }
    for (let k = GROUP - 1; k >= 0; k--) {
      cells[CHART + g * GROUP + k] = v % SYMBOLS;
      v = Math.floor(v / SYMBOLS);
    }
  }
  for (let k = CHART + groups * GROUP; k < n; k++) cells[k] = k % SYMBOLS;
  return { islands, cells };
}

export const QUIET = 2;           // pitches of white plate around the ink

// How many device pixels from one hexagon's centre to the next, for a screen
// whose SHORT side is `shortSide` device pixels. What has to survive is a
// cell of about four pixels after a feed has scaled the recording down to
// 720 on its short side (720p, landscape or portrait) — measured,
// tests/tag-recording. Four, not the three a palette with lightness in it
// needed: six hues at one lightness differ only in colour, and a recording
// keeps colour at half the resolution of brightness. Never under six.
export const tagPitch = shortSide => Math.max(6, Math.ceil(4 * shortSide / 720));

// Nearest hexagon centre to a point on the plane, in axial coordinates.
function hexAt(x, y) {
  const r = y / ROW, q = x - r / 2;
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(-q - r);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs + q + r);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

// The tag as an RGBA bitmap, `pitch` pixels between neighbouring hexagon
// centres — what a canvas's putImageData wants, and what the tests decode
// without a browser. Every pixel takes the colour of the hexagon it falls in:
// the island's colours, the anchors' black, the plate's white.
export function rasterize(tag, pitch = 5, quiet = QUIET) {
  const t = template(tag.islands);
  const [bx0, bx1, by0, by1] = t.box;
  const ox = bx0 - quiet, oy = by0 - quiet;
  const width = Math.round((bx1 - bx0 + 2 * quiet) * pitch);
  const height = Math.round((by1 - by0 + 2 * quiet) * pitch);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [q, r] = hexAt(ox + (x + 0.5) / pitch, oy + (y + 0.5) / pitch);
      const i = t.ink.get(`${q},${r}`);
      if (i === undefined) continue;
      const rgb = i < 0 ? [0, 0, 0] : RGB[tag.cells[i]];
      const o = (y * width + x) * 4;
      data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
    }
  }
  return { width, height, data, origin: [ox, oy] };
}

// Paint a tag into a canvas at `pitch` device pixels a cell, shown by the
// caller at exactly its own pixels: the screen is the one place the tag can
// be perfect, and a recording only ever makes it worse.
export function drawTag(canvas, tag, pitch = 5) {
  const img = rasterize(tag, pitch);
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
// The search: every black blob in the picture (black by its brightest
// channel, which no palette colour is) that is the size and shape of a
// seven-hexagon flower with white around it is an anchor candidate. Any two
// candidates, taken as two of a template's anchors, fix a scale and a
// rotation; the third anchor must then be where they say. Three found, the
// transform is fitted to all three centres, and every hexagon of the island
// is sampled where it must be.
export function readTag(image) {
  const { width: W, height: H, data } = image;
  const V = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < V.length; i++, j += 4) V[i] = Math.max(data[j], data[j + 1], data[j + 2]);
  const blobs = flowers(V, W, H);
  if (blobs.length < 3) return null;
  for (let islands = 1; islands <= MAX_ISLANDS; islands++) {
    const t = template(islands);
    const [T0, T1, T2] = t.anchorXY.map(([x, y]) => ({ re: x, im: y }));
    for (const a of blobs) {
      for (const b of blobs) {
        if (a === b || Math.abs(a.pitch / b.pitch - 1) > 0.35) continue;
        // λ maps template to image: b − a = λ·(T1 − T0).
        const lam = cdiv(csub(b.z, a.z), csub(T1, T0));
        const scale = Math.hypot(lam.re, lam.im);
        if (Math.abs(scale / a.pitch - 1) > 0.35 || Math.abs(Math.atan2(lam.im, lam.re)) > 0.2) continue;
        const want = cadd(a.z, cmul(lam, csub(T2, T0)));
        const c = blobs.find(k => k !== a && k !== b && Math.hypot(k.z.re - want.re, k.z.im - want.im) < 0.6 * scale);
        if (!c) continue;
        const fit = similarity([T0, T1, T2], [a.z, b.z, c.z]);
        const out = sampleAndDecode(image, t, fit);
        if (out) return out;
      }
    }
  }
  return null;
}

const cadd = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const csub = (a, b) => ({ re: a.re - b.re, im: a.im - b.im });
const cmul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cdiv = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};

// Least-squares z = λ·w + β through three point pairs: scale, rotation and
// position from the anchors' centres, each of which is already sub-pixel.
function similarity(ws, zs) {
  const n = ws.length;
  const mw = { re: ws.reduce((s, w) => s + w.re, 0) / n, im: ws.reduce((s, w) => s + w.im, 0) / n };
  const mz = { re: zs.reduce((s, z) => s + z.re, 0) / n, im: zs.reduce((s, z) => s + z.im, 0) / n };
  let num = { re: 0, im: 0 }, den = 0;
  for (let i = 0; i < n; i++) {
    const w = csub(ws[i], mw), z = csub(zs[i], mz);
    num = cadd(num, cmul(z, { re: w.re, im: -w.im }));
    den += w.re * w.re + w.im * w.im;
  }
  const lam = { re: num.re / den, im: num.im / den };
  return { lam, beta: csub(mz, cmul(lam, mw)) };
}

// Black blobs shaped like a flower of seven hexagons: about as wide as tall
// (three pitches by 2.9), filling about 70% of their box, with white all
// around. Their centre is the darkness-weighted centroid — sub-pixel, and
// symmetric enough that blur moves it nowhere.
function flowers(V, W, H) {
  const label = new Int32Array(W * H);
  const out = [];
  const stack = [];
  let next = 0;
  for (let start = 0; start < V.length; start++) {
    if (V[start] >= 110 || label[start]) continue;
    next++;
    label[start] = next;
    stack.push(start);
    let n = 0, sw = 0, sx = 0, sy = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
    let big = false;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p - x) / W;
      n++;
      if (n > 60000) big = true;
      const w = 110 - V[p];
      sw += w; sx += w * (x + 0.5); sy += w * (y + 0.5);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && V[p - 1] < 110 && !label[p - 1]) { label[p - 1] = next; stack.push(p - 1); }
      if (x < W - 1 && V[p + 1] < 110 && !label[p + 1]) { label[p + 1] = next; stack.push(p + 1); }
      if (y > 0 && V[p - W] < 110 && !label[p - W]) { label[p - W] = next; stack.push(p - W); }
      if (y < H - 1 && V[p + W] < 110 && !label[p + W]) { label[p + W] = next; stack.push(p + W); }
    }
    if (big || n < 12) continue;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const aspect = bw / bh, fill = n / (bw * bh);
    if (aspect < 0.75 || aspect > 1.4 || fill < 0.5 || fill > 0.9) continue;
    const pitch = bw / 3;
    const cx = sx / sw, cy = sy / sw;
    // White around it: the plate.
    let light = 0;
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6;
      const px = Math.round(cx + Math.cos(a) * 2.3 * pitch), py = Math.round(cy + Math.sin(a) * 2.3 * pitch);
      if (px >= 0 && py >= 0 && px < W && py < H && V[py * W + px] > 150) light++;
    }
    if (light < 10) continue;
    out.push({ z: { re: cx, im: cy }, pitch });
  }
  return out;
}

function sampleAndDecode(image, t, { lam, beta }) {
  const { width: W, height: H, data } = image;
  const scale = Math.hypot(lam.re, lam.im);
  const rad = Math.max(0, Math.floor(scale * 0.22));
  const px = (x, y, k) => data[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4 + k];
  const bil = (x, y, k) => {
    const fx = x - 0.5, fy = y - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
    return (px(ix, iy, k) * (1 - ax) + px(ix + 1, iy, k) * ax) * (1 - ay)
         + (px(ix, iy + 1, k) * (1 - ax) + px(ix + 1, iy + 1, k) * ax) * ay;
  };
  const labs = t.cells.map(([q, r]) => {
    const z = cadd(cmul(lam, { re: planeX(q, r), im: planeY(r) }), beta);
    let R = 0, G = 0, B = 0, n = 0;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        R += bil(z.re + dx, z.im + dy, 0); G += bil(z.re + dx, z.im + dy, 1); B += bil(z.re + dx, z.im + dy, 2);
        n++;
      }
    }
    const o = srgbToOklab(R / n / 255, G / n / 255, B / n / 255);
    return [o.L * L_WEIGHT, o.a, o.b];
  });
  return decodeCells(classify(labs), t.islands);
}

// Which of the seven each cell is. The chart at the head of the curve gives
// a first centroid per colour as THIS recording renders it; two rounds of
// k-means then move each centroid to the middle of the cells that chose it,
// which follows a tint or a squeeze of contrast across the whole tag rather
// than only where the chart is. A chart whose colours have run together is not a
// tag.
function classify(labs) {
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  let cent = PALETTE.map((_, k) => labs[k]);
  let closest = Infinity;
  for (let a = 0; a < SYMBOLS; a++) for (let b = a + 1; b < SYMBOLS; b++) closest = Math.min(closest, d2(cent[a], cent[b]));
  if (closest < 0.04 ** 2) return null;
  const pick = p => {
    let best = 0, bd = Infinity;
    for (let k = 0; k < SYMBOLS; k++) {
      const d = d2(p, cent[k]);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  };
  let sym = labs.map(pick);
  for (let round = 0; round < 2; round++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    labs.forEach((p, i) => { const s = sum[sym[i]]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; });
    cent = cent.map((c, k) => (sum[k][3] >= 2 ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : c));
    sym = labs.map(pick);
  }
  return sym;
}

function decodeCells(sym, islands) {
  if (!sym) return null;
  const total = codewordsFor(islands);
  const words = new Uint8Array(total);
  const groups = groupsFor(islands);
  for (let g = 0, bit = 0; g < groups; g++) {
    let v = 0;
    for (let k = 0; k < GROUP; k++) v = v * SYMBOLS + sym[CHART + g * GROUP + k];
    // 16 384 and up is no group an encoder writes: a misread. Its bits are
    // wrong whatever is put there, and Reed–Solomon is what fixes them.
    v %= 16384;
    for (let k = 13; k >= 0; k--, bit++) {
      if (bit < total * 8) words[bit >> 3] |= (Math.floor(v / 2 ** k) & 1) << (7 - (bit & 7));
    }
  }
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
