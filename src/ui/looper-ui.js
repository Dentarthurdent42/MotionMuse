// The LOOP panel — the transport, and the pedal's calibration.
//
// The panel exists even though the pedal is the control, for three reasons a
// gesture cannot cover: you have to be able to SEE what state the loop is in
// (a looper whose state you have to infer from what you hear is a looper you
// will fight), STOP and CLEAR must not share the motion that starts a take,
// and a threshold nobody can watch is a threshold nobody can set.

import { looper, MAX_LAYERS, MAX_LOOP_SECONDS } from '../looper.js';
import { PEDAL_SOURCES, DEFAULT_PEDAL, DEFAULT_SENSITIVITY, makePedal } from '../pedal.js';
import { engine } from '../engine.js';
import { cvSource } from '../cv.js';
import { faceSource } from '../face.js';
import { lsGet, lsSet } from '../storage.js';
import { toast } from './status.js';
import { inPort } from './ports.js';
import { rows } from './rows.js';
import { defineControls } from '../controls.js';

const KEY_SRC = 'motionmuse-pedal-src';
const KEY_SENS = 'motionmuse-pedal-sens';
const KEY_ON = 'motionmuse-pedal-on';

// What the transport says it is doing, in the words a pedal would use.
const STATE_LABEL = {
  empty:       'READY',
  recording:   'RECORDING',
  playing:     'PLAYING',
  overdubbing: 'OVERDUB',
  stopped:     'STOPPED',
};
// What one more press would do. Shown because a one-button transport is only
// obvious to the person who wrote it.
const NEXT_LABEL = {
  empty:       'nod to start recording',
  recording:   'nod to close the loop',
  playing:     'nod to overdub',
  overdubbing: 'nod to drop the layer',
  stopped:     'nod to play',
};

export const pedal = makePedal({
  source: PEDAL_SOURCES[lsGet(KEY_SRC)] ? lsGet(KEY_SRC) : DEFAULT_PEDAL,
  sensitivity: Number(lsGet(KEY_SENS)) || DEFAULT_SENSITIVITY,
});
// OFF by default. A nod is the pedal because it is something you can do
// without interrupting a phrase — which is exactly why it is also something
// you do constantly without meaning anything by it: agreeing, glancing down
// at your hands, moving to the beat you are playing. Armed from the first
// run, that made the instrument start recording loops nobody asked for. The
// gesture is opt-in now; the transport buttons work from the start either
// way, so nothing is out of reach, only out of the way.
let pedalOn = lsGet(KEY_ON) === '1';

// The pedal's own settings, as inputs a cable can drive (src/controls.js
// holds the rest of the transport). Defined here because the state is here.
const PEDAL_IDS = Object.keys(PEDAL_SOURCES);
defineControls({
  loop_pedal_src: {
    label: 'Pedal Gesture', min: 0, max: PEDAL_IDS.length - 1, options: PEDAL_IDS,
    read: () => Math.max(0, PEDAL_IDS.indexOf(pedal.source)),
    apply: v => {
      const id = PEDAL_IDS[Math.round(v)] ?? DEFAULT_PEDAL;
      if (id === pedal.source) return;
      pedal.source = id; pedal.reset(); lsSet(KEY_SRC, id);
      const sel = document.getElementById('pedal-src');
      if (sel) sel.value = id;
    },
  },
  loop_pedal_on: {
    label: 'Pedal Armed', min: 0, max: 1, toggle: true,
    read: () => (pedalOn ? 1 : 0),
    apply: v => {
      const on = Math.round(v) >= 1;
      if (on === pedalOn) return;
      setPedalOn(on);
    },
  },
  loop_sensitivity: {
    label: 'Sensitivity', min: 0.3, max: 4, slider: true,
    read: () => pedal.sensitivity,
    apply: v => {
      const r = +Number(v).toFixed(2);
      if (r === +pedal.sensitivity.toFixed(2)) return;
      pedal.sensitivity = r; lsSet(KEY_SENS, String(r));
    },
  },
});
function setPedalOn(on) {
  pedalOn = on;
  lsSet(KEY_ON, on ? '1' : '0');
  const btn = document.getElementById('pedal-on');
  if (btn) {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'ON' : 'OFF';
  }
  pedal.reset();
}
export const pedalEnabled = () => pedalOn;

// The tracker the chosen pedal needs, and whether it is actually running.
function pedalReady() {
  const src = PEDAL_SOURCES[pedal.source];
  if (!cvSource.running) return 'start the camera';
  if (src.group === 'face' && !faceSource.faceOn) return 'switch on ☺ FACE';
  if (src.group === 'pose' && !cvSource.poseOn) return 'switch on 🧍 POSE';
  return '';
}

export function looperSectionHTML() {
  return `
    <div class="audio-section" data-sec="looper">
      <div class="audio-section-label">Loop Pedal <span class="head-sock">${inPort('loop_pedal')}</span></div>
      <div class="loop-transport">
        <div class="loop-bar"><div class="loop-bar-fill" id="loop-pos"></div></div>
        <div class="loop-read">
          <div class="loop-state" id="loop-state">READY</div>
          <div class="loop-next" id="loop-next">PEDAL to start recording</div>
        </div>
      </div>
      <div class="wave-btns">
        <button type="button" class="wave-btn" id="loop-pedal-btn"
                title="The same thing the pedal does — for a mouse, or a camera that is off. Also the socket on this node's header: a pulse there presses it.">PEDAL</button>
      </div>
      <!-- One input per row, on the node's edge: a pulse presses the button. -->
      <div class="met-row">
        <span class="chord-key-lbl">${inPort('loop_undo')}UNDO</span>
        <button type="button" class="wave-btn" id="loop-undo"
                title="Drop the last layer, keeping the loop running">UNDO</button>
      </div>
      <div class="met-row">
        <span class="chord-key-lbl">${inPort('loop_stop')}STOP</span>
        <button type="button" class="wave-btn" id="loop-stop">STOP</button>
      </div>
      <div class="met-row">
        <span class="chord-key-lbl">${inPort('loop_clear')}CLEAR</span>
        <button type="button" class="wave-btn" id="loop-clear">CLEAR</button>
      </div>
      <div class="quant-notes" id="loop-note"></div>
      <div class="audio-section-label" style="margin-top:8px;">Pedal</div>
      <div class="met-row">
        <span class="chord-key-lbl">${inPort('loop_pedal_src')}GESTURE</span>
        <select id="pedal-src" aria-label="What presses the pedal">
          ${Object.entries(PEDAL_SOURCES).map(([id, s]) =>
            `<option value="${id}"${id === pedal.source ? ' selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </div>
      <div class="met-row">
        <span class="chord-key-lbl">${inPort('loop_pedal_on')}ARMED</span>
        <button type="button" class="wave-btn${pedalOn ? ' on' : ''}" id="pedal-on"
                aria-pressed="${pedalOn}"
                title="Let the gesture press the pedal. Off by default: a nod is also something people do without meaning it. The buttons above work either way.">${pedalOn ? 'ON' : 'OFF'}</button>
      </div>
      ${rows(['loop_sensitivity'])}
      <div class="loop-meter"><div class="loop-meter-fill" id="pedal-meter"></div></div>
      <div class="quant-notes" id="pedal-note"></div>
    </div>`;
}

let els = null;

export function wireLooperSection() {
  els = {
    state: document.getElementById('loop-state'),
    next:  document.getElementById('loop-next'),
    pos:   document.getElementById('loop-pos'),
    note:  document.getElementById('loop-note'),
    meter: document.getElementById('pedal-meter'),
    pnote: document.getElementById('pedal-note'),
  };
  if (!els.state) return;

  const press = async () => {
    if (!engine.started) { toast('Start the audio first — there is nothing to record yet'); return; }
    await looper.pedal();
  };
  document.getElementById('loop-pedal-btn').addEventListener('click', press);
  document.getElementById('loop-undo').addEventListener('click', () => looper.undo());
  document.getElementById('loop-stop').addEventListener('click', () => looper.stop());
  document.getElementById('loop-clear').addEventListener('click', () => looper.clear());

  const srcSel = document.getElementById('pedal-src');
  srcSel.addEventListener('change', e => {
    pedal.source = e.target.value;
    pedal.reset();
    lsSet(KEY_SRC, pedal.source);
    render(looper.snapshot());
  });
  document.getElementById('pedal-on').addEventListener('click', () => setPedalOn(!pedalOn));

  looper.subscribe(render);
}

function render(s) {
  if (!els?.state) return;
  els.state.textContent = STATE_LABEL[s.state] ?? s.state;
  els.state.dataset.state = s.state;
  // The prompt names the chosen gesture rather than always saying "nod", so
  // somebody on the brow pedal is not told to do something else.
  els.next.textContent = pedalOn
    ? (NEXT_LABEL[s.state] ?? '')
        .replace('nod', PEDAL_SOURCES[pedal.source]?.hint.toLowerCase() ?? 'press')
    : (NEXT_LABEL[s.state] ?? '').replace('nod', 'PEDAL');
  const bits = [];
  if (s.seconds) bits.push(`${s.seconds.toFixed(1)}s`);
  if (s.layers) bits.push(`${s.layers} layer${s.layers === 1 ? '' : 's'}${s.full ? ' · full' : ''}`);
  if (s.unsupported) bits.push(s.unsupported);
  else if (!s.layers) bits.push(`up to ${MAX_LOOP_SECONDS}s · ${MAX_LAYERS} layers`);
  els.note.textContent = bits.join(' · ');
}

// Per-frame: the playhead ring, the pedal meter, and the pedal itself. Called
// from the RAF loop, so everything here is a read plus at most one style write.
export function tickLooperUI() {
  if (!els?.pos) return;
  const s = looper.snapshot();
  const at = `${(s.position * 100).toFixed(1)}%`;
  if (els.pos.style.width !== at) els.pos.style.width = at;
  const m = `${(pedal.reading() * 100).toFixed(0)}%`;
  if (els.meter.style.width !== m) els.meter.style.width = m;
  const why = pedalReady();
  const note = !pedalOn ? 'Gesture off — the buttons above still work; ON arms the nod'
             : why      ? `Pedal needs the tracker — ${why}`
             : PEDAL_SOURCES[pedal.source]?.hint ?? '';
  if (els.pnote.textContent !== note) els.pnote.textContent = note;
}

// Returns true when the gesture fired this frame and the transport should move.
export function pedalPressed(now) {
  return pedalOn && !pedalReady() && pedal.tick(now);
}
