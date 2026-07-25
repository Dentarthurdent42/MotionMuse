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

// Output parameters grouped into meaningful categories for the picker.
const PARAM_CATS = [
  ['Oscillators', ['osc1_freq', 'osc1_detune', 'osc2_freq', 'osc2_detune', 'osc_mix']],
  ['Filter',      ['filter_freq', 'filter_q']],
  ['LFO',         ['lfo_rate', 'lfo_depth']],
  ['Output',      ['reverb_mix', 'volume']],
];

// Grouped <optgroup> option lists so the pickers stay categorized, not flat.
function groupedSignalOptions(exclude) {
  const groups = new Map();
  bus.signals.forEach((s, k) => {
    if (exclude.includes(k)) return;
    const g = s.group || 'misc';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(`<option value="${k}">${s.label}</option>`);
  });
  let o = '';
  groups.forEach((opts, g) => { o += `<optgroup label="${g}">${opts.join('')}</optgroup>`; });
  return o;
}
function groupedParamOptions(exclude) {
  let o = '';
  for (const [cat, keys] of PARAM_CATS) {
    const av = keys.filter(k => !exclude.includes(k));
    if (av.length) o += `<optgroup label="${cat}">${av.map(k => `<option value="${k}">${engine.PARAMS[k].label}</option>`).join('')}</optgroup>`;
  }
  return o;
}

// Stable, legible cable/socket colour per signal (OKLab hue from a hash).
function sigHue(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}
const sigColor = key => key ? `oklch(0.78 0.14 ${sigHue(key)})` : 'oklch(0.6 0 0)';

let selectedId = null;          // selected cable (mapping id)
let addedInputs = new Set();    // input nodes with no cable yet (user-added)
let addedOutputs = new Set();   // output nodes with no cable yet (user-added)
let wiring = null;              // in-progress connection { side, key, moved }

// Musical default ranges for freshly-wired outputs (else the param's full range).
const DEFAULT_RANGE = { osc1_freq: [220, 880], osc2_freq: [220, 880] };

// Nodes shown = endpoints used by a mapping ∪ user-added — so the canvas
// isn't cluttered with every possible output up front.
function inputKeys() {
  const used = mapper.mappings.filter(m => m.signal).map(m => m.signal);
  return [...new Set([...used, ...addedInputs])];
}
function outputKeys() {
  const used = mapper.mappings.filter(m => m.signal).map(m => m.audioParam);
  return PARAM_KEYS.filter(k => used.includes(k) || addedOutputs.has(k));
}

export function renderMapper() {
  const rows = document.getElementById('mapper-rows');

  const inputs = inputKeys();
  const outputs = outputKeys();

  const inNodes = inputs.map(k => `
    <div class="ng-node ng-in" data-key="${k}" style="--wire:${sigColor(k)}">
      <span class="ng-node-title" title="${sigLabel(k)}">${sigLabel(k)}</span>
      <button class="ng-node-del" data-kind="in" data-key="${k}" aria-label="Remove ${sigLabel(k)}">×</button>
      <button class="ng-socket ng-out" data-side="out" data-key="${k}"
              aria-label="Output of ${sigLabel(k)} — connect to a parameter"></button>
    </div>`).join('');

  const outNodes = outputs.map(k => {
    const wired = mapper.mappings.find(m => m.audioParam === k && m.signal);
    return `
    <div class="ng-node ng-out${wired ? ' wired' : ''}" data-key="${k}"
         style="${wired ? `--wire:${sigColor(wired.signal)}` : ''}">
      <button class="ng-socket ng-in" data-side="in" data-key="${k}"
              aria-label="Input of ${engine.PARAMS[k].label}"></button>
      <button class="ng-node-del" data-kind="out" data-key="${k}" aria-label="Remove ${engine.PARAMS[k].label}">×</button>
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
      <div class="ng-col ng-col-out">${outNodes || '<div class="ng-hint">add an output ↓</div>'}</div>
    </div>
    <div class="ng-addbar">
      <select id="ng-add-input" aria-label="Add an input signal">
        <option value="">+ add input…</option>
        ${groupedSignalOptions(inputs)}
      </select>
      <select id="ng-add-output" aria-label="Add an output parameter">
        <option value="">+ add output…</option>
        ${groupedParamOptions(outputs)}
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
  rows.querySelector('#ng-add-output')?.addEventListener('change', e => {
    if (e.target.value) { addedOutputs.add(e.target.value); renderMapper(); }
  });

  // Remove a node entirely (and any cable attached to it). Works even in the
  // minimal one-in/one-out case.
  rows.querySelectorAll('.ng-node-del').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    removeNode(btn.dataset.kind, btn.dataset.key);
  }));

  // Connect by dragging one socket onto another, or tap-to-arm then tap the
  // target (touch- and keyboard-friendly). On touch the pointer is implicitly
  // captured by the origin, so the drop target is found with elementFromPoint
  // rather than relying on the target's own pointerup.
  rows.querySelectorAll('.ng-socket').forEach(sock => {
    sock.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (wiring && wiring.key !== sock.dataset.key && wiring.side !== sock.dataset.side) {
        finishWire(sock); return;                 // second tap of tap-to-connect
      }
      if (wiring && wiring.key === sock.dataset.key && wiring.side === sock.dataset.side) {
        cancelWire(); return;                      // tap same socket again → cancel
      }
      wiring = { side: sock.dataset.side, key: sock.dataset.key, moved: false, id: e.pointerId };
      sock.classList.add('armed');
      try { sock.setPointerCapture(e.pointerId); } catch { /* ok */ }
    });
    sock.addEventListener('pointermove', e => {
      if (!wiring || wiring.id !== e.pointerId) return;
      wiring.moved = true;
      drawPreview(e.clientX, e.clientY);
    });
    sock.addEventListener('pointerup', e => {
      if (!wiring || wiring.id !== e.pointerId) return;
      const tgt = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.ng-socket');
      if (tgt && tgt.dataset.side !== wiring.side) finishWire(tgt);
      else if (wiring.moved) cancelWire();          // dragged to nowhere → cancel
      // else: a stationary tap — stay armed for tap-to-connect
    });
    sock.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sock.dispatchEvent(new PointerEvent('pointerdown', { pointerId: -1, bubbles: true })); }
    });
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
    if (selectedId != null) disconnect(selectedId);
  });

  function sel() { return mapper.mappings.find(m => m.id === selectedId); }
}

// Remove just the cable, but keep both endpoint nodes on the canvas so they
// can be re-wired — disconnecting shouldn't make the nodes vanish.
function disconnect(id) {
  const m = mapper.mappings.find(x => x.id === id);
  if (m) {
    if (m.signal)     addedInputs.add(m.signal);
    if (m.audioParam) addedOutputs.add(m.audioParam);
    mapper.remove(id);
  }
  selectedId = null;
  renderMapper();
}

// Remove a node and any cable attached to it.
function removeNode(kind, key) {
  if (kind === 'in') {
    addedInputs.delete(key);
    mapper.mappings.filter(m => m.signal === key).forEach(m => {
      addedOutputs.add(m.audioParam);   // keep the far end's node
      mapper.remove(m.id);
    });
  } else {
    addedOutputs.delete(key);
    mapper.mappings.filter(m => m.audioParam === key).forEach(m => mapper.remove(m.id));
  }
  selectedId = null;
  renderMapper();
}

// ── Connection logic ──
function connect(sigKey, paramKey) {
  // One incoming cable per output: replace whatever was driving this param,
  // but keep the displaced signal's node on the canvas (it just loses a cable).
  mapper.mappings.filter(m => m.audioParam === paramKey).forEach(m => {
    if (m.signal && m.signal !== sigKey) addedInputs.add(m.signal);
    mapper.remove(m.id);
  });
  const [lo, hi] = DEFAULT_RANGE[paramKey] ?? [engine.PARAMS[paramKey].min, engine.PARAMS[paramKey].max];
  const id = mapper.add(paramKey, sigKey, lo, hi);
  addedInputs.delete(sigKey);
  addedOutputs.delete(paramKey);
  selectedId = id;
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
  document.querySelectorAll('.ng-socket.armed').forEach(s => s.classList.remove('armed'));
  document.getElementById('ng-preview')?.remove();
}
function drawPreview(clientX, clientY) {
  const g = document.getElementById('nodegraph'), svg = document.getElementById('ng-wires');
  if (!g || !svg || !wiring) return;
  const box = g.getBoundingClientRect();
  const from = g.querySelector(`.ng-socket.ng-${wiring.side}[data-key="${wiring.key}"]`)?.getBoundingClientRect();
  if (!from) return;
  const x1 = from.left + from.width / 2 - box.left, y1 = from.top + from.height / 2 - box.top;
  const x2 = clientX - box.left, y2 = clientY - box.top;
  let path = document.getElementById('ng-preview');
  if (!path) {
    path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.id = 'ng-preview'; path.setAttribute('fill', 'none');
    path.setAttribute('stroke', sigColor(wiring.side === 'out' ? wiring.key : ''));
    path.setAttribute('stroke-width', '2.5'); path.setAttribute('stroke-dasharray', '5 4');
    svg.appendChild(path);
  }
  const dx = Math.max(20, Math.abs(x2 - x1) * 0.5) * (wiring.side === 'out' ? 1 : -1);
  path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
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
