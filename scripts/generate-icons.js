// Generates icons/icon-192.png and icons/icon-512.png using only
// built-in Node.js (zlib for deflate, Buffer for raw PNG assembly).
// Design: dark background (#060609) + cyan (#00e5cc) sine-wave pair.

import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── CRC32 ──────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG builder ────────────────────────────────────────────────────────────────
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf    = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function buildPNG(width, height, rgb) {
  // Prepend filter byte 0 (None) to every scanline
  const raw = Buffer.allocUnsafe(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = y * (1 + width * 3) + 1 + x * 3;
      raw[dst]     = rgb[src];
      raw[dst + 1] = rgb[src + 1];
      raw[dst + 2] = rgb[src + 2];
    }
  }

  const IHDR_DATA = Buffer.allocUnsafe(13);
  IHDR_DATA.writeUInt32BE(width,  0);
  IHDR_DATA.writeUInt32BE(height, 4);
  IHDR_DATA[8]  = 8;  // bit depth
  IHDR_DATA[9]  = 2;  // color type: RGB
  IHDR_DATA[10] = 0; IHDR_DATA[11] = 0; IHDR_DATA[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', IHDR_DATA),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon renderer ──────────────────────────────────────────────────────────────
function renderIcon(size) {
  const bg = [6, 6, 9];          // #060609
  const fg = [0, 229, 204];      // #00e5cc

  const pixels = new Uint8Array(size * size * 3);

  // Fill background
  for (let i = 0; i < size * size; i++) {
    pixels[i * 3]     = bg[0];
    pixels[i * 3 + 1] = bg[1];
    pixels[i * 3 + 2] = bg[2];
  }

  // Helper: blend a pixel toward fg at given alpha
  function paint(x, y, alpha) {
    if (x < 0 || x >= size || y < 0 || y >= size || alpha <= 0) return;
    const i = (y * size + x) * 3;
    pixels[i]     = Math.round(pixels[i]     * (1 - alpha) + fg[0] * alpha);
    pixels[i + 1] = Math.round(pixels[i + 1] * (1 - alpha) + fg[1] * alpha);
    pixels[i + 2] = Math.round(pixels[i + 2] * (1 - alpha) + fg[2] * alpha);
  }

  // Draw an anti-aliased thick curve from a y-function over x range
  function drawCurve(yfn, xStart, xEnd, thickness, baseAlpha) {
    for (let x = Math.floor(xStart); x <= Math.ceil(xEnd); x++) {
      const wy = yfn(x);
      // Paint a vertical column of pixels around the curve
      const yLo = Math.floor(wy - thickness);
      const yHi = Math.ceil(wy + thickness);
      for (let y = yLo; y <= yHi; y++) {
        const dist = Math.abs(y - wy);
        if (dist < thickness) {
          // Smooth falloff
          const t    = dist / thickness;
          const a    = baseAlpha * (1 - t * t);
          paint(x, y, a);
        }
      }
    }
  }

  const pad     = size * 0.18;   // 18% safe-zone padding on each side
  const xStart  = pad;
  const xEnd    = size - pad;
  const yCentre = size * 0.5;
  const amp     = size * 0.18;   // wave amplitude
  const thick   = size * 0.032;  // line thickness

  // Primary wave
  drawCurve(
    x => yCentre + amp * Math.sin(((x - xStart) / (xEnd - xStart)) * 2 * Math.PI * 1.5),
    xStart, xEnd, thick, 1.0
  );

  // Faint echo wave (slightly offset, lower alpha)
  drawCurve(
    x => yCentre + amp * 0.5 * Math.sin(((x - xStart) / (xEnd - xStart)) * 2 * Math.PI * 1.5 + 0.4),
    xStart, xEnd, thick * 0.5, 0.35
  );

  return Buffer.from(pixels);
}

// ── Main ───────────────────────────────────────────────────────────────────────
mkdirSync(join(ROOT, 'icons'), { recursive: true });

for (const size of [192, 512]) {
  const rgb  = renderIcon(size);
  const png  = buildPNG(size, size, rgb);
  const path = join(ROOT, `icons/icon-${size}.png`);
  writeFileSync(path, png);
  console.log(`  wrote ${path}  (${png.length} bytes)`);
}
console.log('Done.');
