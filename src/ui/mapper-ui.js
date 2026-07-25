// Patchbay mapper UI. Each mapping is a patch cable from an input jack (a
// signal, left) to an output jack (an audio parameter, right), drawn as a
// colour-coded bezier over an SVG layer. Range/curve controls stay hidden
// until a cable is selected — keeping the resting view uncluttered — and
// hovering a lane highlights its cable while dimming the rest.

import { bus }    from '../bus.js';
import { engine } from '../engine.js';
import { mapper } from '../mapper.js';

const AP_OPTS = Object.entries(engine.PARAMS)
  .map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');

const CURVE_OPTS = [
  ['linear', 'Linear'], ['quad', 'Quadratic'], ['cubic', 'Cubic'],
  ['log', 'Logarithmic'], ['sqrt', 'Square Root'], ['inv', 'Invert'],
].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

function sigOpts() {
  let o = `<option value="">— none —</option>`;
  const groups = new Map();
  bus.signals.forEach((s, k) => {
    const g = s.group || 'misc';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ k, s });
  });
  groups.forEach((sigs, g) => {
    o += `<optgroup label="${g}">`;
    sigs.forEach(({ k, s }) => { o += `<option value="${k}">${s.label}</option>`; });
    o += `</optgroup>`;
  });
  return o;
}

// Stable, legible cable colour per signal (OKLab hue from a string hash).
function sigHue(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}
const cableColor = key => key ? `oklch(0.78 0.14 ${sigHue(key)})` : 'oklch(0.5 0 0)';

let selectedId = null;

// Cables are positioned from measured DOM, so re-draw whenever the mapper
// column changes width (window resize, panel splitter drag).
let _ro = null;
function ensureRedrawObserver() {
  if (_ro) return;
  const el = document.getElementById('mapper-rows');
  if (!el || typeof ResizeObserver === 'undefined') return;
  _ro = new ResizeObserver(() => drawWires());
  _ro.observe(el);
}

export function renderMapper() {
  const rows  = document.getElementById('mapper-rows');
  const sopts = sigOpts();

  if (!mapper.mappings.length) {
    rows.innerHTML = `<div class="pb-empty">No patches yet — hit <b>+ ADD MAPPING</b> to wire an input to an output.</div>`;
    return;
  }

  const lanes = mapper.mappings.map(m => {
    const sel = m.id === selectedId;
    return `
    <div class="pb-lane${sel ? ' sel' : ''}" data-mid="${m.id}">
      <div class="pb-jack pb-in">
        <select class="m-sig" data-mid="${m.id}" aria-label="Input signal">
          ${sopts.replace(`value="${m.signal}"`, `value="${m.signal}" selected`)}
        </select>
      </div>
      <div class="pb-gutter"></div>
      <div class="pb-jack pb-out">
        <select class="m-ap" data-mid="${m.id}" aria-label="Output parameter">
          ${AP_OPTS.replace(`value="${m.audioParam}"`, `value="${m.audioParam}" selected`)}
        </select>
      </div>
      <button class="rm-btn pb-del" data-mid="${m.id}" aria-label="Remove patch">×</button>
      ${sel ? `
      <div class="pb-editor">
        <label>min <input type="number" class="m-min" data-mid="${m.id}" value="${m.outMin}" step="any"></label>
        <label>max <input type="number" class="m-max" data-mid="${m.id}" value="${m.outMax}" step="any"></label>
        <label>curve
          <select class="m-curve" data-mid="${m.id}">
            ${CURVE_OPTS.replace(`value="${m.curve}"`, `value="${m.curve}" selected`)}
          </select>
        </label>
      </div>` : ''}
    </div>`;
  }).join('');

  rows.innerHTML = `<div id="patchbay"><svg id="pb-wires" aria-hidden="true"></svg>${lanes}</div>`;
  ensureRedrawObserver();

  // ── Wiring: change endpoints ──
  rows.querySelectorAll('.m-sig').forEach(el => el.addEventListener('change', e => {
    const m = mapper.mappings.find(x => x.id == e.target.dataset.mid);
    if (m) { m.signal = e.target.value; drawWires(); }
  }));
  rows.querySelectorAll('.m-ap').forEach(el => el.addEventListener('change', e => {
    const m = mapper.mappings.find(x => x.id == e.target.dataset.mid);
    if (!m) return;
    m.audioParam = e.target.value;
    const p = engine.PARAMS[m.audioParam];
    if (p) { m.outMin = p.min; m.outMax = p.max; }
    renderMapper();
  }));

  // ── Range / curve (only present on the selected lane) ──
  rows.querySelectorAll('.m-min').forEach(el => el.addEventListener('change', e => {
    const m = mapper.mappings.find(x => x.id == e.target.dataset.mid); if (m) m.outMin = parseFloat(e.target.value);
  }));
  rows.querySelectorAll('.m-max').forEach(el => el.addEventListener('change', e => {
    const m = mapper.mappings.find(x => x.id == e.target.dataset.mid); if (m) m.outMax = parseFloat(e.target.value);
  }));
  rows.querySelectorAll('.m-curve').forEach(el => el.addEventListener('change', e => {
    const m = mapper.mappings.find(x => x.id == e.target.dataset.mid); if (m) m.curve = e.target.value;
  }));

  // ── Select a cable (click the lane background, not a control) ──
  rows.querySelectorAll('.pb-lane').forEach(lane => {
    lane.addEventListener('click', e => {
      if (e.target.closest('select, input, button')) return;
      const id = parseInt(lane.dataset.mid);
      selectedId = selectedId === id ? null : id;
      renderMapper();
    });
    const id = parseInt(lane.dataset.mid);
    lane.addEventListener('mouseenter', () => highlight(id));
    lane.addEventListener('mouseleave', () => highlight(null));
  });

  rows.querySelectorAll('.pb-del').forEach(el => el.addEventListener('click', e => {
    const id = parseInt(e.target.dataset.mid);
    mapper.remove(id);
    if (selectedId === id) selectedId = null;
    renderMapper();
  }));

  requestAnimationFrame(drawWires);
}

// Draw one bezier per lane, from the input jack's right edge to the output
// jack's left edge, sagging slightly like a physical patch cable.
function drawWires() {
  const pb  = document.getElementById('patchbay');
  const svg = document.getElementById('pb-wires');
  if (!pb || !svg) return;
  const box = pb.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.setAttribute('width', box.width);
  svg.setAttribute('height', box.height);

  let paths = '';
  mapper.mappings.forEach(m => {
    const lane = pb.querySelector(`.pb-lane[data-mid="${m.id}"]`);
    if (!lane) return;
    const inJack = lane.querySelector('.pb-in'), outJack = lane.querySelector('.pb-out');
    const a = inJack.getBoundingClientRect(), b = outJack.getBoundingClientRect();
    const x1 = a.right - box.left, y1 = a.top + a.height / 2 - box.top;
    const x2 = b.left  - box.left, y2 = b.top + b.height / 2 - box.top;
    const sag = Math.min(22, (x2 - x1) * 0.12);
    const cx = (x1 + x2) / 2;
    const d = `M ${x1} ${y1} C ${cx} ${y1 + sag}, ${cx} ${y2 + sag}, ${x2} ${y2}`;
    const col = cableColor(m.signal);
    paths += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2.5"
      stroke-linecap="round" data-mid="${m.id}" class="pb-wire"
      style="opacity:${m.signal ? 0.85 : 0.3}"/>`;
    // jack pins
    paths += `<circle cx="${x1}" cy="${y1}" r="3" fill="${col}"/>`;
    paths += `<circle cx="${x2}" cy="${y2}" r="3" fill="${col}"/>`;
  });
  svg.innerHTML = paths;
}

function highlight(id) {
  const svg = document.getElementById('pb-wires');
  if (!svg) return;
  svg.querySelectorAll('.pb-wire').forEach(w => {
    w.style.opacity = id == null ? (w.dataset.mid ? 0.85 : 0.3)
                    : (w.dataset.mid == id ? 1 : 0.15);
    w.style.strokeWidth = (id != null && w.dataset.mid == id) ? 4 : 2.5;
  });
}

export function updateMapperBars() {
  // Pulse each cable's width/opacity with its live normalized value.
  const svg = document.getElementById('pb-wires');
  if (!svg) return;
  mapper.mappings.forEach(m => {
    const w = svg.querySelector(`.pb-wire[data-mid="${m.id}"]`);
    if (!w || !m.signal) return;
    const p = engine.PARAMS[m.audioParam];
    const norm = p ? Math.max(0, Math.min(1, (p.val - p.min) / (p.max - p.min))) : 0;
    w.style.strokeWidth = (2 + norm * 3).toFixed(2);
    w.style.opacity = (0.55 + norm * 0.45).toFixed(2);
  });
}
