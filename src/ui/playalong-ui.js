// Play-along rendering: a falling-note "highway" above a piano-keys strip,
// drawn on either the audio panel's #game-canvas or the fullscreen overlay
// (#fs-kbd) — same renderer, different sizes. Also owns the per-RAF panel
// update and registers the fullscreen game renderer.

import { engine }              from '../engine.js';
import { playalong }           from '../playalong.js';
import { keyboardLayout, isWhite, KBD_LO, KBD_HI, OSC1_COL } from './keyboard.js';
import { NOTE_NAMES, SCALES }  from '../scale.js';
import { setFsGameRenderer }   from './fullscreen.js';
import { renderAudioPanel }    from './audio-ui.js';

// Keys strip drawn inside a larger canvas (highway above it). Uses the same
// keyboardLayout as the falling notes, so bars land exactly on their keys.
function drawKeys(ctx, W, yTop, keysH, root, scale, playerMidi) {
  const L = keyboardLayout(W);
  const rootPc = Math.max(0, NOTE_NAMES.indexOf(root ?? 'C'));
  const degs = scale ? (SCALES[scale] || SCALES.chromatic) : null;
  const inScale = degs ? new Set(degs.map(d => (rootPc + d) % 12)) : null;
  const pc = m => ((m % 12) + 12) % 12;

  for (let i = 0; i < L.whites.length; i++) {
    const m = L.whites[i], x = i * L.ww;
    ctx.fillStyle = '#cfd4db';
    ctx.fillRect(x + 0.5, yTop, L.ww - 1, keysH);
    if (inScale?.has(pc(m))) {
      ctx.fillStyle = pc(m) === rootPc ? 'rgba(240,165,0,0.42)' : 'rgba(120,160,255,0.32)';
      ctx.fillRect(x + 0.5, yTop, L.ww - 1, keysH);
    }
    ctx.strokeStyle = '#2a2f38'; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, yTop, L.ww - 1, keysH);
  }
  const bw = L.ww * 0.62, bh = keysH * 0.62;
  for (let m = KBD_LO; m <= KBD_HI; m++) {
    if (isWhite(m)) continue;
    const x = (L.wIdx.get(m - 1) + 1) * L.ww - bw / 2;
    ctx.fillStyle = inScale?.has(pc(m))
      ? (pc(m) === rootPc ? '#c58a1e' : '#41527f') : '#20242b';
    ctx.fillRect(x, yTop, bw, bh);
  }
  // Player's current note marker on the keys.
  if (playerMidi !== null && playerMidi >= KBD_LO && playerMidi <= KBD_HI) {
    const x = L.keyCenter(playerMidi);
    ctx.beginPath(); ctx.arc(x, yTop + keysH - 8, Math.min(L.ww * 0.45, 6), 0, Math.PI * 2);
    ctx.fillStyle = OSC1_COL; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0b0d12'; ctx.stroke();
  }
  return L;
}

// Full game frame. opts: { height, keysH }
export function drawGame(canvas, view, { height = 170, keysH = 40 } = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 300, H = height;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Highway backdrop.
  ctx.fillStyle = 'rgba(8,10,15,0.72)';
  ctx.fillRect(0, 0, W, H);

  const hitY = H - keysH;
  const L = drawKeys(ctx, W, hitY, keysH, view.root, view.scale, view.playerMidi);
  const fallMs = view.cfg.fallSec * 1000;

  // Falling notes: y = hitY when tMs === now; top of highway = fallSec early.
  for (const n of view.notes) {
    const dt = n.tMs - view.nowMs;
    if (dt > fallMs || dt < -1200) continue;
    const y = hitY * (1 - dt / fallMs);                     // note head
    const len = Math.max(6, (n.durMs / fallMs) * hitY);     // bar length
    const x = L.keyCenter(Math.max(KBD_LO, Math.min(KBD_HI, n.m)));
    const w = Math.max(4, L.ww * 0.7);

    if (n.status === 'hit') {
      const age = view.nowMs - (n.hitAtMs ?? n.tMs);
      if (age > 350) continue;                              // quick purple flash
      ctx.globalAlpha = Math.max(0, 1 - age / 350);
      ctx.fillStyle = OSC1_COL;
      ctx.fillRect(x - w / 2, hitY - 10, w, 10);
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.fillStyle = n.status === 'miss' ? 'rgba(255,100,114,0.55)' : 'rgba(0,229,204,0.85)';
    ctx.fillRect(x - w / 2, Math.min(y, hitY) - len, w, len);
    ctx.strokeStyle = 'rgba(8,10,15,0.7)'; ctx.lineWidth = 1;
    ctx.strokeRect(x - w / 2, Math.min(y, hitY) - len, w, len);
  }

  // Hit line.
  ctx.fillStyle = 'rgba(240,165,0,0.9)';
  ctx.fillRect(0, hitY - 2, W, 2);

  // HUD.
  const fs = Math.max(10, Math.round(H * 0.07));
  ctx.font = `${fs}px "IBM Plex Mono", monospace`;
  ctx.textBaseline = 'top';
  if (view.state === 'countdown') {
    ctx.fillStyle = '#f0a500';
    ctx.font = `${Math.round(H * 0.3)}px "IBM Plex Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(String(view.countdown), W / 2, H * 0.18);
    ctx.textAlign = 'left';
  } else if (view.state === 'finished') {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f0a500';
    ctx.font = `${Math.round(fs * 1.6)}px "IBM Plex Mono", monospace`;
    ctx.fillText(`SCORE ${view.score}`, W / 2, H * 0.16);
    ctx.fillStyle = '#cfd4db';
    ctx.font = `${fs}px "IBM Plex Mono", monospace`;
    ctx.fillText(`${Math.round(view.accuracy * 100)}% · BEST STREAK ${view.bestStreak} · ${view.hits}/${view.total}`, W / 2, H * 0.16 + fs * 2);
    ctx.textAlign = 'left';
  } else {
    ctx.fillStyle = '#cfd4db';
    ctx.fillText(`${view.score}`, 8, 6);
    ctx.textAlign = 'right';
    ctx.fillStyle = view.streak >= 5 ? '#f0a500' : '#8a93a3';
    ctx.fillText(`×${view.streak}`, W - 8, 6);
    ctx.textAlign = 'left';
  }
}

// Per-RAF panel update (cheap no-op when idle) + state-transition refresh.
let prevState = 'idle';
export function updateGamePanel() {
  const view = playalong.view;

  // On finish (tuning was restored) refresh the audio panel so the quantise
  // UI reflects reality again; button/canvas states re-derive from view.
  if (view.state !== prevState) {
    if ((view.state === 'finished' || view.state === 'idle') && engine.started) renderAudioPanel();
    prevState = view.state;
  }
  if (view.state === 'idle') return;

  const c = document.getElementById('game-canvas');
  if (c && c.clientWidth) drawGame(c, view, { height: 170, keysH: 40 });

  const scoreEl = document.getElementById('game-score');
  if (scoreEl) {
    const txt = view.state === 'finished'
      ? `FINAL ${view.score} · ${Math.round(view.accuracy * 100)}% · BEST ×${view.bestStreak}`
      : `SCORE ${view.score} · ×${view.streak} · ${Math.round(view.accuracy * 100)}%`;
    if (scoreEl.textContent !== txt) scoreEl.textContent = txt;
  }
}

export function initPlayalongUI() {
  // The fullscreen overlay delegates to the game while one is running.
  setFsGameRenderer(canvas => {
    const view = playalong.view;
    if (view.state === 'idle') return false;
    const wrapH = canvas.parentElement?.clientHeight || 480;
    drawGame(canvas, view, { height: Math.round(wrapH * 0.55), keysH: 80 });
    return true;
  });
}
