// Visual feedback and arming UI for the hand cursor: the cursor rings, the
// hover highlight, the post-clap selection window (prompt + dwell arcs), and
// the 🖐 CURSOR button under the camera. Everything is drawn on one
// fixed-position canvas that ignores the pointer; the decisions live in
// uicontrol.js, which this module only *reads* (view()) and listens to
// (onEvent).

import { uicontrol, cursorMap, raiseReason, UIC } from '../uicontrol.js';
import { driverView }                from './uidriver.js';
import { toast }                     from './status.js';
import { keyLabel, getBinding }      from './hotkeys.js';
import { onThemeChange }             from './theme.js';
import { fullscreen }                from './fullscreen.js';
import { devmode }                   from '../devmode.js';

let cv = null, ctx = null;
let reduced = false;
let hintDone = false;         // the clap hint retires after the first window
let hintShownAt = 0;          // …or after ~10s on screen
let flash = null;             // { x, y, t } — a tap just fired, show that it did
const FLASH_MS = 260;

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
  // The caption lives in its own span so the 🚧 beside it survives: writing
  // textContent on the button itself would take the marker with it. Same shape
  // #depth-btn uses, for the same reason.
  const lbl = document.getElementById('uic-btn-lbl');
  // Three visible states, because "enabled and listening" must never look
  // like "off": OFF (default), READY (enabled, waiting for the clap), ARMED.
  const syncBtn = () => {
    if (!btn) return;
    const on = uicontrol.enabled;
    const armed = uicontrol.anyArmed();
    btn.classList.toggle('on', armed);
    btn.classList.toggle('ready', on && !armed);
    btn.setAttribute('aria-pressed', String(armed));
    if (lbl) lbl.textContent = armed ? '🖐 ARMED' : on ? '🖐 READY' : '🖐 CURSOR';
    // Every state says it, because a tooltip is read one state at a time and
    // the one you are in is the only one you see.
    btn.title = !on
      ? 'Under construction — hand cursor (off). Click to enable, then clap and hold up a hand to arm it'
      : armed
        ? 'Under construction — hand cursor armed. Click (or the cursor key) to disarm everything'
        : 'Under construction — hand cursor ready. CLAP (palms together, fingers up), then hold up '
          + 'the hand(s) to arm. Click opens the toggle window without a clap.';
  };

  btn?.addEventListener('click', () => {
    if (!uicontrol.enabled) {
      uicontrol.setEnabled(true);
      toast('Hand cursor ON — CLAP (palms together, fingers up), then hold up a hand');
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
        hintDone = true;                         // the ritual has been found
        if (ev.open) toast('Hold up a hand to toggle UI control');
        break;
      case 'tap':
        flash = { x: ev.x, y: ev.y, t: performance.now() };
        break;
      case 'unarmed-pinch':
        toast(ev.lone
          ? 'That hand is not armed yet — hold it up, open, for a second to arm it'
          : 'That hand is not armed yet — CLAP, then hold it up to arm it');
        break;
      case 'panic':
        toast('Hand cursor disarmed');
        break;
      case 'denied':
        if (ev.reason === 'disabled') toast('Hand cursor is off — enable it in ⚙ settings');
        break;
      case 'clap-miss':
        // A converged-but-refused clap, told why (rate-limited upstream).
        toast({
          up:    'clap seen — point your fingers UP (prayer hands)',
          open:  'clap seen — open both hands flat first',
          apart: 'clap seen — start with your hands apart',
          pinch: 'clap ignored — a hand just pinched; try again in a moment',
        }[ev.reason] ?? 'almost a clap — palms together, fingers up');
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

// Every ring is drawn twice: a dark halo first, then the bright stroke over
// it. The cursor lands on whatever the app happens to show — a near-black
// panel, a white keyboard, a lit camera frame — and a single thin stroke in
// one colour is legible on some of those and invisible on the rest. The halo
// makes it read on all of them, which is the same reason subtitles are
// outlined.
function ring(x, y, r, color, width, { dash = null, glow = false } = {}) {
  ctx.save();
  ctx.setLineDash(dash ?? []);
  ctx.lineWidth = width + 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.72)';
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  if (glow && !reduced) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// The armed cursor. Bright, thick, and unmistakably different from the idle
// ring — the two used to differ only in radius and alpha, which is how a
// cursor that was never armed passed for a working one.
function drawRing(x, y, { pinched, ghost }) {
  const r = pinched ? 11 : 16;
  ring(x, y, r, cols.ring, pinched ? 5 : 3.5,
       { dash: ghost ? [4, 4] : null, glow: pinched });
  // A pinched cursor fills, so "pressed" is a change in mass, not a hairline.
  if (pinched) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = cols.ring;
    ctx.beginPath(); ctx.arc(x, y, r - 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // A dot pins the exact point so the ring can breathe without ambiguity.
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.72)';
  ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
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
  // Under construction, so DEV-only. Gated here rather than only at the call
  // site because the pre-arm rings are drawn for merely-TRACKED hands, and
  // cv.js keeps feeding hands whether or not the tick runs — so an enabled
  // cursor outside DEV would keep painting rings that no clap could ever arm.
  if (!devmode.enabled) {
    if (cv.__drawn) { ctx.clearRect(0, 0, cv.width, cv.height); cv.__drawn = false; }
    return;
  }
  const v = uicontrol.view();
  // Cheap no-op unless the modality is on and could show something — which
  // includes merely-tracked hands: an enabled system that draws nothing
  // until a clap lands is indistinguishable from a broken one.
  const anyPresent = v.hands.L.present || v.hands.R.present;
  if (!v.enabled
      || (!v.hands.L.armed && !v.hands.R.armed && !v.window && !v.singleDwell
          && !anyPresent)) {
    if (cv.__drawn) { ctx.clearRect(0, 0, cv.width, cv.height); cv.__drawn = false; }
    return;
  }
  ctx.clearRect(0, 0, cv.width, cv.height);
  cv.__drawn = true;

  const pxOf = h => cursorMap(h.x, h.y, v.margin, cv.width, cv.height);

  // Pre-arm "listening" feedback: a faint ring on every tracked hand, so
  // the system is visibly alive before anything is armed — plus, until the
  // arming ritual has been found once, the hint that names it.
  for (const s of ['L', 'R']) {
    const h = v.hands[s];
    if (!h.present || h.armed) continue;
    const p = pxOf(h);
    // Dashed and amber: "seen, not armed". It must be visible enough to prove
    // tracking works and different enough that it is never mistaken for a
    // cursor that can click.
    ring(p.x, p.y, 9, cols.warn, 2, { dash: [3, 3] });
  }
  if (!hintDone && anyPresent && !v.window && !v.hands.L.armed && !v.hands.R.armed) {
    const now = performance.now();
    if (!hintShownAt) hintShownAt = now;
    if (now - hintShownAt < 10000) {
      // Telling someone to clap when only one of their hands is in frame is
      // an instruction they cannot follow — and with a tablet held in the
      // other hand, that is the normal case, not the edge case.
      drawPrompt(v.lone
        ? 'HOLD YOUR HAND UP, OPEN, TO ARM THE CURSOR'
        : 'CLAP — PALMS TOGETHER, FINGERS UP — TO ARM THE CURSOR',
        `or press ${keyLabel(getBinding('cursor'))} / the 🖐 button`);
    } else {
      hintDone = true;
    }
  }

  // A tap that fires draws a ring where it landed. Without it a click and a
  // missed click look identical, which is how a broken tap rule stayed
  // invisible: the cursor moved, so the modality looked alive.
  if (flash) {
    const age = (performance.now() - flash.t) / FLASH_MS;
    if (age >= 1) {
      flash = null;
    } else {
      const p = pxOf(flash);
      ctx.save();
      ctx.strokeStyle = cols.armed;
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, reduced ? 22 : 12 + age * 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // DEV: the live gate metrics — the tuning clinic for fitting the gates to
  // a real pair of hands. Pinch first, since that is what a click is.
  if (document.body.classList.contains('dev') && anyPresent) {
    const f = n => (n == null ? '—' : n.toFixed(2));
    const pin = s => {
      const h = v.hands[s];
      if (!h.present) return `${s} —`;
      return `${s} r ${f(h.r)}${h.pinched ? ' PINCH' : ''}${h.ghost ? ' ghost' : ''}`;
    };
    ctx.save();
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillStyle = cols.text;
    ctx.globalAlpha = 0.75;
    ctx.fillText(`uic ${pin('L')} · ${pin('R')}`, 8, cv.height - 22);
    ctx.fillText(
      `up ${f(v.hands.L.up)}/${f(v.hands.R.up)} · `
      + `open ${f(v.hands.L.open)}/${f(v.hands.R.open)} · wristD ${f(v.wristD)}`,
      8, cv.height - 8);
    ctx.restore();
  }

  // Hover highlight behind the rings.
  for (const s of ['L', 'R']) {
    if (!v.hands[s].armed) continue;
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

  // Selection window: prompt plus a dwell arc at each raised hand. A hand
  // that is visible but not qualifying gets told which half it is missing —
  // the arc filling is the confirmation, this is the correction.
  if (v.window) {
    const left = Math.max(0, (v.window.until - v.window.now) / 1000);
    let sub = `arms the cursor · window closes in ${left.toFixed(1)}s`;
    for (const s of ['L', 'R']) {
      const h = v.hands[s];
      if (!h.present || v.window.dwell[s] > 0) continue;
      const why = raiseReason(h.yUp, h.open);
      if (why) {
        sub = why === 'raise' ? 'raise it higher' : 'open your hand flat';
        break;
      }
    }
    drawPrompt('RAISE A HAND TO TOGGLE UI CONTROL', sub);
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
    if (!h.armed || !h.present) continue;
    const p = pxOf(h);
    drawRing(p.x, p.y, h);
  }
}
