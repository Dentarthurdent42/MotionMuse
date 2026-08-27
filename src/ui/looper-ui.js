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
// Off by default is the wrong default for a pedal — it is the whole feature —
// but a switch has to exist, because a nod is also a thing people do.
let pedalOn = lsGet(KEY_ON) !== '0';
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
      <div class="audio-section-label">Loop Pedal</div>
      <div class="loop-transport">
        <div class="loop-bar"><div class="loop-bar-fill" id="loop-pos"></div></div>
        <div class="loop-read">
          <div class="loop-state" id="loop-state">READY</div>
          <div class="loop-next" id="loop-next">nod to start recording</div>
        </div>
      </div>
      <div class="wave-btns">
        <button type="button" class="wave-btn" id="loop-pedal-btn"
                title="The same thing the pedal does — for a mouse, or a camera that is off">PEDAL</button>
        <button type="button" class="wave-btn" id="loop-undo"
                title="Drop the last layer, keeping the loop running">UNDO</button>
        <button type="button" class="wave-btn" id="loop-stop">STOP</button>
        <button type="button" class="wave-btn" id="loop-clear">CLEAR</button>
      </div>
      <div class="quant-notes" id="loop-note"></div>
      <div class="audio-section-label" style="margin-top:8px;">Pedal</div>
      <div class="scale-grid" style="grid-template-columns:1fr 1fr;">
        <select id="pedal-src" aria-label="What presses the pedal">
          ${Object.entries(PEDAL_SOURCES).map(([id, s]) =>
            `<option value="${id}"${id === pedal.source ? ' selected' : ''}>${s.label}</option>`).join('')}
        </select>
        <button type="button" class="wave-btn${pedalOn ? ' on' : ''}" id="pedal-on"
                aria-pressed="${pedalOn}"
                title="Stop the gesture pressing the pedal — the buttons above still work">${pedalOn ? 'ON' : 'OFF'}</button>
      </div>
      <label class="ctrl-row" title="How hard the movement has to be. Watch the meter and nod: a deliberate stab should fill it.">
        <span class="ctrl-lbl">SENSITIVITY</span>
        <input type="range" id="pedal-sens" min="0.3" max="4" step="0.05" value="${pedal.sensitivity}">
      </label>
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
  const onBtn = document.getElementById('pedal-on');
  onBtn.addEventListener('click', () => {
    pedalOn = !pedalOn;
    lsSet(KEY_ON, pedalOn ? '1' : '0');
    onBtn.classList.toggle('on', pedalOn);
    onBtn.setAttribute('aria-pressed', String(pedalOn));
    onBtn.textContent = pedalOn ? 'ON' : 'OFF';
    pedal.reset();
  });
  document.getElementById('pedal-sens').addEventListener('input', e => {
    pedal.sensitivity = +e.target.value;
    lsSet(KEY_SENS, String(pedal.sensitivity));
  });

  looper.subscribe(render);
}

function render(s) {
  if (!els?.state) return;
  els.state.textContent = STATE_LABEL[s.state] ?? s.state;
  els.state.dataset.state = s.state;
  // The prompt names the chosen gesture rather than always saying "nod", so
  // somebody on the brow pedal is not told to do something else.
  els.next.textContent = (NEXT_LABEL[s.state] ?? '')
    .replace('nod', PEDAL_SOURCES[pedal.source]?.hint.toLowerCase() ?? 'press');
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
  const note = !pedalOn ? 'Pedal off — the buttons above still work'
             : why      ? `Pedal needs the tracker — ${why}`
             : PEDAL_SOURCES[pedal.source]?.hint ?? '';
  if (els.pnote.textContent !== note) els.pnote.textContent = note;
}

// Returns true when the gesture fired this frame and the transport should move.
export function pedalPressed(now) {
  return pedalOn && !pedalReady() && pedal.tick(now);
}
