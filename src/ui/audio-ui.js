import { engine } from '../engine.js';
import { mapper } from '../mapper.js';

export function renderAudioPanel() {
  const panel = document.getElementById('audio-panel');

  const rangeRow = (key, p) => `
    <div class="ctrl-row">
      <span class="ctrl-lbl">${p.label}</span>
      <input type="range" class="apr" data-key="${key}"
        min="${p.min}" max="${p.max}" value="${p.val}"
        step="${((p.max - p.min) / 300).toPrecision(3)}">
      <span class="ctrl-val" id="av-${key}">${p.val.toFixed(p.unit === 'Hz' ? 0 : 2)}</span>
    </div>`;

  const waveBtn = (type, label, osc) =>
    `<div class="wave-btn" data-type="${type}" data-osc="${osc}">${label}</div>`;

  panel.innerHTML = `
    <div class="audio-section">
      <div class="audio-section-label">Osc 1 Waveform</div>
      <div class="wave-btns" id="osc1-waves">
        ${waveBtn('sine','SIN','1')}${waveBtn('triangle','TRI','1')}
        ${waveBtn('sawtooth','SAW','1')}${waveBtn('square','SQR','1')}
      </div>
    </div>
    <div class="audio-section">
      <div class="audio-section-label">Osc 2 Waveform</div>
      <div class="wave-btns" id="osc2-waves">
        ${waveBtn('sine','SIN','2')}${waveBtn('triangle','TRI','2')}
        ${waveBtn('sawtooth','SAW','2')}${waveBtn('square','SQR','2')}
      </div>
    </div>
    <div class="audio-section">
      <div class="audio-section-label">Filter Type</div>
      <div class="wave-btns" id="filt-types">
        ${['lowpass','highpass','bandpass','notch'].map(t =>
          `<div class="wave-btn" data-ftype="${t}">${t.slice(0, 3).toUpperCase()}</div>`
        ).join('')}
      </div>
    </div>
    <div class="audio-section" style="border-bottom:none;">
      ${Object.entries(engine.PARAMS).map(([k, p]) => rangeRow(k, p)).join('')}
    </div>`;

  const activateWave = (group, type) =>
    group.querySelectorAll('.wave-btn').forEach(b =>
      b.classList.toggle('on', (b.dataset.type ?? b.dataset.ftype) === type));

  document.getElementById('osc1-waves').querySelectorAll('.wave-btn').forEach(b => {
    b.addEventListener('click', () => {
      engine.setOsc1Type(b.dataset.type);
      activateWave(b.parentElement, b.dataset.type);
    });
  });
  document.getElementById('osc2-waves').querySelectorAll('.wave-btn').forEach(b => {
    b.addEventListener('click', () => {
      engine.setOsc2Type(b.dataset.type);
      activateWave(b.parentElement, b.dataset.type);
    });
  });
  document.getElementById('filt-types').querySelectorAll('.wave-btn').forEach(b => {
    b.addEventListener('click', () => {
      engine.setFilterType(b.dataset.ftype);
      activateWave(b.parentElement, b.dataset.ftype);
    });
  });

  panel.querySelectorAll('.apr').forEach(el => {
    el.addEventListener('input', e => {
      const key = e.target.dataset.key;
      const val = parseFloat(e.target.value);
      engine.set(key, val);
      const p     = engine.PARAMS[key];
      const dispEl = document.getElementById(`av-${key}`);
      if (dispEl) dispEl.textContent = val.toFixed(p.unit === 'Hz' ? 0 : 2);
    });
  });

  document.getElementById('osc1-waves').querySelector('[data-type="sine"]').classList.add('on');
  document.getElementById('osc2-waves').querySelector('[data-type="triangle"]').classList.add('on');
  document.getElementById('filt-types').querySelector('[data-ftype="lowpass"]').classList.add('on');
}

export function updateAudioSliders() {
  mapper.mappings.forEach(m => {
    if (!m.signal) return;
    const p = engine.PARAMS[m.audioParam];
    if (!p) return;
    const slider = document.querySelector(`.apr[data-key="${m.audioParam}"]`);
    const valEl  = document.getElementById(`av-${m.audioParam}`);
    if (slider) slider.value = p.val;
    if (valEl)  valEl.textContent = p.val.toFixed(p.unit === 'Hz' ? 0 : 2);
  });
}
