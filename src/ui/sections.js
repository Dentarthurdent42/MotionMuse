// Resizable, individually scrollable sections.
//
// Every section in the app already has the same shape — a header element
// followed by its content — so this enhances them at runtime rather than
// asking a dozen template strings across three files to grow the same
// boilerplate. A section added later gets the treatment for free, which
// matters in a UI that changes every week: the alternative is markup that
// silently misses out until someone remembers.
//
// What each enhanced section gains:
//   * a visible container — its own border and header strip, so it reads as a
//     distinct thing rather than a run of text in a long column
//   * a body that scrolls on its own once it has a height, so a long list
//     (signals, gestures, sliders) can be paged through without moving the
//     rest of the panel
//   * a grip along the bottom edge to set that height; double-click clears it
//     back to natural height. Heights persist per section id.
//
// Sections start at their natural height with NO scroller, exactly as before,
// unless a default is declared or the user drags one. Imposing scrollbars on
// every section by default would trade one annoyance for a worse one.

import { lsGet, lsSet } from '../storage.js';

const KEY = 'motionmuse-sections';
const ORDER_KEY = 'motionmuse-sec-order';
const FOLD_KEY  = 'motionmuse-sec-folded';
const MIN_H = 56;              // below this a section is unreadable, not compact

// Sections whose content is an open-ended list get a default height, because
// "scroll the list" is the whole point of them. Everything else stays natural.
// Deliberately excludes the column-level panels (signals, patchbay). Those
// already fill their column and scroll inside it, so pinning them to a default
// height would strand empty space below them in landscape. Their grip still
// works if you want to pin one.
const DEFAULT_H = {
  gestures: 220,
  'chord-mode': 220,
  sliders: 260,
};

let heights = load();
let order   = loadOrder();

function loadOrder() {
  try {
    const v = JSON.parse(lsGet(ORDER_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
const saveOrder = () => lsSet(ORDER_KEY, JSON.stringify(order));

// Collapsed sections, by id. Separate from the height map: a folded section
// still remembers how tall it was, so unfolding restores the size you chose
// rather than resetting it.
let folded = (() => {
  try { return new Set(JSON.parse(lsGet(FOLD_KEY) || '[]')); } catch { return new Set(); }
})();
const saveFolded = () => lsSet(FOLD_KEY, JSON.stringify([...folded]));

export function setFolded(sec, on) {
  const id = sec.dataset.secId;
  sec.classList.toggle('folded', on);
  const btn = sec.querySelector(':scope > .sec-fold');
  if (btn) btn.setAttribute('aria-expanded', String(!on));
  if (on) folded.add(id); else folded.delete(id);
  saveFolded();
}

function load() {
  try {
    const v = JSON.parse(lsGet(KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
const save = () => lsSet(KEY, JSON.stringify(heights));

// A section's id: an explicit data-sec wins, otherwise the header's own text.
// Headers often carry controls too (an ON/OFF pill, a count), so only the
// leading text node is used — a title that changes because a toggle flipped
// would otherwise orphan the stored height.
function sectionId(sec, head) {
  if (sec.dataset.sec) return sec.dataset.sec;
  const raw = [...head.childNodes]
    .filter(n => n.nodeType === Node.TEXT_NODE)
    .map(n => n.textContent).join(' ').trim();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
}

const headOf = sec =>
  sec.querySelector(':scope > .audio-section-label, :scope > .ph, :scope > .src-tabs');

// The bottom fade says "there is more below". It has to lift when you reach the
// end, or a fully-scrolled list looks like it still has hidden content.
function syncEnd(body) {
  const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
  body.classList.toggle('at-end', atEnd);
}

export function applyHeight(sec, h) {
  const body = sec.querySelector(':scope > .sec-body');
  if (!body) return;
  if (h == null) {
    body.style.removeProperty('height');
    body.classList.remove('sec-scroll');
  } else {
    body.style.height = `${Math.max(MIN_H, h)}px`;
    body.classList.add('sec-scroll');
  }
  syncEnd(body);
}

// Wrap one section's content and give it a grip. Idempotent: re-running over
// already-enhanced markup only re-applies the stored height, which is what
// makes this safe to call after every re-render.
function enhance(sec) {
  const head = headOf(sec);
  if (!head) return;
  const id = sectionId(sec, head);
  if (!id) return;

  let body = sec.querySelector(':scope > .sec-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'sec-body';
    // Everything after the header becomes the body. Moving nodes rather than
    // re-creating them keeps any listeners and canvas contexts intact.
    let n = head.nextSibling;
    while (n) { const next = n.nextSibling; body.appendChild(n); n = next; }
    sec.appendChild(body);
    body.addEventListener('scroll', () => syncEnd(body), { passive: true });
    // Content can change height without any scrolling (a list grows, a toggle
    // reveals a row), which changes whether anything is hidden.
    new ResizeObserver(() => syncEnd(body)).observe(body);

    // Collapse control, before the drag wiring so its click is not read as a
    // drag start (wireDrag ignores presses that land on a button).
    const fold = document.createElement('button');
    fold.className = 'sec-fold';
    fold.type = 'button';
    fold.title = 'Collapse / expand';
    fold.setAttribute('aria-expanded', 'true');
    head.insertBefore(fold, head.firstChild);
    fold.addEventListener('click', e => {
      e.stopPropagation();
      setFolded(sec, !sec.classList.contains('folded'));
    });

    // Only sections stacked inside a scrolling column are reorderable; a
    // section that IS a column has nothing to reorder among.
    if (sec.classList.contains('audio-section')) {
      sec.dataset.reorder = '1';
      wireDrag(sec, head);
    }

    const grip = document.createElement('div');
    grip.className = 'sec-grip';
    grip.title = 'Drag to resize — double-click to fit';
    sec.appendChild(grip);
    wireGrip(sec, grip, body, id);
  }
  sec.classList.add('sec');
  sec.dataset.secId = id;

  const stored = heights[id];
  applyHeight(sec, stored === undefined ? DEFAULT_H[id] ?? null : stored);
  if (folded.has(id)) setFolded(sec, true);
}

function wireGrip(sec, grip, body, id) {
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();          // never start a panel drag underneath
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = body.getBoundingClientRect().height;
    document.body.classList.add('resizing-sec');
    const move = ev => applyHeight(sec, startH + (ev.clientY - startY));
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing-sec');
      heights[id] = Math.round(body.getBoundingClientRect().height);
      save();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  // Double-click releases the height entirely — back to fitting the content,
  // which is the only way to discover how tall a list actually wants to be.
  grip.addEventListener('dblclick', e => {
    e.preventDefault();
    delete heights[id];
    save();
    applyHeight(sec, DEFAULT_H[id] ?? null);
  });
}

// Enhance every section under `root`. Safe (and cheap) to call after any
// re-render; panels that rebuild their innerHTML lose the wrappers and get
// them back here, with their stored heights.
export function enhanceSections(root = document) {
  root.querySelectorAll('.audio-section').forEach(enhance);
  root.querySelectorAll('[data-sec]').forEach(enhance);
  applyOrder(document);
  // Geometry is only settled after layout, and hues are derived from it.
  requestAnimationFrame(() => colorSections(document));
}

// Position drives the hue, so anything that moves sections has to recolour.
if (typeof window !== 'undefined') {
  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => colorSections(document), 120);
  });
}


// ── Position colour-coding ───────────────────────────────────────────────
//
// A hue per section, derived from where it actually is: the column sets the
// base and vertical order shifts it. Derived from measured geometry rather
// than declared per section, because the layout is rearrangeable — a hardcoded
// hue would lie the moment a section moved, and lying is worse than absent.
//
// Hues are spaced around the wheel by column so neighbouring columns are
// obviously different, then walked slowly within a column so a section's
// neighbours are close but distinguishable.
const COLUMN_HUES = [200, 280, 45, 140, 330];
const STEP_WITHIN = 22;

export function colorSections(root = document) {
  const secs = [...root.querySelectorAll('.sec, .sig-sec')]
    .filter(el => el.getClientRects().length);
  if (!secs.length) return;
  // Group by column using each section's left edge. Exact equality is wrong
  // (margins, nesting), so cluster anything within 40px into one column.
  const cols = [];
  for (const el of secs) {
    const r = el.getBoundingClientRect();
    let col = cols.find(c => Math.abs(c.x - r.left) < 40);
    if (!col) cols.push(col = { x: r.left, items: [] });
    col.items.push({ el, top: r.top });
  }
  cols.sort((a, b) => a.x - b.x);
  cols.forEach((col, ci) => {
    col.items.sort((a, b) => a.top - b.top);
    const base = COLUMN_HUES[ci % COLUMN_HUES.length];
    col.items.forEach(({ el }, i) => {
      el.style.setProperty('--hue', String((base + i * STEP_WITHIN) % 360));
    });
  });
}

// ── Drag to reorder ──────────────────────────────────────────────────────
//
// Order is stored as a map of id -> index and applied as CSS `order`, not by
// moving DOM nodes. That is the whole reason it survives: the audio panel
// rebuilds its innerHTML on any structural change, which would discard a
// reordered DOM instantly. A stored order is simply re-applied by the next
// enhanceSections() pass.
//
// Scope is deliberately within a container: sections reorder among their
// siblings. Dragging one between columns would have to rewrite the landscape
// grid placement AND the portrait source order, which are two different
// layouts — a change worth making on its own terms, not smuggled in here.
export function applyOrder(root = document) {
  root.querySelectorAll('.sec[data-sec-id]').forEach(el => {
    const i = order[el.dataset.secId];
    if (Number.isFinite(i)) el.style.order = String(i);
    else el.style.removeProperty('order');
  });
}

function siblingsOf(sec) {
  return [...sec.parentElement.children]
    .filter(el => el.classList.contains('sec') && el.getClientRects().length);
}

// Renumber every sibling from its current visual position, so an order map
// built from one drag stays coherent for the next.
function commitOrder(list) {
  list.forEach((el, i) => { order[el.dataset.secId] = i; el.style.order = String(i); });
  saveOrder();
}

function wireDrag(sec, head) {
  head.addEventListener('pointerdown', e => {
    // Controls inside a header keep their own behaviour — a drag that starts
    // on the ON/OFF pill would make the pill unclickable.
    if (e.target.closest('button, select, input, textarea, .wave-btn, .sec-grip')) return;
    if (e.button != null && e.button !== 0) return;

    const startY = e.clientY;
    let dragging = false, marked = null;
    head.setPointerCapture(e.pointerId);

    const move = ev => {
      // A few pixels of slop, so a click on the header is still a click.
      if (!dragging && Math.abs(ev.clientY - startY) < 5) return;
      if (!dragging) {
        dragging = true;
        sec.classList.add('dragging');
        document.body.classList.add('reordering');
      }
      const sibs = siblingsOf(sec).filter(el => el !== sec);
      marked?.el.classList.remove('drop-before', 'drop-after');
      marked = null;
      for (const el of sibs) {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
          const after = ev.clientY > r.top + r.height / 2;
          el.classList.add(after ? 'drop-after' : 'drop-before');
          marked = { el, after };
          break;
        }
      }
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      document.body.classList.remove('reordering');
      sec.classList.remove('dragging');
      if (marked) {
        marked.el.classList.remove('drop-before', 'drop-after');
        const list = siblingsOf(sec)
          .sort((a, b) => (+a.style.order || 0) - (+b.style.order || 0));
        // Re-derive from visual position when no order has been set yet.
        const visual = siblingsOf(sec).sort((a, b) =>
          a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const seq = (list.every(el => el.style.order) ? list : visual).filter(el => el !== sec);
        const at = seq.indexOf(marked.el) + (marked.after ? 1 : 0);
        seq.splice(at, 0, sec);
        commitOrder(seq);
        colorSections();          // hues follow position, so they move too
      }
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
}
