// Shared piano-keyboard renderer — used by the audio panel's pitch-quantise
// keyboard, the fullscreen keyboard overlay, and the play-along note highway.
// A 5-octave piano (C2–C7): in-scale pitch classes tinted (root strongest),
// plus optional oscillator marker dots.

import { NOTE_NAMES, SCALES, midiName } from '../scale.js';

export const KBD_LO = 36, KBD_HI = 96;                 // MIDI C2 … C7
// One colour per oscillator slot, cycled if the bank is grown past the list.
// Ordered so slots 1 and 2 keep the purple/cyan they have always had.
export const OSC_COLS = ['#9d5cff', '#00e5cc', '#ffb340', '#ff5c8a',
                        '#5cff9d', '#5c9dff', '#ffe45c', '#ff8a5c'];

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

// Where in the keyboard a canvas-local point lands — inverse of the black-key
// placement math in drawKeyboard, for click-to-pick-a-note UIs.
export function midiAtPoint(width, height, x, y) {
  const L = keyboardLayout(width);
  const bw = L.ww * 0.62, bh = height * 0.62;
  if (y <= bh) {
    for (let m = KBD_LO; m <= KBD_HI; m++) {
      if (isWhite(m)) continue;
      const bx = (L.wIdx.get(m - 1) + 1) * L.ww - bw / 2;
      if (x >= bx && x <= bx + bw) return m;
    }
  }
  const i = Math.max(0, Math.min(L.whites.length - 1, Math.floor(x / L.ww)));
  return L.whites[i];
}

// Pure draw. opts: { height, root, scale, markers, labels, dpr }
//   scale: null → plain keys, no in-scale tint (quantise off)
//   markers: array of marker midis (one per oscillator); null entries skipped
//   chord:   what is sounding, painted ON the keys, so the keyboard shows the
//            harmony as a picture rather than as a note list. Either bare
//            midis (all equally down — a block chord) or `{m, level}` pairs,
//            where `level` is 0..1 loudness. The pairs are what an arpeggio
//            needs: one note is struck while the last is still falling, and
//            drawing both at full strength would claim a chord that is not
//            being played.
//   labels: true → octave anchors (C2…C7) on the C keys
export function drawKeyboard(canvas, { height = 46, root = 'C', scale = null, markers = [], chord = [], labels = false, dpr } = {}) {
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

  // Chord tones. Every octave of each pitch class is lit, not just the octave
  // the voice happens to be in: the point of the overlay is to show the SHAPE
  // of the harmony across the keyboard while you play, and one triad in the
  // middle of six octaves is a detail you cannot read at arm's length from a
  // camera. The sounding octave is drawn solid, its echoes translucent, so the
  // actual voicing is still distinguishable.
  if (chord.length) {
    // A bare number is a note at full strength — every caller that has no
    // opinion about loudness keeps working unchanged.
    const notes = chord.map(c => Number.isFinite(c) ? { m: c, level: 1 } : c)
                       .filter(n => n && Number.isFinite(n.m));
    const sounding = new Map();   // midi → level
    const classes  = new Map();   // pitch class → loudest level in it
    for (const n of notes) {
      const lv = Math.max(0, Math.min(1, n.level ?? 1));
      sounding.set(n.m, Math.max(sounding.get(n.m) ?? 0, lv));
      classes.set(pc(n.m), Math.max(classes.get(pc(n.m)) ?? 0, lv));
    }
    const CHORD_COL = '0,229,204';                       // the app's cyan
    for (let m = KBD_LO; m <= KBD_HI; m++) {
      if (!classes.has(pc(m))) continue;
      // The sounding octave is drawn at its own level; the echoes follow the
      // loudest note of that pitch class, so a fading note's echoes fade with
      // it instead of hanging on after it has gone.
      const lv = sounding.get(m) ?? classes.get(pc(m));
      if (lv <= 0) continue;
      const solid = sounding.has(m);
      ctx.fillStyle = `rgba(${CHORD_COL},${(solid ? 0.82 : 0.26) * lv})`;
      if (isWhite(m)) {
        const x = L.wIdx.get(m) * L.ww;
        ctx.fillRect(x + 0.5, 0, L.ww - 1, H);
      } else {
        const x = (L.wIdx.get(m - 1) + 1) * L.ww - bw / 2;
        ctx.fillRect(x, 0, bw, bh);
      }
    }
  }

  // Octave anchors on C keys — per-key names are unreadable at 36 white keys,
  // but "C3" every octave orients the eye; exact names live in the readouts.
  if (labels) {
    ctx.font = '7px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#20242b';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (let i = 0; i < L.whites.length; i++) {
      if (L.whites[i] % 12 === 0) ctx.fillText(midiName(L.whites[i]), (i + 0.5) * L.ww, H - 1);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
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
  // Painted back to front so slot 1 wins on unison, as it always has.
  for (let i = markers.length - 1; i >= 0; i--)
    marker(markers[i], OSC_COLS[i % OSC_COLS.length]);

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
      const h = height instanceof Function ? height() : height;
      // Levels are quantised into the signature: a fading note has to redraw
      // as it falls, but not on differences too small to see.
      const chordSig = (opts.chord ?? []).map(n => Number.isFinite(n)
        ? `${n}` : `${n?.m}:${Math.round((n?.level ?? 1) * 16)}`).join(',');
      const s = `${opts.root}|${opts.scale}|${c.clientWidth}|${h}`
              + `|${(opts.markers ?? []).join(',')}|${chordSig}`;
      if (s === sig) return;
      sig = s;
      drawKeyboard(c, { ...opts, height: h });
    },
    invalidate() { sig = ''; },
  };
}
