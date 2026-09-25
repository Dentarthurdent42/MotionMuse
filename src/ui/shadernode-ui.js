// Shader nodes on the workspace canvas.
//
// A shader node looks and behaves like a function node — a header, inputs
// down the left, its result on the right — with one difference you can see:
// its sockets are COLOURED BY TYPE rather than by which signal reaches them.
// A number, a coordinate and a colour are different kinds of thing, and in a
// graph where anything plugs into anything it should be possible to tell at a
// glance which is which without reading the labels.
//
//   number      a value, 0–1. Also the only kind a SIGNAL cable can drive, so
//               these are the sockets where the instrument reaches the picture.
//   coordinate  where on the screen a pattern is being asked about.
//   colour      three numbers, usually red/green/blue.
//
// Mismatches are converted rather than refused (shadergraph.js `cast`), so the
// colours are guidance, not a fence: a number into a colour socket is a grey,
// which is exactly what you would want it to mean.
//
// The cables themselves are drawn by mapper-ui.js, which draws every cable on
// the canvas whoever owns it. This module supplies the sockets and links for
// the shader half and renders the node bodies; it holds no cable state of its
// own — that lives in shadergraph.js.

import { html, render, nothing } from '../../vendor/lit-html.js';
import { shadergraph, SHADER_NODES, CATS, shxInKey, shxOutKey, nodeIdOf, isShaderOut }
  from '../shadergraph.js';
import * as WS from './workspace.js';

// One colour per type, as CSS custom properties so themes can move them.
const TYPE_COLOR = {
  float: 'var(--shx-float)',
  vec2:  'var(--shx-vec2)',
  vec3:  'var(--shx-vec3)',
};
const TYPE_WORD = { float: 'number', vec2: 'coordinate', vec3: 'colour' };

export const isShaderNodeId = id => /^shx:\d+$/.test(String(id));
const wsIdOf = id => `shx:${id}`;
const graphIdOf = wsId => +String(wsId).slice(4);

// The colour a shader socket and its cable are drawn in. mapper-ui asks this
// before falling back to its per-signal hues, so a shader cable reads as its
// type while a signal cable reads as its signal.
export function shaderKeyColor(key) {
  const t = shadergraph.typeOfKey(key);
  return t ? TYPE_COLOR[t] : null;
}

export function shaderKeyLabel(key) {
  const id = nodeIdOf(key);
  if (id == null) return null;
  const n = shadergraph.nodes().find(x => x.id === id);
  if (!n) return null;
  const t = SHADER_NODES[n.type];
  if (isShaderOut(key)) return `▨${id} ${t.name}`;
  const s = t.ins.find(s => shxInKey(id, s.name) === key);
  return s ? `▨${id} ${t.name} · ${s.name.toUpperCase()}` : null;
}

// ── Sockets and links, for the canvas ────────────────────────────────────
//
// Only the sockets the parameter table does NOT already provide: a float
// input is an engine parameter and arrives through params.js like any other,
// so listing it here too would put two sockets with one key on one node.
export function shaderSockets() {
  const out = [];
  for (const n of shadergraph.nodes()) {
    const { ins, out: o } = shadergraph.socketsOf(n.id);
    const node = wsIdOf(n.id);
    if (o) out.push({ node, side: 'out', key: o.key });
    for (const s of ins) if (!s.uniform) out.push({ node, side: 'in', key: s.key });
  }
  return out;
}

// Shader link ids live in a band of their own so they can share the canvas's
// one id space with the mapper's cables without ever colliding — the wire
// elements carry the id in a data attribute that is parsed as a number.
export const SHX_LINK_BASE = 1e9;
export const isShaderLinkId = id => Number.isFinite(id) && id >= SHX_LINK_BASE;
export const shaderLinkIdOf = id => id - SHX_LINK_BASE;

export function shaderLinks() {
  return shadergraph.links().map(l => ({
    id: l.id + SHX_LINK_BASE,
    from: { node: wsIdOf(l.from), key: shxOutKey(l.from) },
    to:   { node: wsIdOf(nodeIdOf(l.to)), key: l.to },
  }));
}

// ── The node body ────────────────────────────────────────────────────────

const port = (side, key, type, label) => html`
  <button class="port port-${side} shx-port" type="button" data-side=${side} data-key=${key}
          data-type=${type} style="--wire:${TYPE_COLOR[type]}"
          aria-label=${`${side === 'out' ? 'Output' : 'Input'} ${label} — ${TYPE_WORD[type]}`}
          title=${`${label} · ${TYPE_WORD[type]}`}></button>`;

function renderShaderNode(node, el) {
  const id = graphIdOf(node.id);
  const g = shadergraph.nodes().find(x => x.id === id);
  if (!g) { render(nothing, el); return; }
  const t = SHADER_NODES[g.type];
  const { ins, out } = shadergraph.socketsOf(id);
  el.style.setProperty('--wire', TYPE_COLOR[t.out]);
  el.dataset.shxCat = t.cat;

  const optCtl = (key, decl) => {
    const set = v => { shadergraph.setOpt(id, key, v); onChange(); };
    if (decl.kind === 'choice') return html`
      <label class="fn-opt">${key}
        <select aria-label=${`${key} of shader node ${id}`} @change=${e => set(e.target.value)}>
          ${decl.of.map(v => html`<option value=${v} ?selected=${v === g.opts[key]}>${String(v).toUpperCase()}</option>`)}
        </select></label>`;
    return html`
      <label class="fn-opt">${key}
        <input type="range" min="0" max="1" step="0.01" .value=${String(g.opts[key])}
               aria-label=${`${key} of shader node ${id}`} @input=${e => set(e.target.value)}></label>`;
  };

  render(html`
    <div class="node-head">
      <span class="node-title sec-title" title=${`▨${id} ${t.name} — ${t.help ?? ''}`}>▨${id} ${t.name.toUpperCase()}</span>
    </div>
    <div class="node-ports">
      <div class="ports-in">
        ${ins.map(s => html`
          <div class="port-row">
            ${port('in', s.key, s.type, `${t.name} · ${s.name}`)}
            <span class="port-lbl">${s.name}</span>
          </div>`)}
      </div>
      <div class="ports-out">
        ${out ? html`<div class="port-row">
          <span class="port-lbl">out</span>${port('out', out.key, out.type, `▨${id} ${t.name}`)}
        </div>` : nothing}
      </div>
    </div>
    ${Object.keys(t.opts ?? {}).length ? html`
      <div class="node-body fn-body">${Object.entries(t.opts).map(([k, d]) => optCtl(k, d))}</div>` : nothing}
    ${t.help ? html`<div class="node-body shx-help">${t.help}</div>` : nothing}`, el);
}

// ── Keeping the canvas in step ───────────────────────────────────────────

let onChange = () => {};
export function setOnChange(fn) { onChange = fn; }
// Anything that edits the shader graph from OUTSIDE this module — the
// panel's RESET, a preset being loaded — calls this so the canvas grows and
// drops node shells to match.
export function shaderChanged() { onChange(); }

// A workspace node for every shader node, and none for one that is gone.
export function syncShaderNodes() {
  for (const g of shadergraph.nodes()) WS.ensureNode(wsIdOf(g.id));
  const live = new Set(shadergraph.nodes().map(g => wsIdOf(g.id)));
  for (const n of WS.allNodes()) if (n.kind === 'shx' && !live.has(n.id)) WS.removeNode(n.id);
}

export function addShaderNode(type, at = null) {
  const before = new Set(shadergraph.nodes().map(n => n.id));
  const gid = shadergraph.add(type);
  if (gid == null) return null;
  const id = wsIdOf(gid);
  // add() of a second Output returns the one that already exists; reveal it
  // rather than dropping an invisible duplicate where the user clicked.
  if (before.has(gid)) { onChange(); WS.revealNode(id); return id; }
  WS.ensureNode(id, at ? { x: at.x, y: at.y } : {});
  onChange();
  return id;
}

export function removeShaderNode(id) {
  if (!isShaderNodeId(id)) return;
  shadergraph.remove(graphIdOf(id));
  WS.removeNode(id);
  onChange();
}

// ── Add-menu entries ─────────────────────────────────────────────────────
export function shaderMenuEntries() {
  const byCat = new Map(CATS.map(c => [c, []]));
  for (const [key, t] of Object.entries(SHADER_NODES)) {
    if (!byCat.has(t.cat)) byCat.set(t.cat, []);
    byCat.get(t.cat).push({
      label: `▨ ${t.name}`,
      hint: t.help ?? (t.ins.length ? t.ins.map(s => s.name).join(', ') : 'a source'),
      add: (x, y) => WS.selectNodes([addShaderNode(key, { x, y })].filter(Boolean)),
    });
  }
  return [...byCat.entries()].filter(([, items]) => items.length)
    .map(([cat, items]) => ({ title: `Shader · ${cat}`, items }));
}

export function initShaderNodeUI() {
  WS.registerRenderer('shx', renderShaderNode);
}
