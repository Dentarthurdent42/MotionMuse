// UI for the Metronome section — the beat clock the play modes can sample.
//
// Same panel conventions as its neighbours: the section renders whole from
// state, structural changes rebuild via the shared rerender, and the sliders
// that are dragged while listening mutate in place so a re-render never
// steals the pointer mid-adjustment.

import { metronome, SIGNATURES, BPM_MIN, BPM_MAX } from '../metronome.js';
import { setReadout } from './numeric.js';
import { inPort } from './mapper-ui.js';
import { syncControls } from '../controls.js';

export function metronomeSection() {
  const c = metronome.config();

  const sigOpts = SIGNATURES.map(s =>
    `<option value="${s}"${s === c.sig ? ' selected' : ''}>${s}</option>`).join('');

  // One button per beat of the bar — the SAMPLE mask. This row IS the time
  // signature, drawn the same way the camera strip draws it: beat 1 first,
  // lit beats strike, hollow beats rest.
  const beatBtns = c.mask.map((v, i) => `
    <button type="button" class="wave-btn met-beat${v ? ' on' : ''}" data-beat="${i}"
            aria-pressed="${v}"
            title="${v ? 'Strikes' : 'Rests'} on beat ${i + 1} — the beat-sampled volume modes play only on lit beats">${i + 1}</button>`).join('');

  return `
    <div class="audio-section" data-sec="metronome">
      <div class="audio-section-label">
        Metronome
        <span class="head-sock">${inPort('metro_on')}</span>
        <button class="wave-btn${c.on ? ' on' : ''}" id="metro-toggle" aria-pressed="${c.on}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${c.on ? 'ON' : 'OFF'}</button>
      </div>
      <div class="met-row">
        <span class="chord-key-lbl">${inPort('metro_bpm')}TEMPO</span>
        <button type="button" class="wave-btn met-nudge" id="metro-down" aria-label="Slower" title="Slow down">−</button>
        <input type="range" id="metro-bpm" min="${BPM_MIN}" max="${BPM_MAX}" step="1" value="${c.bpm}"
               aria-label="Tempo in beats per minute">
        <button type="button" class="wave-btn met-nudge" id="metro-up" aria-label="Faster" title="Speed up">+</button>
        <span class="ctrl-val" id="metro-bpm-val">${c.bpm}</span>
      </div>
      <div class="met-row">
        <span class="chord-key-lbl">TIME</span>
        <select id="metro-sig" aria-label="Time signature"
                title="Beats per bar — the camera strip, the SAMPLE row and the downbeat accent all follow it">${sigOpts}</select>
        <button type="button" class="wave-btn met-mute${c.muted ? ' on' : ''}" id="metro-mute" aria-pressed="${c.muted}"
                title="Silence the click. The clock keeps counting: the camera strip still pulses and the beat-sampled modes still sample.">MUTE</button>
      </div>
      <div class="met-row" title="Which beats the beat-sampled volume modes strike on — set VOLUME (Radial Mode) or PLAY WITH (Gesture Mode) to “Metronome beats” to use them">
        <span class="chord-key-lbl">SAMPLE</span>
        <div class="met-beats" id="metro-beats">${beatBtns}</div>
      </div>
      <div class="quant-notes" id="metro-read">${c.on
        ? '● counting'
        : 'switch on to click — and to drive the “Metronome beats” volume modes'}</div>
      <!-- The clock's own outputs: beat and downbeat pulses, phase ramps.
           Filled by src/ui/signals.js. -->
      <div class="sig-list" id="metro-signals"></div>
    </div>`;
}

export function wireMetronomeSection(rerender) {
  document.getElementById('metro-toggle')?.addEventListener('click', () => {
    metronome.setOn(!metronome.on);
    syncControls();
    rerender();
  });
  // The slider mutates in place — tempo is adjusted while listening, and a
  // re-render mid-drag drops the pointer.
  const bpmEl = document.getElementById('metro-bpm');
  const bpmVal = document.getElementById('metro-bpm-val');
  const showBpm = v => setReadout(bpmVal, String(v));
  bpmEl?.addEventListener('input', e => { showBpm(metronome.setBpm(+e.target.value)); syncControls(); });
  const nudge = dir => {
    const v = metronome.nudge(dir);
    if (bpmEl) bpmEl.value = String(v);
    showBpm(v);
  };
  document.getElementById('metro-down')?.addEventListener('click', () => nudge(-1));
  document.getElementById('metro-up')?.addEventListener('click', () => nudge(+1));
  document.getElementById('metro-sig')?.addEventListener('change', e => {
    metronome.setSig(e.target.value);
    rerender();                       // the SAMPLE row grows or shrinks with it
  });
  document.getElementById('metro-mute')?.addEventListener('click', e => {
    metronome.setMuted(!metronome.config().muted);
    const on = metronome.config().muted;
    e.target.classList.toggle('on', on);
    e.target.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('.met-beat').forEach(btn =>
    btn.addEventListener('click', () => {
      const i = +btn.dataset.beat;
      metronome.toggleMaskBeat(i);
      const on = metronome.config().mask[i];
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.title = `${on ? 'Strikes' : 'Rests'} on beat ${i + 1} — the beat-sampled volume modes play only on lit beats`;
    }));
}

// Per-frame: walk the current beat along the SAMPLE row, so the panel and
// the camera strip agree about where the bar stands.
export function updateMetronomePanel() {
  const view = metronome.view();
  document.querySelectorAll('.met-beat').forEach((btn, i) =>
    btn.classList.toggle('met-now', !!view && i === view.beat));
  const read = document.getElementById('metro-read');
  if (read && view) {
    const txt = `● beat ${view.beat + 1} / ${view.num}`;
    if (read.textContent !== txt) read.textContent = txt;
  }
}
