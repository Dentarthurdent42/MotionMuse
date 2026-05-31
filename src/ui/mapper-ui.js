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

export function renderMapper() {
  const rows    = document.getElementById('mapper-rows');
  const sopts   = sigOpts();

  rows.innerHTML = mapper.mappings.map(m => `
    <div class="map-row-wrap" data-mid="${m.id}">
      <div class="map-row">
        <select class="m-ap" data-mid="${m.id}">
          ${AP_OPTS.replace(`value="${m.audioParam}"`, `value="${m.audioParam}" selected`)}
        </select>
        <select class="m-sig" data-mid="${m.id}">
          ${sopts.replace(`value="${m.signal}"`, `value="${m.signal}" selected`)}
        </select>
        <input type="number" class="m-min" data-mid="${m.id}" value="${m.outMin}" step="any">
        <input type="number" class="m-max" data-mid="${m.id}" value="${m.outMax}" step="any">
        <select class="m-curve" data-mid="${m.id}">
          ${CURVE_OPTS.replace(`value="${m.curve}"`, `value="${m.curve}" selected`)}
        </select>
        <button class="rm-btn" data-mid="${m.id}">×</button>
      </div>
      <div class="map-bar"><div class="map-bar-fill" id="mb-${m.id}" style="width:0%"></div></div>
    </div>`).join('');

  rows.querySelectorAll('.m-ap').forEach(el => el.addEventListener('change', e => {
    const m = mapper.mappings.find(x => x.id == e.target.dataset.mid);
    if (!m) return;
    m.audioParam = e.target.value;
    const p = engine.PARAMS[m.audioParam];
    if (p) { m.outMin = p.min; m.outMax = p.max; }
    renderMapper();
  }));

  rows.querySelectorAll('.m-sig').forEach(el => el.addEventListener('change', e => {
    const m = mapper.mappings.find(x => x.id == e.target.dataset.mid);
    if (m) m.signal = e.target.value;
  }));

  rows.querySelectorAll('.m-min').forEach(el => el.addEventListener('change', e => {
    const m = mapper.mappings.find(x => x.id == e.target.dataset.mid);
    if (m) m.outMin = parseFloat(e.target.value);
  }));

  rows.querySelectorAll('.m-max').forEach(el => el.addEventListener('change', e => {
    const m = mapper.mappings.find(x => x.id == e.target.dataset.mid);
    if (m) m.outMax = parseFloat(e.target.value);
  }));

  rows.querySelectorAll('.m-curve').forEach(el => el.addEventListener('change', e => {
    const m = mapper.mappings.find(x => x.id == e.target.dataset.mid);
    if (m) m.curve = e.target.value;
  }));

  rows.querySelectorAll('.rm-btn').forEach(el => el.addEventListener('click', e => {
    mapper.remove(parseInt(e.target.dataset.mid));
    renderMapper();
  }));
}

export function updateMapperBars() {
  mapper.mappings.forEach(m => {
    const el = document.getElementById(`mb-${m.id}`);
    if (!el || !m.signal) return;
    const p   = engine.PARAMS[m.audioParam];
    const val = p?.val ?? 0;
    const norm = p ? (val - p.min) / (p.max - p.min) : 0;
    el.style.width = Math.max(0, Math.min(100, norm * 100)).toFixed(1) + '%';
  });
}
