// Programmatic WCAG AA contrast check — no browser, no API key needed.
// Parses CSS custom properties from css/main.css, then checks every
// text/background pair used in the UI against the 4.5:1 threshold
// (all text in this app is ≤11 px so "large text" rules don't apply).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// ── Parse CSS variables ───────────────────────────────────────────────────────
function parseCssVars(cssPath) {
  const src  = readFileSync(cssPath, 'utf8');
  const vars = {};
  // Match lines like:  --name: #rrggbb;  (ignores alpha hex and other values)
  for (const [, name, hex] of src.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
    vars[`--${name}`] = hex;
  }
  return vars;
}

// ── WCAG contrast math ────────────────────────────────────────────────────────
function hexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 0xff, n & 0xff].map(c => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
}

function luminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hex1, hex2) {
  const l1 = luminance(hexToLinear(hex1));
  const l2 = luminance(hexToLinear(hex2));
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
  ['--green',   '--panel',   'Green status dot label on panel'],
  ['--red',     '--panel',   'Red text on panel'],
];

const THRESHOLD = 4.5; // WCAG AA normal text

// ── Run ───────────────────────────────────────────────────────────────────────
const vars  = parseCssVars(join(ROOT, 'css/main.css'));

let failures = 0;
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

// ── Report ────────────────────────────────────────────────────────────────────
const maxUsage = Math.max(...rows.map(r => r.usage.length));
console.log(`\nWCAG AA contrast check (threshold ${THRESHOLD}:1)\n`);

for (const r of rows) {
  const status = r.passes ? ' PASS ' : ' FAIL ';
  const ratio  = r.ratio.toFixed(2).padStart(5);
  console.log(`  [${status}]  ${ratio}:1  ${r.fg} on ${r.bg.padEnd(11)}  ${r.usage}`);
}

console.log(`\n${rows.length} pairs checked — ${failures} failure(s)\n`);

if (failures > 0) {
  process.exit(1);
}
