// The signals, as OUTPUT SOCKETS on the nodes that produce them.
//
// There is no signals list of its own any more: every signal is an output of
// the node that measures it — the camera's trackers on the Camera Input node,
// the microphone's four on the Microphone node, the beat clock's on the
// Metronome — grouped by tracker, each row a socket, a live value and a bar.
// Drag a row's ● to a parameter's ● anywhere on the canvas to wire it. A row
// still copies its bus key when clicked. A group folded shut keeps the
// sockets of its wired signals in its summary (the patchbay fills that strip),
// so a cable never ends on a closed box.
//
// One channel line: its name, its number, and a bar. The bar column is a
// fixed width for every channel of every signal, so two bars under one
// measure — and bars under different measures — are read against the same
// scale.

import { bus, velKeyOf } from '../bus.js';
import { toast } from './status.js';
import { cvSource }   from '../cv.js';
import { faceSource } from '../face.js';
import { signalOwner } from '../params.js';

// Where each node's signals are rendered. Absent containers (a node not yet
// rendered) are skipped; call again once they exist.
const HOSTS = {
  'panel:camera':    'cam-signals',
  'panel:mic':       'mic-signals',
  'panel:metronome': 'metro-signals',
};

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
// Nothing the camera measures is "live" without a camera, whatever the
// tracker flags say. The mic's and the metronome's groups are live while
// they run; those modules gate their own rows through `on` below.
const groupLive = (g, owner) => {
  if (owner === 'panel:camera') return cvSource.running && (GROUP_SOURCE[g] ?? (() => true))();
  return true;
};

// The switch that runs each tracker group, as an input socket on the group's
// summary — on the node's left edge, so wiring a pulse into HAND L switches
// the left-hand tracker. Depth and gesture ride on pose and the hands.
const GROUP_SWITCH = {
  'hand l': 'track_hands_l', 'hand r': 'track_hands_r', pose: 'track_pose',
  face: 'track_face', gaze: 'track_gaze',
};
const switchPort = key => `
  <span class="sig-sum-in"><button type="button" class="port port-in" data-side="in" data-key="${key}"
          aria-label="Input ${key} — connect a signal to switch this tracker"
          title="Input: ${key} — a cable here switches the tracker on and off"></button></span>`;

// Groups the user has opened or closed by hand. Their choice outranks the
// automatic behaviour from then on.
const manual = new Set();
// Element refs cached at build time — updateSigPanel runs every frame.
const refs = new Map();   // key → { valEl, barEl, lastW }

const port = (owner, key, label) => `
  <button type="button" class="port port-out" data-node="${owner}" data-side="out" data-key="${key}"
          aria-label="Output ${label} — drag to a parameter's socket to wire it"
          title="Output: ${key} — drag to a parameter's ● to wire it"></button>`;

export function buildSigPanel() {
  refs.clear();
  for (const [owner, hostId] of Object.entries(HOSTS)) {
    const host = document.getElementById(hostId);
    if (!host) continue;
    const groups = new Map();
    bus.signals.forEach((s, k) => {
      if (signalOwner(k, s) !== owner) return;
      const g = s.group || 'misc';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ k, s });
    });

    const channel = (key, name = '', cls = '') => `
      ${name ? `<span class="sig-chan-name ${cls}" data-key="${key}">${name}</span>` : ''}
      <span class="sig-val ${cls}" id="sv-${key}" data-key="${key}">0.00</span>
      <div class="sig-bar" data-key="${key}"><div class="sig-bar-fill ${cls}" id="sb-${key}" style="width:0%"></div></div>
      ${port(owner, key, bus.signals.get(key)?.label ?? key)}`;

    let html = '';
    groups.forEach((sigs, g) => {
      const live = groupLive(g, owner);
      const bases = sigs.filter(({ s }) => !s.of);
      html += `<details class="sig-sec" data-group="${g}" data-owner="${owner}"${live ? ' open' : ''}>
        <summary class="sig-group">
          ${owner === 'panel:camera' && GROUP_SWITCH[g] ? switchPort(GROUP_SWITCH[g]) : ''}
          <span class="sig-group-name">${g}</span>
          <span class="sig-group-meta">${bases.length}${live ? '' : ' · off'}</span>
          <span class="sig-sum-ports" data-owner="${owner}"></span>
        </summary>
        <div class="sig-sec-body">`;
      bases.forEach(({ k, s }) => {
        const vk = velKeyOf(k);
        html += bus.signals.has(vk)
          ? `<div class="sig-row sig-row-multi" data-key="${k}" title="Click to copy signal key">
               <span class="sig-name">${s.label}</span>
               <div class="sig-chans">
                 ${channel(k, 'displacement')}
                 ${channel(vk, 'velocity', 'vel')}
               </div>
             </div>`
          : `<div class="sig-row" data-key="${k}" title="Click to copy signal key">
               <span class="sig-name">${s.label}</span>
               ${channel(k)}
             </div>`;
      });
      html += `</div></details>`;
    });
    host.innerHTML = html || '<div class="pb-empty">no signals</div>';

    host.querySelectorAll('.sig-sec').forEach(d => {
      d.addEventListener('toggle', () => {
        if (d.open !== groupLive(d.dataset.group, owner)) manual.add(d.dataset.group);
        else manual.delete(d.dataset.group);
      });
    });
    host.querySelectorAll('.sig-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.port')) return;       // the socket is not the row
        const key = e.target.closest('[data-key]')?.dataset.key ?? row.dataset.key;
        navigator.clipboard.writeText(key).catch(() => {});
        toast(`Copied: ${key}`);
      });
    });
  }

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
    if (!s || !r.valEl.isConnected) return;
    const disp = (s.of ? Math.abs(s.value) > 10 : s.max > 10)
      ? s.value.toFixed(0) : s.value.toFixed(2);
    if (r.valEl.textContent !== disp) r.valEl.textContent = disp;
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
    const owner = d.dataset.owner ?? 'panel:camera';
    const live = groupLive(g, owner);
    const meta = d.querySelector('.sig-group-meta');
    if (meta) meta.textContent = meta.textContent.replace(/ · off$/, '') + (live ? '' : ' · off');
    if (!manual.has(g)) d.open = live;
  });
}
