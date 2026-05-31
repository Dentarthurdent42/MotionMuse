import { bus }   from '../bus.js';
import { toast } from './status.js';

let built = false;

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

  built = true;
}

export function updateSigPanel() {
  if (!built) return;
  bus.signals.forEach((s, k) => {
    const n     = bus.norm(k);
    const valEl = document.getElementById(`sv-${k}`);
    const barEl = document.getElementById(`sb-${k}`);
    if (valEl) {
      const disp = s.max > 10 ? s.value.toFixed(0) : s.value.toFixed(2);
      if (valEl.textContent !== disp) valEl.textContent = disp;
    }
    if (barEl) barEl.style.width = (n * 100).toFixed(1) + '%';
  });
}
