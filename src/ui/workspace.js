// The workspace: one pan-and-zoom canvas on which everything is a node.
//
// The old interface was three columns of sections that could be dragged
// between the columns. That was a layout with a little freedom in it; this
// is the other way round. The canvas is infinite, every section is a node
// with a position, every signal and parameter is a node with a socket, and
// cables run between sockets across the whole surface — the way a node
// editor works in Blender, Unreal or TouchDesigner rather than the way a
// settings page does.
//
// What this module owns:
//
//   • the viewport: pan with a drag on empty canvas (or the middle button
//     anywhere), zoom with the wheel or a pinch, FIT to see everything;
//   • node shells: every node has the same chrome — a header that drags it,
//     a caret that folds it, a pin that holds it on screen, an × — and a body
//     that is whatever the node is;
//   • adoption: the panels are still authored as sections (index.html) or
//     rendered as sections (audio-ui.js); any section that appears in the
//     staging area is picked up and BECOMES a node, so a panel added next
//     week is a node without anyone remembering to make it one;
//   • groups: a frame around any set of nodes, dragged as one, collapsed
//     into a single node whose sockets are the members' outward-facing
//     ones. INPUTS and AUDIO ENGINE ship as groups; the patch is one too;
//   • the add menu (right-click, double-click, or + NODE), TIDY (a layered
//     layout from dagre), and persistence of all of it.
//
// What it does not own: sockets and cables. Those are the patchbay's
// (ui/mapper-ui.js), which registers itself here as the "patch source" and
// renders the sig / par / fn node bodies. This module never imports it —
// the dependency runs one way.
//
// The model (positions, membership, what a collapsed group exposes) is
// src/workspace.js, kept DOM-free so it is unit-tested.

import { html, render, nothing } from '../../vendor/lit-html.js';
import { zoom, zoomIdentity, select } from '../../vendor/d3-zoom.js';
import { graphlib, layout as dagreLayout } from '../../vendor/dagre.js';
import * as M from '../workspace.js';
import { lsGet, lsSet, lsDel } from '../storage.js';
import { isRecord } from '../is.js';
import { stepsForSection, startSectionHelp } from './tutorial.js';

export const LS_KEY = 'motionmuse-workspace';

// Widths a panel starts at. The camera wants room for a 4:3 picture; the
// lists want less. Anything unlisted takes the default.
const DEFAULT_W = {
  camera: 440, mic: 440, eeg: 440, emg: 440, models: 440,
  'shader-visual-output': 270, output: 340,
};
const PANEL_W = 340;
// Panels whose content is an open-ended list start with a height, so the
// list scrolls inside the node instead of running down the canvas.
const DEFAULT_H = { 'gesture-mode': 300 };
const MIN_W = 180, MIN_H = 72;
const COL_X = [0, 480, 770];      // where the three default columns start
const GAP = 12;
// A group's members stack in columns no taller than this, wrapping to the
// right: the audio engine is thirteen nodes, and one column of them is a
// strip four screens tall that FIT can only show as a smear.
const COL_MAX_H = 980;
const FRAME_PAD = 10, FRAME_HEAD = 26;

// Every node shell is watched for size changes: content grows (a web font
// lands, a list gains rows, a mode switches on) after a node has been placed
// by its measured height, and nodes placed by the canvas are re-stacked so
// they never come to overlap. See restack().
const sizeWatcher = globalThis.ResizeObserver ? new ResizeObserver(() => scheduleRestack()) : null;
let restackTimer = null;
function scheduleRestack() {
  clearTimeout(restackTimer);
  restackTimer = setTimeout(restack, 60);
}

const state = M.createState(parseSaved());
// Whether this is a first visit (nothing stored): only then do the shipped
// groups get created. A store that has nodes in it is someone's layout.
const startedEmpty = state.nodes.size === 0;
const els = new Map();            // node id → shell element
const selected = new Set();
const renderers = new Map();      // kind → (node, shell) => void, from the patchbay
const dirtyCbs = [];              // "cables need redrawing"
const selectCbs = [];             // "the selection changed"
let patch = null;                 // the patch source (mapper-ui)
let ws, world, nodesEl, dock, cablesSvg, boxEl, menuEl;
let zoomBehavior = null;
let view = state.view;
let saveTimer = null;

function parseSaved() {
  try {
    const v = JSON.parse(lsGet(LS_KEY) || 'null');
    return isRecord(v) ? v : null;
  } catch { return null; }
}

const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => lsSet(LS_KEY, JSON.stringify(M.serialize(state))), 150);
};
export const serializeLayout = () => M.serialize(state);

// ── Registration from the patchbay ───────────────────────────────────────
export function registerRenderer(kind, fn) { renderers.set(kind, fn); }
export function setPatchSource(src) { patch = src; }
export function onCablesDirty(cb) { dirtyCbs.push(cb); }
export function onSelect(cb) { selectCbs.push(cb); }
const dirty = () => dirtyCbs.forEach(cb => cb());

// ── Coordinates ──────────────────────────────────────────────────────────
export const viewTransform = () => view;
export function toWorld(cx, cy) {
  const r = ws.getBoundingClientRect();
  return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
}
export function toScreen(wx, wy) {
  const r = ws.getBoundingClientRect();
  return { x: wx * view.k + view.x + r.left, y: wy * view.k + view.y + r.top };
}
// The world-space rectangle a client rect covers — for sockets, whose
// positions are only known by measuring them.
export function rectToWorld(r) {
  const a = toWorld(r.left, r.top), b = toWorld(r.right, r.bottom);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

// A node's box in world units. Pinned nodes live on the screen, so theirs is
// measured back through the transform; frames use their computed size.
export function measure(id) {
  const n = state.nodes.get(id), el = els.get(id);
  if (!n || !el) return null;
  if (n.pinned) return rectToWorld(el.getBoundingClientRect());
  const w = n.kind === 'group' && !n.collapsed ? (n._fw ?? el.offsetWidth) : el.offsetWidth;
  const h = n.kind === 'group' && !n.collapsed ? (n._fh ?? el.offsetHeight) : el.offsetHeight;
  return { x: n.x, y: n.y, w, h };
}

export const nodeEl = id => els.get(id) ?? null;
export const getNode = id => M.get(state, id);
export const allNodes = () => [...state.nodes.values()];
export const ownerOf = id => M.visualOwner(state, id);
export const isNodeShown = id => M.isShown(state, id) && !!els.get(id) && els.get(id).getClientRects().length > 0;
export const selectedIds = () => [...selected];

// The element carrying a socket on screen: the node's own, or the collapsed
// group standing in for it. Null when the socket is inside a collapsed group
// that does not expose it (an internal cable).
export function portEl(nodeId, side, key) {
  const owner = ownerOf(nodeId);
  const el = els.get(owner);
  if (!el) return null;
  return el.querySelector(`.port[data-side="${side}"][data-key="${CSS.escape(key)}"]`);
}

// ── Shells ───────────────────────────────────────────────────────────────

const isVisible = el => !!el && el.getClientRects().length > 0;
const headOf = el => el.querySelector(':scope > .node-head');

// A hue per node, from its id: stable, so the same panel is the same colour
// wherever it is dragged — you can aim at the amber one without reading it.
function hueOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

// The controls every header carries, in the same places on every node.
function chromeButtons(node, head) {
  if (!head.querySelector(':scope > .sec-fold') && node.kind === 'panel') {
    const fold = document.createElement('button');
    fold.className = 'sec-fold'; fold.type = 'button';
    fold.title = 'Collapse / expand'; fold.setAttribute('aria-expanded', 'true');
    head.insertBefore(fold, head.firstChild);
    fold.addEventListener('click', e => { e.stopPropagation(); setFolded(node.id, !node.folded); });
  }
  let tail = head.querySelector(':scope > .node-tail');
  if (!tail) {
    tail = document.createElement('span');
    tail.className = 'node-tail';
    head.appendChild(tail);
  }
  tail.innerHTML = '';
  if (node.kind === 'panel' && stepsForSection(M.keyOf(node.id)).length) {
    const help = document.createElement('button');
    help.className = 'sec-help'; help.type = 'button'; help.textContent = '?';
    help.title = 'What this node does';
    help.setAttribute('aria-label', `Help for ${M.keyOf(node.id)}`);
    help.addEventListener('click', e => { e.stopPropagation(); startSectionHelp(M.keyOf(node.id)); });
    tail.appendChild(help);
  }
  if (node.kind !== 'group') {
    const pin = document.createElement('button');
    pin.className = 'node-pin'; pin.type = 'button';
    pin.title = 'Pin to the screen — stays put while you pan the canvas';
    pin.setAttribute('aria-pressed', String(node.pinned));
    pin.textContent = '⌖';
    pin.addEventListener('click', e => { e.stopPropagation(); setPinned(node.id, !node.pinned); });
    tail.appendChild(pin);
  }
  const close = document.createElement('button');
  close.className = 'node-close'; close.type = 'button';
  close.textContent = '×';
  close.title = node.kind === 'group' ? 'Ungroup — the members stay'
              : node.kind === 'panel' ? 'Close — bring it back from + NODE'
              : 'Remove this node and its cables';
  close.setAttribute('aria-label', close.title);
  close.addEventListener('click', e => { e.stopPropagation(); closeNode(node.id); });
  tail.appendChild(close);
}

// Turn a section element (authored, or rendered by a panel) into a node
// shell in place: its header becomes the drag handle, everything after it
// becomes the body. Moving nodes rather than re-creating them keeps every
// listener and canvas context intact — the same reason the old sections.js
// worked this way.
function shellFromSection(sec, node) {
  sec.classList.add('node', 'node-panel', 'sec');
  sec.dataset.node = node.id;
  sec.dataset.secId = M.keyOf(node.id);
  sec.style.setProperty('--hue', String(hueOf(node.id)));
  const head = sec.querySelector(':scope > .audio-section-label, :scope > .ph, :scope > .node-head');
  if (!head) return;
  head.classList.add('node-head');
  // The title is a bare text node in the authored headers. Wrapping it makes
  // it an element that can shrink and ellipsize instead of shoving the
  // header's controls out of the node.
  if (!head.querySelector(':scope > .sec-title')) {
    const lead = [];
    for (const n of head.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) { lead.push(n); continue; }
      break;
    }
    if (lead.some(n => n.textContent.trim())) {
      const span = document.createElement('span');
      span.className = 'sec-title node-title';
      head.insertBefore(span, lead[0]);
      lead.forEach(n => span.appendChild(n));
    }
  }
  let body = sec.querySelector(':scope > .node-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'node-body sec-body';
    let n = head.nextSibling;
    while (n) { const next = n.nextSibling; body.appendChild(n); n = next; }
    sec.appendChild(body);
  }
  chromeButtons(node, head);
  if (!sec.querySelector(':scope > .node-grip')) {
    const grip = document.createElement('div');
    grip.className = 'node-grip sec-grip';
    grip.title = 'Drag to resize — double-click to fit the content';
    sec.appendChild(grip);
  }
}

// A section's id: an explicit data-sec wins, otherwise the header's text.
export function sectionIdOf(sec) {
  if (sec.dataset.sec) return sec.dataset.sec;
  const head = sec.querySelector(':scope > .audio-section-label, :scope > .ph');
  if (!head) return null;
  const titled = head.querySelector(':scope > .sec-title');
  const raw = (titled ? titled.textContent : [...head.childNodes]
    .filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' ')).trim();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
}

function makeShell(node) {
  const el = document.createElement('div');
  el.className = `node node-${node.kind}`;
  el.dataset.node = node.id;
  el.style.setProperty('--hue', String(hueOf(node.id)));
  if (node.kind === 'group') renderGroup(node, el);
  else renderers.get(node.kind)?.(node, el);
  const head = headOf(el);
  if (head) chromeButtons(node, head);
  return el;
}

// Group shells are lit templates: the port lists change with every cable.
function renderGroup(node, el) {
  const ports = node.collapsed && patch
    ? M.exposedPorts(state, node.id, patch.sockets(), patch.links())
    : { ins: [], outs: [] };
  const port = (s, side) => html`
    <button class="port port-${side}" type="button"
            data-node=${node.id} data-owner=${s.node} data-side=${side} data-key=${s.key}
            style="--wire:${patch?.socketColor(s) ?? 'var(--dim)'}"
            title=${patch?.socketLabel(s) ?? s.key}
            aria-label=${`${side === 'in' ? 'Input' : 'Output'} ${patch?.socketLabel(s) ?? s.key} of ${node.title}`}></button>
    <span class="port-lbl">${patch?.socketLabel(s) ?? s.key}</span>`;
  render(html`
    <div class="node-head group-head">
      <button class="group-toggle" type="button" aria-expanded=${String(!node.collapsed)}
              title=${node.collapsed ? 'Expand the group' : 'Collapse into one node'}
              @click=${e => { e.stopPropagation(); setCollapsed(node.id, !node.collapsed); }}></button>
      <span class="sec-title node-title group-title" title="Double-click to rename"
            @dblclick=${e => { e.stopPropagation(); renameGroup(node.id); }}>${node.title}</span>
    </div>
    ${node.collapsed ? html`
      <div class="group-ports">
        <div class="ports-in">${ports.ins.map(s => html`<div class="port-row">${port(s, 'in')}</div>`)}</div>
        <div class="ports-out">${ports.outs.map(s => html`<div class="port-row">${port(s, 'out')}</div>`)}</div>
      </div>` : nothing}`, el);
  el.classList.toggle('collapsed', node.collapsed);
}

function renameGroup(id) {
  const n = state.nodes.get(id), el = els.get(id);
  const title = el?.querySelector('.group-title');
  if (!n || !title) return;
  const input = document.createElement('input');
  input.type = 'text'; input.value = n.title; input.className = 'group-rename';
  input.setAttribute('aria-label', 'Group name');
  title.replaceWith(input);
  input.focus(); input.select();
  const done = commit => {
    if (commit) { const v = input.value.trim(); if (v) n.title = v.toUpperCase(); }
    renderGroup(n, el); chromeButtons(n, headOf(el)); save();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') done(true);
    else if (e.key === 'Escape') done(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => done(true));
  input.addEventListener('pointerdown', e => e.stopPropagation());
}

// ── Adoption ─────────────────────────────────────────────────────────────
//
// Every section under `root` that is not yet a node becomes one. Safe to
// call after any re-render: a panel that rebuilt its innerHTML has fresh
// section elements in the staging area, and the stale shells they replace
// are dropped — positions live in the model, not in the elements.
export function adoptSections(root = document) {
  const fresh = [];
  const candidates = [...root.querySelectorAll('.audio-section, [data-sec]')]
    .filter(el => !el.closest('.node-body'))   // nested content is content
    .filter(el => !els.has(el.dataset.node ?? '') || els.get(el.dataset.node) !== el);
  for (const sec of candidates) {
    const key = sectionIdOf(sec);
    if (!key) continue;
    const id = M.nodeId('panel', key);
    const old = els.get(id);
    if (old && old !== sec) old.remove();
    const existed = state.nodes.has(id);
    const node = M.ensure(state, id, { w: DEFAULT_W[key] ?? PANEL_W, h: DEFAULT_H[key] ?? null });
    if (!existed) fresh.push(node);
    shellFromSection(sec, node);
    els.set(id, sec);
    (node.pinned ? dock : nodesEl).appendChild(sec);
    sizeWatcher?.observe(sec);
    // Sized before it is measured: placement stacks nodes by their boxes,
    // and a list that starts with a height must be measured AT that height.
    applyNode(node, sec);
  }
  ensureDefaultGroups(fresh);
  placeDefaults();
  syncWorkspace();
  return fresh.map(n => n.id);
}

// The groups the app ships with. Created once, on a fresh store; a user who
// ungroups them is not second-guessed on the next load. A node the store has
// never seen that belongs to a shipped group joins it, if the group is there.
function ensureDefaultGroups(freshNodes) {
  for (const g of M.DEFAULT_GROUPS) {
    if (startedEmpty && !state.nodes.has(g.id)) M.ensure(state, g.id, { title: g.title });
  }
  for (const n of freshNodes) {
    if (n.parent) continue;
    const g = M.DEFAULT_GROUPS.find(d => d.members.includes(n.id));
    if (g && state.nodes.has(g.id)) n.parent = g.id;
  }
}

// ── Placement of nodes the store has never placed ────────────────────────

const shellH = id => els.get(id)?.offsetHeight ?? 120;
const shellW = id => els.get(id)?.offsetWidth ?? PANEL_W;

// Members of a group stack in columns inside its frame, continuing under
// whatever is already there — the audio engine's sections arrive in a later
// render than its oscilloscope, and they belong under it, not beside it.
// Returns the bottom edge of what was placed.
function placeMembers(g, members) {
  const had = M.children(state, g.id).filter(m => m.placed && !m.pinned && isVisible(els.get(m.id)));
  const top = had.length ? Math.min(...had.map(m => m.y)) : g.y + FRAME_HEAD + FRAME_PAD;
  let mx = had.length ? Math.max(...had.map(m => m.x)) : g.x + FRAME_PAD;
  const col = had.filter(m => Math.abs(m.x - mx) < 40);
  let my = col.length ? Math.max(...col.map(m => m.y + shellH(m.id))) + GAP : top;
  let colW = col.length ? Math.max(...col.map(m => shellW(m.id))) : 0;
  let bottom = my;
  for (const m of members) {
    const shown = isVisible(els.get(m.id));
    if (shown && my > top && my + shellH(m.id) - top > COL_MAX_H) {
      mx += colW + GAP; my = top; colW = 0;       // next column in the frame
    }
    m.x = mx; m.y = my; m.placed = true; m.auto = true;
    if (shown) {
      my += shellH(m.id) + GAP;
      colW = Math.max(colW, shellW(m.id));
      bottom = Math.max(bottom, my);
    }
  }
  return bottom;
}

const memberOrder = gid => M.DEFAULT_GROUPS.find(d => d.id === gid)?.members ?? [];
const sortMembers = (gid, list) => {
  const order = memberOrder(gid);
  return list.sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999));
};

function placeDefaults() {
  const unplaced = [...state.nodes.values()].filter(n => !n.placed && n.kind !== 'group');
  if (!unplaced.length) return;
  // 1. Late arrivals into groups that already stand on the canvas.
  for (const g of state.nodes.values()) {
    if (g.kind !== 'group' || !g.placed) continue;
    const late = sortMembers(g.id, unplaced.filter(n => n.parent === g.id));
    if (late.length) placeMembers(g, late);
  }
  // 2. Top-level items: root panels, and groups that have never been placed.
  const items = [];
  for (const n of unplaced) if (!n.parent && n.kind === 'panel') items.push(n.id);
  for (const n of unplaced) {
    const g = n.parent && state.nodes.get(n.parent);
    if (g && !g.placed && !items.includes(g.id)) items.push(g.id);
  }
  const colOf = id => M.DEFAULT_COLUMNS[id]?.col ?? 1;
  const orderOf = id => M.DEFAULT_COLUMNS[id]?.order ?? 99;
  const byCol = new Map();
  for (const id of items) {
    if (!byCol.has(colOf(id))) byCol.set(colOf(id), []);
    byCol.get(colOf(id)).push(id);
  }
  for (const [col, ids] of byCol) {
    const x = COL_X[col] ?? COL_X[1];
    // Below whatever is already placed in this column, so a panel added by a
    // later build lands under the layout rather than on top of it.
    let y = 0;
    for (const n of state.nodes.values()) {
      if (!n.placed || n.pinned || n.parent) continue;
      const r = measure(n.id);
      if (r && Math.abs(r.x - x) < 60) y = Math.max(y, r.y + r.h + GAP);
    }
    for (const id of ids.sort((a, b) => orderOf(a) - orderOf(b))) {
      const n = state.nodes.get(id);
      if (n.kind === 'group') {
        n.x = x; n.y = y; n.placed = true; n.auto = true;
        const bottom = placeMembers(n, sortMembers(id, M.children(state, id).filter(m => !m.placed)));
        y = bottom + FRAME_PAD + GAP;
      } else {
        n.x = x; n.y = y; n.placed = true; n.auto = true;
        y += shellH(id) + GAP;
      }
    }
  }
  // 3. Function nodes flow down the middle column.
  for (const n of unplaced) if (!n.placed) placeFlow(n);
  save();
}

// Where a new function node goes: the middle column, under whatever is
// already there at the same level.
function placeFlow(n) {
  const x = COL_X[M.PATCH_COLUMN];
  let y = 0;
  for (const m of state.nodes.values()) {
    if (m === n || !m.placed || m.pinned || m.parent !== n.parent) continue;
    const r = measure(m.id);
    if (r && Math.abs(r.x - x) < 60) y = Math.max(y, r.y + r.h + GAP);
  }
  n.x = M.snap(x); n.y = M.snap(y); n.placed = true; n.auto = true;
}

// Keep auto-placed nodes stacked. A node placed by the canvas sits under the
// node above it by that node's height AT THE TIME; when content grows later
// the two would overlap. So each column of auto nodes — inside every frame,
// and at the top level — is re-stacked from its top node down, by current
// heights, whenever a shell changes size. Deepest frames first, so a frame's
// own height is settled before the level that stacks the frame.
function restack() {
  restackTimer = null;
  if (!nodesEl) return;
  const levels = [...state.nodes.values()]
    .filter(n => n.kind === 'group' && !n.collapsed)
    .sort((a, b) => depthOf(b.id) - depthOf(a.id))
    .map(g => g.id);
  levels.push(null);
  let moved = false;
  for (const parent of levels) {
    // Every placed node in the column takes part: the auto-placed ones are
    // moved, a node placed by hand stays where it was put — and the stack
    // flows AROUND it rather than through it, or the nodes below a
    // hand-placed one would close up over it.
    const kids = [...state.nodes.values()].filter(n =>
      n.parent === parent && n.placed && !n.pinned
      && M.isShown(state, n.id) && isVisible(els.get(n.id)));
    const cols = [];
    for (const n of kids.sort((a, b) => a.x - b.x)) {
      let col = cols.find(c => Math.abs(c.x - n.x) < 40);
      if (!col) cols.push(col = { x: n.x, items: [] });
      col.items.push(n);
    }
    for (const col of cols) {
      col.items.sort((a, b) => a.y - b.y);
      let y = col.items[0].y;
      for (const n of col.items) {
        if (n.auto) {
          if (Math.abs(n.y - y) > 0.5) { n.y = y; moved = true; const el = els.get(n.id); if (el) applyNode(n, el); }
        } else {
          y = Math.max(y, n.y);
        }
        y += (measure(n.id)?.h ?? 0) + GAP;
      }
    }
    if (moved) layoutFrames();
  }
  if (moved) { dirty(); save(); }
}

// Get-or-create a function node from the patchbay. A new one takes the next
// slot in the middle column, or the spot it was asked for.
export function ensureNode(id, init = {}) {
  const had = state.nodes.has(id);
  const n = M.ensure(state, id, init);
  if (!had && Number.isFinite(init.x) && Number.isFinite(init.y)) {
    n.x = init.x; n.y = init.y; n.placed = true; n.auto = false;
  }
  return n;
}

export function removeNode(id) {
  const el = els.get(id);
  el?.remove();
  els.delete(id);
  selected.delete(id);
  M.remove(state, id);
  syncWorkspace();
  save();
}

// ── Sync: model → DOM ────────────────────────────────────────────────────

export function syncWorkspace() {
  for (const n of state.nodes.values()) {
    let el = els.get(n.id);
    if (!el) {
      if (n.kind === 'panel') continue;      // panels arrive by adoption only
      el = makeShell(n);
      els.set(n.id, el);
      (n.pinned ? dock : nodesEl).appendChild(el);
      sizeWatcher?.observe(el);
      if (!n.placed) placeFlow(n);
    } else if (n.kind === 'group') {
      renderGroup(n, el);
      chromeButtons(n, headOf(el));
    } else if (renderers.has(n.kind)) {
      renderers.get(n.kind)(n, el);
    }
    if (n.kind === 'panel' && !n.placed) { placeDefaults(); }
    applyNode(n, el);
  }
  // Shells for nodes the model no longer has.
  for (const [id, el] of els) if (!state.nodes.has(id)) { el.remove(); els.delete(id); }
  layoutFrames();
  dirty();
}

function applyNode(n, el) {
  const shown = M.isShown(state, n.id);
  el.classList.toggle('node-hidden', !shown);
  el.classList.toggle('folded', n.folded);
  el.classList.toggle('pinned', n.pinned);
  el.classList.toggle('selected', selected.has(n.id));
  el.classList.toggle('in-group', !!n.parent);
  const fold = el.querySelector(':scope > .node-head > .sec-fold');
  if (fold) fold.setAttribute('aria-expanded', String(!n.folded));
  el.querySelector(':scope > .node-head .node-pin')?.setAttribute('aria-pressed', String(n.pinned));
  const host = n.pinned ? dock : nodesEl;
  if (el.parentElement !== host) host.appendChild(el);
  if (n.pinned) {
    el.style.transform = `translate(${n.px}px, ${n.py}px)`;
  } else {
    el.style.transform = `translate(${n.x}px, ${n.y}px)`;
  }
  if (n.kind !== 'group' || n.collapsed) {
    el.style.width = n.w ? `${n.w}px` : '';
    el.style.height = n.h && !n.folded ? `${n.h}px` : '';
    el.classList.toggle('sized', !!n.h && !n.folded);
  }
  el.style.zIndex = String(zOf(n));
}

const depthOf = id => M.ancestors(state, id).length;
function zOf(n) {
  if (n.kind === 'group' && !n.collapsed) return 1 + depthOf(n.id);
  return 20 + depthOf(n.id) + (selected.has(n.id) ? 5 : 0);
}

// Expanded groups are frames drawn around their members: sized from what is
// inside them, deepest first so a nested frame is measured before the frame
// that holds it.
function layoutFrames() {
  const groups = [...state.nodes.values()].filter(n => n.kind === 'group')
    .sort((a, b) => depthOf(b.id) - depthOf(a.id));
  for (const g of groups) {
    const el = els.get(g.id);
    if (!el) continue;
    if (g.collapsed) { g._fw = null; g._fh = null; el.style.width = ''; el.style.height = ''; continue; }
    const rects = M.children(state, g.id)
      .filter(m => !m.pinned && M.isShown(state, m.id) && isVisible(els.get(m.id)))
      .map(m => measure(m.id)).filter(Boolean);
    const b = M.bounds(rects);
    if (b) {
      g.x = b.x - FRAME_PAD; g.y = b.y - FRAME_HEAD - FRAME_PAD;
      g._fw = b.w + 2 * FRAME_PAD; g._fh = b.h + FRAME_HEAD + 2 * FRAME_PAD;
    } else {
      g._fw = 200; g._fh = FRAME_HEAD + 40;
    }
    el.style.transform = `translate(${g.x}px, ${g.y}px)`;
    el.style.width = `${g._fw}px`;
    el.style.height = `${g._fh}px`;
    el.classList.toggle('empty', !b);
  }
}
export const relayout = () => { layoutFrames(); dirty(); };

// ── State changes ────────────────────────────────────────────────────────

export function setFolded(id, on) {
  const n = state.nodes.get(id);
  if (!n) return;
  n.folded = on;
  syncWorkspace(); save();
}

export function setCollapsed(id, on) {
  const g = state.nodes.get(id);
  if (!g || g.kind !== 'group') return;
  if (on && !g.collapsed) {
    // The compact node sits where the frame's corner was.
    g.x = M.snap(g.x); g.y = M.snap(g.y);
  }
  g.collapsed = on;
  if (!on) {
    // Members were left where they were; the frame re-derives from them.
    // But if the group was DRAGGED while collapsed, they are stale — shift
    // them by how far the compact node travelled.
    const dx = g.x - (g._cx ?? g.x), dy = g.y - (g._cy ?? g.y);
    if (dx || dy) for (const m of M.descendants(state, id)) { m.x += dx; m.y += dy; }
  } else { g._cx = g.x; g._cy = g.y; }
  syncWorkspace(); save();
}

export function setPinned(id, on) {
  const n = state.nodes.get(id), el = els.get(id);
  if (!n || !el) return;
  if (on && !n.pinned) {
    const r = el.getBoundingClientRect(), w = ws.getBoundingClientRect();
    n.pinned = true;
    n.px = Math.round(r.left - w.left); n.py = Math.round(r.top - w.top);
  } else if (!on && n.pinned) {
    const r = el.getBoundingClientRect();
    const p = toWorld(r.left, r.top);
    n.pinned = false;
    n.x = M.snap(p.x); n.y = M.snap(p.y);
  }
  syncWorkspace(); save();
}

export function setHidden(id, on) {
  const n = state.nodes.get(id);
  if (!n) return;
  n.hidden = on;
  if (on) selected.delete(id);
  syncWorkspace(); save();
}

function closeNode(id) {
  const n = state.nodes.get(id);
  if (!n) return;
  if (n.kind === 'group') ungroupNode(id);
  else if (n.kind === 'panel') setHidden(id, true);
  else patch?.remove(id);
}

export function groupSelected(title = 'GROUP') {
  const ids = [...selected].filter(id => state.nodes.has(id));
  if (!ids.length) return null;
  // Grouping a selection that already includes members of one frame plus
  // that frame would nest the frame in itself. Only top-most picks count.
  const top = ids.filter(id => !M.ancestors(state, id).some(a => ids.includes(a.id)));
  const g = M.group(state, top, title);
  if (!g) return null;
  g.placed = true;
  selected.clear(); selected.add(g.id);
  syncWorkspace(); save();
  return g.id;
}

export function ungroupNode(id) {
  const g = state.nodes.get(id);
  if (!g || g.kind !== 'group') return;
  if (g.collapsed) setCollapsed(id, false);
  const el = els.get(id);
  el?.remove(); els.delete(id); selected.delete(id);
  M.ungroup(state, id);
  syncWorkspace(); save();
}

export function selectNodes(ids, { add = false } = {}) {
  if (!add) selected.clear();
  for (const id of ids) if (state.nodes.has(id)) selected.add(id);
  for (const n of state.nodes.values()) {
    const el = els.get(n.id);
    if (el) { el.classList.toggle('selected', selected.has(n.id)); el.style.zIndex = String(zOf(n)); }
  }
  selectCbs.forEach(cb => cb([...selected]));
}
export const clearSelection = () => selectNodes([]);

function deleteSelected() {
  for (const id of Array.from(selected)) closeNode(id);   // closing edits the set
  selected.clear();
}

// ── Viewport ─────────────────────────────────────────────────────────────

function applyView(t) {
  view = { x: t.x, y: t.y, k: t.k };
  state.view = view;
  world.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
  ws.style.setProperty('--k', String(t.k));
  dirty();
}

// A wheel over a list that can scroll scrolls the list; anywhere else it
// zooms. A drag on empty canvas pans; the middle button pans from anywhere,
// so a node under the pointer never traps you.
function zoomFilter(e) {
  if (e.type === 'wheel') {
    if (e.ctrlKey) return true;                  // a pinch on a trackpad
    for (let el = e.target; el && el !== ws; el = el.parentElement) {
      if (!el.classList?.contains('node-body')) continue;
      if (el.scrollHeight > el.clientHeight + 1) return false;
    }
    return true;
  }
  if (e.type === 'mousedown' || e.type === 'touchstart') {
    if (e.button === 1) return true;
    if (e.button && e.button !== 0) return false;
    if (e.shiftKey) return false;                // box select
    return !e.target.closest('.node, .ws-dock, .ws-menu');
  }
  return !e.button;
}

function initZoom() {
  zoomBehavior = zoom()
    .scaleExtent([0.15, 2.5])
    .filter(zoomFilter)
    .wheelDelta(e => -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002) * (e.ctrlKey ? 5 : 1))
    .on('zoom', e => applyView(e.transform))
    .on('end', save);
  select(ws).call(zoomBehavior).on('dblclick.zoom', null);
  select(ws).call(zoomBehavior.transform, zoomIdentity.translate(view.x, view.y).scale(view.k));
}

export function setView(t, animate = true) {
  const tr = zoomIdentity.translate(t.x, t.y).scale(t.k);
  if (animate) select(ws).transition().duration(320).call(zoomBehavior.transform, tr);
  else select(ws).call(zoomBehavior.transform, tr);
}

// Every visible top-level node in view, at most 1:1.
export function fitAll(ids = null) {
  const list = (ids ?? [...state.nodes.keys()]).map(id => state.nodes.get(id))
    .filter(n => n && !n.pinned && M.isShown(state, n.id) && isVisible(els.get(n.id)))
    .filter(n => ids || !n.parent || M.ancestors(state, n.id).every(a => a.collapsed === false && !a.hidden));
  const rects = list.map(n => measure(n.id)).filter(Boolean);
  const b = M.bounds(rects);
  if (!b) return;
  const r = ws.getBoundingClientRect();
  setView(M.fitTransform(b, r.width, r.height, { pad: 28, maxK: 1 }));
}

// ── Pointer interaction: drag, resize, box select ────────────────────────

const isControl = t => !!t.closest('button, select, input, textarea, a, .wave-btn, .port, .num-in, details > summary');

function initPointer() {
  ws.addEventListener('pointerdown', e => {
    if (e.target.closest('.ws-menu')) return;
    if (e.target.closest('.port')) return;                      // the patchbay's
    const grip = e.target.closest('.node-grip');
    if (grip) { startResize(e, grip.closest('.node')); return; }
    const head = e.target.closest('.node-head');
    if (head && !isControl(e.target)) { startDrag(e, head.closest('.node')); return; }
    if (e.target.closest('.node')) return;                      // a body: its own business
    closeMenu();
    if (e.button === 0 && e.shiftKey) { startBox(e); return; }
    if (e.button === 0 && !e.target.closest('.ws-dock')) clearSelection();
  });
  ws.addEventListener('contextmenu', e => {
    if (e.target.closest('input, textarea, select')) return;
    e.preventDefault();
    const node = e.target.closest('.node');
    if (node) openNodeMenu(node.dataset.node, e.clientX, e.clientY);
    else openAddMenu(e.clientX, e.clientY);
  });
  ws.addEventListener('dblclick', e => {
    if (e.target.closest('.node, .ws-dock, .ws-menu')) return;
    openAddMenu(e.clientX, e.clientY);
  });
}

function startDrag(e, shell) {
  if (e.button != null && e.button !== 0) return;
  const id = shell.dataset.node;
  const n = state.nodes.get(id);
  if (!n) return;
  e.preventDefault();
  if (!selected.has(id)) selectNodes([id], { add: e.shiftKey });
  else if (e.shiftKey) { selected.delete(id); selectNodes([...selected]); return; }
  // Everything selected moves, plus the members of any selected frame.
  const moving = new Map();
  for (const sid of selected) {
    const s = state.nodes.get(sid);
    if (!s) continue;
    if (s.pinned && s !== n) continue;
    moving.set(sid, s);
    if (s.kind === 'group') for (const d of M.descendants(state, sid)) if (!d.pinned) moving.set(d.id, d);
  }
  const start = new Map([...moving].map(([mid, m]) => [mid, m.pinned ? { x: m.px, y: m.py } : { x: m.x, y: m.y }]));
  // Each moving node's own frame, as it stood before the drag: a node dropped
  // still inside it stays, however the frame later reshapes around it.
  const homes = new Map();
  for (const m of moving.values()) if (m.parent && !moving.has(m.parent)) {
    if (!homes.has(m.parent)) homes.set(m.parent, measure(m.parent));
  }
  const sx = e.clientX, sy = e.clientY;
  let dragging = false;
  const head = shell.querySelector(':scope > .node-head') ?? shell;
  try { head.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    const dxs = ev.clientX - sx, dys = ev.clientY - sy;
    if (!dragging && Math.hypot(dxs, dys) < 4) return;
    if (!dragging) { dragging = true; document.body.classList.add('ws-dragging'); shell.classList.add('dragging'); }
    for (const [mid, m] of moving) {
      const s0 = start.get(mid);
      if (m.pinned) { m.px = s0.x + dxs; m.py = s0.y + dys; }
      else { m.x = s0.x + dxs / view.k; m.y = s0.y + dys / view.k; }
      const el = els.get(mid);
      if (el && (m.kind !== 'group' || m.collapsed)) applyNode(m, el);
    }
    layoutFrames();
    dirty();
  };
  const up = ev => {
    if (ev.pointerId !== e.pointerId) return;
    head.removeEventListener('pointermove', move);
    head.removeEventListener('pointerup', up);
    head.removeEventListener('pointercancel', up);
    document.body.classList.remove('ws-dragging');
    shell.classList.remove('dragging');
    if (!dragging) return;
    for (const [, m] of moving) {
      if (m.pinned) { m.px = Math.round(m.px); m.py = Math.round(m.py); }
      else { m.x = M.snap(m.x); m.y = M.snap(m.y); }
      m.auto = false;                 // placed by hand now: the canvas leaves it be
    }
    // Dropped into a frame it was not in — or out of the one it was in.
    if (!n.pinned) reparentByPosition(moving, homes);
    syncWorkspace(); save();
  };
  head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', up);
  head.addEventListener('pointercancel', up);
}

// A node whose centre lands inside an expanded frame joins it; one dragged
// out of its frame leaves it. Frames themselves can be dropped into frames.
//
// The frame is measured WITHOUT the nodes being dropped: a frame grows to
// hold its members, so measured with them it would always contain them and
// nothing could ever be dragged out.
function frameRectWithout(g, exclude) {
  const rects = M.children(state, g.id)
    .filter(m => !exclude.has(m.id) && !m.pinned && M.isShown(state, m.id) && isVisible(els.get(m.id)))
    .map(m => (m.kind === 'group' && !m.collapsed ? frameRectWithout(m, exclude) : measure(m.id)))
    .filter(Boolean);
  const b = M.bounds(rects);
  return b ? { x: b.x - FRAME_PAD, y: b.y - FRAME_HEAD - FRAME_PAD, w: b.w + 2 * FRAME_PAD, h: b.h + FRAME_HEAD + 2 * FRAME_PAD }
           : null;
}
const inRect = (x, y, f) => !!f && x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h;
function reparentByPosition(moving, homes = new Map()) {
  const frames = [...state.nodes.values()]
    .filter(g => g.kind === 'group' && !g.collapsed && !moving.has(g.id) && M.isShown(state, g.id))
    .sort((a, b) => depthOf(b.id) - depthOf(a.id));       // deepest wins
  for (const [, m] of moving) {
    if (m.pinned || (m.parent && moving.has(m.parent))) continue;
    const r = measure(m.id);
    if (!r) continue;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    // Still inside the frame it came from: nothing to decide, unless a
    // deeper frame inside that one now holds it.
    const home = m.parent ? homes.get(m.parent) : null;
    const deeper = home && frames.find(g => g.id !== m.parent && M.isInside(state, g.id, m.parent)
                                          && inRect(cx, cy, frameRectWithout(g, moving)));
    if (home && inRect(cx, cy, home) && !deeper) continue;
    const hit = frames.find(g => {
      if (g.id === m.id || M.isInside(state, g.id, m.id)) return false;
      const f = frameRectWithout(g, moving) ?? measure(g.id);
      return f && cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
    });
    const want = hit?.id ?? null;
    if (want !== m.parent) M.setParent(state, m.id, want);
  }
}

function startResize(e, shell) {
  const id = shell.dataset.node;
  const n = state.nodes.get(id);
  if (!n) return;
  e.preventDefault(); e.stopPropagation();
  const grip = e.target;
  try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  const sx = e.clientX, sy = e.clientY;
  const w0 = shell.offsetWidth, h0 = shell.offsetHeight;
  const keepRatio = id === 'panel:camera';           // the picture stays 4:3
  document.body.classList.add('ws-resizing');
  const move = ev => {
    const k = n.pinned ? 1 : view.k;
    n.w = Math.max(MIN_W, Math.round(w0 + (ev.clientX - sx) / k));
    if (!keepRatio) n.h = Math.max(MIN_H, Math.round(h0 + (ev.clientY - sy) / k));
    applyNode(n, shell); layoutFrames(); dirty();
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    document.body.classList.remove('ws-resizing');
    // Taller than the content is a box of empty space with a scrollbar:
    // release the height instead of pinning it.
    const body = shell.querySelector(':scope > .node-body');
    if (body && n.h && body.scrollHeight <= body.clientHeight + 1) n.h = null;
    n.auto = false;
    syncWorkspace(); save();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
}

function startBox(e) {
  e.preventDefault();
  const r0 = ws.getBoundingClientRect();
  const x0 = e.clientX - r0.left, y0 = e.clientY - r0.top;
  boxEl.hidden = false;
  const draw = (x1, y1) => {
    boxEl.style.left = `${Math.min(x0, x1)}px`; boxEl.style.top = `${Math.min(y0, y1)}px`;
    boxEl.style.width = `${Math.abs(x1 - x0)}px`; boxEl.style.height = `${Math.abs(y1 - y0)}px`;
  };
  draw(x0, y0);
  try { ws.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  const move = ev => draw(ev.clientX - r0.left, ev.clientY - r0.top);
  const up = ev => {
    ws.removeEventListener('pointermove', move);
    ws.removeEventListener('pointerup', up);
    boxEl.hidden = true;
    const x1 = ev.clientX - r0.left, y1 = ev.clientY - r0.top;
    const a = toWorld(Math.min(x0, x1) + r0.left, Math.min(y0, y1) + r0.top);
    const b = toWorld(Math.max(x0, x1) + r0.left, Math.max(y0, y1) + r0.top);
    const hit = [];
    for (const n of state.nodes.values()) {
      if (n.pinned || !M.isShown(state, n.id) || !isVisible(els.get(n.id))) continue;
      if (n.kind === 'group' && !n.collapsed) continue;
      const r = measure(n.id);
      if (r && r.x < b.x && r.x + r.w > a.x && r.y < b.y && r.y + r.h > a.y) hit.push(n.id);
    }
    selectNodes(hit, { add: true });
  };
  ws.addEventListener('pointermove', move);
  ws.addEventListener('pointerup', up);
}

// ── Keyboard ─────────────────────────────────────────────────────────────

function initKeys() {
  document.addEventListener('keydown', e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (e.key === 'Escape') { if (menuEl && !menuEl.hidden) closeMenu(); else clearSelection(); return; }
    if (e.metaKey || e.ctrlKey) {
      if (e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) { for (const id of Array.from(selected)) if (M.kindOf(id) === 'group') ungroupNode(id); }
        else groupSelected();
      }
      return;
    }
    if (e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (selected.size) { e.preventDefault(); deleteSelected(); } return; }
    if (e.key === 'Home') { e.preventDefault(); fitAll(); return; }
    if (e.key.toLowerCase() === 'f' && !e.repeat) { e.preventDefault(); fitAll(selected.size ? [...selected] : null); }
  });
}

// ── Menus ────────────────────────────────────────────────────────────────

let menuState = null;   // { kind: 'add'|'node', x, y, wx, wy, query, node }

function closeMenu() {
  if (!menuEl) return;
  menuEl.hidden = true;
  menuState = null;
}

// Everything that can be added, from the app and from the patchbay.
function addEntries() {
  const sections = [];
  const hidden = [...state.nodes.values()].filter(n => n.kind === 'panel' && n.hidden);
  if (hidden.length) sections.push({
    title: 'Panels',
    items: hidden.map(n => ({
      label: titleOf(n.id), hint: 'closed — bring it back',
      add: (wx, wy) => { n.x = M.snap(wx); n.y = M.snap(wy); n.parent = null; n.auto = false; setHidden(n.id, false); },
    })),
  });
  if (selected.size) sections.push({
    title: 'Selection',
    items: [{ label: 'Group selected', hint: `${selected.size} node${selected.size > 1 ? 's' : ''} into one frame`,
              add: () => groupSelected() }],
  });
  if (patch) sections.push(...patch.entries());
  return sections;
}

export function titleOf(id) {
  const n = state.nodes.get(id);
  if (!n) return id;
  if (n.kind === 'group') return n.title;
  const t = els.get(id)?.querySelector(':scope > .node-head .node-title, :scope > .node-head .sec-title');
  return (t?.textContent ?? M.keyOf(id)).trim().replace(/\s+/g, ' ');
}

export function openAddMenu(cx, cy) {
  const w = toWorld(cx, cy);
  menuState = { kind: 'add', x: cx, y: cy, wx: w.x, wy: w.y, query: '' };
  renderMenu();
}

function openNodeMenu(id, cx, cy) {
  const n = state.nodes.get(id);
  if (!n) return;
  if (!selected.has(id)) selectNodes([id]);
  menuState = { kind: 'node', x: cx, y: cy, node: n };
  renderMenu();
}

function nodeMenuItems(n) {
  const items = [];
  if (n.kind === 'group') {
    items.push({ label: n.collapsed ? 'Expand' : 'Collapse into one node', add: () => setCollapsed(n.id, !n.collapsed) });
    items.push({ label: 'Rename', add: () => renameGroup(n.id) });
    items.push({ label: 'Tidy inside', add: () => tidy(M.children(state, n.id).map(c => c.id)) });
    items.push({ label: 'Ungroup', add: () => ungroupNode(n.id) });
  } else {
    items.push({ label: n.folded ? 'Unfold' : 'Fold', add: () => setFolded(n.id, !n.folded) });
    items.push({ label: n.pinned ? 'Unpin from screen' : 'Pin to screen', add: () => setPinned(n.id, !n.pinned) });
  }
  if (selected.size > 1 || (selected.size === 1 && !selected.has(n.id)))
    items.push({ label: `Group selected (${selected.size})`, add: () => groupSelected() });
  if (n.parent) items.push({ label: 'Leave its group', add: () => { M.setParent(state, n.id, null); syncWorkspace(); save(); } });
  items.push({ label: 'Fit in view', add: () => fitAll([n.id]) });
  items.push({ label: n.kind === 'panel' ? 'Close' : n.kind === 'group' ? 'Ungroup' : 'Delete',
               danger: true, add: () => closeNode(n.id) });
  return [{ title: titleOf(n.id), items }];
}

function renderMenu() {
  if (!menuState) return;
  const sections = menuState.kind === 'add' ? addEntries() : nodeMenuItems(menuState.node);
  const q = (menuState.query ?? '').trim().toLowerCase();
  const filtered = sections.map(s => ({
    ...s,
    items: s.items.filter(it => !q || `${s.title} ${it.label} ${it.hint ?? ''}`.toLowerCase().includes(q)),
  })).filter(s => s.items.length);
  const run = it => { const { wx = 0, wy = 0 } = menuState ?? {}; closeMenu(); it.add(wx, wy); };
  render(html`
    <div class="ws-menu-inner" role="menu">
      ${menuState.kind === 'add' ? html`
        <input class="ws-menu-search" type="text" placeholder="Search nodes…" aria-label="Search nodes"
               .value=${menuState.query}
               @input=${e => { menuState.query = e.target.value; renderMenu(); }}
               @keydown=${e => {
                 if (e.key === 'Enter') { const first = filtered[0]?.items[0]; if (first) run(first); }
                 if (e.key === 'Escape') closeMenu();
                 e.stopPropagation();
               }}>` : nothing}
      <div class="ws-menu-list">
        ${filtered.length ? filtered.map(s => html`
          <div class="ws-menu-sec">${s.title}</div>
          ${s.items.map(it => html`
            <button type="button" class="ws-menu-item ${it.danger ? 'danger' : ''}" role="menuitem"
                    @click=${() => run(it)}>
              <span class="ws-menu-lbl">${it.label}</span>
              ${it.hint ? html`<span class="ws-menu-hint">${it.hint}</span>` : nothing}
            </button>`)}`)
        : html`<div class="ws-menu-empty">nothing matches</div>`}
      </div>
    </div>`, menuEl);
  menuEl.hidden = false;
  // Keep it on screen.
  const r = ws.getBoundingClientRect();
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  menuEl.style.left = `${Math.max(4, Math.min(menuState.x - r.left, r.width - mw - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(menuState.y - r.top, r.height - mh - 4))}px`;
  const search = menuEl.querySelector('.ws-menu-search');
  if (search && document.activeElement !== search) search.focus();
}

// ── TIDY: a layered layout ───────────────────────────────────────────────
//
// Cables define an order — signals feed functions feed parameters — and
// dagre turns that into ranks, left to right, with the panels that have no
// cables at all laid out alongside. Applied to the selection when there is
// one, else to everything at the top level; a frame moves as one box and
// its members keep their places inside it.
export function tidy(ids = null) {
  const scope = ids ?? (selected.size > 1 ? [...selected]
    : [...state.nodes.values()].filter(n => !n.parent).map(n => n.id));
  const nodes = scope.map(id => state.nodes.get(id))
    .filter(n => n && !n.pinned && M.isShown(state, n.id) && isVisible(els.get(n.id)));
  if (nodes.length < 2) return;
  const inScope = new Set(nodes.map(n => n.id));
  // Which scoped node each socket node belongs to on screen.
  const scopedOwner = id => {
    let cur = id;
    while (cur && !inScope.has(cur)) cur = state.nodes.get(cur)?.parent ?? null;
    return cur;
  };
  const rects = new Map(nodes.map(n => [n.id, measure(n.id)]));
  const edges = [];
  for (const l of patch?.links() ?? []) {
    const a = scopedOwner(l.from.node), b = scopedOwner(l.to.node);
    if (a && b && a !== b) edges.push([a, b]);
  }
  const linked = new Set(edges.flat());
  const target = new Map();          // id → { x, y } top-left
  const b0 = M.bounds([...rects.values()]);
  let right = b0.x;                  // where the next block starts
  // The wired part ranks left to right: what feeds what.
  if (linked.size) {
    const g = new graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 90, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const id of linked) { const r = rects.get(id); g.setNode(id, { width: r.w, height: r.h }); }
    for (const [a, b] of edges) g.setEdge(a, b);
    dagreLayout(g);
    let maxX = 0;
    for (const id of linked) {
      const p = g.node(id), r = rects.get(id);
      target.set(id, { x: b0.x + p.x - r.w / 2, y: b0.y + p.y - r.h / 2 });
      maxX = Math.max(maxX, b0.x + p.x + r.w / 2);
    }
    right = maxX + 48;
  }
  // The rest — panels and groups with no cables between them — pack into
  // columns beside it, top to bottom, no taller than a screen or so.
  const loose = nodes.filter(n => !linked.has(n.id));
  let cx = right, cy = b0.y, colW = 0;
  const maxH = Math.max(COL_MAX_H, ...[...linked].map(id => rects.get(id).h));
  for (const n of loose) {
    const r = rects.get(n.id);
    if (cy > b0.y && cy + r.h - b0.y > maxH) { cx += colW + GAP * 2; cy = b0.y; colW = 0; }
    target.set(n.id, { x: cx, y: cy });
    cy += r.h + GAP;
    colW = Math.max(colW, r.w);
  }
  for (const n of nodes) {
    const t = target.get(n.id), r = rects.get(n.id);
    const nx = M.snap(t.x), ny = M.snap(t.y);
    const dx = nx - r.x, dy = ny - r.y;
    if (n.kind === 'group' && !n.collapsed) {
      for (const d of M.descendants(state, n.id)) if (!d.pinned) { d.x += dx; d.y += dy; }
    } else { n.x = nx; n.y = ny; }
    n.auto = false;
  }
  syncWorkspace(); save();
  fitAll(ids && ids.length > 1 ? ids : null);
}

// ── Reset ────────────────────────────────────────────────────────────────
// Back to the layout the app ships with, in place: every panel back in its
// column and its group, nothing folded, pinned or closed.
export function resetLayout() {
  lsDel(LS_KEY);
  for (const n of Array.from(state.nodes.values())) {       // groups are deleted as we go
    if (n.kind === 'group') { state.nodes.delete(n.id); els.get(n.id)?.remove(); els.delete(n.id); continue; }
    n.placed = false; n.parent = null; n.folded = false; n.hidden = false; n.pinned = false;
    n.w = n.kind === 'panel' ? (DEFAULT_W[M.keyOf(n.id)] ?? PANEL_W) : null;
    n.h = n.kind === 'panel' ? (DEFAULT_H[M.keyOf(n.id)] ?? null) : null;
    n._seen = false;
  }
  selected.clear();
  const fresh = [...state.nodes.values()];
  for (const g of M.DEFAULT_GROUPS) M.ensure(state, g.id, { title: g.title });
  ensureDefaultGroups(fresh);
  placeDefaults();
  syncWorkspace();
  save();
  fitAll();
}

// ── Init ─────────────────────────────────────────────────────────────────

export function initWorkspace() {
  ws = document.getElementById('ws');
  world = document.getElementById('ws-world');
  nodesEl = document.getElementById('ws-nodes');
  dock = document.getElementById('ws-dock');
  cablesSvg = document.getElementById('ws-cables');
  boxEl = document.getElementById('ws-box');
  menuEl = document.getElementById('ws-menu');
  if (!ws) return;
  view = state.view;
  initZoom();
  initPointer();
  initKeys();
  document.addEventListener('pointerdown', e => {
    if (menuEl && !menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
  }, true);
  // Header buttons.
  document.getElementById('add-node-btn')?.addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = ws.getBoundingClientRect();
    openAddMenu(Math.min(r.left, w.right - 260), w.top + 12);
  });
  document.getElementById('fit-btn')?.addEventListener('click', () => fitAll(selected.size ? [...selected] : null));
  document.getElementById('tidy-btn')?.addEventListener('click', () => tidy());
  // Frames are measured from their members, and members change size when
  // their content does — a list grows, a section unfolds, dev mode reveals
  // a panel. Watch the node layer rather than every node.
  const ro = new ResizeObserver(() => { layoutFrames(); dirty(); });
  ro.observe(nodesEl);
  new MutationObserver(() => { layoutFrames(); dirty(); })
    .observe(nodesEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'open'] });
  const first = state.nodes.size === 0;
  adoptSections(document);
  for (const n of state.nodes.values()) if (n.kind === 'panel' && !n.placed) placeDefaults();
  syncWorkspace();
  // A first look: everything, on a screen that can show it; on a phone the
  // camera's group, at a size you can use — the rest is a pinch away.
  if (first) requestAnimationFrame(() => fitAll(window.innerWidth < 769 && state.nodes.has('group:inputs') ? ['group:inputs'] : null));
  window.addEventListener('resize', () => dirty());
  document.fonts?.ready?.then(scheduleRestack);
}

export const cablesLayer = () => cablesSvg;
export const viewportEl = () => ws;
