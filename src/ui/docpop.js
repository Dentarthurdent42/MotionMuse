// The card a `?` opens: one node's documentation, beside the button that
// asked for it.
//
// Deliberately small. No scrim, no spotlight, no steps: the canvas stays
// usable underneath, and the card goes away on ×, Escape, a click anywhere
// else, or the same `?` pressed again. Opening it is reading it, so it marks
// the doc read and every `?` redraws.

import { docFor, markRead, isRead, pulses, onDocsChange, APP_KEY } from './nodedocs.js';

// The open card is tracked by the NODE it belongs to, not by the button
// element: reading it redraws every \`?\`, which replaces the button it was
// opened from. Each help button carries data-doc-for with its node's id.
let pop = null, openId = null;
const anchorEl = () => (openId === null ? null
  : document.querySelector(`[data-doc-for="${CSS.escape(openId)}"]`));

function ensure() {
  if (pop) return pop;
  pop = document.createElement('div');
  pop.id = 'doc-pop';
  pop.className = 'doc-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-labelledby', 'doc-pop-title');
  pop.hidden = true;
  pop.innerHTML = `
    <div class="doc-pop-head">
      <span class="doc-pop-title" id="doc-pop-title"></span>
      <button type="button" class="doc-pop-close" aria-label="Close help">×</button>
    </div>
    <div class="doc-pop-body"></div>`;
  document.body.appendChild(pop);
  pop.querySelector('.doc-pop-close').addEventListener('click', closeDoc);
  // Presses inside are the card's own; a press anywhere else closes it.
  pop.addEventListener('pointerdown', e => e.stopPropagation());
  document.addEventListener('pointerdown', e => {
    if (pop.hidden) return;
    // Its own \`?\` toggles it on click; anything else closes it now.
    if (e.target.closest?.('[data-doc-for]')?.dataset.docFor === openId) return;
    closeDoc();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !pop.hidden) { e.stopPropagation(); closeDoc(); }
  }, true);
  window.addEventListener('resize', () => { if (!pop.hidden) place(); });
  return pop;
}

// Beside the button: below it if there is room, above it if not, and always
// inside the viewport with a margin. On a phone that is close to full width.
function place() {
  const M = 8;
  const a = anchorEl();
  const r = a && a.getClientRects().length ? a.getBoundingClientRect() : null;
  const vw = window.innerWidth, vh = window.innerHeight;
  pop.style.maxWidth = `${Math.min(340, vw - 2 * M)}px`;
  pop.style.maxHeight = `${Math.max(160, vh - 2 * M)}px`;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let x = r ? r.right - w : (vw - w) / 2;
  let y = r ? r.bottom + 6 : (vh - h) / 2;
  if (r && y + h > vh - M && r.top - 6 - h >= M) y = r.top - 6 - h;
  x = Math.max(M, Math.min(vw - w - M, x));
  y = Math.max(M, Math.min(vh - h - M, y));
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;
}

// Open the doc for a node id (or 'app'), beside that node's `?`. Pressing
// the same `?` again closes it.
export function openDoc(id) {
  const doc = docFor(id);
  if (!doc) return false;
  ensure();
  if (!pop.hidden && openId === String(id)) { closeDoc(); return false; }
  anchorEl()?.setAttribute('aria-expanded', 'false');
  openId = String(id);
  pop.querySelector('.doc-pop-title').textContent = doc.title;
  pop.querySelector('.doc-pop-body').innerHTML = doc.body;
  pop.dataset.doc = doc.key;
  pop.hidden = false;
  markRead(doc.key);                 // redraws the \`?\`s — place against the new one
  place();
  anchorEl()?.setAttribute('aria-expanded', 'true');
  return true;
}

export function closeDoc() {
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  anchorEl()?.setAttribute('aria-expanded', 'false');
  openId = null;
}

export const docOpen = () => !!pop && !pop.hidden;
export const openDocId = () => openId;

// The header's own `?`: the app as a whole — the quick start and what the
// header buttons do. Same card, same read state, same three looks.

export function initHeaderHelp() {
  const btn = document.getElementById('tour-btn');
  if (!btn) return;
  btn.dataset.docFor = APP_KEY;
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.addEventListener('click', e => { e.stopPropagation(); openDoc(APP_KEY); });
  const sync = () => {
    const doc = docFor(APP_KEY);
    const unread = !isRead(doc.key);
    btn.classList.toggle('tour-unread', unread);
    btn.classList.toggle('tour-new', pulses(doc));
    btn.title = unread ? 'How MotionMuse works — not read yet' : 'How MotionMuse works';
  };
  onDocsChange(sync);
  sync();
}
