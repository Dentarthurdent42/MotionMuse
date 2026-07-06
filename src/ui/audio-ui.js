import { engine }                    from '../engine.js';
import { mapper }                    from '../mapper.js';
import { SCALES, TUNINGS, NOTE_NAMES } from '../scale.js';

const opts = (arr, sel) =>
  arr.map(v => `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`).join('');

// Oscillator marker colours on the pitch-quantise keyboard (also used to tint
// the note readout, so the readout doubles as the keyboard's legend).
const OSC1_COL = '#9d5cff';   // purple
const OSC2_COL = '#00e5cc';   // cyan

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

  const t = engine.getTuning();

  panel.innerHTML = `
    <div class="audio-section">
      <div class="audio-section-label" style="display:flex;align-items:center;">
        Pitch Quantize
        <div class="wave-btn${t.enabled ? ' on' : ''}" id="quant-toggle"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${t.enabled ? 'ON' : 'OFF'}</div>
      </div>
      <div class="scale-grid">
        <select id="scale-root"   title="Root note">${opts(NOTE_NAMES, t.root)}</select>
        <select id="scale-name"   title="Scale">${opts(Object.keys(SCALES), t.scale)}</select>
        <select id="scale-tuning" title="Tuning system">${opts(Object.keys(TUNINGS), t.system)}</select>
      </div>
      <canvas id="quant-kbd" class="quant-kbd" style="display:${t.enabled ? 'block' : 'none'}"></canvas>
      <div id="quant-notes" class="quant-notes">${t.enabled ? '' : '—'}</div>
    </div>
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

  // Pitch quantisation controls
  const quantToggle = document.getElementById('quant-toggle');
  const kbd = document.getElementById('quant-kbd');
  quantToggle.addEventListener('click', () => {
    const on = !engine.getTuning().enabled;
    engine.setTuning({ enabled: on });
    quantToggle.classList.toggle('on', on);
    quantToggle.textContent = on ? 'ON' : 'OFF';
    kbd.style.display = on ? 'block' : 'none';
    if (on) { kbdSig = ''; drawKeyboard(); }
    else document.getElementById('quant-notes').textContent = '—';
  });
  const onScaleChange = () => { kbdSig = ''; drawKeyboard(); };
  document.getElementById('scale-root')
    .addEventListener('change', e => { engine.setTuning({ root: e.target.value }); onScaleChange(); });
  document.getElementById('scale-name')
    .addEventListener('change', e => { engine.setTuning({ scale: e.target.value }); onScaleChange(); });
  document.getElementById('scale-tuning')
    .addEventListener('change', e => { engine.setTuning({ system: e.target.value }); onScaleChange(); });

  // Reflect the engine's actual waveform / filter selections (they may have
  // just been restored from a saved preset, not the factory defaults).
  document.getElementById('osc1-waves').querySelector(`[data-type="${engine.getOsc1Type()}"]`)?.classList.add('on');
  document.getElementById('osc2-waves').querySelector(`[data-type="${engine.getOsc2Type()}"]`)?.classList.add('on');
  document.getElementById('filt-types').querySelector(`[data-ftype="${engine.getFilterType()}"]`)?.classList.add('on');

  kbdSig = '';
  if (t.enabled) drawKeyboard();
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

  // Live readout of the notes the oscillators are currently snapped to, plus
  // the keyboard markers. Colour the two note tokens to match their markers.
  if (engine.getTuning().enabled) {
    const notesEl = document.getElementById('quant-notes');
    if (notesEl) {
      const html = `OSC1 <b style="color:${OSC1_COL}">${engine.noteFor('osc1_freq')}</b>`
                 + `  ·  OSC2 <b style="color:${OSC2_COL}">${engine.noteFor('osc2_freq')}</b>`;
      if (notesEl.innerHTML !== html) notesEl.innerHTML = html;
    }
    drawKeyboard();
  }
}

// ── Pitch-quantise keyboard visualisation ───────────────────────────────────
// A 5-octave piano (C2–C7) drawn on a canvas. In-scale pitch classes are
// tinted (the root more strongly); the two oscillators' currently-snapped
// notes are marked with coloured dots. Redraws only when something visible
// changes (tuning, or either oscillator crossing to a new key).
const KBD_LO = 36, KBD_HI = 96;                       // MIDI C2 … C7
const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
const isWhite  = m => WHITE_PC.has(((m % 12) + 12) % 12);
const midiOf   = f => Math.round(69 + 12 * Math.log2(f / 440));

let kbdSig = '';   // last drawn state signature — skip redraw when unchanged

function drawKeyboard() {
  const c = document.getElementById('quant-kbd');
  if (!c) return;
  const t = engine.getTuning();

  const m1 = midiOf(engine.PARAMS.osc1_freq.val);
  const m2 = midiOf(engine.PARAMS.osc2_freq.val);
  const sig = `${t.root}|${t.scale}|${c.clientWidth}|${m1}|${m2}`;
  if (sig === kbdSig) return;
  kbdSig = sig;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = c.clientWidth || 260, H = 46;
  if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const whites = [];
  for (let m = KBD_LO; m <= KBD_HI; m++) if (isWhite(m)) whites.push(m);
  const ww = W / whites.length;
  const wIdx = new Map(whites.map((m, i) => [m, i]));

  const rootPc = Math.max(0, NOTE_NAMES.indexOf(t.root));
  const degs   = SCALES[t.scale] || SCALES.chromatic;
  const inScale = new Set(degs.map(d => (rootPc + d) % 12));
  const pc = m => ((m % 12) + 12) % 12;

  // White keys (with in-scale wash).
  for (let i = 0; i < whites.length; i++) {
    const m = whites[i], x = i * ww;
    ctx.fillStyle = '#cfd4db';
    ctx.fillRect(x + 0.5, 0, ww - 1, H);
    if (inScale.has(pc(m))) {
      ctx.fillStyle = pc(m) === rootPc ? 'rgba(240,165,0,0.42)' : 'rgba(120,160,255,0.32)';
      ctx.fillRect(x + 0.5, 0, ww - 1, H);
    }
    ctx.strokeStyle = '#2a2f38'; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, 0, ww - 1, H);
  }

  // Black keys on top (in-scale ones drawn in an accent instead of dark).
  const bw = ww * 0.62, bh = H * 0.62;
  for (let m = KBD_LO; m <= KBD_HI; m++) {
    if (isWhite(m)) continue;
    const x = (wIdx.get(m - 1) + 1) * ww - bw / 2;
    ctx.fillStyle = inScale.has(pc(m))
      ? (pc(m) === rootPc ? '#c58a1e' : '#41527f')
      : '#20242b';
    ctx.fillRect(x, 0, bw, bh);
  }

  // Oscillator markers.
  const keyCenter = m => isWhite(m) ? (wIdx.get(m) + 0.5) * ww : (wIdx.get(m - 1) + 1) * ww;
  const marker = (m, col) => {
    const inRange = m >= KBD_LO && m <= KBD_HI;
    const mm = Math.max(KBD_LO, Math.min(KBD_HI, m));
    const x = keyCenter(mm), y = H - 7, r = Math.min(ww * 0.42, 5.5);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = inRange ? col : '#0b0d12';
    ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = inRange ? '#0b0d12' : col;
    ctx.stroke();
  };
  marker(m2, OSC2_COL);
  marker(m1, OSC1_COL);   // draw osc1 last so it wins on unison
}
