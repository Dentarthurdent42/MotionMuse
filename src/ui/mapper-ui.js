// Node-graph mapper — inputs (signals) on the left, outputs (parameters) on
// the right, wired together with cables. The point is INPUT REUSE: each signal
// is a single node with one output socket that fans out to as many parameter
// nodes as you like (à la Blender geometry nodes / UE Blueprints). Each output
// parameter takes a single incoming cable (it can only be driven by one thing
// at a time). Connect by dragging from one socket to another (or click a
// socket, then click a target). Click a cable to edit its range/curve; that
// stays hidden otherwise to keep the graph uncluttered.

import { bus }    from '../bus.js';
import { engine } from '../engine.js';
import { mapper } from '../mapper.js';

const PARAM_KEYS = Object.keys(engine.PARAMS);

const CURVE_OPTS = [
  ['linear', 'Linear'], ['quad', 'Quadratic'], ['cubic', 'Cubic'],
  ['log', 'Logarithmic'], ['sqrt', 'Square Root'], ['inv', 'Invert'],
].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

const sigLabel = k => bus.signals.get(k)?.label ?? k;

// Stable, legible cable/socket colour per signal (OKLab hue from a hash).
function sigHue(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}
const sigColor = key => key ? `oklch(0.78 0.14 ${sigHue(key)})` : 'oklch(0.6 0 0)';

let selectedId = null;          // selected cable (mapping id)
let addedInputs = new Set();    // input nodes with no cable yet (user-added)
let wiring = null;              // in-progress connection { side, key }

// Input nodes shown = signals used by a mapping ∪ user-added, in a stable order.
function inputKeys() {
  const used = mapper.mappings.filter(m => m.signal).map(m => m.signal);
  return [...new Set([...used, ...addedInputs])];
}

export function renderMapper() {
  const rows = document.getElementById('mapper-rows');

  const inputs = inputKeys();
  const addable = [...bus.signals.keys()].filter(k => !inputs.includes(k));

  const inNodes = inputs.map(k => `
    <div class="ng-node ng-in" data-key="${k}" style="--wire:${sigColor(k)}">
      <span class="ng-node-title" title="${sigLabel(k)}">${sigLabel(k)}</span>
      <button class="ng-socket ng-out" data-side="out" data-key="${k}"
              aria-label="Output of ${sigLabel(k)} — connect to a parameter"></button>
    </div>`).join('');

  const outNodes = PARAM_KEYS.map(k => {
    const wired = mapper.mappings.find(m => m.audioParam === k && m.signal);
    return `
    <div class="ng-node ng-out${wired ? ' wired' : ''}" data-key="${k}"
         style="${wired ? `--wire:${sigColor(wired.signal)}` : ''}">
      <button class="ng-socket ng-in" data-side="in" data-key="${k}"
              aria-label="Input of ${engine.PARAMS[k].label}"></button>
      <span class="ng-node-title">${engine.PARAMS[k].label}</span>
    </div>`;
  }).join('');

  const sel = selectedId != null ? mapper.mappings.find(m => m.id === selectedId) : null;
  const editor = sel ? `
    <div id="ng-editor">
      <span class="ng-edit-label">${sigLabel(sel.signal)} → ${engine.PARAMS[sel.audioParam].label}</span>
      <label>min <input type="number" class="m-min" value="${sel.outMin}" step="any"></label>
      <label>max <input type="number" class="m-max" value="${sel.outMax}" step="any"></label>
      <label>curve <select class="m-curve">${CURVE_OPTS.replace(`value="${sel.curve}"`, `value="${sel.curve}" selected`)}</select></label>
      <button class="rm-btn" id="ng-del" aria-label="Delete cable">×</button>
    </div>` : '';

  rows.innerHTML = `
    <div id="nodegraph">
      <svg id="ng-wires" aria-hidden="true"></svg>
      <div class="ng-col ng-col-in">${inNodes || '<div class="ng-hint">add an input ↓</div>'}</div>
      <div class="ng-col ng-col-out">${outNodes}</div>
    </div>
    <div class="ng-addbar">
      <select id="ng-add-input" aria-label="Add an input signal">
        <option value="">+ add input…</option>
        ${addable.map(k => `<option value="${k}">${sigLabel(k)}</option>`).join('')}
      </select>
    </div>
    ${editor}`;

  wireHandlers(rows);
  ensureRedrawObserver();
  requestAnimationFrame(drawWires);
}

function wireHandlers(rows) {
  rows.querySelector('#ng-add-input')?.addEventListener('change', e => {
    if (e.target.value) { addedInputs.add(e.target.value); renderMapper(); }
  });

  rows.querySelectorAll('.ng-socket').forEach(sock => {
    sock.addEventListener('pointerdown', e => { e.preventDefault(); beginWire(sock); });
    sock.addEventListener('pointerup',   e => { e.preventDefault(); endWireOn(sock); });
    sock.addEventListener('click',        () => clickSocket(sock));   // click-to-connect / a11y
  });

  rows.querySelectorAll('.m-min').forEach(el => el.addEventListener('change', e => {
    if (sel()) sel().outMin = parseFloat(e.target.value);
  }));
  rows.querySelectorAll('.m-max').forEach(el => el.addEventListener('change', e => {
    if (sel()) sel().outMax = parseFloat(e.target.value);
  }));
  rows.querySelectorAll('.m-curve').forEach(el => el.addEventListener('change', e => {
    if (sel()) sel().curve = e.target.value;
  }));
  rows.querySelector('#ng-del')?.addEventListener('click', () => {
    if (selectedId != null) { mapper.remove(selectedId); selectedId = null; renderMapper(); }
  });

  function sel() { return mapper.mappings.find(m => m.id === selectedId); }
}

// ── Connection logic ──
function connect(sigKey, paramKey) {
  // One incoming cable per output: replace whatever was driving this param.
  mapper.mappings.filter(m => m.audioParam === paramKey).map(m => m.id)
    .forEach(id => mapper.remove(id));
  const id = mapper.add(paramKey, sigKey);   // defaults to the param's full range
  addedInputs.delete(sigKey);                // it's a real wired input now
  selectedId = id;
  renderMapper();
}

function beginWire(sock) { wiring = { side: sock.dataset.side, key: sock.dataset.key }; highlightArmed(sock); }
function endWireOn(sock) {
  if (!wiring) return;
  if (sock.dataset.side !== wiring.side) {
    const sig   = wiring.side === 'out' ? wiring.key : sock.dataset.key;
    const param = wiring.side === 'out' ? sock.dataset.key : wiring.key;
    connect(sig, param);
  }
  wiring = null; clearPreview();
}
function clickSocket(sock) {
  // Click one socket to arm, another (opposite side) to connect.
  if (!wiring) { beginWire(sock); return; }
  if (sock.dataset.side === wiring.side && sock.dataset.key === wiring.key) { wiring = null; clearPreview(); return; }
  endWireOn(sock);
}

function highlightArmed(sock) {
  document.querySelectorAll('.ng-socket.armed').forEach(s => s.classList.remove('armed'));
  sock.classList.add('armed');
}
function clearPreview() {
  document.querySelectorAll('.ng-socket.armed').forEach(s => s.classList.remove('armed'));
  const prev = document.getElementById('ng-preview'); if (prev) prev.remove();
}

// Cancel an armed/dragging wire when releasing on empty space.
if (typeof window !== 'undefined') {
  window.addEventListener('pointerup', e => {
    if (wiring && !e.target?.classList?.contains('ng-socket')) { /* keep armed for click-to-connect */ }
  });
}

// ── Draw cables ──
function drawWires() {
  const g   = document.getElementById('nodegraph');
  const svg = document.getElementById('ng-wires');
  if (!g || !svg) return;
  const box = g.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.setAttribute('width', box.width); svg.setAttribute('height', box.height);

  const pin = (side, key) => {
    const el = g.querySelector(`.ng-socket.ng-${side}[data-key="${key}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top };
  };

  let paths = '';
  mapper.mappings.forEach(m => {
    if (!m.signal) return;
    const a = pin('out', m.signal), b = pin('in', m.audioParam);
    if (!a || !b) return;
    const dx = Math.max(30, (b.x - a.x) * 0.5);
    const d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    const col = sigColor(m.signal);
    paths += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${m.id === selectedId ? 4 : 2.5}"
      stroke-linecap="round" data-mid="${m.id}" class="ng-wire" style="opacity:0.85"/>`;
  });
  svg.innerHTML = paths;

  svg.querySelectorAll('.ng-wire').forEach(w => {
    w.style.pointerEvents = 'stroke';
    w.addEventListener('click', () => {
      const id = parseInt(w.dataset.mid);
      selectedId = selectedId === id ? null : id;
      renderMapper();
    });
    w.addEventListener('mouseenter', () => highlightWire(parseInt(w.dataset.mid)));
    w.addEventListener('mouseleave', () => highlightWire(null));
  });
}

function highlightWire(id) {
  const svg = document.getElementById('ng-wires');
  if (!svg) return;
  svg.querySelectorAll('.ng-wire').forEach(w =>
    w.style.opacity = id == null ? 0.85 : (w.dataset.mid == id ? 1 : 0.15));
}

let _ro = null;
function ensureRedrawObserver() {
  if (_ro || typeof ResizeObserver === 'undefined') return;
  const el = document.getElementById('mapper-rows');
  if (!el) return;
  _ro = new ResizeObserver(() => drawWires());
  _ro.observe(el);
}

export function updateMapperBars() {
  const svg = document.getElementById('ng-wires');
  if (!svg) return;
  mapper.mappings.forEach(m => {
    const w = svg.querySelector(`.ng-wire[data-mid="${m.id}"]`);
    if (!w || !m.signal) return;
    const p = engine.PARAMS[m.audioParam];
    const norm = p ? Math.max(0, Math.min(1, (p.val - p.min) / (p.max - p.min))) : 0;
    if (m.id !== selectedId) w.style.strokeWidth = (2 + norm * 3).toFixed(2);
    w.style.opacity = (0.55 + norm * 0.45).toFixed(2);
  });
}
