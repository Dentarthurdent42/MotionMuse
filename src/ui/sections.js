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
}
