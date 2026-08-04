import { engine }                    from '../engine.js';
import { mapper }                    from '../mapper.js';
import { SCALES, TUNINGS, NOTE_NAMES } from '../scale.js';
import { makeKbdView, midiOf, OSC1_COL, OSC2_COL } from './keyboard.js';
import { KITS, KIT_PARAM_KEYS, applyKit, currentKit, markCustom } from '../soundkit.js';
import { playalong } from '../playalong.js';
import { SONGS }     from '../songs.js';
import { gestureSectionsHTML, wireGestureSections, updateGesturePanel } from './gesture-ui.js';
import { shaderSectionHTML, wireShaderSection } from './shader-ui.js';

const opts = (arr, sel) =>
  arr.map(v => `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`).join('');

// The panel's pitch-quantise keyboard (canvas #quant-kbd, recreated with the
// panel; the view looks it up by id on every draw).
const panelKbd = makeKbdView('quant-kbd', { height: 46 });
const sliderRefs = new Map();   // param key → {slider, valEl}, rebuilt per render

// Saved best score for the currently selected song+difficulty (idle display).
const bestLine = () => {
  const song = document.getElementById('song-select')?.value ?? playalong.lastSong;
  const diff = document.getElementById('diff-select')?.value ?? playalong.lastDiff;
  const b = playalong.bestFor(song, diff);
  return b ? `BEST ${b.score} · ${b.grade} · ${Math.round(b.acc * 100)}%` : '—';
};
const kbdOpts = () => {
  const t = engine.getTuning();
  return {
    root: t.root, scale: t.scale,
    m1: midiOf(engine.PARAMS.osc1_freq.val),
    m2: midiOf(engine.PARAMS.osc2_freq.val),
  };
};

export function renderAudioPanel() {
  const panel = document.getElementById('audio-panel');

  // Tick marks at the snap values, drawn on the track as background gradients
  // (native <datalist> ticks are suppressed by our -webkit-appearance:none).
  const tickBg = p => !p.snaps ? '' : ` style="background-image:${p.snaps.map(s => {
    const f = ((s - p.min) / (p.max - p.min) * 100).toFixed(2);
    return `linear-gradient(90deg,transparent calc(${f}% - 1.5px),var(--dim) calc(${f}% - 1.5px),var(--dim) calc(${f}% + 1.5px),transparent calc(${f}% + 1.5px))`;
  }).join(',')}"`;

  const rangeRow = (key, p) => `
    <div class="ctrl-row">
      <span class="ctrl-lbl">${p.label}</span>
      <input type="range" class="apr" data-key="${key}"
        min="${p.min}" max="${p.max}" value="${p.val}"
        step="${((p.max - p.min) / 300).toPrecision(3)}"${tickBg(p)}>
      <span class="ctrl-val" id="av-${key}">${p.val.toFixed(p.unit === 'Hz' ? 0 : 2)}</span>
    </div>`;

  const waveBtn = (type, label, osc) =>
    `<div class="wave-btn" data-type="${type}" data-osc="${osc}">${label}</div>`;

  const t = engine.getTuning();

  const kitId = currentKit();
  const kitOpts = Object.entries(KITS)
    .map(([id, k]) => `<option value="${id}"${id === kitId ? ' selected' : ''}>${k.label}</option>`)
    .join('') + (kitId === 'custom' ? '<option value="custom" selected>Custom</option>' : '');

  const gv = playalong.view;
  const gameActive = gv.state === 'countdown' || gv.state === 'playing';

  panel.innerHTML = `
    <div class="audio-section">
      <div class="audio-section-label">Sound Kit</div>
      <select id="kit-select" title="Instrument timbre preset (synthesized)">${kitOpts}</select>
    </div>
    <div class="audio-section">
      <div class="audio-section-label">Play Along</div>
      <div class="scale-grid" style="grid-template-columns:1.6fr 1fr;">
        <select id="song-select" title="Song"${gameActive ? ' disabled' : ''}>
          ${SONGS.map(s => `<option value="${s.id}"${s.id === playalong.lastSong ? ' selected' : ''}>${s.name}</option>`).join('')}
        </select>
        <select id="diff-select" title="Difficulty"${gameActive ? ' disabled' : ''}>
          ${['easy', 'medium', 'hard'].map(d => `<option value="${d}"${d === playalong.lastDiff ? ' selected' : ''}>${d}</option>`).join('')}
        </select>
      </div>
      <div class="wave-btns" style="margin-top:4px;">
        <div class="wave-btn${gameActive ? ' on' : ''}" id="game-btn">${gameActive ? 'STOP' : 'PLAY'}</div>
        <div class="wave-btn${playalong.guide ? ' on' : ''}" id="guide-btn" title="Play a quiet guide melody">GUIDE</div>
      </div>
      <canvas id="game-canvas" class="game-canvas" style="display:${gv.state !== 'idle' ? 'block' : 'none'}"></canvas>
      <div id="game-score" class="quant-notes">${gv.state === 'idle' ? bestLine() : '—'}</div>
    </div>
    ${gestureSectionsHTML()}
    ${shaderSectionHTML()}
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

  // Selecting a kit applies it and refreshes the panel to reflect it.
  document.getElementById('kit-select').addEventListener('change', e => {
    if (applyKit(e.target.value)) renderAudioPanel();
  });

  // Play-along controls.
  document.getElementById('game-btn').addEventListener('click', () => {
    const st = playalong.view.state;
    if (st === 'countdown' || st === 'playing') { playalong.stop(); renderAudioPanel(); return; }
    if (st === 'finished') playalong.stop();     // clear results, then restart
    const ok = playalong.start(
      document.getElementById('song-select').value,
      document.getElementById('diff-select').value,
    );
    if (ok) renderAudioPanel();
  });
  document.getElementById('guide-btn').addEventListener('click', e => {
    playalong.setGuide(!playalong.guide);
    e.target.classList.toggle('on', playalong.guide);
  });
  // Show the saved best for the selected song+difficulty while idle.
  ['song-select', 'diff-select'].forEach(id =>
    document.getElementById(id).addEventListener('change', () => {
      if (playalong.view.state !== 'idle') return;
      const el = document.getElementById('game-score');
      if (el) el.textContent = bestLine();
    }));
  // Manual timbre tweaks flip the kit selection to "Custom" in place
  // (no full re-render — that would kill a slider mid-drag).
  const syncKitToCustom = () => {
    markCustom();
    const sel = document.getElementById('kit-select');
    if (!sel) return;
    if (!sel.querySelector('option[value="custom"]')) {
      sel.insertAdjacentHTML('beforeend', '<option value="custom">Custom</option>');
    }
    sel.value = 'custom';
  };

  document.getElementById('osc1-waves').querySelectorAll('.wave-btn').forEach(b => {
    b.addEventListener('click', () => {
      engine.setOsc1Type(b.dataset.type);
      activateWave(b.parentElement, b.dataset.type);
      syncKitToCustom();
    });
  });
  document.getElementById('osc2-waves').querySelectorAll('.wave-btn').forEach(b => {
    b.addEventListener('click', () => {
      engine.setOsc2Type(b.dataset.type);
      activateWave(b.parentElement, b.dataset.type);
      syncKitToCustom();
    });
  });
  document.getElementById('filt-types').querySelectorAll('.wave-btn').forEach(b => {
    b.addEventListener('click', () => {
      engine.setFilterType(b.dataset.ftype);
      activateWave(b.parentElement, b.dataset.ftype);
      syncKitToCustom();
    });
  });

  // Magnetic detent: dragging within ~1.5% of the range of a snap value locks
  // onto it. Applies only to user drags — mapped writeback never snaps.
  const snapTo = (p, v) => {
    if (!p.snaps) return v;
    const tol = 0.015 * (p.max - p.min);
    for (const s of p.snaps) if (Math.abs(v - s) <= tol) return s;
    return v;
  };
  panel.querySelectorAll('.apr').forEach(el => {
    el.addEventListener('input', e => {
      const key = e.target.dataset.key;
      const p   = engine.PARAMS[key];
      let val = parseFloat(e.target.value);
      const s = snapTo(p, val);
      if (s !== val) { val = s; e.target.value = s; }   // detent the thumb too
      engine.set(key, val);
      const dispEl = document.getElementById(`av-${key}`);
      if (dispEl) dispEl.textContent = val.toFixed(p.unit === 'Hz' ? 0 : 2);
      if (KIT_PARAM_KEYS.has(key)) syncKitToCustom();
    });
  });

  // Pitch quantisation controls
  const quantToggle = document.getElementById('quant-toggle');
  const kbd = document.getElementById('quant-kbd');
  const redrawKbd = () => { panelKbd.invalidate(); panelKbd.draw(kbdOpts()); };
  quantToggle.addEventListener('click', () => {
    const on = !engine.getTuning().enabled;
    engine.setTuning({ enabled: on });
    quantToggle.classList.toggle('on', on);
    quantToggle.textContent = on ? 'ON' : 'OFF';
    kbd.style.display = on ? 'block' : 'none';
    if (on) redrawKbd();
    else document.getElementById('quant-notes').textContent = '—';
  });
  document.getElementById('scale-root')
    .addEventListener('change', e => { engine.setTuning({ root: e.target.value }); redrawKbd(); });
  document.getElementById('scale-name')
    .addEventListener('change', e => { engine.setTuning({ scale: e.target.value }); redrawKbd(); });
  document.getElementById('scale-tuning')
    .addEventListener('change', e => { engine.setTuning({ system: e.target.value }); redrawKbd(); });

  // Reflect the engine's actual waveform / filter selections (they may have
  // just been restored from a saved preset, not the factory defaults).
  document.getElementById('osc1-waves').querySelector(`[data-type="${engine.getOsc1Type()}"]`)?.classList.add('on');
  document.getElementById('osc2-waves').querySelector(`[data-type="${engine.getOsc2Type()}"]`)?.classList.add('on');
  document.getElementById('filt-types').querySelector(`[data-ftype="${engine.getFilterType()}"]`)?.classList.add('on');

  if (t.enabled) redrawKbd();

  wireGestureSections(renderAudioPanel);
  wireShaderSection();

  // Cache slider/readout refs — updateAudioSliders runs every frame and
  // shouldn't pay for per-mapping querySelector calls.
  sliderRefs.clear();
  panel.querySelectorAll('.apr').forEach(el =>
    sliderRefs.set(el.dataset.key, { slider: el, valEl: document.getElementById(`av-${el.dataset.key}`) }));
}

export function updateAudioSliders() {
  mapper.mappings.forEach(m => {
    if (!m.signal) return;
    const p = engine.PARAMS[m.audioParam];
    const r = sliderRefs.get(m.audioParam);
    if (!p || !r) return;
    r.slider.value = p.val;
    if (r.valEl) r.valEl.textContent = p.val.toFixed(p.unit === 'Hz' ? 0 : 2);
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
    panelKbd.draw(kbdOpts());
  }

  updateGesturePanel();
}
