// The picture stays with you down the column.
//
// In column mode (a phone) the camera node is the first thing in the stack
// and everything you play with is below it — so the moment you scroll to a
// slider the picture is gone, and with it the only feedback that the
// tracking is seeing you. So the picture is lifted out of its node into the
// dock, which rides the top of the viewport, and a placeholder of the same
// size holds its place in the node: at the top of the column the picture
// sits exactly over the placeholder, and as the placeholder scrolls away the
// picture stays, shrinking to a thumbnail in the top-right corner. A tap on
// the thumbnail scrolls back to the camera node. On the canvas nothing of
// this happens: the picture is in its node, where a pin can hold it.
//
// The CSS fullscreen (ui/fullscreen.js) lifts the same element to <body>
// and puts it back where it found it — in the dock or in the node, either
// way the right place.

import * as WS from './workspace.js';

const MINI = 0.4;          // the thumbnail's share of the screen's width
const INSET = 8;

let wrap, hold, strip, ws;

const lifted = () => !!wrap && wrap.parentElement === strip;
const inFullscreen = () => wrap.classList.contains('fake-fullscreen') || document.fullscreenElement === wrap;

export function initCamSticky() {
  wrap = document.getElementById('video-wrap');
  ws = WS.viewportEl();
  const dock = document.getElementById('ws-dock');
  if (!wrap || !ws || !dock) return;
  strip = document.createElement('div');
  strip.id = 'cam-sticky';
  strip.hidden = true;
  dock.appendChild(strip);
  hold = document.createElement('div');
  hold.id = 'cam-hold';
  hold.hidden = true;
  hold.setAttribute('aria-hidden', 'true');
  wrap.before(hold);
  strip.addEventListener('click', e => {
    if (!strip.classList.contains('cam-mini') || e.target.closest('button, a, select, input, label')) return;
    WS.fitAll(['panel:camera']);
  });
  WS.onViewScroll(update);
  WS.onCablesDirty(update);            // every re-stack, resize and drag
  WS.onModeChange(sync);
  window.addEventListener('resize', update);
  document.addEventListener('fullscreenchange', () => setTimeout(sync, 0));
  sync();
}

// Lift the picture out for the column, put it back for the canvas.
export function sync() {
  if (!wrap) return;
  const want = WS.isColumnMode() && !inFullscreen();
  if (want && !lifted()) {
    hold.hidden = false;
    strip.hidden = false;
    strip.appendChild(wrap);
  } else if (!want && lifted()) {
    hold.before(wrap);
    hold.hidden = true;
    strip.hidden = true;
    strip.classList.remove('cam-mini');
    strip.style.cssText = '';
  }
  update();
}

function update() {
  if (!lifted()) return;
  // The map, or a node that is folded, closed or off screen: no picture.
  const shown = !WS.isOverview() && hold.getClientRects().length > 0;
  strip.hidden = !shown;
  if (!shown) return;
  const wsr = ws.getBoundingClientRect();
  const hr = hold.getBoundingClientRect();
  const W = wsr.width;
  const full = { left: hr.left - wsr.left, top: hr.top - wsr.top, w: hr.width };
  // How far past the top the placeholder has gone, as a share of its own
  // height: 0 while it is on screen, 1 once it has scrolled clear.
  const p = Math.min(1, Math.max(0, -full.top) / Math.max(1, hr.height));
  const miniW = Math.round(W * MINI);
  const w = full.w + (miniW - full.w) * p;
  const left = full.left + ((W - miniW - INSET) - full.left) * p;
  const top = Math.max(0, full.top) + INSET * p;
  strip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  strip.style.width = `${Math.round(w)}px`;
  strip.classList.toggle('cam-mini', p > 0.5);
}
