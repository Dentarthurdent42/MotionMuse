import { bus, velKeyOf } from '../bus.js';
import { toast } from './status.js';
import { cvSource }   from '../cv.js';
import { faceSource } from '../face.js';
import { wireDragOut } from './mapper-ui.js';

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

  // One channel line: its name, its number, and a bar. The bar column is a
  // fixed width for every channel of every signal, so two bars under one
  // measure — and bars under different measures — are read against the same
  // scale. A bar whose length meant something different per row would not be
  // a comparison, it would be decoration.
  // Every channel carries a socket: drag it onto the canvas to make that
  // signal a node there, drop it on a parameter's socket to wire it, or
  // click it to add the node in the flow.
  const src = key => `<button type="button" class="port-src" data-sig="${key}"
      title="Drag onto the canvas to add ${key} as a node — or click" aria-label="Add ${key} as a node"></button>`;
  const channel = (key, name = '', cls = '') => `
    ${name ? `<span class="sig-chan-name ${cls}" data-key="${key}">${src(key)}${name}</span>` : ''}
    <span class="sig-val ${cls}" id="sv-${key}" data-key="${key}">0.00</span>
    <div class="sig-bar" data-key="${key}"><div class="sig-bar-fill ${cls}" id="sb-${key}" style="width:0%"></div></div>`;

  let html = '';
  groups.forEach((sigs, g) => {
    const live = groupLive(g);
    // Count what a reader counts: the things being measured, not the channels
    // they are measured on.
    const bases = sigs.filter(({ s }) => !s.of);
    html += `<details class="sig-sec" data-group="${g}"${live ? ' open' : ''}>
      <summary class="sig-group">
        <span class="sig-group-name">${g}</span>
        <span class="sig-group-meta">${bases.length}${live ? '' : ' · off'}</span>
      </summary>
      <div class="sig-sec-body">`;
    bases.forEach(({ k, s }) => {
      const vk = velKeyOf(k);
      // A measure that also reports how fast it is changing gets its name on
      // its own line with both channels indented under it; one that does not
      // stays the single line it always was, rather than growing a heading
      // over a lone value.
      html += bus.signals.has(vk)
        ? `<div class="sig-row sig-row-multi" data-key="${k}" title="Click to copy signal key">
             <span class="sig-name">${s.label}</span>
             <div class="sig-chans">
               ${channel(k, 'displacement')}
               ${channel(vk, 'velocity', 'vel')}
             </div>
           </div>`
        : `<div class="sig-row" data-key="${k}" title="Click to copy signal key">
             <span class="sig-name">${src(k)}${s.label}</span>
             ${channel(k)}
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
    row.addEventListener('click', e => {
      // On a two-channel row, copy the channel actually clicked — the whole
      // point of having both is that they are wired to different things. Every
      // channel element carries its own key, and the row carries the base one,
      // so a click on the measure's name (or on the row's padding) walks up to
      // the measure itself rather than guessing at one of its channels.
      const key = e.target.closest('[data-key]')?.dataset.key ?? row.dataset.key;
      navigator.clipboard.writeText(key).catch(() => {});
      toast(`Copied: ${key}`);
    });
  });

  wireDragOut(list);

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
    // Range picks the precision for a measure: two decimals on a 0–1 openness,
    // whole degrees on a 0–180 elbow. A velocity's range is four spans of its
    // source per second, so the same rule would round a real 0.4 m/s of
    // approach to "0" — its magnitude, not its bounds, is what says how many
    // digits carry information.
    const disp = (s.of ? Math.abs(s.value) > 10 : s.max > 10)
      ? s.value.toFixed(0) : s.value.toFixed(2);
    if (r.valEl.textContent !== disp) r.valEl.textContent = disp;
    // A velocity is signed, so its normalised value sits mid-scale at rest —
    // a bar half full while nothing moves reads as "half on". The bar shows
    // SPEED, filling from empty in either direction, and the number beside it
    // keeps the sign, which is where the direction belongs.
    const n = bus.norm(k);
    const w = ((s.of ? Math.abs(n * 2 - 1) : n) * 100).toFixed(1) + '%';
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
