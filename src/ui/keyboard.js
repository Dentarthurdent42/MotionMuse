// Shared piano-keyboard renderer — used by the audio panel's pitch-quantise
// keyboard, the fullscreen keyboard overlay, and the play-along note highway.
// A 5-octave piano (C2–C7): in-scale pitch classes tinted (root strongest),
// plus optional oscillator marker dots.

import { NOTE_NAMES, SCALES } from '../scale.js';

export const KBD_LO = 36, KBD_HI = 96;                 // MIDI C2 … C7
export const OSC1_COL = '#9d5cff';                     // osc1 marker (purple)
export const OSC2_COL = '#00e5cc';                     // osc2 marker (cyan)

const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
export const isWhite = m => WHITE_PC.has(((m % 12) + 12) % 12);
export const midiOf  = f => Math.round(69 + 12 * Math.log2(f / 440));

// Key geometry for a given pixel width — shared with the game highway so
// falling notes line up exactly with their keys.
export function keyboardLayout(width) {
  const whites = [];
  for (let m = KBD_LO; m <= KBD_HI; m++) if (isWhite(m)) whites.push(m);
  const ww = width / whites.length;
  const wIdx = new Map(whites.map((m, i) => [m, i]));
  const keyCenter = m => isWhite(m) ? (wIdx.get(m) + 0.5) * ww : (wIdx.get(m - 1) + 1) * ww;
  return { whites, ww, wIdx, keyCenter };
}

// Pure draw. opts: { height, root, scale, m1, m2, dpr }
//   scale: null → plain keys, no in-scale tint (quantise off)
//   m1/m2: marker midis or null
export function drawKeyboard(canvas, { height = 46, root = 'C', scale = null, m1 = null, m2 = null, dpr } = {}) {
  dpr = dpr ?? Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 260, H = height;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const L = keyboardLayout(W);
  const rootPc = Math.max(0, NOTE_NAMES.indexOf(root));
  const degs   = scale ? (SCALES[scale] || SCALES.chromatic) : null;
  const inScale = degs ? new Set(degs.map(d => (rootPc + d) % 12)) : null;
  const pc = m => ((m % 12) + 12) % 12;

  // White keys (with in-scale wash when a scale is given).
  for (let i = 0; i < L.whites.length; i++) {
    const m = L.whites[i], x = i * L.ww;
    ctx.fillStyle = '#cfd4db';
    ctx.fillRect(x + 0.5, 0, L.ww - 1, H);
    if (inScale?.has(pc(m))) {
      ctx.fillStyle = pc(m) === rootPc ? 'rgba(240,165,0,0.42)' : 'rgba(120,160,255,0.32)';
      ctx.fillRect(x + 0.5, 0, L.ww - 1, H);
    }
    ctx.strokeStyle = '#2a2f38'; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, 0, L.ww - 1, H);
  }

  // Black keys (in-scale ones accented instead of dark).
  const bw = L.ww * 0.62, bh = H * 0.62;
  for (let m = KBD_LO; m <= KBD_HI; m++) {
    if (isWhite(m)) continue;
    const x = (L.wIdx.get(m - 1) + 1) * L.ww - bw / 2;
    ctx.fillStyle = inScale?.has(pc(m))
      ? (pc(m) === rootPc ? '#c58a1e' : '#41527f')
      : '#20242b';
    ctx.fillRect(x, 0, bw, bh);
  }

  // Oscillator markers.
  const marker = (m, col) => {
    if (m === null || m === undefined) return;
    const inRange = m >= KBD_LO && m <= KBD_HI;
    const mm = Math.max(KBD_LO, Math.min(KBD_HI, m));
    const x = L.keyCenter(mm), y = H - 7, r = Math.min(L.ww * 0.42, 5.5);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = inRange ? col : '#0b0d12';
    ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = inRange ? '#0b0d12' : col;
    ctx.stroke();
  };
  marker(m2, OSC2_COL);
  marker(m1, OSC1_COL);   // osc1 drawn last so it wins on unison

  return L;
}

// Stateful wrapper owning the redraw-skip signature, one per target canvas.
// height may be a number or a function (evaluated per draw, e.g. % of parent).
export function makeKbdView(canvasId, { height = 46 } = {}) {
  let sig = '';
  return {
    draw(opts = {}) {
      const c = document.getElementById(canvasId);
      if (!c) return;
      const h = typeof height === 'function' ? height() : height;
      const s = `${opts.root}|${opts.scale}|${c.clientWidth}|${h}|${opts.m1}|${opts.m2}`;
      if (s === sig) return;
      sig = s;
      drawKeyboard(c, { ...opts, height: h });
    },
    invalidate() { sig = ''; },
  };
}
