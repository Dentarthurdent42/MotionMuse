// Programmatic WCAG AA contrast check — no browser, no API key needed.
// Parses CSS custom properties from css/main.css, then checks every
// text/background pair used in the UI against the 4.5:1 threshold
// (all text in this app is ≤11 px so "large text" rules don't apply).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// ── Parse CSS variables ───────────────────────────────────────────────────────
// Parse each theme's token block separately. Checking only `:root` would have
// verified the default palette and let every other theme ship unread: a light
// theme reusing a dark theme's accents is the exact failure mode, and it looks
// fine right up until someone selects it.
function parseThemes(cssPath) {
  const src = readFileSync(cssPath, 'utf8');
  const themes = new Map();
  const declRe = /--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6}|oklch\([^)]*\))\s*;/g;
  // Each block is `<selector-list> { ... }` where the selector mentions :root.
  const blockRe = /(:root[^{]*)\{([^}]*)\}/g;
  for (const [, selector, body] of src.matchAll(blockRe)) {
    const ids = [...selector.matchAll(/\[data-theme="([a-z-]+)"\]/g)].map(m => m[1]);
    const names = ids.length ? ids : ['(default)'];
    const vars = {};
    for (const [, name, val] of body.matchAll(declRe)) vars[`--${name}`] = val.trim();
    if (!Object.keys(vars).length) continue;
    for (const n of names) themes.set(n, { ...themes.get(n), ...vars });
  }
  return themes;
}

// ── Colour → linear-light sRGB ────────────────────────────────────────────────
function hexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 0xff, n & 0xff].map(c => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
}

// OKLCH → linear sRGB (Björn Ottosson). Alpha (/ A) is ignored — the contrast
// pairs use only opaque tokens. Returns linear-light rgb, clamped to gamut.
function oklchToLinear(str) {
  const [L, C, h] = str.slice(6, -1).split('/')[0].trim().split(/\s+/).map(Number);
  const hr = (h || 0) * Math.PI / 180;
  const a = (C || 0) * Math.cos(hr), b = (C || 0) * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map(v => Math.max(0, Math.min(1, v)));
}

const toLinear = c => c.startsWith('#') ? hexToLinear(c) : oklchToLinear(c);

function luminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(c1, c2) {
  const l1 = luminance(toLinear(c1));
  const l2 = luminance(toLinear(c2));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ── Pairs to check ────────────────────────────────────────────────────────────
// (fg var, bg var, usage description)
// All text in this app is ≤11 px → normal text threshold (4.5:1) applies everywhere.
const PAIRS = [
  // Body / primary text
  ['--text',    '--bg',      'Body text on page background'],
  ['--text',    '--surface', 'Body text on header background'],
  ['--text',    '--panel',   'Body text on panel background'],
  ['--text',    '--faint',   'Body text on faint (button) background'],

  // Dim labels — used pervasively for section headers, control labels, status
  ['--dim',     '--bg',      'Dim label on page background'],
  ['--dim',     '--surface', 'Dim label on header (hstatus, logo span)'],
  ['--dim',     '--panel',   'Dim label on panel (ph, sig-name, ctrl-lbl, wave-btn)'],
  ['--dim',     '--faint',   'Dim label on faint background'],

  // Accent text
  ['--cyan',    '--panel',   'Cyan text on panel (sig-val, btn.on, logo)'],
  ['--cyan',    '--surface', 'Cyan text on header (logo)'],
  ['--purple',  '--panel',   'Purple text on panel (ctrl-val, btn.purple.on)'],
  ['--amber',   '--panel',   'Amber text on panel (note-badge, wave-btn.on)'],
  ['--amber',   '--surface', 'Amber text on header (audio-btn while muted)'],
  ['--green',   '--panel',   'Green status dot label on panel'],
  ['--red',     '--panel',   'Red text on panel'],
];

const THRESHOLD = 4.5; // WCAG AA normal text

// ── Run ───────────────────────────────────────────────────────────────────────
const themes = parseThemes(join(ROOT, 'css/main.css'));

let failures = 0;
let checked  = 0;

for (const [themeName, vars] of themes) {
  console.log(`\nTheme: ${themeName}`);
  runTheme(themeName, vars);
}

function runTheme(themeName, vars) {
const rows   = PAIRS.map(([fg, bg, usage]) => {
  const fgHex = vars[fg];
  const bgHex = vars[bg];
  if (!fgHex || !bgHex) {
    console.warn(`  SKIP  ${fg} / ${bg} — variable not found`);
    return null;
  }
  const ratio  = contrastRatio(fgHex, bgHex);
  const passes = ratio >= THRESHOLD;
  if (!passes) failures++;
  return { fg, bg, fgHex, bgHex, ratio, passes, usage };
}).filter(Boolean);

  // Only the failures and the worst survivor are printed per theme: with six
  // themes a full table is 90 lines of PASS nobody reads, and the one number
  // that matters is how close the weakest pair sits to the threshold.
  checked += rows.length;
  const worst = rows.reduce((a, r) => (a && a.ratio <= r.ratio ? a : r), null);
  for (const r of rows.filter(r => !r.passes))
    console.log(`  [ FAIL ]  ${r.ratio.toFixed(2).padStart(5)}:1  ${r.fg} on ${r.bg.padEnd(11)}  ${r.usage}`);
  if (worst)
    console.log(`  ${rows.length} pairs · worst ${worst.ratio.toFixed(2)}:1 ` +
                `(${worst.fg} on ${worst.bg})${rows.every(r => r.passes) ? ' — all pass' : ''}`);
}

console.log(`\nWCAG AA (threshold ${THRESHOLD}:1) — ${themes.size} themes, ` +
            `${checked} pairs checked — ${failures} failure(s)\n`);

if (failures > 0) process.exit(1);
