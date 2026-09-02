// The patchbay, on the workspace: signals, parameters and function nodes as
// nodes with sockets, and the cables between them.
//
// Every SIGNAL node has one output socket that fans out to as many parameters
// as you like; every PARAMETER node takes a single incoming cable (a
// parameter can only be driven by one thing at a time); a FUNCTION node
// (graph.js) is both — inputs on the left, its result on the right. Drag from
// a socket to a socket to connect, or tap one socket then the other. Select a
// parameter node (or click its cable) and its range / curve / steps / invert
// editor opens inside the node; oscillator-frequency cables add a piano
// keyboard for picking the range as notes.
//
// The sockets can also be a GROUP's: when the workspace collapses a frame,
// the members' outward-facing sockets appear on the collapsed node and carry
// the same data-key, so wiring to a closed box is wiring to what is inside
// it. Nothing here needs to know — a cable goes from a key to a key.
//
// Data lives where it always did: cables in mapper.js, nodes in graph.js.
// This module only draws them and turns gestures into calls. Node presence
// on the canvas is the workspace's: a signal or parameter node exists while a
// cable uses it or someone put it there on purpose, and its position is
// remembered with the rest of the layout.

import { html, render, nothing } from '../../vendor/lit-html.js';
import { bus }    from '../bus.js';
import { engine } from '../engine.js';
import { mapper } from '../mapper.js';
import { graph, NODE_TYPES, sigKeyOf, paramKeyOf } from '../graph.js';
import { mtof, parseNote, midiName }        from '../scale.js';
import { STEP_OPTS }                       from '../dynamics.js';
import { drawKeyboard, midiAtPoint, midiOf } from './keyboard.js';
import { isDesktop } from './viewport.js';
import { PARAM_CATS } from '../params.js';
import * as WS from './workspace.js';

const CURVES = [
  ['linear', 'Linear'], ['quad', 'Quadratic'], ['cubic', 'Cubic'],
  ['log', 'Logarithmic'], ['sqrt', 'Square Root'], ['inv', 'Invert'],
  ['invquad', 'Invert + Ease'],
];

// Signals are all registered at startup, so a label is normally there. The
// fallback humanises the key rather than leaking `hand_R_open` into the UI —
// a bus key is an internal name and should never be shown as prose.
const humanizeKey = k => String(k)
  .split('_')
  .map(w => w.length === 1 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ');
export const sigLabel = k => bus.signals.get(k)?.label ?? humanizeKey(k);
const paramLabel = k => engine.PARAMS[k]?.label ?? humanizeKey(k);

// The parameter categories live in src/params.js (DOM-free, unit-tested);
// re-exported so the two modules that always read them from here still can.
export { PARAM_CATS };

// Stable, legible cable/socket colour per signal (OKLab hue from a hash).
function sigHue(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}
export const sigColor = key => key ? `oklch(0.78 0.14 ${sigHue(key)})` : 'oklch(0.6 0 0)';

// ── Which node carries which socket ──────────────────────────────────────
// A function node's sockets are bus signals and engine parameters like any
// other (that is the whole design of graph.js), so a key says which node it
// lives on.
const FN_SIG = /^fn_(\d+)$/, FN_PAR = /^fn_(\d+)_(\w+)$/;
const sigNodeOf   = key => (FN_SIG.test(key) ? `fn:${FN_SIG.exec(key)[1]}` : `sig:${key}`);
const paramNodeOf = key => (FN_PAR.test(key) ? `fn:${FN_PAR.exec(key)[1]}` : `par:${key}`);

const isFreqParam = k => /^osc\d+_freq$/.test(k);
const clampFreq = f => Math.round(Math.max(40, Math.min(2000, f)) * 10) / 10;

let selectedId = null;           // selected cable (mapping id)
let wiring = null;               // in-progress connection { side, key, moved, id }
const wireRefs = new Map();      // mapping id → <path>
const levelRefs = new Map();     // `${side}:${key}` → level bar element
const lastLevel = new Map();
// Signal / parameter nodes that exist without a cable, because someone put
// them there. Seeded from the saved layout at startup so a node left on the
// canvas is still there after a reload.
const loose = new Set();
let fpArm = 'min';
let fpOct = 4;

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
function sockets() {
  const out = [];
  for (const n of WS.allNodes()) {
    if (n.kind === 'sig') out.push({ node: n.id, side: 'out', key: keyOf(n.id) });
    else if (n.kind === 'par') out.push({ node: n.id, side: 'in', key: keyOf(n.id) });
    else if (n.kind === 'fn') {
      const id = +keyOf(n.id), g = graph.nodes().find(x => x.id === id);
      if (!g) continue;
      for (const i of NODE_TYPES[g.type].ins) out.push({ node: n.id, side: 'in', key: paramKeyOf(id, i) });
      out.push({ node: n.id, side: 'out', key: sigKeyOf(id) });
    }
  }
  return out;
}
const links = () => mapper.mappings.filter(m => m.signal).map(m => ({
  id: m.id,
  from: { node: sigNodeOf(m.signal), key: m.signal },
  to:   { node: paramNodeOf(m.audioParam), key: m.audioParam },
}));
const keyOf = id => id.slice(id.indexOf(':') + 1);
const socketLabel = s => (s.side === 'out' ? sigLabel(s.key) : paramLabel(s.key));
const socketColor = s => {
  if (s.side === 'out') return sigColor(s.key);
  const m = mapper.mappings.find(x => x.audioParam === s.key && x.signal);
  return m ? sigColor(m.signal) : 'var(--dim)';
};

// ── Node renderers ───────────────────────────────────────────────────────

const port = (nodeId, side, key, label) => html`
  <button class="port port-${side}" type="button" data-node=${nodeId} data-side=${side} data-key=${key}
          style="--wire:${side === 'out' ? sigColor(key) : socketColor({ side, key })}"
          aria-label=${side === 'out' ? `Output of ${label} — connect to a parameter` : `Input of ${label}`}></button>`;

function renderSig(node, el) {
  const key = keyOf(node.id);
  el.style.setProperty('--wire', sigColor(key));
  render(html`
    <div class="node-head">
      <span class="node-title sec-title" title=${sigLabel(key)}>${sigLabel(key)}</span>
    </div>
    <div class="node-ports"><div class="ports-out">
      <div class="port-row">${port(node.id, 'out', key, sigLabel(key))}</div>
    </div></div>
    <span class="ng-level" data-side="in" data-key=${key} aria-hidden="true"></span>`, el);
}

function renderPar(node, el) {
  const key = keyOf(node.id);
  const m = mapper.mappings.find(x => x.audioParam === key && x.signal);
  const p = engine.PARAMS[key];
  el.classList.toggle('wired', !!m);
  el.style.setProperty('--wire', m ? sigColor(m.signal) : 'var(--dim)');
  const open = m && m.id === selectedId;
  const range = m && !open ? html`<span class="par-range">${fmtRange(m)}</span>` : nothing;
  render(html`
    <div class="node-head">
      <span class="node-title sec-title" title=${p?.label ?? key}>${p?.label ?? key}</span>
    </div>
    <div class="node-ports"><div class="ports-in">
      <div class="port-row">${port(node.id, 'in', key, p?.label ?? key)}</div>
    </div></div>
    ${range}
    ${open ? editorTpl(m) : nothing}
    <span class="ng-level" data-side="out" data-key=${key} aria-hidden="true"></span>`, el);
  if (open && isFreqParam(key)) requestAnimationFrame(drawFreqKbd);
}

const fmtRange = m => {
  const p = engine.PARAMS[m.audioParam];
  const f = v => (p?.unit === 'Hz' ? Math.round(v) : +(+v).toFixed(2));
  return `${f(m.outMin)} → ${f(m.outMax)}${p?.unit ? ' ' + p.unit : ''}${m.curve !== 'linear' ? ' · ' + m.curve : ''}${m.invert ? ' · ⇅' : ''}${m.steps >= 2 ? ' · ' + m.steps + ' steps' : ''}`;
};

function renderFn(node, el) {
  const id = +keyOf(node.id);
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
        ${t.ins.map(i => html`<div class="port-row">${port(node.id, 'in', paramKeyOf(id, i), `${t.name} · ${i}`)}<span class="port-lbl">${i}</span></div>`)}
      </div>
      <div class="ports-out">
        <div class="port-row"><span class="port-lbl">out</span>${port(node.id, 'out', out, `ƒ${id} ${t.name}`)}</div>
      </div>
    </div>
    ${Object.keys(t.opts ?? {}).length ? html`
      <div class="node-body fn-body">${Object.entries(t.opts).map(([k, d]) => optCtl(k, d))}</div>` : nothing}
    <span class="ng-level" data-side="in" data-key=${out} aria-hidden="true"></span>`, el);
}

// ── The cable editor, inside the selected parameter node ─────────────────

const STEP_SEL = [0, ...STEP_OPTS];

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
  return html`
    <div class="ng-editor node-body" data-freq=${isFreq ? '1' : nothing}>
      <span class="ng-edit-label">${sigLabel(m.signal)} → ${p?.label ?? m.audioParam}</span>
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
      <button type="button" class="rm-btn ng-del" aria-label="Delete cable" @click=${() => disconnect(m.id)}>×</button>
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

function rerenderPar(paramKey) {
  const n = WS.getNode(paramNodeOf(paramKey)), el = WS.nodeEl(paramNodeOf(paramKey));
  if (n && el && n.kind === 'par') renderPar(n, el);
  cacheLevelRefs();
  WS.relayout();
}

// ── Frequency picker internals ───────────────────────────────────────────
const selMapping = () => mapper.mappings.find(m => m.id === selectedId);

// Must mirror .ng-freq-kbd's CSS height at each breakpoint.
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
// place (no re-render — that would kill the interaction mid-gesture) and
// auditions the tone. The armed endpoint deliberately does NOT advance.
function pickMidi(m) {
  const s = selMapping();
  if (!s || !isFreqParam(s.audioParam)) return;
  const f = clampFreq(mtof(m));
  const field = document.querySelector(fpArm === 'min' ? '.ng-editor .m-min' : '.ng-editor .m-max');
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
// Pick on pointer*up*, and only when the pointer barely moved — on narrow
// screens the keyboard is wider than its container and scrolls.
const kbdUp = e => {
  if (!kbdPress || kbdPress.id !== e.pointerId) return;
  const moved = Math.hypot(e.clientX - kbdPress.x, e.clientY - kbdPress.y);
  kbdPress = null;
  if (moved > 10) return;
  const r = e.currentTarget.getBoundingClientRect();
  pickMidi(midiAtPoint(r.width, r.height, e.clientX - r.left, e.clientY - r.top));
};

// QWERTY note entry — active only while a frequency cable's editor is open
// and focus isn't in a form field.
const FP_KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11 };
if (globalThis.document !== undefined) document.addEventListener('keydown', e => {
  if (!document.querySelector('.ng-editor[data-freq]')) return;
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

// ── Node presence on the canvas ──────────────────────────────────────────

// Bring the canvas into step with the patch: a node for every cable end and
// every function node, the loose ones kept, anything else gone.
export function renderMapper() {
  const usedSig = new Set(), usedPar = new Set();
  for (const m of mapper.mappings) {
    if (!m.signal) continue;
    if (!FN_SIG.test(m.signal)) usedSig.add(m.signal);
    if (!FN_PAR.test(m.audioParam)) usedPar.add(m.audioParam);
  }
  for (const k of usedSig) WS.ensureNode(`sig:${k}`);
  for (const k of usedPar) if (engine.PARAMS[k]) WS.ensureNode(`par:${k}`);
  for (const g of graph.nodes()) WS.ensureNode(`fn:${g.id}`);
  const fnIds = new Set(graph.nodes().map(g => `fn:${g.id}`));
  for (const n of WS.allNodes()) {
    const key = keyOf(n.id);
    const gone = (n.kind === 'sig' && !usedSig.has(key) && !loose.has(n.id))
      || (n.kind === 'par' && (!engine.PARAMS[key] || (!usedPar.has(key) && !loose.has(n.id))))
      || (n.kind === 'fn' && !fnIds.has(n.id));
    if (gone) { loose.delete(n.id); WS.removeNode(n.id); }
  }
  WS.syncWorkspace();
  cacheLevelRefs();
  if (wiring) WS.viewportEl()?.querySelector(`.port[data-side="${wiring.side}"][data-key="${CSS.escape(wiring.key)}"]`)?.classList.add('armed');
  requestAnimationFrame(drawFreqKbd);
}

// Drop the nodes no cable uses — after a preset replaced the patch, the
// previous one's unwired ends are clutter rather than a choice.
export function pruneLoose() {
  loose.clear();
  renderMapper();
}

// Put a signal or parameter node on the canvas on purpose, at a point or in
// the flow. Returns the node id.
export function addSignalNode(key, at = null) {
  const id = `sig:${key}`;
  loose.add(id);
  WS.ensureNode(id, at ? { x: at.x, y: at.y } : {});
  renderMapper();
  return id;
}
export function addParamNode(key, at = null) {
  if (!engine.PARAMS[key]) return null;
  const id = `par:${key}`;
  loose.add(id);
  WS.ensureNode(id, at ? { x: at.x, y: at.y } : {});
  renderMapper();
  return id;
}
export function addFnNode(type, at = null) {
  const gid = graph.add(type);
  if (gid == null) return null;
  const id = `fn:${gid}`;
  WS.ensureNode(id, at ? { x: at.x, y: at.y } : {});
  renderMapper();
  return id;
}

// Remove a node and any cable attached to it. The node at the far end of each
// cable stays: pulling one node never takes a second one with it.
function removeNode(id) {
  const n = WS.getNode(id);
  if (!n) return;
  const key = keyOf(id);
  if (n.kind === 'sig') {
    mapper.mappings.filter(m => m.signal === key).forEach(m => {
      loose.add(paramNodeOf(m.audioParam)); rememberSettings(m); mapper.remove(m.id);
    });
  } else if (n.kind === 'par') {
    mapper.mappings.filter(m => m.audioParam === key).forEach(m => {
      loose.add(sigNodeOf(m.signal)); rememberSettings(m); mapper.remove(m.id);
    });
  } else if (n.kind === 'fn') {
    const fid = +key;
    for (const m of mapper.mappings) {
      if (m.signal === sigKeyOf(fid)) loose.add(paramNodeOf(m.audioParam));
      if (m.audioParam.startsWith(`fn_${fid}_`)) loose.add(sigNodeOf(m.signal));
    }
    graph.remove(fid);       // takes its cables with it
  }
  loose.delete(id);
  if (selectedId != null && !mapper.mappings.some(m => m.id === selectedId)) selectedId = null;
  WS.removeNode(id);
  renderMapper();
}

// Remove just the cable, but keep both endpoint nodes so they can be re-wired.
function disconnect(id) {
  const m = mapper.mappings.find(x => x.id === id);
  if (m) {
    if (m.signal)     loose.add(sigNodeOf(m.signal));
    if (m.audioParam) loose.add(paramNodeOf(m.audioParam));
    rememberSettings(m);
    mapper.remove(id);
  }
  if (selectedId === id) selectedId = null;
  renderMapper();
}

// ── Connection logic ─────────────────────────────────────────────────────
function connect(sigKey, paramKey) {
  if (!engine.PARAMS[paramKey]) return;
  // One incoming cable per output: replace whatever was driving this param,
  // but keep the displaced signal's node on the canvas.
  mapper.mappings.filter(m => m.audioParam === paramKey).forEach(m => {
    if (m.signal && m.signal !== sigKey) loose.add(sigNodeOf(m.signal));
    rememberSettings(m);
    mapper.remove(m.id);
  });
  const prev = lastSettings.get(paramKey);
  const [lo, hi] = prev ? [prev.outMin, prev.outMax]
    : (defaultRange(paramKey) ?? [engine.PARAMS[paramKey].min, engine.PARAMS[paramKey].max]);
  const id = mapper.add(paramKey, sigKey, lo, hi, prev?.curve ?? 'linear', prev?.steps ?? 0,
                        prev?.invert ?? false);
  loose.delete(sigNodeOf(sigKey));
  loose.delete(paramNodeOf(paramKey));
  selectedId = id;
  fpArm = 'min';
  renderMapper();
  WS.selectNodes([paramNodeOf(paramKey)]);
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
// A fingertip is ~40px across; a socket is 15px. Resolve a release point to
// an eligible socket generously: exact hit → the enclosing node's socket of
// that side → nearest socket within a fingertip's radius.
const DROP_TOL = 48;
function socketAt(x, y, wantSide) {
  const el = document.elementFromPoint(x, y);
  const direct = el?.closest?.('.port');
  if (direct && direct.dataset.side === wantSide) return direct;
  const viaNode = el?.closest?.('.node')?.querySelector(`.port[data-side="${wantSide}"]`);
  if (viaNode && viaNode.getClientRects().length) return viaNode;
  let best = null, bestD = DROP_TOL;
  document.querySelectorAll(`.port[data-side="${wantSide}"]`).forEach(s => {
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

function drawPreview(clientX, clientY) {
  const svg = WS.cablesLayer();
  if (!svg || !wiring) return;
  const from = document.querySelector(`.port.armed`)?.getBoundingClientRect();
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

const bezier = (a, b) => {
  const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
};

// Sockets: drag to connect, or tap to arm then tap the other end. One
// delegated listener on the viewport, because sockets are rendered by lit
// templates that come and go.
function initSocketGestures(root) {
  root.addEventListener('pointerdown', e => {
    const sock = e.target.closest('.port');
    if (!sock) return;
    e.preventDefault(); e.stopPropagation();
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
      // A stationary tap stays armed for the second tap.
      document.getElementById('ng-preview')?.remove();
    };
    sock.addEventListener('pointermove', move);
    sock.addEventListener('pointerup', up);
    sock.addEventListener('pointercancel', up);
  });
  root.addEventListener('keydown', e => {
    const sock = e.target.closest?.('.port');
    if (!sock || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    sock.dispatchEvent(new PointerEvent('pointerdown', { pointerId: -1, bubbles: true }));
  });
}

// ── Cables ───────────────────────────────────────────────────────────────

function drawWires() {
  const svg = WS.cablesLayer();
  if (!svg) return;
  let paths = '';
  for (const l of links()) {
    const a = WS.portEl(l.from.node, 'out', l.from.key);
    const b = WS.portEl(l.to.node, 'in', l.to.key);
    if (!a || !b) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    if (!ra.width || !rb.width) continue;
    const pa = WS.toWorld(ra.left + ra.width / 2, ra.top + ra.height / 2);
    const pb = WS.toWorld(rb.left + rb.width / 2, rb.top + rb.height / 2);
    paths += `<path d="${bezier(pa, pb)}" fill="none" stroke="${sigColor(l.from.key)}"
      stroke-width="${l.id === selectedId ? 4 : 2.5}" stroke-linecap="round"
      data-mid="${l.id}" class="ng-wire${l.id === selectedId ? ' selected' : ''}" style="opacity:0.85"/>`;
  }
  const preview = document.getElementById('ng-preview');
  svg.innerHTML = paths;
  if (preview) svg.appendChild(preview);
  wireRefs.clear();
  svg.querySelectorAll('.ng-wire').forEach(w => {
    const id = parseInt(w.dataset.mid);
    wireRefs.set(id, w);
    w.addEventListener('click', () => {
      const m = mapper.mappings.find(x => x.id === id);
      if (!m) return;
      if (selectedId === id) { selectedId = null; WS.selectNodes([]); }
      else { selectedId = id; fpArm = 'min'; WS.selectNodes([paramNodeOf(m.audioParam)]); }
      rerenderPar(m.audioParam);
      drawWires();
    });
    w.addEventListener('mouseenter', () => highlightWire(id));
    w.addEventListener('mouseleave', () => highlightWire(null));
  });
}

function highlightWire(id) {
  for (const [mid, w] of wireRefs) w.style.opacity = id == null ? 0.85 : (mid === id ? 1 : 0.15);
}

// The selection drives the editor: one parameter node selected shows its
// cable; a signal node selected shows its first cable; anything else, none.
function onSelection(ids) {
  let next = null;
  if (ids.length === 1) {
    const id = ids[0], key = keyOf(id);
    if (id.startsWith('par:')) next = mapper.mappings.find(m => m.audioParam === key && m.signal)?.id ?? null;
    else if (id.startsWith('sig:')) next = mapper.mappings.find(m => m.signal === key)?.id ?? null;
  }
  if (next === selectedId) return;
  const prev = mapper.mappings.find(m => m.id === selectedId);
  selectedId = next;
  fpArm = 'min';
  if (prev) rerenderPar(prev.audioParam);
  const now = mapper.mappings.find(m => m.id === next);
  if (now) rerenderPar(now.audioParam);
  drawWires();
}

// ── Level bars ───────────────────────────────────────────────────────────

function cacheLevelRefs() {
  levelRefs.clear();
  lastLevel.clear();
  document.querySelectorAll('#ws .ng-level').forEach(el =>
    levelRefs.set(`${el.dataset.side}:${el.dataset.key}`, el));
}

const clamp01 = v => Math.max(0, Math.min(1, v));

// How full an OUTPUT node's bar is: measured against the driving cable's own
// [outMin, outMax] — the travel you are actually playing.
function outputLevel(key) {
  const p = engine.PARAMS[key];
  if (!p) return 0;
  const m = mapper.mappings.find(x => x.audioParam === key && x.signal);
  const [lo, hi] = m ? [m.outMin, m.outMax] : [p.min, p.max];
  return hi === lo ? 0 : clamp01((p.val - lo) / (hi - lo));
}

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
    const i = refKey.indexOf(':');
    const side = refKey.slice(0, i), key = refKey.slice(i + 1);
    setLevel(refKey, side === 'in' ? clamp01(bus.norm(key)) : outputLevel(key));
  }
}

// ── Drag-out: a signal row or a parameter slider becomes a node ──────────
//
// The SIGNALS list and the PARAMETERS panel are the palettes. Each row
// carries a small socket; drag it onto the canvas to put a node there, drop
// it on a socket of the other side to wire it straight away, or just click
// it to add the node in the flow.
export function wireDragOut(root = document) {
  root.querySelectorAll('.port-src:not([data-wired])').forEach(h => {
    h.dataset.wired = '1';
    // The signal row copies its key on click; the socket is not that.
    h.addEventListener('click', e => e.stopPropagation());
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      const sigKey = h.dataset.sig, parKey = h.dataset.param;
      const side = sigKey ? 'out' : 'in', key = sigKey ?? parKey;
      try { h.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const sx = e.clientX, sy = e.clientY;
      let ghost = null;
      const move = ev => {
        if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        if (!ghost) {
          ghost = document.createElement('div');
          ghost.className = 'ws-ghost';
          ghost.textContent = sigKey ? sigLabel(key) : paramLabel(key);
          ghost.style.setProperty('--wire', sigKey ? sigColor(key) : 'var(--dim)');
          document.body.appendChild(ghost);
        }
        ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 10}px)`;
        markDropTarget(socketAt(ev.clientX, ev.clientY, side === 'out' ? 'in' : 'out'));
      };
      const up = ev => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        const dragged = !!ghost;
        ghost?.remove(); ghost = null;
        const tgt = dragged ? socketAt(ev.clientX, ev.clientY, side === 'out' ? 'in' : 'out') : null;
        markDropTarget(null);
        if (tgt) {
          if (sigKey) connect(sigKey, tgt.dataset.key); else connect(tgt.dataset.key, parKey);
          return;
        }
        const overCanvas = dragged && document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#ws');
        const at = overCanvas ? WS.toWorld(ev.clientX, ev.clientY) : null;
        const id = sigKey ? addSignalNode(key, at) : addParamNode(key, at);
        if (id) WS.selectNodes([id]);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
  });
}

// ── Add-menu entries ─────────────────────────────────────────────────────
function menuEntries() {
  const groups = new Map();
  bus.signals.forEach((s, k) => {
    const g = s.group || 'misc';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ label: s.label, hint: k, add: (x, y) => WS.selectNodes([addSignalNode(k, { x, y })]) });
  });
  const out = [];
  for (const [g, items] of groups) out.push({ title: `Signal · ${g}`, items });
  for (const [cat, keys] of PARAM_CATS()) {
    const items = keys.filter(k => engine.PARAMS[k]).map(k => ({
      label: engine.PARAMS[k].label, hint: k, add: (x, y) => WS.selectNodes([addParamNode(k, { x, y })]),
    }));
    if (items.length) out.push({ title: `Parameter · ${cat}`, items });
  }
  out.push({ title: 'Function', items: Object.entries(NODE_TYPES).map(([k, t]) => ({
    label: `ƒ ${t.name}`, hint: t.ins.length ? t.ins.join(', ') : 'a knob',
    add: (x, y) => WS.selectNodes([addFnNode(k, { x, y })]),
  })) });
  return out;
}

// ── Init ─────────────────────────────────────────────────────────────────
export function initMapperUI() {
  WS.registerRenderer('sig', renderSig);
  WS.registerRenderer('par', renderPar);
  WS.registerRenderer('fn', renderFn);
  WS.setPatchSource({ sockets, links, socketLabel, socketColor, remove: removeNode, entries: menuEntries });
  WS.onCablesDirty(drawWires);
  WS.onSelect(onSelection);
  // Nodes the saved layout still holds are there on purpose.
  for (const n of WS.allNodes()) if (n.kind === 'sig' || n.kind === 'par') loose.add(n.id);
  const root = WS.viewportEl();
  if (root) initSocketGestures(root);
}
