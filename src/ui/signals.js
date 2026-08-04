import { bus }   from '../bus.js';
import { toast } from './status.js';

let built = false;
// Element refs cached at build time — updateSigPanel runs every frame and
// two getElementById calls per signal (~120+/frame) add up.
const refs = new Map();   // key → { valEl, barEl, lastW }

export function buildSigPanel() {
  const list   = document.getElementById('sig-list');
  const groups = new Map();
  bus.signals.forEach((s, k) => {
    const g = s.group || 'misc';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ k, s });
  });

  let html = '';
  groups.forEach((sigs, g) => {
    html += `<div class="sig-group">${g}</div>`;
    sigs.forEach(({ k, s }) => {
      html += `<div class="sig-row" data-key="${k}" title="Click to copy signal key">
        <span class="sig-name">${s.label}</span>
        <span class="sig-val" id="sv-${k}">0.00</span>
        <div class="sig-bar"><div class="sig-bar-fill" id="sb-${k}" style="width:0%"></div></div>
      </div>`;
    });
  });
  list.innerHTML = html;

  list.querySelectorAll('.sig-row').forEach(row => {
    row.addEventListener('click', () => {
      const key = row.dataset.key;
      navigator.clipboard.writeText(key).catch(() => {});
      toast(`Copied: ${key}`);
    });
  });

  refs.clear();
  bus.signals.forEach((s, k) => {
    const valEl = document.getElementById(`sv-${k}`);
    const barEl = document.getElementById(`sb-${k}`);
    if (valEl && barEl) refs.set(k, { valEl, barEl, lastW: '' });
  });

  built = true;
}

export function updateSigPanel() {
  if (!built) return;
  refs.forEach((r, k) => {
    const s = bus.signals.get(k);
    if (!s) return;
    const disp = s.max > 10 ? s.value.toFixed(0) : s.value.toFixed(2);
    if (r.valEl.textContent !== disp) r.valEl.textContent = disp;
    const w = (bus.norm(k) * 100).toFixed(1) + '%';
    if (w !== r.lastW) { r.barEl.style.width = w; r.lastW = w; }
  });
}
