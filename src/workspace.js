// The workspace model: everything on screen is a node on one canvas.
//
// A node is one of five kinds, and the canvas does not care which:
//
//   panel   a section of the old interface — the camera, the signals list, the
//           oscillators, the loop pedal. Its body is the same markup it always
//           had; the workspace only gives it a position, a size and a header.
//   sig     a signal on the bus, with one OUTPUT socket.
//   par     an engine parameter, with one INPUT socket.
//   fn      a function node (graph.js): input sockets and one output.
//   group   a frame holding other nodes. Dragged as one; collapsed into a
//           single node whose sockets are the members' sockets that face
//           outward. This is how primitive nodes compose into larger ones —
//           the same idea as a Blender node group or an Unreal collapsed
//           graph — and INPUTS and AUDIO ENGINE, the two big containers of the
//           old layout, are simply groups the app ships with.
//
// This module is the model only: positions, membership, what a collapsed
// group exposes, and how all of it is saved. It knows nothing of the DOM, so
// it runs under `node --test` (tests/unit/workspace.test.js); the canvas that
// draws it is src/ui/workspace.js.

import { isRecord, isString } from './is.js';

export const KINDS = ['panel', 'sig', 'par', 'fn', 'group'];

// Ids are `<kind>:<key>` so the kind is readable off the id and a signal and a
// parameter with the same bus key can never collide.
export const nodeId = (kind, key) => `${kind}:${key}`;
export const kindOf = id => String(id).split(':')[0];
export const keyOf  = id => String(id).slice(String(id).indexOf(':') + 1);

// Where a panel starts, before anyone has moved it. Columns rather than
// coordinates: heights are only known once the panel has rendered, so the
// canvas stacks each column from measured boxes (see ui/workspace.js
// placeDefaults). Order is the authored order of the old layout, so a first
// visit looks like the interface it replaces — three columns, camera in the
// middle — with every piece now free to leave its column.
//
// A group's children keep the group's column; the group is what has an order.
export const DEFAULT_GROUPS = [
  { id: 'group:inputs', title: 'INPUTS', col: 0, order: 0,
    members: ['panel:camera', 'panel:mic', 'panel:eeg', 'panel:emg', 'panel:models'] },
  // The patch: the PATCH TOOLS panel plus every function node — so the
  // computing part of the wiring can be collapsed into one node.
  { id: 'group:patch', title: 'PATCH', col: 1, order: 0, members: ['panel:patch'] },
  { id: 'group:audio', title: 'AUDIO ENGINE', col: 2, order: 0,
    members: ['panel:output', 'panel:oscillators', 'panel:filter', 'panel:gesture-mode',
              'panel:chord-filter', 'panel:radial-mode', 'panel:metronome', 'panel:sound-kit',
              'panel:play-along', 'panel:looper', 'panel:pitch-quantize', 'panel:volume-quantize'] },
];
export const DEFAULT_COLUMNS = {
  'group:inputs':  { col: 0, order: 0 },
  'group:patch':   { col: 1, order: 0 },
  'panel:shader':  { col: 1, order: 1 },
  'group:audio':   { col: 2, order: 0 },
};
// Sockets nodes (sig / par / fn) are placed in the patch column, in flow order.
export const PATCH_COLUMN = 1;

export const GRID = 8;
export const snap = v => Math.round(v / GRID) * GRID;

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

// One node record, with every field the canvas reads present and typed.
function normalize(id, raw) {
  const kind = kindOf(id);
  if (!KINDS.includes(kind)) return null;
  const r = isRecord(raw) ? raw : {};
  const n = {
    id, kind,
    x: num(r.x), y: num(r.y),
    // Width is a choice; height is the content's unless the user set one.
    w: Number.isFinite(r.w) && r.w > 0 ? r.w : null,
    h: Number.isFinite(r.h) && r.h > 0 ? r.h : null,
    folded: r.folded === true,
    hidden: r.hidden === true,
    parent: isString(r.parent) ? r.parent : null,
    // Pinned: taken off the canvas and held on the screen — for the camera,
    // so you can see yourself while panning around the patch.
    pinned: r.pinned === true,
    px: num(r.px), py: num(r.py),
    // Placed: the canvas has given it a position. A node arriving from
    // storage was; one created by ensure() waits for placeDefaults / placeFlow.
    placed: r.placed === true,
    // Auto: still where the canvas put it, never moved or resized by hand.
    // Such nodes are kept stacked as their content changes size; a node the
    // user has placed stays exactly where they left it.
    auto: r.auto === true,
  };
  if (kind === 'group') {
    n.title = isString(r.title) ? r.title : 'GROUP';
    n.collapsed = r.collapsed === true;
  }
  return n;
}

export function createState(saved) {
  const state = { nodes: new Map(), view: { x: 0, y: 0, k: 1 }, nextGroup: 1 };
  if (!isRecord(saved)) return state;
  if (isRecord(saved.nodes)) {
    for (const [id, raw] of Object.entries(saved.nodes)) {
      const n = normalize(id, raw);
      if (n) { n.placed = true; state.nodes.set(id, n); }
    }
  }
  // A parent that does not exist is no parent — a stale reference would
  // otherwise hide the node inside a frame that is never drawn.
  for (const n of state.nodes.values()) {
    if (n.parent && !state.nodes.has(n.parent)) n.parent = null;
  }
  if (isRecord(saved.view)) {
    state.view = { x: num(saved.view.x), y: num(saved.view.y),
                   k: Number.isFinite(saved.view.k) && saved.view.k > 0 ? saved.view.k : 1 };
  }
  state.nextGroup = Number.isInteger(saved.nextGroup) && saved.nextGroup > 0 ? saved.nextGroup : 1;
  // Never trust a saved counter below the ids in use: two groups with one id
  // would merge in the store.
  for (const id of state.nodes.keys()) {
    const m = /^group:g(\d+)$/.exec(id);
    if (m) state.nextGroup = Math.max(state.nextGroup, +m[1] + 1);
  }
  return state;
}

export function serialize(state) {
  const nodes = {};
  for (const n of state.nodes.values()) {
    const out = { x: n.x, y: n.y };
    if (n.w) out.w = n.w;
    if (n.h) out.h = n.h;
    if (n.folded) out.folded = true;
    if (n.hidden) out.hidden = true;
    if (n.parent) out.parent = n.parent;
    if (n.pinned) { out.pinned = true; out.px = n.px; out.py = n.py; }
    if (n.auto) out.auto = true;
    if (n.kind === 'group') { out.title = n.title; if (n.collapsed) out.collapsed = true; }
    nodes[n.id] = out;
  }
  return { v: 1, nodes, view: { ...state.view }, nextGroup: state.nextGroup };
}

// Get-or-create. A node the store has never seen arrives unplaced (x/y 0) and
// the canvas gives it a position; one it has seen comes back where it was.
export function ensure(state, id, init = {}) {
  let n = state.nodes.get(id);
  if (n) return n;
  n = normalize(id, init);
  if (!n) throw new Error(`bad node id ${id}`);
  state.nodes.set(id, n);
  return n;
}

export const get = (state, id) => state.nodes.get(id) ?? null;
export const has = (state, id) => state.nodes.has(id);

export function remove(state, id) {
  const n = state.nodes.get(id);
  if (!n) return;
  // Members of a removed group are freed, not deleted with it.
  for (const m of state.nodes.values()) if (m.parent === id) m.parent = n.parent;
  state.nodes.delete(id);
}

export const children = (state, gid) =>
  [...state.nodes.values()].filter(n => n.parent === gid);

export function descendants(state, gid) {
  const out = [];
  const walk = id => {
    for (const n of state.nodes.values()) {
      if (n.parent === id) { out.push(n); if (n.kind === 'group') walk(n.id); }
    }
  };
  walk(gid);
  return out;
}

export function ancestors(state, id) {
  const out = [];
  let n = state.nodes.get(id);
  const seen = new Set();
  while (n && n.parent && !seen.has(n.parent)) {
    seen.add(n.parent);
    n = state.nodes.get(n.parent);
    if (n) out.push(n);
  }
  return out;
}

export const isInside = (state, id, gid) => ancestors(state, id).some(a => a.id === gid);

// The node that stands for `id` on screen: itself, unless it sits inside a
// collapsed group — then the OUTERMOST collapsed ancestor, because a collapsed
// group inside a collapsed group is not drawn either.
export function visualOwner(state, id) {
  let owner = id;
  for (const a of ancestors(state, id)) if (a.kind === 'group' && a.collapsed) owner = a.id;
  return owner;
}

// Hidden for any reason: closed, or inside a folded/collapsed/hidden ancestor.
export function isShown(state, id) {
  const n = state.nodes.get(id);
  if (!n || n.hidden) return false;
  for (const a of ancestors(state, id)) if (a.hidden || a.collapsed || a.folded) return false;
  return true;
}

// ── Groups ───────────────────────────────────────────────────────────────

export function group(state, ids, title = 'GROUP') {
  const members = ids.map(id => state.nodes.get(id)).filter(Boolean);
  if (!members.length) return null;
  // The new group sits where its first member's parent is, so grouping
  // inside a frame keeps the result inside that frame. Members from
  // different parents all come along; the deepest common frame would be
  // more precise and is not worth the arithmetic.
  const parent = members[0].parent;
  const id = `group:g${state.nextGroup++}`;
  const g = ensure(state, id, { title, parent, x: Math.min(...members.map(m => m.x)),
                                y: Math.min(...members.map(m => m.y)), placed: true });
  for (const m of members) {
    if (m.id === id || isInside(state, id, m.id)) continue;   // never a cycle
    m.parent = id;
    m.pinned = false;
  }
  return g;
}

export function ungroup(state, gid) {
  const g = state.nodes.get(gid);
  if (!g || g.kind !== 'group') return false;
  for (const m of state.nodes.values()) if (m.parent === gid) m.parent = g.parent;
  state.nodes.delete(gid);
  return true;
}

export function setParent(state, id, gid) {
  const n = state.nodes.get(id);
  if (!n) return false;
  if (gid !== null) {
    const g = state.nodes.get(gid);
    if (!g || g.kind !== 'group' || gid === id || isInside(state, gid, id)) return false;
  }
  n.parent = gid;
  return true;
}

// ── Sockets on a collapsed group ─────────────────────────────────────────
//
// `sockets`: every socket in the patch — { node, side: 'in'|'out', key }.
// `links`:   every cable — { from: { node, key }, to: { node, key } }, from an
//            out socket to an in socket.
//
// A collapsed group exposes each member socket whose cable CROSSES its
// boundary — reaches a node outside the group. A cable that starts and ends
// inside the group is the group's own business and stays hidden with it, and
// an unwired socket is not shown at all: a camera has sixty of them, and a
// collapsed box lists what it is connected to, not everything it could be.
// Expand the group to wire something new into it.
export function exposedPorts(state, gid, sockets, links) {
  const owned = s => visualOwner(state, s.node) === gid;
  const partnerOf = s => {
    const out = [];
    for (const l of links) {
      if (s.side === 'out' && l.from.node === s.node && l.from.key === s.key) out.push(l.to.node);
      if (s.side === 'in'  && l.to.node   === s.node && l.to.key   === s.key) out.push(l.from.node);
    }
    return out;
  };
  const ins = [], outs = [];
  for (const s of sockets) {
    if (!owned(s)) continue;
    const outward = partnerOf(s).some(p => visualOwner(state, p) !== gid);
    if (!outward) continue;
    (s.side === 'in' ? ins : outs).push(s);
  }
  return { ins, outs };
}

// ── Bounds ───────────────────────────────────────────────────────────────
// Sizes come from the canvas (measured boxes); this only does the arithmetic.
export function bounds(items) {
  if (!items.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// The transform that shows `box` (world units) inside a viewport of vw×vh,
// with `pad` px of air, never zoomed past `maxK`.
export function fitTransform(box, vw, vh, { pad = 24, maxK = 1, minK = 0.1 } = {}) {
  if (!box || !box.w || !box.h) return { x: 0, y: 0, k: 1 };
  const k = Math.max(minK, Math.min(maxK, (vw - 2 * pad) / box.w, (vh - 2 * pad) / box.h));
  return {
    k,
    x: (vw - box.w * k) / 2 - box.x * k,
    y: (vh - box.h * k) / 2 - box.y * k,
  };
}

// A column layout for nodes the store has never placed: each column is a
// stack, top to bottom in `order`, columns side by side. Heights are measured
// by the caller, which is why this takes items rather than ids.
//   items: [{ id, col, order, w, h }]
export function stackColumns(items, { gap = 12, colGap = 16, colWidths = [] } = {}) {
  const cols = new Map();
  for (const it of items) {
    if (!cols.has(it.col)) cols.set(it.col, []);
    cols.get(it.col).push(it);
  }
  const out = new Map();
  let x = 0;
  for (const c of [...cols.keys()].sort((a, b) => a - b)) {
    const list = cols.get(c).sort((a, b) => a.order - b.order);
    const width = Math.max(colWidths[c] ?? 0, ...list.map(it => it.w));
    let y = 0;
    for (const it of list) {
      out.set(it.id, { x: snap(x), y: snap(y) });
      y += it.h + gap;
    }
    x += width + colGap;
  }
  return out;
}
