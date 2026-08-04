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
import { mtof, parseNote, midiName }        from '../scale.js';
import { drawKeyboard, midiAtPoint, midiOf } from './keyboard.js';

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
const wireRefs = new Map();     // mapping id → <path>, cached per drawWires (per-frame lookups)
let addedInputs = new Set();    // input nodes with no cable yet (user-added)
let addedOutputs = new Set();   // output nodes with no cable yet (user-added)
let wiring = null;              // in-progress connection { side, key, moved }

// Musical default ranges for freshly-wired outputs (else the param's full range).
const DEFAULT_RANGE = { osc1_freq: [220, 880], osc2_freq: [220, 880] };

// ── Frequency-range picker state (oscillator-frequency cables only) ──────
// Pick the min/max of the range as *tones*: click the labeled piano, play
// QWERTY keys (A W S E D F T G Y H U J, Z/X octave), or type "A4" in the
// fields. `fpArm` is which endpoint the next pick sets.
const FREQ_PARAMS = new Set(['osc1_freq', 'osc2_freq']);
const clampFreq = f => Math.round(Math.max(40, Math.min(2000, f)) * 10) / 10;
let fpArm = 'min';
let fpOct = 4;

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
  const isFreq = sel && FREQ_PARAMS.has(sel.audioParam);
  // Frequency cables use text inputs (they accept note names like "A4") plus
  // a click/QWERTY-playable labeled piano; everything else keeps number inputs.
  const editor = sel ? `
    <div id="ng-editor"${isFreq ? ' data-freq="1"' : ''}>
      <span class="ng-edit-label">${sigLabel(sel.signal)} → ${engine.PARAMS[sel.audioParam].label}</span>
      <label>min <input type="${isFreq ? 'text' : 'number'}" class="m-min" value="${sel.outMin}"
        ${isFreq ? `title="${midiName(midiOf(sel.outMin))} — Hz or a note name like A4"` : 'step="any"'}></label>
      <label>max <input type="${isFreq ? 'text' : 'number'}" class="m-max" value="${sel.outMax}"
        ${isFreq ? `title="${midiName(midiOf(sel.outMax))} — Hz or a note name like A4"` : 'step="any"'}></label>
      <label>curve <select class="m-curve">${CURVE_OPTS.replace(`value="${sel.curve}"`, `value="${sel.curve}" selected`)}</select></label>
      <button class="rm-btn" id="ng-del" aria-label="Delete cable">×</button>
      ${isFreq ? `
      <div class="ng-freq-picker">
        <div class="ng-freq-bar">
          <button class="wave-btn${fpArm === 'min' ? ' on' : ''}" id="fp-min" aria-pressed="${fpArm === 'min'}">SET MIN</button>
          <button class="wave-btn${fpArm === 'max' ? ' on' : ''}" id="fp-max" aria-pressed="${fpArm === 'max'}">SET MAX</button>
          <span class="ng-freq-oct" id="fp-oct">oct ${fpOct} · Z/X</span>
        </div>
        <canvas id="fp-kbd" class="ng-freq-kbd"
                aria-label="Piano keyboard — click a key to set the armed endpoint"></canvas>
        <div class="ng-freq-hint">click a key or play A W S E D F T G Y H U J · type "C#4" or Hz above · ● min ● max</div>
      </div>` : ''}
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
  requestAnimationFrame(() => { drawWires(); drawFreqKbd(); });
}

// ── Frequency picker internals ────────────────────────────────────────────
const selMapping = () => mapper.mappings.find(m => m.id === selectedId);

function drawFreqKbd() {
  const s = selMapping(), c = document.getElementById('fp-kbd');
  if (!s || !c || !FREQ_PARAMS.has(s.audioParam)) return;
  // m1 (purple) marks the range MIN, m2 (cyan) the range MAX.
  drawKeyboard(c, { height: 56, labels: true, scale: null,
                    m1: midiOf(s.outMin), m2: midiOf(s.outMax) });
}

function armEndpoint(which) {
  fpArm = which;
  document.getElementById('fp-min')?.classList.toggle('on', fpArm === 'min');
  document.getElementById('fp-max')?.classList.toggle('on', fpArm === 'max');
  document.getElementById('fp-min')?.setAttribute('aria-pressed', String(fpArm === 'min'));
  document.getElementById('fp-max')?.setAttribute('aria-pressed', String(fpArm === 'max'));
}

// Apply a picked tone to the armed endpoint. Mutates the mapping + field in
// place (no renderMapper — a full innerHTML rebuild would kill the
// interaction mid-gesture) and auditions the tone.
function pickMidi(m) {
  const s = selMapping();
  if (!s || !FREQ_PARAMS.has(s.audioParam)) return;
  const f = clampFreq(mtof(m));
  const field = document.querySelector(fpArm === 'min' ? '#ng-editor .m-min' : '#ng-editor .m-max');
  if (fpArm === 'min') s.outMin = f; else s.outMax = f;
  if (field) { field.value = f; field.title = `${midiName(m)} — Hz or a note name like A4`; }
  if (fpArm === 'min') armEndpoint('max');   // natural flow: pick min, then max
  engine.playTone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.1 });
  drawFreqKbd();
}

// QWERTY note entry — one document-level listener (module scope survives
// renderMapper rebuilds; it re-queries the DOM per event). Active only while
// a frequency cable's editor is open and focus isn't in a form field.
const FP_KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11 };
// Guarded so the module stays importable in node (unit tests).
if (typeof document !== 'undefined') document.addEventListener('keydown', e => {
  if (!document.querySelector('#ng-editor[data-freq]')) return;
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
  if (k in FP_KEYMAP) {
    e.preventDefault();
    pickMidi(12 * (fpOct + 1) + FP_KEYMAP[k]);
  }
});

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

  // Range fields. Frequency cables also accept note names ("A4", "C#3") —
  // parsed to Hz on commit; garbage restores the previous value.
  const parseField = (raw, isFreq) => {
    if (isFreq) {
      const m = parseNote(raw);
      if (m != null) return clampFreq(mtof(m));
    }
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };
  const fieldHandler = which => e => {
    const s = sel();
    if (!s) return;
    const isFreq = FREQ_PARAMS.has(s.audioParam);
    const v = parseField(e.target.value, isFreq);
    if (v == null) { e.target.value = which === 'min' ? s.outMin : s.outMax; return; }
    if (which === 'min') s.outMin = v; else s.outMax = v;
    e.target.value = v;   // note names echo back as the resolved Hz
    if (isFreq) {
      e.target.title = `${midiName(midiOf(v))} — Hz or a note name like A4`;
      engine.playTone({ freq: v, dur: 0.3, type: 'triangle', gain: 0.1 });
      drawFreqKbd();
    }
  };
  rows.querySelectorAll('.m-min').forEach(el => el.addEventListener('change', fieldHandler('min')));
  rows.querySelectorAll('.m-max').forEach(el => el.addEventListener('change', fieldHandler('max')));
  rows.querySelectorAll('.m-curve').forEach(el => el.addEventListener('change', e => {
    if (sel()) sel().curve = e.target.value;
  }));
  rows.querySelector('#ng-del')?.addEventListener('click', () => {
    if (selectedId != null) disconnect(selectedId);
  });

  // Frequency picker: arm buttons + clickable piano.
  rows.querySelector('#fp-min')?.addEventListener('click', () => armEndpoint('min'));
  rows.querySelector('#fp-max')?.addEventListener('click', () => armEndpoint('max'));
  rows.querySelector('#fp-kbd')?.addEventListener('pointerdown', e => {
    e.preventDefault();
    const r = e.target.getBoundingClientRect();
    pickMidi(midiAtPoint(r.width, r.height, e.clientX - r.left, e.clientY - r.top));
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
  fpArm = 'min';   // a fresh cable's picker starts at the min endpoint
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

  wireRefs.clear();
  svg.querySelectorAll('.ng-wire').forEach(w => {
    wireRefs.set(parseInt(w.dataset.mid), w);
    w.style.pointerEvents = 'stroke';
    w.addEventListener('click', () => {
      const id = parseInt(w.dataset.mid);
      selectedId = selectedId === id ? null : id;
      fpArm = 'min';   // fresh selection → picker starts at the min endpoint
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
  if (!wireRefs.size) return;
  mapper.mappings.forEach(m => {
    const w = wireRefs.get(m.id);
    if (!w || !m.signal) return;
    const p = engine.PARAMS[m.audioParam];
    const norm = p ? Math.max(0, Math.min(1, (p.val - p.min) / (p.max - p.min))) : 0;
    if (m.id !== selectedId) w.style.strokeWidth = (2 + norm * 3).toFixed(2);
    w.style.opacity = (0.55 + norm * 0.45).toFixed(2);
  });
}
