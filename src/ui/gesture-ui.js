// UI for the Gestures and Chord Mode panel sections. Markup + handlers +
// cheap per-frame live updates (match dots, chord readout). Kept separate so
// audio-ui.js stays focused on the synth panel.

import { gesture }    from '../gesture.js';
import { chordmode }  from '../chordmode.js';
import { QUALITIES }  from '../chords.js';
import { NOTE_NAMES } from '../scale.js';
import { cvSource }   from '../cv.js';
import { toast }      from './status.js';
import { buildSigPanel } from './signals.js';

const opt = (v, sel) => `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`;

export function gestureSectionsHTML() {
  const gestures = gesture.list();
  const on = chordmode.enabled;
  const asg = chordmode.assignments();

  const gestureRows = gestures.map(g => `
    <div class="gesture-row" data-gid="${g.id}">
      <span class="gesture-dot" id="gdot-${g.id}"></span>
      <span class="gesture-name">${g.name}</span>
      <span class="gesture-tag">${g.builtin ? 'built-in' : 'custom'}</span>
      <button class="rm-btn gesture-del" data-gid="${g.id}"
              title="Remove ${g.name}" aria-label="Remove ${g.name}">×</button>
    </div>`).join('');
  const restore = gesture.hiddenCount()
    ? `<button class="btn gesture-restore" style="margin-top:4px;width:100%;">RESTORE BUILT-IN GESTURES</button>` : '';

  const octaves = [2, 3, 4, 5];
  const assignRows = on ? gestures.map(g => {
    const a = asg[g.id] ?? { root: 'C', octave: 4, quality: 'major' };
    return `
    <div class="chord-assign" data-gid="${g.id}">
      <span class="gesture-name">${g.name}</span>
      <select class="ch-root" data-gid="${g.id}">${NOTE_NAMES.map(n => opt(n, a.root)).join('')}</select>
      <select class="ch-oct"  data-gid="${g.id}">${octaves.map(o => opt(o, a.octave)).join('')}</select>
      <select class="ch-qual" data-gid="${g.id}">${Object.keys(QUALITIES).map(q => opt(q, a.quality)).join('')}</select>
    </div>`;
  }).join('') : '';

  return `
    <div class="audio-section uc-feature">
      <div class="audio-section-label" style="display:flex;align-items:center;">
        Gestures <span class="uc-badge">under construction</span>
        <div class="wave-btn" id="record-gesture-btn"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">● REC</div>
      </div>
      <div id="gesture-list">${gestureRows}</div>
      ${restore}
    </div>
    <div class="audio-section uc-feature">
      <div class="audio-section-label" style="display:flex;align-items:center;">
        Chord Mode <span class="uc-badge">under construction</span>
        <button class="wave-btn${on ? ' on' : ''}" id="chord-toggle" aria-pressed="${on}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${on ? 'ON' : 'OFF'}</button>
      </div>
      <div id="chord-assigns">${assignRows}</div>
      <div id="chord-readout" class="quant-notes">${on ? '—' : 'hold a gesture to play its chord'}</div>
    </div>`;
}

// rerender: renderAudioPanel (used for structural changes).
export function wireGestureSections(rerender) {
  const recBtn = document.getElementById('record-gesture-btn');
  recBtn?.addEventListener('click', () => {
    if (gesture.recordingActive) return;
    if (!cvSource.running) { toast('Start the camera first'); return; }
    const name = prompt('Name this gesture:');
    if (name === null) return;
    let n = 3;
    recBtn.classList.add('on');
    recBtn.textContent = `${n}…`;
    const iv = setInterval(() => {
      n--;
      if (n > 0) { recBtn.textContent = `${n}…`; return; }
      clearInterval(iv);
      recBtn.textContent = '● REC…';
      gesture.record(name.trim() || 'Gesture', g => {
        toast(`Recorded "${g.name}"`);
        buildSigPanel();     // new gesture_<id> signal appears in the panel + mapper
        rerender();
      });
    }, 700);
  });

  document.querySelectorAll('.gesture-del').forEach(b =>
    b.addEventListener('click', () => {
      gesture.remove(b.dataset.gid);
      chordmode.unassign(b.dataset.gid);
      buildSigPanel();
      rerender();
    }));

  document.querySelector('.gesture-restore')?.addEventListener('click', () => {
    gesture.restoreBuiltins();
    buildSigPanel();
    rerender();
  });

  document.getElementById('chord-toggle')?.addEventListener('click', () => {
    chordmode.setEnabled(!chordmode.enabled);
    rerender();
  });

  const bindAssign = (cls, field, cast = v => v) =>
    document.querySelectorAll(cls).forEach(sel =>
      sel.addEventListener('change', e =>
        chordmode.assign(e.target.dataset.gid, { [field]: cast(e.target.value) })));
  bindAssign('.ch-root', 'root');
  bindAssign('.ch-oct',  'octave', Number);
  bindAssign('.ch-qual', 'quality');
}

// Cheap per-frame update: light the dot of each currently-held gesture and
// show the active gesture→chord.
export function updateGesturePanel() {
  const active = new Set(gesture.current());
  gesture.list().forEach(g => {
    const dot = document.getElementById(`gdot-${g.id}`);
    if (dot) dot.classList.toggle('on', active.has(g.id));
  });
  if (chordmode.enabled) {
    const el = document.getElementById('chord-readout');
    if (el) {
      const txt = chordmode.currentLabel() || '—';
      if (el.textContent !== txt) el.textContent = txt;
    }
  }
}
