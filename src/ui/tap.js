// A touch tap on a button is a click — decided here, not by the browser.
//
// Reported on an iPhone: buttons needed two or three taps. The finger landed
// on the right button every time (the ?debug log showed it), but iOS Safari
// often never sent the click. Before WebKit turns a tap into a click it
// fires the mouse-hover events and watches the page; if anything changes in
// that window it treats the tap as "showing the hover" and drops the click.
// This page changes every frame — signal readouts, meters, the picture's
// overlays — so the watcher sees a change on most taps. Fewer per-frame DOM
// writes made it rarer; it cannot make it zero, because those readouts are
// supposed to move.
//
// So for a touch that goes down and comes up on the same button without
// travelling, the click is dispatched here, on pointerup. If the browser does
// send its own click afterwards, that one is dropped, so each tap is still
// exactly one click. pointerup from a touch counts as a user gesture, so the
// camera prompt, fullscreen and audio unlock behave as they did.
//
// Only real (isTrusted) touch and pen input: the mouse already works, and the
// hand cursor (src/ui/uidriver.js) synthesises its own events and clicks.
// Only buttons and links: text fields and selects need the native tap to
// focus and open, and sockets and node headers are drag handles.

const ACTIVATABLE = 'button, a[href], [role="button"], summary';
const EXCLUDE = '.port, .node-grip, input, select, textarea';
const SLOP = 10;          // px a finger may wander and still be a tap
const MAX_MS = 800;       // longer than this is a press, not a tap
const DUP_MS = 700;       // how long a native click after ours is a duplicate
const DUP_PX = 30;

let down = null;          // { id, el, x, y, t }
let synthetic = null;     // { x, y, t } — the click we just sent

const target = el => {
  const hit = el?.closest?.(ACTIVATABLE);
  if (!hit || hit.closest(EXCLUDE) || hit.disabled) return null;
  return hit;
};

export function initTapClicks() {
  window.addEventListener('pointerdown', e => {
    if (!e.isTrusted || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) { down = null; return; }
    const el = target(e.target);
    down = el ? { id: e.pointerId, el, x: e.clientX, y: e.clientY, t: performance.now() } : null;
  }, { capture: true, passive: true });

  window.addEventListener('pointercancel', e => {
    if (down && e.pointerId === down.id) down = null;      // it became a scroll
  }, { capture: true, passive: true });

  window.addEventListener('pointerup', e => {
    const d = down;
    if (!d || !e.isTrusted || e.pointerId !== d.id) return;
    down = null;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > SLOP) return;
    if (performance.now() - d.t > MAX_MS) return;
    if (!d.el.isConnected || d.el.disabled) return;
    // Still on the same button where the finger lifted? Asked of the layout,
    // not of the event's target, which is the thing WebKit gets wrong here.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (under && !d.el.contains(under) && target(under) !== d.el) return;
    synthetic = { x: e.clientX, y: e.clientY, t: performance.now() };
    d.el.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
      button: 0, detail: 1,
    }));
  }, { capture: true, passive: true });

  // The browser's own click for a tap we already clicked: drop it. Matched by
  // place and time rather than target — if the first click re-rendered the
  // panel, the native one lands on whatever replaced the button.
  window.addEventListener('click', e => {
    const s = synthetic;
    if (!s || !e.isTrusted) return;
    if (performance.now() - s.t > DUP_MS) { synthetic = null; return; }
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > DUP_PX) return;
    synthetic = null;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });
}
