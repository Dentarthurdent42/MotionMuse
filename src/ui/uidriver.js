// The hand cursor's hands: turns press/move/release decisions from
// uicontrol.js into real effects on the existing UI. Injected via
// uicontrol.setDriver() so the decision layer stays DOM-free.
//
// Two mechanisms, chosen per target:
//
// - Native widgets can't be driven by synthetic events (untrusted events
//   trigger no default actions — a fake pointerdown will not move a range
//   thumb or open a select), so they get *semantic* adapters: sliders are
//   written through .value + an 'input' event (the same authoritative path
//   the real thumb uses — audio-ui listens there and calls engine.set),
//   selects get a floating option list, buttons get .click().
//
// - App-authored pointer surfaces (patchbay pills, section headers, resize
//   grips, splitters, piano canvases) listen for pointer events themselves,
//   so they are driven by synthetic PointerEvents: pointerdown dispatched at
//   the innermost element under the cursor (bubbling, so e.target-based
//   guards in those handlers see the truth), then pointermove/up at the
//   surface that took the press — which emulates the pointer capture those
//   handlers request. Each hand uses a constant negative pointerId, the
//   in-tree convention for a synthetic pointer (mapper-ui's keyboard path
//   dispatches pointerId -1), and the `wiring.id !== e.pointerId` guards
//   hold naturally.
//
// A grip is exactly one of: 'range' (slider write-through), 'pointer'
// (synthetic capture), 'scroll' (scrollTop write), or 'tap' (nothing until
// the release classifies as a tap).

import { uicontrol, cursorMap } from '../uicontrol.js';

const PTR_ID = { L: -2, R: -3 };
const SCROLL_RATE = 1.4;              // scroll travels faster than the hand

// Surfaces that own their own pointer handling, innermost match first.
const POINTER_SURFACE =
  '.port, .port-src, .node-grip, .node-head, canvas';
// What the hover ring highlights as "you are aiming at something".
const INTERACTIVE =
  'button, a, [role="button"], select, input, label, canvas, .port, ' +
  '.node-grip, .node-head';

const px = (nx, ny) =>
  cursorMap(nx, ny, uicontrol.margin, window.innerWidth, window.innerHeight);

const synth = (type, el, id, x, y) => el.dispatchEvent(new PointerEvent(type, {
  pointerId: id, bubbles: true, cancelable: true,
  clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  pointerType: 'hand', isPrimary: true,
}));

// Nearest scrollable ancestor — the second level of the app's two-level
// scrolling (section bodies), falling back to whatever else clips.
function scrollableFrom(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 4) {
      const o = getComputedStyle(n).overflowY;
      if (o === 'auto' || o === 'scroll') return n;
    }
  }
  return null;
}

// ── Floating option list (selects can't be opened by script) ─────────────
let selBox = null;
export function closeSelectList() { selBox?.remove(); selBox = null; }

function openSelectList(sel) {
  closeSelectList();
  const box = document.createElement('div');
  box.id = 'uic-select';
  box.setAttribute('role', 'listbox');
  // Clicks inside must not reach the document-level closers that dismiss
  // popovers (settings closes itself on any outside click).
  box.addEventListener('click', ev => ev.stopPropagation());
  box.addEventListener('pointerdown', ev => ev.stopPropagation());
  [...sel.options].forEach((opt, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opt.textContent;
    if (i === sel.selectedIndex) b.classList.add('sel');
    b.addEventListener('click', () => {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      closeSelectList();
    });
    box.appendChild(b);
  });
  document.body.appendChild(box);
  const r = sel.getBoundingClientRect(), b = box.getBoundingClientRect();
  box.style.left = `${Math.round(Math.min(Math.max(4, r.left), window.innerWidth - b.width - 4))}px`;
  box.style.top  = `${Math.round(r.bottom + b.height + 8 > window.innerHeight
    ? Math.max(4, r.top - b.height - 4) : r.bottom + 4)}px`;
}

// ── Per-hand state ───────────────────────────────────────────────────────
const mk = () => ({ x: 0, y: 0, hover: null, hoverRect: null, grip: null });
const S = { L: mk(), R: mk() };

// The stage (Phase 2) plugs its card-grabbing in here — injected so this
// module never imports stage-ui (which imports this one).
let stageHooks = null;
export function setStageHooks(h) { stageHooks = h; }

function resolveGrip(el, x, y) {
  // Real clickables win even inside a pointer surface (the × on a patchbay
  // pill is a button; the socket is too, but the socket IS wiring's pointer
  // target, so it stays on the pointer path).
  if (!el.closest?.('.port, .port-src')
      && el.closest?.('button:not(.port):not(.port-src), select, a, [role="button"], .wave-btn, input[type="checkbox"]')) {
    return { kind: 'tap', el, x0: x, y0: y };
  }
  // A stage card is grabbed by its title bar; its contents stay ordinary
  // targets for the adapters below.
  const bar = stageHooks && el.closest?.('.stage-bar');
  if (bar) return { kind: 'stage', el: bar.closest('.stage-card'), x0: x, y0: y };
  const range = el.closest?.('input[type="range"]');
  if (range) {
    const r = range.getBoundingClientRect();
    return {
      kind: 'range', el: range, r,
      v0: parseFloat(range.value) || 0,
      min: parseFloat(range.min) || 0,
      max: range.max !== '' ? parseFloat(range.max) : 100,
      step: parseFloat(range.step) || 0,
      x0: x,
    };
  }
  const surf = el.closest?.(POINTER_SURFACE);
  if (surf) return { kind: 'pointer', el: surf, target: el, x0: x, y0: y };
  // A node header drags its node; give it the pointer path.
  const head = el.closest?.('.node-head');
  if (head && !el.closest('button, select, input, textarea, .wave-btn, .node-grip')) {
    return { kind: 'pointer', el: head, target: el, x0: x, y0: y };
  }
  const scroller = scrollableFrom(el);
  if (scroller) return { kind: 'scroll', el: scroller, lastY: y, x0: x, y0: y, el0: el };
  return { kind: 'tap', el, x0: x, y0: y };
}

function press(side, nx, ny) {
  const { x, y } = px(nx, ny);
  const st = S[side];
  st.x = x; st.y = y;
  const el = document.elementFromPoint(x, y);
  if (!el) { st.grip = null; return; }
  st.grip = resolveGrip(el, x, y);
  if (st.grip.kind === 'pointer') {
    synth('pointerdown', st.grip.target, PTR_ID[side], x, y);
  } else if (st.grip.kind === 'stage') {
    stageHooks?.grab(side, st.grip.el, x, y);
  }
}

function move(side, nx, ny) {
  const { x, y } = px(nx, ny);
  const st = S[side];
  const g = st.grip;
  if (g) {
    if (g.kind === 'pointer') {
      synth('pointermove', g.el, PTR_ID[side], x, y);
    } else if (g.kind === 'range') {
      const span = (g.max - g.min) || 1;
      let v = g.v0 + ((x - g.x0) / Math.max(1, g.r.width)) * span;
      if (g.step > 0) v = Math.round(v / g.step) * g.step;
      v = Math.min(g.max, Math.max(g.min, v));
      const str = String(+v.toFixed(6));
      if (g.el.value !== str) {
        g.el.value = str;
        g.el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (g.kind === 'scroll') {
      g.el.scrollTop -= (y - g.lastY) * SCROLL_RATE;
      g.lastY = y;
    } else if (g.kind === 'stage') {
      stageHooks?.drag(side, x, y);
    }
  } else {
    // Aiming: keep the hover target and its rect fresh for the overlay ring.
    const el = document.elementFromPoint(x, y);
    st.hover = el?.closest?.(INTERACTIVE) ?? null;
    st.hoverRect = st.hover?.getBoundingClientRect() ?? null;
  }
  st.x = x; st.y = y;
}

// A tap on something not otherwise special: activate it the way a mouse
// user's click would. Selects need the floating list; everything else takes
// a real .click() (a bubbling, activation-running event).
function tapActivate(el) {
  const sel = el.closest?.('select');
  if (sel) { openSelectList(sel); return; }
  closeSelectList();
  (el.closest?.('button, a, [role="button"], label, input, .wave-btn') ?? el)
    .click?.();
}

function release(side, { kind, vx = 0, vy = 0 }) {
  const st = S[side];
  const g = st.grip;
  st.grip = null;
  if (!g) return;
  if (g.kind === 'stage') {
    // Velocities arrive in frame-fractions/s; the stage flies in px/s, so
    // scale by the same gain the cursor mapping applies.
    const gain = 1 / (1 - 2 * uicontrol.margin);
    stageHooks?.drop(side, {
      kind,
      pvx: vx * window.innerWidth * gain,
      pvy: vy * window.innerHeight * gain,
    });
    return;
  }
  if (g.kind === 'pointer') {
    // The pointer surface hears its own up; a quick pinch IS its tap
    // (patchbay pills arm/inspect on exactly this pair).
    synth('pointerup', g.el, PTR_ID[side], st.x, st.y);
    return;
  }
  if (g.kind === 'range') {
    g.el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (kind === 'tap') tapActivate(g.el0 ?? g.el);
}

export function initUidriver() {
  uicontrol.setDriver({
    press, move, release,
    isHolding: side => S[side].grip !== null,
  });
}

// For the overlay: cursor px, hover rect, and whether a grip is live.
export function driverView(side) {
  const st = S[side];
  return { x: st.x, y: st.y, hoverRect: st.hoverRect, gripping: st.grip !== null };
}
