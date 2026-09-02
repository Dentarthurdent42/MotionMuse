// The patchbay, on the workspace: sockets on the nodes, cables between them.
//
// Every signal is an OUTPUT socket on the node that measures it (the camera's
// trackers on the Camera Input node, the mic's four on the Microphone node,
// the beat clock's on the Metronome); every parameter — an audio value or a
// control such as the filter type, the key or the tempo — is an INPUT socket
// on the node that owns it, beside the slider or button it drives. A function
// node (graph.js) is both: inputs on its left, its result on its right. Drag
// from a socket to a socket to connect, or tap one then the other. Click a
// cable and its editor opens beside the input it runs into: range, curve,
// steps, invert, and a piano keyboard for oscillator-frequency ranges.
//
// An output fans out to as many inputs as you like; an input takes one cable.
//
// The sockets can also be a GROUP's: when the workspace collapses a frame,
// the members' sockets whose cables cross the frame appear on the collapsed
// node with the same data-key, so a cable to a closed box is a cable to what
// is inside it. Nothing here needs to know — a cable goes from a key to a key.
//
// Data lives where it always did: cables in mapper.js, function nodes in
// graph.js. This module draws them and turns gestures into calls.

import { html, render, nothing } from '../../vendor/lit-html.js';
import { bus }    from '../bus.js';
import { engine } from '../engine.js';
import { mapper } from '../mapper.js';
import { graph, NODE_TYPES, sigKeyOf, paramKeyOf } from '../graph.js';
import { mtof, parseNote, midiName }        from '../scale.js';
import { STEP_OPTS }                       from '../dynamics.js';
import { drawKeyboard, midiAtPoint, midiOf } from './keyboard.js';
import { isDesktop } from './viewport.js';
import { PARAM_CATS, paramOwner, signalOwner } from '../params.js';
import { controlLabel } from '../controls.js';
import * as WS from './workspace.js';

// The parameter categories live in src/params.js (DOM-free, unit-tested);
// re-exported for the modules that read them from here.
export { PARAM_CATS };

const CURVES = [
  ['linear', 'Linear'], ['quad', 'Quadratic'], ['cubic', 'Cubic'],
  ['log', 'Logarithmic'], ['sqrt', 'Square Root'], ['inv', 'Invert'],
  ['invquad', 'Invert + Ease'],
];

// Signals are all registered at startup, so a label is normally there. The
// fallback humanises the key rather than leaking `hand_R_open` into the UI.
const humanizeKey = k => String(k)
  .split('_')
  .map(w => w.length === 1 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ');
export const sigLabel = k => bus.signals.get(k)?.label ?? humanizeKey(k);
const paramLabel = k => engine.PARAMS[k]?.label ?? humanizeKey(k);

// Stable, legible cable/socket colour per signal (OKLab hue from a hash).
function sigHue(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}
export const sigColor = key => key ? `oklch(0.78 0.14 ${sigHue(key)})` : 'oklch(0.6 0 0)';

// An input socket, for the panels' own markup: put this beside the control
// it feeds. Its node is found by the parameter's owner (src/params.js).
export const inPort = (key, label = paramLabel(key)) => `
  <button type="button" class="port port-in" data-side="in" data-key="${key}"
          aria-label="Input ${label} — connect a signal here"
          title="Input: ${key} — drag a signal's ● here, or drag from here to one"></button>`;

const isFreqParam = k => /^osc\d+_freq$/.test(k);
const clampFreq = f => Math.round(Math.max(40, Math.min(2000, f)) * 10) / 10;

let selectedId = null;           // the cable in the editor (mapping id)
let wiring = null;               // in-progress connection { side, key, moved, id }
const wireRefs = new Map();      // mapping id → <path>
const levelRefs = new Map();     // `${side}:${key}` → level bar element (function nodes)
const lastLevel = new Map();
let fpArm = 'min';
let fpOct = 4;
let editorEl = null;

// Outputs remember how they were configured. Re-wiring a different input into
// a parameter (or unplugging and re-plugging it) used to rebuild the mapping
// from defaults, silently throwing away the range/curve/steps you'd set up.
const lastSettings = new Map();
const rememberSettings = m => {
  if (!m?.audioParam) return;
  lastSettings.set(m.audioParam,
    { outMin: m.outMin, outMax: m.outMax, curve: m.curve, steps: m.steps, invert: m.invert });
};
const defaultRange = key => (isFreqParam(key) ? [220, 880] : null);

// ── Sockets and links, as the workspace sees them ────────────────────────
// Every signal on the bus and every parameter the engine knows, each with
// the node that carries it on screen.
function sockets() {
  const out = [];
  bus.signals.forEach((s, k) => out.push({ node: signalOwner(k, s), side: 'out', key: k }));
  for (const k of Object.keys(engine.PARAMS)) {
    const node = paramOwner(k);
    if (node) out.push({ node, side: 'in', key: k });
  }
  return out;
}
const sigNodeOf   = key => signalOwner(key, bus.signals.get(key));
const paramNodeOf = key => paramOwner(key);
// A cable to a parameter the engine does not have right now — an oscillator
// slot the bank has shrunk past — is kept in the patch (the slot may come
// back) but not drawn: a wire to nothing is worse than no wire.
const links = () => mapper.mappings.filter(m => m.signal && engine.PARAMS[m.audioParam]).map(m => ({
  id: m.id,
  from: { node: sigNodeOf(m.signal), key: m.signal },
  to:   { node: paramNodeOf(m.audioParam), key: m.audioParam },
}));
const socketLabel = s => (s.side === 'out' ? sigLabel(s.key) : paramLabel(s.key));
const socketColor = s => {
  if (s.side === 'out') return sigColor(s.key);
  const m = mapper.mappings.find(x => x.audioParam === s.key && x.signal);
  return m ? sigColor(m.signal) : 'var(--dim)';
};

// ── Function nodes ───────────────────────────────────────────────────────

const port = (side, key, label) => html`
  <button class="port port-${side}" type="button" data-side=${side} data-key=${key}
          style="--wire:${side === 'out' ? sigColor(key) : socketColor({ side, key })}"
          aria-label=${side === 'out' ? `Output of ${label} — connect to a parameter` : `Input of ${label}`}></button>`;

function renderFn(node, el) {
  const id = +node.id.slice(3);
  const g = graph.nodes().find(x => x.id === id);
  if (!g) { render(nothing, el); return; }
  const t = NODE_TYPES[g.type];
  const out = sigKeyOf(id);
  el.style.setProperty('--wire', sigColor(out));
  const optCtl = (key, decl) => {
    const set = v => graph.setOpt(id, key, v);
    if (decl.kind === 'choice') return html`
      <label class="fn-opt">${key}
        <select aria-label=${`${key} of node ${id}`} @change=${e => set(e.target.value)}>
          ${decl.of.map(v => html`<option value=${v} ?selected=${v === g.opts[key]}>${v.toUpperCase()}</option>`)}
        </select></label>`;
    if (decl.kind === 'int') return html`
      <label class="fn-opt">${key}
        <input type="number" min=${decl.min} max=${decl.max} step="1" .value=${String(g.opts[key])}
               aria-label=${`${key} of node ${id}`} @change=${e => set(e.target.value)}></label>`;
    return html`
      <label class="fn-opt">${key}
        <input type="range" min="0" max="1" step="0.01" .value=${String(g.opts[key])}
               aria-label=${`${key} of node ${id}`} @input=${e => set(e.target.value)}></label>`;
  };
  render(html`
    <div class="node-head">
      <span class="node-title sec-title" title=${`ƒ${id} ${t.name}`}>ƒ${id} ${t.name.toUpperCase()}</span>
    </div>
    <div class="node-ports">
      <div class="ports-in">
        ${t.ins.map(i => html`<div class="port-row">${port('in', paramKeyOf(id, i), `${t.name} · ${i}`)}<span class="port-lbl">${i}</span></div>`)}
      </div>
      <div class="ports-out">
        <div class="port-row"><span class="port-lbl">out</span>${port('out', out, `ƒ${id} ${t.name}`)}</div>
      </div>
    </div>
    ${Object.keys(t.opts ?? {}).length ? html`
      <div class="node-body fn-body">${Object.entries(t.opts).map(([k, d]) => optCtl(k, d))}</div>` : nothing}
    <span class="ng-level" data-side="in" data-key=${out} aria-hidden="true"></span>`, el);
}

// Bring the canvas into step with the graph: a node for every function
// node, none for one that is gone.
export function renderMapper() {
  for (const g of graph.nodes()) WS.ensureNode(`fn:${g.id}`);
  const fnIds = new Set(graph.nodes().map(g => `fn:${g.id}`));
  for (const n of WS.allNodes()) if (n.kind === 'fn' && !fnIds.has(n.id)) WS.removeNode(n.id);
  // Signal and parameter pill nodes belonged to an earlier layout; anything
  // still stored under those kinds is dropped.
  for (const n of WS.allNodes()) if (n.kind === 'sig' || n.kind === 'par') WS.removeNode(n.id);
  if (selectedId != null && !mapper.mappings.some(m => m.id === selectedId)) closeEditor();
  syncFoldedPorts();
  paintSockets();
  WS.syncWorkspace();
  cacheLevelRefs();
  if (wiring) document.querySelector(`#ws .port[data-side="${wiring.side}"][data-key="${CSS.escape(wiring.key)}"]`)?.classList.add('armed');
  renderEditor();
}

export function addFnNode(type, at = null) {
  const gid = graph.add(type);
  if (gid == null) return null;
  const id = `fn:${gid}`;
  WS.ensureNode(id, at ? { x: at.x, y: at.y } : {});
  renderMapper();
  return id;
}

// Remove a function node and, with it, its cables.
function removeNode(id) {
  const n = WS.getNode(id);
  if (!n || n.kind !== 'fn') return;
  graph.remove(+id.slice(3));
  WS.removeNode(id);
  renderMapper();
}

// Remove just the cable.
function disconnect(id) {
  const m = mapper.mappings.find(x => x.id === id);
  if (m) { rememberSettings(m); mapper.remove(id); }
  if (selectedId === id) closeEditor();
  renderMapper();
}

// ── Connection logic ─────────────────────────────────────────────────────
function connect(sigKey, paramKey) {
  if (!engine.PARAMS[paramKey] || !bus.signals.has(sigKey)) return;
  // One incoming cable per input: replace whatever was driving this param.
  mapper.mappings.filter(m => m.audioParam === paramKey).forEach(m => {
    rememberSettings(m);
    mapper.remove(m.id);
  });
  const prev = lastSettings.get(paramKey);
  const p = engine.PARAMS[paramKey];
  const [lo, hi] = prev ? [prev.outMin, prev.outMax]
    : (defaultRange(paramKey) ?? [p.min, p.max]);
  // A choice or a switch is stepped by nature: the cable arrives quantised
  // to its options, so a hand's travel lands on a filter type, not between.
  const steps = prev?.steps ?? (p.control && (p.options || p.toggle || p.integer) ? Math.round(p.max - p.min) + 1 : 0);
  const id = mapper.add(paramKey, sigKey, lo, hi, prev?.curve ?? 'linear', steps, prev?.invert ?? false);
  selectedId = id;
  fpArm = 'min';
  renderMapper();
}

function finishWire(sock) {
  const sig   = wiring.side === 'out' ? wiring.key : sock.dataset.key;
  const param = wiring.side === 'out' ? sock.dataset.key : wiring.key;
  cancelWire();
  connect(sig, param);
}
function cancelWire() {
  wiring = null;
  document.querySelectorAll('.port.armed').forEach(s => s.classList.remove('armed'));
  document.querySelectorAll('.port.drop-target').forEach(s => s.classList.remove('drop-target'));
  document.getElementById('ng-preview')?.remove();
}

// ── Drop-target resolution ──
// A fingertip is ~40px across; a socket is 13px. Resolve a release point to
// an eligible socket generously: exact hit → nearest socket of the wanted
// side within a fingertip's radius.
const DROP_TOL = 40;
function socketAt(x, y, wantSide) {
  const el = document.elementFromPoint(x, y);
  const direct = el?.closest?.('.port');
  if (direct && direct.dataset.side === wantSide) return direct;
  let best = null, bestD = DROP_TOL;
  document.querySelectorAll(`#ws .port[data-side="${wantSide}"]`).forEach(s => {
    if (!shown(s)) return;
    const r = s.getBoundingClientRect();
    if (!r.width) return;
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < bestD) { best = s; bestD = d; }
  });
  return best;
}
function markDropTarget(sock) {
  document.querySelectorAll('.port.drop-target')
    .forEach(s => { if (s !== sock) s.classList.remove('drop-target'); });
  sock?.classList.add('drop-target');
}

const bezier = (a, b) => {
  const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
};

function drawPreview(clientX, clientY) {
  const svg = WS.cablesLayer();
  if (!svg || !wiring) return;
  const from = document.querySelector('.port.armed')?.getBoundingClientRect();
  if (!from) return;
  const a = WS.toWorld(from.left + from.width / 2, from.top + from.height / 2);
  const b = WS.toWorld(clientX, clientY);
  let path = document.getElementById('ng-preview');
  if (!path) {
    path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.id = 'ng-preview'; path.setAttribute('fill', 'none');
    path.setAttribute('stroke', sigColor(wiring.side === 'out' ? wiring.key : ''));
    path.setAttribute('stroke-width', '2.5'); path.setAttribute('stroke-dasharray', '5 4');
    svg.appendChild(path);
  }
  path.setAttribute('d', wiring.side === 'out' ? bezier(a, b) : bezier(b, a));
}

// Sockets: drag to connect, or tap to arm then tap the other end. One
// delegated listener on the viewport, because sockets come and go with the
// panels that render them.
function initSocketGestures(root) {
  root.addEventListener('pointerdown', e => {
    const sock = e.target.closest('.port');
    if (!sock) return;
    e.preventDefault(); e.stopPropagation();
    if (e.button === 2) return;
    const side = sock.dataset.side, key = sock.dataset.key;
    if (wiring && wiring.side !== side) { finishWire(sock); return; }   // 2nd tap
    if (wiring && wiring.key === key)   { cancelWire();     return; }   // same socket → cancel
    cancelWire();
    wiring = { side, key, moved: false, id: e.pointerId };
    sock.classList.add('armed');
    try { sock.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const move = ev => {
      if (!wiring || wiring.id !== ev.pointerId) return;
      wiring.moved = true;
      drawPreview(ev.clientX, ev.clientY);
      markDropTarget(socketAt(ev.clientX, ev.clientY, wiring.side === 'out' ? 'in' : 'out'));
    };
    const up = ev => {
      sock.removeEventListener('pointermove', move);
      sock.removeEventListener('pointerup', up);
      sock.removeEventListener('pointercancel', up);
      if (!wiring || wiring.id !== ev.pointerId) return;
      const tgt = wiring.moved ? socketAt(ev.clientX, ev.clientY, wiring.side === 'out' ? 'in' : 'out') : null;
      if (tgt) { finishWire(tgt); return; }
      if (wiring.moved) { cancelWire(); return; }        // dragged to nowhere → cancel
      document.getElementById('ng-preview')?.remove();   // a tap stays armed for the second tap
    };
    sock.addEventListener('pointermove', move);
    sock.addEventListener('pointerup', up);
    sock.addEventListener('pointercancel', up);
  });
  // Right-click a wired input: its cable's editor.
  root.addEventListener('contextmenu', e => {
    const sock = e.target.closest('.port[data-side="in"]');
    if (!sock) return;
    const m = mapper.mappings.find(x => x.audioParam === sock.dataset.key && x.signal);
    if (!m) return;
    e.preventDefault(); e.stopPropagation();
    openEditor(m.id);
  }, true);
  root.addEventListener('keydown', e => {
    const sock = e.target.closest?.('.port');
    if (!sock || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    sock.dispatchEvent(new PointerEvent('pointerdown', { pointerId: -1, bubbles: true }));
  });
}

// ── Where a cable ends ───────────────────────────────────────────────────
//
// The socket's centre, when it can be seen. A socket inside a list that has
// scrolled it away, a folded node, a closed tracker group or a collapsed
// frame is still a real end of a real cable — so the cable goes to the
// node's edge instead: the input side or the output side, at the socket's
// clamped height, or at the header when the socket is not drawn at all.
const scrolls = el => { const o = getComputedStyle(el).overflowY; return o === 'auto' || o === 'scroll'; };
// Drawn, as opposed to merely present: a socket inside a folded tracker
// group keeps a stale box (the group's content is skipped, not removed), so
// its rectangle is not the test.
const shown = el => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
const socketSel = (side, key) => `.port[data-side="${side}"][data-key="${CSS.escape(key)}"]`;
function anchor(nodeId, side, key) {
  const owner = WS.ownerOf(nodeId);
  const el = WS.nodeEl(owner);
  if (!el || !WS.isNodeShown(owner)) return null;
  const nr = el.getBoundingClientRect();
  const edgeX = side === 'in' ? nr.left : nr.right;   // the sockets sit on the border
  // A key can have two sockets on one node — its row's, and a folded
  // group's summary copy — of which at most one is drawn.
  const sock = [...el.querySelectorAll(socketSel(side, key))].find(shown);
  if (sock) {
    const r = sock.getBoundingClientRect();
    let cx = r.left + r.width / 2, cy = r.top + r.height / 2, clipped = false;
    for (let sc = sock.parentElement; sc && sc !== el.parentElement; sc = sc.parentElement) {
      if (!scrolls(sc)) continue;
      const b = sc.getBoundingClientRect();
      if (cy < b.top + 2 || cy > b.bottom - 2) { cy = Math.max(b.top + 4, Math.min(b.bottom - 4, cy)); clipped = true; }
    }
    if (clipped) cx = edgeX;
    return { pt: WS.toWorld(cx, cy), visible: !clipped };
  }
  const head = el.querySelector(':scope > .node-head')?.getBoundingClientRect() ?? nr;
  return { pt: WS.toWorld(edgeX, head.top + head.height / 2), visible: false };
}

// ── Cables ───────────────────────────────────────────────────────────────

function drawWires() {
  const svg = WS.cablesLayer();
  if (!svg) return;
  let paths = '';
  for (const l of links()) {
    // A cable with both ends inside one collapsed group is folded away with it.
    const oa = WS.ownerOf(l.from.node), ob = WS.ownerOf(l.to.node);
    if (oa === ob && oa !== l.from.node) continue;
    const a = anchor(l.from.node, 'out', l.from.key);
    const b = anchor(l.to.node, 'in', l.to.key);
    if (!a || !b) continue;
    paths += `<path d="${bezier(a.pt, b.pt)}" fill="none" stroke="${sigColor(l.from.key)}"
      stroke-width="${l.id === selectedId ? 4 : 2.5}" stroke-linecap="round"
      data-mid="${l.id}" class="ng-wire${l.id === selectedId ? ' selected' : ''}${a.visible && b.visible ? '' : ' ng-wire-edge'}"
      style="opacity:0.85"/>`;
  }
  const preview = document.getElementById('ng-preview');
  svg.innerHTML = paths;
  if (preview) svg.appendChild(preview);
  wireRefs.clear();
  svg.querySelectorAll('.ng-wire').forEach(w => {
    const id = parseInt(w.dataset.mid);
    wireRefs.set(id, w);
    w.addEventListener('click', () => { if (selectedId === id) closeEditor(); else openEditor(id); });
    w.addEventListener('mouseenter', () => highlightWire(id));
    w.addEventListener('mouseleave', () => highlightWire(null));
  });
  positionEditor();
}

function highlightWire(id) {
  for (const [mid, w] of wireRefs) w.style.opacity = id == null ? 0.85 : (mid === id ? 1 : 0.15);
}

// ── The cable editor ─────────────────────────────────────────────────────
// A floating panel beside the input the cable runs into, on the screen
// layer (it is a dialog, not a node), following the socket as the canvas
// pans and zooms.

const STEP_SEL = [0, ...STEP_OPTS];
const selMapping = () => mapper.mappings.find(m => m.id === selectedId);

function openEditor(id) {
  selectedId = id;
  fpArm = 'min';
  renderEditor();
  drawWires();
}
function closeEditor() {
  if (selectedId == null) return;
  selectedId = null;
  renderEditor();
  drawWires();
}

function editorTpl(m) {
  const isFreq = isFreqParam(m.audioParam);
  const p = engine.PARAMS[m.audioParam];
  const parseField = raw => {
    if (isFreq) { const n = parseNote(raw); if (n != null) return clampFreq(mtof(n)); }
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : null;
  };
  const onField = which => e => {
    const v = parseField(e.target.value);
    if (v == null) { e.target.value = which === 'min' ? m.outMin : m.outMax; return; }
    if (which === 'min') m.outMin = v; else m.outMax = v;
    e.target.value = v;
    if (isFreq) { engine.playTone({ freq: v, dur: 0.3, type: 'triangle', gain: 0.1 }); drawFreqKbd(); }
  };
  const readout = p?.control
    ? html`<span class="ng-edit-now">now ${controlLabel(m.audioParam)}</span>` : nothing;
  return html`
    <div class="ng-editor" data-freq=${isFreq ? '1' : nothing} role="dialog" aria-label="Cable editor">
      <span class="ng-edit-label">${sigLabel(m.signal)} → ${p?.label ?? m.audioParam} ${readout}
        <button type="button" class="rm-btn ng-close" aria-label="Close editor" title="Close (Esc)"
                @click=${closeEditor}>–</button></span>
      <label>min <input type=${isFreq ? 'text' : 'number'} class="m-min" .value=${String(m.outMin)}
        title=${isFreq ? `${midiName(midiOf(m.outMin))} — Hz or a note name like A4` : nothing}
        step=${isFreq ? nothing : 'any'} @change=${onField('min')}></label>
      <label>max <input type=${isFreq ? 'text' : 'number'} class="m-max" .value=${String(m.outMax)}
        title=${isFreq ? `${midiName(midiOf(m.outMax))} — Hz or a note name like A4` : nothing}
        step=${isFreq ? nothing : 'any'} @change=${onField('max')}></label>
      <label>curve <select class="m-curve" @change=${e => { m.curve = e.target.value; }}>
        ${CURVES.map(([v, l]) => html`<option value=${v} ?selected=${v === m.curve}>${l}</option>`)}
      </select></label>
      <label>steps <select class="m-steps" @change=${e => { m.steps = Math.max(0, parseInt(e.target.value, 10) || 0); delete m._stepIdx; }}>
        ${STEP_SEL.map(s => html`<option value=${s} ?selected=${s === (m.steps ?? 0)}>${s === 0 ? 'off' : s}</option>`)}
      </select></label>
      <button type="button" class="wave-btn m-invert ${m.invert ? 'on' : ''}" aria-pressed=${String(!!m.invert)}
              title="Reverse the connection: the input's high end drives the output's low end"
              @click=${e => { m.invert = !m.invert; e.currentTarget.classList.toggle('on', m.invert); e.currentTarget.setAttribute('aria-pressed', String(m.invert)); }}>⇅ INVERT</button>
      <button type="button" class="rm-btn ng-del" aria-label="Delete cable" title="Delete this cable" @click=${() => disconnect(m.id)}>×</button>
      ${isFreq ? html`
      <div class="ng-freq-picker">
        <div class="ng-freq-bar">
          <button type="button" class="wave-btn ${fpArm === 'min' ? 'on' : ''}" id="fp-min" aria-pressed=${String(fpArm === 'min')} @click=${() => armEndpoint('min')}>SET MIN</button>
          <button type="button" class="wave-btn ${fpArm === 'max' ? 'on' : ''}" id="fp-max" aria-pressed=${String(fpArm === 'max')} @click=${() => armEndpoint('max')}>SET MAX</button>
          <button type="button" class="wave-btn ng-freq-nudge" id="fp-down" aria-label="Down a semitone" @click=${() => nudgeArmed(-1)}>−</button>
          <button type="button" class="wave-btn ng-freq-nudge" id="fp-up" aria-label="Up a semitone" @click=${() => nudgeArmed(+1)}>+</button>
          <span class="ng-freq-oct" id="fp-oct">oct ${fpOct} · Z/X</span>
        </div>
        <div class="ng-freq-kbd-wrap">
          <canvas id="fp-kbd" class="ng-freq-kbd"
                  aria-label=${`Piano keyboard — tap a key to set the ${fpArm === 'min' ? 'minimum' : 'maximum'} frequency`}
                  @pointerdown=${kbdDown} @pointerup=${kbdUp} @pointercancel=${() => { kbdPress = null; }}></canvas>
        </div>
        <div class="ng-freq-hint">tap a key or play A W S E D F T G Y H U J · − / + nudge a semitone · type "C#4" or Hz above · ● min ● max</div>
      </div>` : nothing}
    </div>`;
}

function renderEditor() {
  if (!editorEl) return;
  const m = selMapping();
  render(m ? editorTpl(m) : nothing, editorEl);
  editorEl.hidden = !m;
  if (m) { positionEditor(); if (isFreqParam(m.audioParam)) requestAnimationFrame(drawFreqKbd); }
}

// Beside the input socket, on the screen layer, kept inside the viewport.
function positionEditor() {
  const m = selMapping();
  if (!editorEl || !m || editorEl.hidden) return;
  const ws = WS.viewportEl().getBoundingClientRect();
  const a = anchor(paramNodeOf(m.audioParam), 'in', m.audioParam);
  const s = a ? WS.toScreen(a.pt.x, a.pt.y) : { x: ws.left + ws.width / 2, y: ws.top + ws.height / 2 };
  const w = editorEl.offsetWidth, h = editorEl.offsetHeight;
  let x = s.x - ws.left + 16, y = s.y - ws.top - 12;
  if (x + w > ws.width - 6) x = Math.max(6, s.x - ws.left - w - 16);
  y = Math.max(6, Math.min(ws.height - h - 6, y));
  editorEl.style.left = `${Math.round(x)}px`;
  editorEl.style.top = `${Math.round(y)}px`;
}

// ── Frequency picker internals ───────────────────────────────────────────
const fpKbdHeight = () =>
  globalThis.matchMedia?.('(max-width: 768px)').matches ? 88 : isDesktop() ? 72 : 56;

function drawFreqKbd() {
  const s = selMapping(), c = document.getElementById('fp-kbd');
  if (!s || !c || !isFreqParam(s.audioParam)) return;
  drawKeyboard(c, { height: fpKbdHeight(), labels: true, scale: null,
                    m1: midiOf(s.outMin), m2: midiOf(s.outMax) });
}

function armEndpoint(which) {
  fpArm = which;
  document.getElementById('fp-min')?.classList.toggle('on', fpArm === 'min');
  document.getElementById('fp-max')?.classList.toggle('on', fpArm === 'max');
  document.getElementById('fp-min')?.setAttribute('aria-pressed', String(fpArm === 'min'));
  document.getElementById('fp-max')?.setAttribute('aria-pressed', String(fpArm === 'max'));
  document.getElementById('fp-kbd')?.setAttribute('aria-label',
    `Piano keyboard — tap a key to set the ${fpArm === 'min' ? 'minimum' : 'maximum'} frequency`);
}

// Apply a picked tone to the armed endpoint. Mutates the mapping + field in
// place and auditions the tone. The armed endpoint deliberately does NOT
// advance: staying on MIN lets you correct it until you press SET MAX.
function pickMidi(m) {
  const s = selMapping();
  if (!s || !isFreqParam(s.audioParam)) return;
  const f = clampFreq(mtof(m));
  const field = editorEl?.querySelector(fpArm === 'min' ? '.m-min' : '.m-max');
  if (fpArm === 'min') s.outMin = f; else s.outMax = f;
  if (field) { field.value = f; field.title = `${midiName(m)} — Hz or a note name like A4`; }
  engine.playTone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.1 });
  drawFreqKbd();
}
function nudgeArmed(delta) {
  const s = selMapping();
  if (!s || !isFreqParam(s.audioParam)) return;
  pickMidi(midiOf(fpArm === 'min' ? s.outMin : s.outMax) + delta);
}

let kbdPress = null;
const kbdDown = e => { kbdPress = { x: e.clientX, y: e.clientY, id: e.pointerId }; e.stopPropagation(); };
const kbdUp = e => {
  if (!kbdPress || kbdPress.id !== e.pointerId) return;
  const moved = Math.hypot(e.clientX - kbdPress.x, e.clientY - kbdPress.y);
  kbdPress = null;
  if (moved > 10) return;                       // that was a scroll, not a tap
  const r = e.currentTarget.getBoundingClientRect();
  pickMidi(midiAtPoint(r.width, r.height, e.clientX - r.left, e.clientY - r.top));
};

// QWERTY note entry — active only while a frequency cable's editor is open
// and focus isn't in a form field.
const FP_KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11 };
if (globalThis.document !== undefined) document.addEventListener('keydown', e => {
  if (!editorEl || editorEl.hidden || !editorEl.querySelector('.ng-editor[data-freq]')) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'x') {
    fpOct = Math.max(1, Math.min(7, fpOct + (k === 'x' ? 1 : -1)));
    const o = document.getElementById('fp-oct');
    if (o) o.textContent = `oct ${fpOct} · Z/X`;
    e.preventDefault();
    return;
  }
  if (k in FP_KEYMAP) { e.preventDefault(); pickMidi(12 * (fpOct + 1) + FP_KEYMAP[k]); }
});

// ── The sockets' own state ───────────────────────────────────────────────

// A wired socket takes its cable's colour (a dot in the ring). The panels'
// sockets only: a function node's and a group's come coloured from their
// own renderers.
function paintSockets() {
  const wiredIn = new Map(mapper.mappings.filter(m => m.signal).map(m => [m.audioParam, m.signal]));
  const wiredOut = new Set(wiredIn.values());
  document.querySelectorAll('#ws .port').forEach(p => {
    if (p.closest('.node-fn, .node-group')) return;
    const key = p.dataset.key;
    const sig = p.dataset.side === 'out' ? (wiredOut.has(key) ? key : null) : (wiredIn.get(key) ?? null);
    p.classList.toggle('wired', !!sig);
    if (sig) p.style.setProperty('--wire', sigColor(sig)); else p.style.removeProperty('--wire');
  });
}

// A signal group folded shut (its tracker is off, or the user shut it) hides
// its rows — but not its cables. Its summary carries a copy of every WIRED
// socket in it, one under another on the node's border, so the cable still
// ends on a ring; open the group and the copies go, the rows take over.
function syncFoldedPorts() {
  const wired = new Set(mapper.mappings.filter(m => m.signal).map(m => m.signal));
  document.querySelectorAll('#ws .sig-sec').forEach(d => {
    const strip = d.querySelector(':scope > summary > .sig-sum-ports');
    if (!strip) return;
    const keys = d.open ? []
      : [...d.querySelectorAll('.sig-sec-body .port-out')].map(p => p.dataset.key).filter(k => wired.has(k));
    const want = keys.join('\n');
    if (strip.dataset.keys === want) return;
    strip.dataset.keys = want;
    strip.innerHTML = keys.map(k => `
      <span class="sig-sum-port"><span class="sig-sum-lbl">${sigLabel(k)}</span><button type="button"
        class="port port-out wired" data-node="${strip.dataset.owner}" data-side="out" data-key="${k}"
        style="--wire:${sigColor(k)}" aria-label="Output ${sigLabel(k)} — wired; open the group for the rest"
        title="Output: ${k} — open the group for the rest of its signals"></button></span>`).join('');
  });
}

// ── Level bars (function nodes) and cable pulse ──────────────────────────

function cacheLevelRefs() {
  levelRefs.clear();
  lastLevel.clear();
  document.querySelectorAll('#ws .ng-level').forEach(el =>
    levelRefs.set(`${el.dataset.side}:${el.dataset.key}`, el));
}
const clamp01 = v => Math.max(0, Math.min(1, v));
function setLevel(refKey, v) {
  const el = levelRefs.get(refKey);
  if (!el) return;
  const q = v.toFixed(3);
  if (lastLevel.get(refKey) === q) return;
  lastLevel.set(refKey, q);
  el.style.setProperty('--lvl', q);
}

export function updateMapperBars() {
  if (!wireRefs.size && !levelRefs.size) return;
  mapper.mappings.forEach(m => {
    const w = wireRefs.get(m.id);
    if (!w || !m.signal) return;
    const p = engine.PARAMS[m.audioParam];
    const norm = p ? clamp01((p.val - p.min) / (p.max - p.min)) : 0;
    if (m.id !== selectedId) w.style.strokeWidth = (2 + norm * 3).toFixed(2);
    w.style.opacity = (0.55 + norm * 0.45).toFixed(2);
  });
  for (const [refKey, el] of levelRefs) {
    if (!el.isConnected) continue;
    const key = refKey.slice(refKey.indexOf(':') + 1);
    setLevel(refKey, clamp01(bus.norm(key)));
  }
}

// ── Add-menu entries ─────────────────────────────────────────────────────
function menuEntries() {
  return [{ title: 'Function', items: Object.entries(NODE_TYPES).map(([k, t]) => ({
    label: `ƒ ${t.name}`, hint: t.ins.length ? t.ins.join(', ') : 'a knob',
    add: (x, y) => WS.selectNodes([addFnNode(k, { x, y })]),
  })) }];
}

// ── Init ─────────────────────────────────────────────────────────────────
export function initMapperUI() {
  WS.registerRenderer('fn', renderFn);
  WS.setPatchSource({ sockets, links, socketLabel, socketColor, remove: removeNode, entries: menuEntries });
  WS.onCablesDirty(drawWires);
  const root = WS.viewportEl();
  // A signal group opening or closing swaps which of a key's sockets is
  // drawn: refill the summaries, then let the cables find the new ends.
  // (toggle does not bubble; the capture phase sees it.)
  document.addEventListener('toggle', e => {
    if (!e.target.classList?.contains('sig-sec')) return;
    syncFoldedPorts();
    paintSockets();
    WS.relayout();
  }, true);
  if (!root) return;
  initSocketGestures(root);
  editorEl = document.createElement('div');
  editorEl.id = 'ng-editor-pop';
  editorEl.className = 'ng-editor-pop';
  editorEl.hidden = true;
  editorEl.addEventListener('pointerdown', e => e.stopPropagation());
  document.getElementById('ws-dock')?.appendChild(editorEl);
  // Escape closes the editor; a press anywhere outside it does too.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && selectedId != null && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) closeEditor();
  });
  root.addEventListener('pointerdown', e => {
    if (selectedId != null && !e.target.closest('.ng-editor-pop, .ng-wire')) closeEditor();
  });
}
