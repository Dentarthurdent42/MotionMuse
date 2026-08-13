import { bus }   from '../bus.js';
import { toast } from './status.js';
import { cvSource }   from '../cv.js';
import { faceSource } from '../face.js';

let built = false;

// Which tracker feeds each signal group. A group whose tracker is off reads a
// column of 0.00 forever, which is noise — so those collapse. Depth and
// gesture are derived: depth from the pose landmarks, gestures from the hands.
const GROUP_SOURCE = {
  'hand l': () => cvSource.handsOn,
  'hand r': () => cvSource.handsOn,
  gesture:  () => cvSource.handsOn,
  pose:     () => cvSource.poseOn,
  depth:    () => cvSource.poseOn,
  face:     () => faceSource.faceOn,
  gaze:     () => faceSource.gazeOn,
};
// Nothing is "live" without a camera, whatever the tracker flags say: the
// flags describe intent, and with no stream every group reads 0.00. So every
// group starts minimized on a cold page — a wall of zeroes is not information,
// and the user can open any of them to go looking.
const groupLive = g => cvSource.running && (GROUP_SOURCE[g] ?? (() => true))();

// Groups the user has opened or closed by hand. Their choice outranks the
// automatic behaviour from then on — auto-collapsing a group someone had
// deliberately opened, because an unrelated toggle flipped, would be the app
// arguing with them.
const manual = new Set();
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
    const live = groupLive(g);
    html += `<details class="sig-sec" data-group="${g}"${live ? ' open' : ''}>
      <summary class="sig-group">
        <span class="sig-group-name">${g}</span>
        <span class="sig-group-meta">${sigs.length}${live ? '' : ' · off'}</span>
      </summary>
      <div class="sig-sec-body">`;
    sigs.forEach(({ k, s }) => {
      html += `<div class="sig-row" data-key="${k}" title="Click to copy signal key">
        <span class="sig-name">${s.label}</span>
        <span class="sig-val" id="sv-${k}">0.00</span>
        <div class="sig-bar"><div class="sig-bar-fill" id="sb-${k}" style="width:0%"></div></div>
      </div>`;
    });
    html += `</div></details>`;
  });
  list.innerHTML = html;

  // A group opened or closed by hand stops following its tracker.
  list.querySelectorAll('.sig-sec').forEach(d => {
    d.addEventListener('toggle', () => {
      if (d.open !== groupLive(d.dataset.group)) manual.add(d.dataset.group);
      else manual.delete(d.dataset.group);
    });
  });

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

// Re-collapse / re-open groups after a tracker toggle. Called from main.js
// rather than polled: this changes only when a button is pressed.
export function syncSigGroups() {
  document.querySelectorAll('.sig-sec').forEach(d => {
    const g = d.dataset.group;
    const live = groupLive(g);
    const meta = d.querySelector('.sig-group-meta');
    if (meta) meta.textContent = meta.textContent.replace(/ · off$/, '') + (live ? '' : ' · off');
    if (!manual.has(g)) d.open = live;
  });
}
