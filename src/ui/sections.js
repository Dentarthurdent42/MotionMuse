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
import { stepsForSection, startSectionHelp } from './tutorial.js';

const KEY = 'motionmuse-sections';
const ORDER_KEY = 'motionmuse-sec-order';
const FOLD_KEY  = 'motionmuse-sec-folded';
const HOME_KEY  = 'motionmuse-sec-home';
const MIN_H = 56;              // below this a section is unreadable, not compact

// The containers a section is allowed to live in, so a drop always lands
// somewhere that can hold it. Landscape and portrait differ in where these
// boxes sit on screen, not in what they contain, which is what lets one drag
// mean the same thing in both.
//
// A host is the PANEL, not its collapsible body.
//
// It was the body, and that made a dropped section a child of the thing the
// fold button hides: collapse SIGNALS and a MODELS panel someone had dragged
// into that column vanished with it. A section moved into a column is a
// NEIGHBOUR of that column's content, not part of it — so it goes beside the
// body, and only the body folds away.
//
// The audio column has two: #audio-panel holds the synth sections (it is what
// renderAudioPanel rebuilds), and .panel-aud holds the oscilloscope, which has
// to live outside that rebuild to keep its canvas and its click handler.
// hostUnder picks the smallest box containing the pointer, so aiming at the
// synth list targets the inner one and aiming at the scope targets the outer.
// The three columns come first: they are the outermost hosts, and everything
// else nests inside one of them. They exist so that SIGNALS, the camera and the
// AUDIO ENGINE can be moved at all — those panels used to BE the columns, which
// made them the only sections in the app that could not go anywhere. hostUnder
// picks the smallest box under the pointer, so aiming at a panel's own list
// still targets that panel rather than the column holding it.
const HOSTS = [
  ['col-l', '.col-l'],
  ['col-c', '.col-c'],
  ['col-r', '.col-r'],
  ['audio', '#audio-panel'],
  // The audio panel is now a section itself, and enhance() wraps a section's
  // content into its collapsible body — so the oscilloscope and the synth list
  // moved one level down and `.panel-aud` stopped being their parent. The body
  // is the host here for that reason, unlike the panels above: folding AUDIO
  // ENGINE *should* hide what is inside it, which is exactly what the body is.
  ['aud',   '.panel-aud > .sec-body'],
  ['cam',   '#cam-extras'],
  ['sig',   '.panel-sig'],
  ['map',   '.panel-map'],
];

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
let order   = loadMap(ORDER_KEY);
let home    = loadMap(HOME_KEY);
// Section ids that have already been given their DEFAULT_H this page load, so a
// re-render cannot re-impose it. Deliberately not persisted: the default is
// about the first sight of a section, and a fresh page should get it again.
const defaulted = new Set();

function loadMap(key) {
  try {
    const v = JSON.parse(lsGet(key) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
const saveOrder = () => lsSet(ORDER_KEY, JSON.stringify(order));
const saveHome  = () => lsSet(HOME_KEY,  JSON.stringify(home));

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
  sec.querySelector(':scope > .audio-section-label, :scope > .ph');

// The bottom fade says "there is more below". It has to lift when you reach the
// end, or a fully-scrolled list looks like it still has hidden content.
function syncEnd(body) {
  const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
  body.classList.toggle('at-end', atEnd);
}

// How tall the body would be if left alone. Measured with the height released,
// because `scrollHeight` on a box that is already taller than its content just
// reports the box — which would make the content look as tall as whatever the
// last drag left behind, and the clamp below would then never bite.
function contentHeight(body) {
  const prev = body.style.height;
  body.style.height = 'auto';
  const h = body.scrollHeight;
  if (prev) body.style.height = prev; else body.style.removeProperty('height');
  return h;
}

function natural(body) {
  body.style.removeProperty('height');
  body.classList.remove('sec-scroll');
}

export function applyHeight(sec, h) {
  const body = sec.querySelector(':scope > .sec-body');
  if (!body) return;
  if (h == null) {
    natural(body);
  } else {
    // Content height is the ceiling: past it a section is just a box of empty
    // space with its own scrollbar, which is strictly worse than the natural
    // height in every way. Rather than pinning at exactly the content height,
    // release the height altogether — a pinned section would stop growing when
    // its list gained a row, and silently start hiding it.
    const max = contentHeight(body);
    const want = Math.max(MIN_H, h);
    if (want >= max) natural(body);
    else {
      body.style.height = `${want}px`;
      body.classList.add('sec-scroll');
    }
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

    // Per-panel help, on the RIGHT of the header. Appended, so it lands after
    // whatever the header already carries (an ON/OFF pill, a count) rather than
    // shoving it along. Only where there is something to say — a `?` that opens
    // nothing is worse than no `?`.
    if (stepsForSection(id).length) {
      const help = document.createElement('button');
      help.className = 'sec-help';
      help.type = 'button';
      help.textContent = '?';
      help.title = 'What this panel does';
      help.setAttribute('aria-label', `Help for ${id}`);
      head.appendChild(help);
      help.addEventListener('click', e => {
        e.stopPropagation();            // not a fold, not the start of a drag
        startSectionHelp(id);
      });
    }

    // Collapse control. Its click must not read as a drag start — wireDrag
    // ignores presses that land on a button, so order here is incidental.
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

    const grip = document.createElement('div');
    grip.className = 'sec-grip';
    grip.title = 'Drag to resize — double-click to fit';
    sec.appendChild(grip);
    wireGrip(sec, grip, body, id);
  }
  sec.classList.add('sec');
  sec.dataset.secId = id;

  const stored = heights[id];
  if (stored !== undefined) applyHeight(sec, stored);
  else if (!defaulted.has(id)) {
    // A default height is a STARTING size, applied once. It used to be
    // re-applied on every enhance pass, and every re-render goes through one —
    // so picking a handshape from a dropdown rebuilt the audio panel and
    // snapped Chord Mode back to 220px, which read as "the container resets
    // when I use it". Worse, whether it snapped depended on how much content
    // the section happened to have the first time it was measured: applyHeight
    // releases a height that exceeds the content, so a section that was short
    // at first paint (chord mode off) went natural, grew when you switched the
    // mode on, and then got clamped by the next unrelated re-render.
    defaulted.add(id);
    applyHeight(sec, DEFAULT_H[id] ?? null);
  }
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
      // Dragged to (or past) the content height: applyHeight released the
      // height, so store nothing. Persisting the measured pixel value here
      // would freeze the section at today's content size and stop it growing.
      if (body.classList.contains('sec-scroll')) {
        heights[id] = Math.round(body.getBoundingClientRect().height);
      } else {
        delete heights[id];
      }
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
  // Before the hosts are tagged: #cam-extras is one of them, and this decides
  // which box it lives in.
  placeCamExtras();
  // Hosts are the column bodies, and a column body is itself created by
  // enhance() above — so they can only be tagged once that pass has run.
  tagHosts();
  dedupe();          // drop stale copies of anything this render recreated
  recordBirth();
  applyPlacement();  // …then put the moved ones back where the user left them
  applyOrder();
  wireMovable();
  // Geometry is only settled after layout, and hues are derived from it.
  requestAnimationFrame(() => colorSections(document));
}

// Position drives the hue, so anything that moves sections has to recolour —
// and crossing the portrait breakpoint moves the camera column's extras between
// two different parents, so that is re-decided here too.
if (typeof window !== 'undefined') {
  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { placeCamExtras(); colorSections(document); }, 120);
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

// ── Drag to rearrange, within and between columns ────────────────────────
//
// Two things are stored: which host a section lives in (`home`) and where it
// sits among that host's sections (`order`). Both are re-applied on every
// enhanceSections() pass, which is what makes them survive the audio panel
// rebuilding its innerHTML — the panel discards its children, they come back in
// their birth column, and the next pass puts them where the user left them.
//
// Placement moves real DOM nodes. An earlier version applied `order` as CSS,
// which was cheaper but cannot cross a container, and a section moved to
// another column has to actually live there: the columns are explicit grid
// cells in landscape and a plain source-order stack in portrait, so relocating
// the node is the one operation that means the same thing in both. Moving nodes
// rather than re-creating them keeps listeners and canvas contexts intact.

// In portrait the camera panel is sticky — pinned to the top of the page so the
// picture stays visible while you scroll (see the mobile block in main.css).
// Everything inside it rides along, including the dev-only EEG / EMG / MODELS
// sections, which then sit pinned under the video occupying a screen you cannot
// scroll past. They are not the picture, so in portrait they move OUT of the
// sticky panel and become its next sibling — which, in a single-column stack, is
// exactly where they already appeared. Landscape puts them back inside: #main's
// grid places each panel in an explicit cell there, and a stray child would be
// auto-placed into whatever cell happened to be free.
//
// A DOM move rather than CSS because there is no CSS for "opt out of an
// ancestor's stickiness": position:sticky pins the element's whole box, and
// this content's only problem is which box it is in.
const PORTRAIT = '(max-width: 768px)';

function placeCamExtras() {
  const ex   = document.getElementById('cam-extras');
  const cam  = document.querySelector('.panel-cam');
  const main = document.getElementById('main');
  if (!ex || !cam || !main) return;
  const portrait = window.matchMedia?.(PORTRAIT).matches ?? false;
  const want = portrait ? main : cam;
  if (ex.parentElement === want) return;
  if (portrait) cam.after(ex); else cam.appendChild(ex);
}

function tagHosts() {
  for (const [id, sel] of HOSTS) {
    const el = document.querySelector(sel);
    if (el) el.dataset.secHost = id;
  }
}

const hostSecs = host =>
  [...host.children].filter(el => el.classList.contains('sec'));

const visibleHosts = () =>
  [...document.querySelectorAll('[data-sec-host]')].filter(el => el.getClientRects().length);

// A re-render recreates sections the user has since moved away, so the same id
// exists twice for a moment: the fresh copy in its birth column and the moved,
// now-stale one. The fresh copy wins — it carries the state that caused the
// re-render — and the relocated one is dropped before placement runs again.
function dedupe() {
  const seen = new Map();
  for (const el of document.querySelectorAll('.sec[data-sec-id]')) {
    const id = el.dataset.secId;
    const prev = seen.get(id);
    if (!prev) { seen.set(id, el); continue; }
    const stale = prev.dataset.secMoved ? prev : el;
    stale.remove();
    seen.set(id, stale === prev ? el : prev);
  }
}

// Where a section was born — which host its markup puts it in, and where it
// sat among that host's siblings. Recorded the first time an id is seen, so
// "dragged back to where it started" can clear the stored entry instead of
// pinning the section there forever, and so a section this build ADDED can be
// slotted in beside the neighbour it was authored next to (see `rank` below).
//
// The index is captured on the first pass of a page load, which runs before
// applyOrder has touched anything — so it really is markup order. Keyed by id
// in a module map rather than a data attribute, because a re-rendered panel
// gets fresh elements and would otherwise re-record its position from the
// already-reordered DOM.
const authored = new Map();
function recordBirth() {
  for (const host of document.querySelectorAll('[data-sec-host]')) {
    hostSecs(host).forEach((el, i) => {
      if (!el.dataset.secBirth) el.dataset.secBirth = host.dataset.secHost;
      const id = el.dataset.secId;
      if (id && !authored.has(id)) authored.set(id, i);
    });
  }
}

// A panel that is itself a section owns a resize grip as its last child;
// appending past it would leave the grip floating above whatever was dropped.
const addTo = (host, el) => {
  const grip = [...host.children].find(c => c.classList.contains('sec-grip'));
  if (grip) host.insertBefore(el, grip); else host.appendChild(el);
};

export function applyPlacement() {
  for (const el of document.querySelectorAll('.sec[data-sec-id]')) {
    const want = home[el.dataset.secId];
    if (!want) continue;
    const host = document.querySelector(`[data-sec-host="${want}"]`);
    if (!host || el.parentElement === host) continue;
    el.dataset.secMoved = '1';
    addTo(host, el);
  }
}

export function applyOrder() {
  document.querySelectorAll('[data-sec-host]').forEach(orderHost);
}

// Rank for a section the stored order has never seen: sit it just after its
// nearest authored predecessor that HAS a rank, or just before its nearest
// authored successor if it was authored first. The epsilon keeps two new
// neighbours in their authored order rather than tied.
function inherited(el, kids) {
  const mine = authored.get(el.dataset.secId);
  if (!Number.isFinite(mine)) return 1e6;
  let before = null, after = null;
  for (const k of kids) {
    const a = authored.get(k.dataset.secId);
    const o = order[k.dataset.secId];
    if (!Number.isFinite(a) || !Number.isFinite(o)) continue;
    if (a < mine && (!before || a > before.a)) before = { a, o };
    if (a > mine && (!after  || a < after.a))  after  = { a, o };
  }
  const eps = mine * 1e-6;
  if (before) return before.o + 0.5 + eps;
  if (after)  return after.o  - 0.5 + eps;
  return mine;
}

function orderHost(host) {
  const kids = hostSecs(host);
  // Earlier builds wrote CSS `order`; left behind it would fight the DOM order
  // this now relies on.
  kids.forEach(el => el.style.removeProperty('order'));
  if (kids.length < 2) return;
  // A section with no stored index is one this build ADDED — the stored order
  // predates it. It used to sort to 1e6, i.e. the bottom of its host, so every
  // new panel was exiled to the end for anyone who had ever dragged anything
  // in that column: the microphone ships authored above EEG Input and landed
  // under the patchbay. Instead it inherits a rank from the sibling it was
  // authored next to, so it appears where the markup puts it and the user's
  // arrangement of everything else is untouched.
  const rank = el => {
    const i = order[el.dataset.secId];
    return Number.isFinite(i) ? i : inherited(el, kids);
  };
  const want = kids.slice().sort((a, b) => rank(a) - rank(b));
  if (want.every((el, i) => el === kids[i])) return;
  let prev = null;
  for (const el of want) {
    if (prev) prev.after(el); else host.insertBefore(el, kids[0]);
    prev = el;
  }
}

// Renumber a host's sections from their current positions, so a map built by
// one drag stays coherent for the next.
function commitOrder(host) {
  hostSecs(host).forEach((el, i) => { order[el.dataset.secId] = i; });
  saveOrder();
}

// Which host the pointer is over. Hit-tested against measured rects rather than
// elementFromPoint: the dragged section sits under the cursor for the whole
// drag, and the usual fix — pointer-events:none on it — would also disable the
// element holding the pointer capture that is driving the drag.
function hostUnder(x, y) {
  let best = null, bestArea = Infinity;
  for (const h of visibleHosts()) {
    const r = h.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const a = r.width * r.height;
    if (a < bestArea) { best = h; bestArea = a; }
  }
  return best;
}

// Every section sitting directly in a host is draggable. A section that IS a
// column (the panels themselves) lives in #main, which is not a host, so it
// stays put — there is nothing to rearrange it among.
function wireMovable() {
  for (const host of document.querySelectorAll('[data-sec-host]')) {
    for (const sec of hostSecs(host)) {
      if (sec.dataset.reorder) continue;      // already wired
      const head = headOf(sec);
      if (!head) continue;
      sec.dataset.reorder = '1';
      wireDrag(sec, head);
    }
  }
}

function wireDrag(sec, head) {
  head.addEventListener('pointerdown', e => {
    // Controls inside a header keep their own behaviour — a drag that starts
    // on the ON/OFF pill would make the pill unclickable.
    if (e.target.closest('button, select, input, textarea, .wave-btn, .sec-grip')) return;
    if (e.button != null && e.button !== 0) return;

    const startX = e.clientX, startY = e.clientY;
    let dragging = false, marked = null, target = null;
    head.setPointerCapture(e.pointerId);

    const clearMark = () => {
      marked?.classList.remove('drop-before', 'drop-after', 'drop-into');
      marked = null;
    };

    const move = ev => {
      // A few pixels of slop, so a click on the header is still a click. Both
      // axes now: a move into the next column is mostly horizontal, and a
      // vertical-only threshold left those drags feeling dead until the pointer
      // happened to wander far enough up or down.
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      if (!dragging) {
        dragging = true;
        sec.classList.add('dragging');
        document.body.classList.add('reordering');
      }
      const host = hostUnder(ev.clientX, ev.clientY);
      if (!host) return;      // off every column — keep the last valid target
      clearMark();
      const sibs = hostSecs(host).filter(el => el !== sec && el.getClientRects().length);
      // DOM order is visual order now that placement moves nodes, so the first
      // sibling whose midpoint is below the pointer is the insertion point.
      const before = sibs.find(el => {
        const r = el.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      }) ?? null;
      target = { host, before };
      if (before) { marked = before; before.classList.add('drop-before'); }
      else if (sibs.length) { marked = sibs[sibs.length - 1]; marked.classList.add('drop-after'); }
      else { marked = host; host.classList.add('drop-into'); }
    };

    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      document.body.classList.remove('reordering');
      sec.classList.remove('dragging');
      clearMark();
      if (!dragging || !target) return;
      const { host, before } = target;
      if (before) host.insertBefore(sec, before); else addTo(host, sec);
      const hostId = host.dataset.secHost;
      if (hostId === sec.dataset.secBirth) {
        delete home[sec.dataset.secId];
        delete sec.dataset.secMoved;
      } else {
        home[sec.dataset.secId] = hostId;
        sec.dataset.secMoved = '1';
      }
      saveHome();
      commitOrder(host);
      colorSections();          // hues follow position, so they move too
    };

    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
}
