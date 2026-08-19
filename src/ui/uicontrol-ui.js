// Visual feedback and arming UI for the hand cursor: the cursor rings, the
// hover highlight, the post-clap selection window (prompt + dwell arcs), and
// the 🖐 CURSOR button under the camera. Everything is drawn on one
// fixed-position canvas that ignores the pointer; the decisions live in
// uicontrol.js, which this module only *reads* (view()) and listens to
// (onEvent).

import { uicontrol, cursorMap, UIC } from '../uicontrol.js';
import { driverView }                from './uidriver.js';
import { toast }                     from './status.js';
import { onThemeChange }             from './theme.js';
import { fullscreen }                from './fullscreen.js';

let cv = null, ctx = null;
let reduced = false;

// Theme tokens, cached — re-read when the theme flips, not every frame.
let cols = null;
function readCols() {
  const cs = getComputedStyle(document.documentElement);
  const tok = (n, fb) => (cs.getPropertyValue(n) || fb).trim();
  cols = {
    ring:  tok('--cyan',  '#7de8dc'),
    armed: tok('--green', '#8fe8a0'),
    warn:  tok('--amber', '#e8c46a'),
    text:  tok('--text',  '#eee'),
  };
}

function fit() {
  if (!cv) return;
  cv.width = window.innerWidth;
  cv.height = window.innerHeight;
}

const sideName = s => (s === 'L' ? 'LEFT' : 'RIGHT');

export function initUicontrol() {
  cv = document.createElement('canvas');
  cv.id = 'uic-overlay';
  cv.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cv);
  ctx = cv.getContext('2d');
  fit();
  window.addEventListener('resize', fit);
  reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  readCols();
  onThemeChange(readCols);

  // Native fullscreen shows only the fullscreened subtree, so the overlay
  // rides into #video-wrap while it is active and comes back out after.
  fullscreen.onChange(active => {
    (active ? document.getElementById('video-wrap') : document.body).appendChild(cv);
    fit();
  });

  const btn = document.getElementById('uic-btn');
  const syncBtn = () => {
    if (!btn) return;
    const on = uicontrol.enabled;
    const armed = uicontrol.anyArmed();
    btn.classList.toggle('on', armed);
    btn.setAttribute('aria-pressed', String(armed));
    btn.title = !on
      ? 'Hand cursor (off) — click to enable, then clap and hold up a hand to arm it'
      : armed
        ? 'Hand cursor armed — click (or the cursor key) to disarm everything'
        : 'Hand cursor ready — clap, then hold up the hand(s) to arm. Click opens the toggle window.';
  };

  btn?.addEventListener('click', () => {
    if (!uicontrol.enabled) {
      uicontrol.setEnabled(true);
      toast('Hand cursor enabled — CLAP, then hold up the hand(s) to arm');
      syncBtn();
      return;
    }
    uicontrol.hotkey();     // window when idle, disarm-all when armed
  });

  uicontrol.onEvent(ev => {
    switch (ev.type) {
      case 'armed':
        toast(ev.on ? `${sideName(ev.side)} HAND → UI CURSOR`
                    : `${sideName(ev.side)} HAND → INSTRUMENT`);
        break;
      case 'window':
        if (ev.open) toast('Hold up a hand to toggle UI control');
        break;
      case 'panic':
        toast('Hand cursor disarmed');
        break;
      case 'denied':
        if (ev.reason === 'disabled') toast('Hand cursor is off — enable it in ⚙ settings');
        break;
      case 'sweep':
        break;                                   // the stage narrates its own sweep
      case 'enabled':
        if (!ev.on) toast('Hand cursor off');
        syncBtn();
        break;
    }
    syncBtn();
  });
  syncBtn();
}

// One ring: the cursor. Shrinks and brightens while pinched; dashed while a
// ghost/probation grip is still proving itself.
function drawRing(x, y, { pinched, ghost, armed }) {
  const r = pinched ? 10 : 15;
  ctx.save();
  ctx.lineWidth = pinched ? 3.5 : 2.5;
  ctx.strokeStyle = armed ? cols.ring : cols.warn;
  if (ghost) ctx.setLineDash([4, 4]);
  if (pinched && !reduced) {
    ctx.shadowColor = cols.ring;
    ctx.shadowBlur = 12;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  // A dot pins the exact point so the ring can breathe without ambiguity.
  ctx.setLineDash([]);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.arc(x, y, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// The dwell arc: a conic ring filling toward "toggled".
function drawDwell(x, y, frac) {
  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = cols.warn;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.arc(x, y, 26, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(x, y, 26, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawPrompt(text, sub) {
  ctx.save();
  ctx.font = '600 13px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  const y = Math.round(cv.height * 0.14);
  const w = ctx.measureText(text).width + 36;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect((cv.width - w) / 2, y - 22, w, sub ? 52 : 34, 8);
  ctx.fill();
  ctx.fillStyle = cols.text;
  ctx.fillText(text, cv.width / 2, y);
  if (sub) {
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.globalAlpha = 0.8;
    ctx.fillText(sub, cv.width / 2, y + 18);
  }
  ctx.restore();
}

export function updateUicOverlay() {
  if (!ctx) return;
  const v = uicontrol.view();
  // Cheap no-op unless the modality is actually doing something visible.
  if (!v.enabled || (!v.armed.L && !v.armed.R && !v.window && !v.singleDwell)) {
    if (cv.__drawn) { ctx.clearRect(0, 0, cv.width, cv.height); cv.__drawn = false; }
    return;
  }
  ctx.clearRect(0, 0, cv.width, cv.height);
  cv.__drawn = true;

  const pxOf = h => cursorMap(h.x, h.y, v.margin, cv.width, cv.height);

  // Hover highlight behind the rings.
  for (const s of ['L', 'R']) {
    if (!v.armed[s]) continue;
    const d = driverView(s);
    if (d.hoverRect && !d.gripping) {
      const r = d.hoverRect;
      ctx.save();
      ctx.strokeStyle = cols.ring;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(r.x - 3, r.y - 3, r.width + 6, r.height + 6, 6);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Selection window: prompt plus a dwell arc at each raised hand.
  if (v.window) {
    const left = Math.max(0, (v.window.until - v.window.now) / 1000);
    drawPrompt('RAISE A HAND TO TOGGLE UI CONTROL',
               `arms the cursor · window closes in ${left.toFixed(1)}s`);
    for (const s of ['L', 'R']) {
      const h = v.hands[s];
      if (!h.present) continue;
      const p = pxOf(h);
      if (v.window.dwell[s] > 0) drawDwell(p.x, p.y, v.window.dwell[s] / UIC.DWELL_MS);
    }
  } else if (v.singleDwell > 0) {
    // One-hand fallback arming: same arc, longer fill.
    for (const s of ['L', 'R']) {
      const h = v.hands[s];
      if (h.present) {
        const p = pxOf(h);
        drawDwell(p.x, p.y, v.singleDwell / UIC.SINGLE_DWELL);
      }
    }
  }

  // The cursors themselves.
  for (const s of ['L', 'R']) {
    const h = v.hands[s];
    if (!v.armed[s] || !h.present) continue;
    const p = pxOf(h);
    drawRing(p.x, p.y, h);
  }
}
