// OKLab / OKLCH ↔ sRGB, for canvas painters that need theme-derived colours.
//
// The theme tokens in main.css are authored in OKLCH (`--cyan: oklch(0.86
// 0.130 195)`), and the camera overlay derives its skeleton palette FROM
// them — rotated hues, ramped lightness, same chroma. That derivation has to
// happen in the same space the tokens are written in, or "the same lightness
// as the theme accent" stops being true the moment it is computed. OKLCH is
// OKLab in polar form; OKHSL/OKHSV are not used here because they renormalise
// lightness and saturation against the sRGB gamut's shape, which would break
// exactly that equality.
//
// Matrices and transfer functions are Björn Ottosson's reference values
// (https://bottosson.github.io/posts/oklab/), unmodified.

// ── sRGB transfer ─────────────────────────────────────────────────────────
const toLinear = x => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const fromLinear = x => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

// ── Forward: sRGB → OKLab ─────────────────────────────────────────────────
export function srgbToOklab(r, g, b) {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}

// ── Reverse: OKLab → linear sRGB (unclamped — gamut tests read the raw values) ──
function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return {
    r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}

const hex2 = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');

// ── OKLCH → sRGB hex, matching what the browser paints ────────────────────
//
// The palette hands the canvas oklch() strings and lets the browser render
// them — that is what makes the skeleton EXACTLY the theme's colours, because
// the stylesheet's tokens go through the same code. This function exists so
// the unit tests can measure those rendered colours (pairwise ΔEok floors)
// without a browser, so it has to reproduce the browser's semantics, not the
// css-color-4 gamut-mapping spec: measured against Chrome's canvas, oklch()
// is the raw OKLab→linear-sRGB conversion with each channel CLIPPED —
// 182/192 of a sweep exact, the rest one 8-bit step out. The fancier
// chroma-reduction mapping was tried first and disagreed with the browser by
// up to ΔEok 0.22 on saturated hues, which would have made the tests assert
// distances no viewer ever sees.
export function oklchToHex(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const rgb = oklabToLinear(L, Math.max(0, C) * Math.cos(h), Math.max(0, C) * Math.sin(h));
  return '#' + hex2(fromLinear(Math.max(0, rgb.r)))
             + hex2(fromLinear(Math.max(0, rgb.g)))
             + hex2(fromLinear(Math.max(0, rgb.b)));
}

// ── Reading a theme token ─────────────────────────────────────────────────
//
// Tokens arrive as the computed value of a CSS custom property: the oklch()
// they were authored as, or a #hex where one was written that way. Anything
// else (or a parse failure) returns null and the caller keeps its fallback.
export function parseColor(str) {
  const s = String(str ?? '').trim();
  const ok = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/[^)]*)?\)$/i.exec(s);
  if (ok) {
    const L = ok[1].endsWith('%') ? parseFloat(ok[1]) / 100 : parseFloat(ok[1]);
    return { L, C: parseFloat(ok[2]), h: parseFloat(ok[3]) };
  }
  const hx = /^#([0-9a-f]{6})$/i.exec(s);
  if (hx) {
    const n = parseInt(hx[1], 16);
    const { L, a, b } = srgbToOklab(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
  }
  return null;
}

// Perceptual distance between two OKLab points — what the palette tests use
// to prove "distinguishable" instead of asserting it.
export function oklabDist(x, y) {
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}

export const hexToOklab = hx => {
  const n = parseInt(hx.slice(1), 16);
  return srgbToOklab(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
