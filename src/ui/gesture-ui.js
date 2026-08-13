// UI for the Gestures and Chord Mode panel sections. Markup + handlers +
// cheap per-frame live updates (match dots, chord readout). Kept separate so
// audio-ui.js stays focused on the synth panel.

import { gesture, gestureLabel } from '../gesture.js';
import { chordmode }  from '../chordmode.js';
import { diatonicChord, DIATONIC_SCALES } from '../chords.js';
import { NOTE_NAMES } from '../scale.js';
import { cvSource }   from '../cv.js';
import { toast }      from './status.js';
import { buildSigPanel } from './signals.js';

const opt = (v, sel) => `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`;

// The key select is narrow; scale.js's full names ("major (ionian)") get
// clipped mid-word, so shorten them for this one control.
const MODE_LABELS = {
  'major (ionian)': 'major',
  'natural minor':  'minor',
  'harmonic minor': 'harm min',
};

export function gestureSectionsHTML() {
  const gestures = gesture.list();
  const on = chordmode.enabled;
  const asg = chordmode.assignments();

  const row = g => {
    const label = gestureLabel(g);
    // The panel column is narrow, so the row shows "Pinky Touch · 6" and keeps
    // the spelled-out "ASL 6" for the tooltip, the signals panel and the chord
    // readout, where there's room. Only `custom` earns a tag of its own —
    // "built-in" on nine of eleven rows is noise that squeezes out the name.
    const short = g.name + (g.asl ? ` · ${g.asl}` : '');
    const tag = g.est
      ? `<span class="gesture-tag est" title="Estimated template — calibrate it on your own hand">est</span>`
      : (g.builtin ? '' : `<span class="gesture-tag">custom</span>`);
    return `
    <div class="gesture-row" data-gid="${g.id}" title="${label}${g.builtin ? ' (built-in)' : ''}">
      <span class="gesture-dot" id="gdot-${g.id}"></span>
      <span class="gesture-name">${short}</span>
      ${tag}
      <button class="rm-btn gesture-cal" data-gid="${g.id}"
              title="Calibrate ${label} on your own hand" aria-label="Calibrate ${label}">⊙</button>
      <button class="rm-btn gesture-del" data-gid="${g.id}"
              title="Remove ${label}" aria-label="Remove ${label}">×</button>
    </div>`;
  };
  // The number handshapes are a set you opt into, so they collapse away by
  // default rather than tripling the length of the list you actually scan.
  const isNum = g => /^asl\d/.test(g.id);
  const nums  = gestures.filter(isNum);
  const est   = gesture.estimated().length;
  const gestureRows = gestures.filter(g => !isNum(g)).map(row).join('')
    + (nums.length ? `
    <details class="gesture-group" id="asl-group">
      <summary>ASL NUMBERS <span class="gesture-tag">${nums.length}</span></summary>
      ${nums.map(row).join('')}
    </details>` : '');
  const restore = gesture.hiddenCount()
    ? `<button class="btn gesture-restore" style="margin-top:4px;width:100%;">RESTORE BUILT-IN GESTURES</button>` : '';
  const calibrate = est
    ? `<button class="btn gesture-cal-all" style="margin-top:4px;width:100%;"
               title="Record each estimated handshape from your own hand, one at a time">CALIBRATE ${est} HANDSHAPE${est > 1 ? 'S' : ''}</button>` : '';

  const key  = chordmode.key();
  const eff  = chordmode.effectiveKey();
  const flw  = chordmode.isFollowing();   // armed *and* actually overriding
  // Degree options are labelled with the numeral *and* the chord it currently
  // spells ("V · G"), so the abstraction stays legible while you pick.
  const degOptions = sel => Array.from({ length: 7 }, (_, i) => {
    const c = diatonicChord(eff.root, eff.octave, eff.mode, i);
    return `<option value="${i}"${i === sel ? ' selected' : ''}>${c.numeral} · ${c.rootName}</option>`;
  }).join('');

  const keyRow = on ? `
    <div class="chord-key">
      <span class="chord-key-lbl">KEY</span>
      <select id="ck-root" ${flw ? 'disabled' : ''} aria-label="Chord key root"
              title="${flw ? 'Following Pitch Quantize' : 'Root of the key chords are built in'}"
        >${NOTE_NAMES.map(n => opt(n, eff.root)).join('')}</select>
      <select id="ck-mode" ${flw ? 'disabled' : ''} aria-label="Chord key mode"
        >${DIATONIC_SCALES.map(s => `<option value="${s}"${s === eff.mode ? ' selected' : ''}>${MODE_LABELS[s] ?? s}</option>`).join('')}</select>
      <select id="ck-oct" aria-label="Chord octave" title="Octave of the chord roots"
        >${[2, 3, 4, 5].map(o => opt(o, key.octave)).join('')}</select>
      <button class="wave-btn${key.follow ? ' on' : ''}" id="ck-follow" aria-pressed="${key.follow}"
              title="${key.follow && !flw
                ? 'Following Pitch Quantize — inactive until quantise is on'
                : 'Take the key from Pitch Quantize, so chords match the melody'}">FOLLOW</button>
    </div>` : '';

  const assignRow = g => {
    const a = asg[g.id] ?? { degree: 0, seventh: false };
    return `
    <div class="chord-assign" data-gid="${g.id}">
      <span class="gesture-name" title="${gestureLabel(g)}">${g.name + (g.asl ? ` · ${g.asl}` : '')}</span>
      <select class="ch-deg" data-gid="${g.id}" aria-label="Scale degree for ${gestureLabel(g)}"
        >${degOptions(a.degree)}</select>
      <button class="wave-btn ch-sev${a.seventh ? ' on' : ''}" data-gid="${g.id}"
              aria-pressed="${a.seventh}" title="Add the diatonic 7th">7th</button>
    </div>`;
  };
  const assignRows = !on ? '' :
    gestures.filter(g => !isNum(g)).map(assignRow).join('')
    + (nums.length ? `
    <details class="gesture-group">
      <summary>ASL NUMBERS <span class="gesture-tag">${nums.length}</span></summary>
      ${nums.map(assignRow).join('')}
    </details>` : '');

  return `
    <div class="audio-section uc-feature" data-sec="gestures">
      <div class="audio-section-label" style="display:flex;align-items:center;">
        Gestures <span class="uc-badge">under construction</span>
        <div class="wave-btn" id="record-gesture-btn"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">● REC</div>
      </div>
      <div id="gesture-list">${gestureRows}</div>
      <div id="gesture-cal-status" class="quant-notes"></div>
      ${calibrate}
      ${restore}
    </div>
    <div class="audio-section uc-feature" data-sec="chord-mode">
      <div class="audio-section-label" style="display:flex;align-items:center;">
        Chord Mode <span class="uc-badge">under construction</span>
        <button class="wave-btn${on ? ' on' : ''}" id="chord-toggle" aria-pressed="${on}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${on ? 'ON' : 'OFF'}</button>
      </div>
      ${keyRow}
      <div id="chord-assigns">${assignRows}</div>
      <div id="chord-readout" class="quant-notes">${on ? '—' : 'hold a gesture to play its chord'}</div>
    </div>`;
}

// How to make each shape, shown during calibration. A template recorded from
// the wrong pose is worse than the estimate it replaces, so the prompt has to
// say exactly what to hold.
const HOW_TO = {
  palm:  'Open hand, all five fingers spread',
  horns: 'Index and pinky up, middle and ring down, thumb tucked',
  asl3:  'Thumb, index and middle up — ring and pinky folded down',
  asl4:  'Four fingers up, thumb folded across the palm',
  asl6:  'Pinky tip touching the thumb, other three fingers up',
  asl7:  'Ring tip touching the thumb, other three fingers up',
  asl8:  'Middle tip touching the thumb, other three fingers up',
  asl9:  'Index tip touching the thumb, other three fingers up',
  asl0:  'All fingertips curved to meet the thumb in an O',
};

// Countdown → record, shared by the single-gesture button and the walkthrough.
// `onDone` receives true when a template was captured.
function runCalibration(id, statusEl, onDone) {
  const g = gesture.list().find(x => x.id === id);
  const label = g ? gestureLabel(g) : id;
  const say = t => { if (statusEl) statusEl.textContent = t; };
  let n = 3;
  say(`${label} — ${HOW_TO[id] ?? 'hold the pose'} … ${n}`);
  const iv = setInterval(() => {
    if (--n > 0) { say(`${label} — ${HOW_TO[id] ?? 'hold the pose'} … ${n}`); return; }
    clearInterval(iv);
    say(`${label} — hold still…`);
    gesture.recalibrate(id, () => { say(`${label} ✓`); onDone(true); });
  }, 900);
}

// rerender: renderAudioPanel (used for structural changes).
export function wireGestureSections(rerender) {
  const recBtn = document.getElementById('record-gesture-btn');
  const status = document.getElementById('gesture-cal-status');

  const calGuard = () => {
    if (gesture.recordingActive) return false;
    if (!cvSource.running) { toast('Start the camera first'); return false; }
    return true;
  };

  document.querySelectorAll('.gesture-cal').forEach(b =>
    b.addEventListener('click', () => {
      if (!calGuard()) return;
      runCalibration(b.dataset.gid, status, () => rerender());
    }));

  document.querySelector('.gesture-cal-all')?.addEventListener('click', () => {
    if (!calGuard()) return;
    const queue = gesture.estimated();
    const step = () => {
      const id = queue.shift();
      if (!id) {
        toast('Calibration complete');
        rerender();               // clears the `est` badges and the button
        return;
      }
      // Re-render between steps would tear down this handler mid-walkthrough,
      // so the list is only rebuilt once the queue is empty.
      runCalibration(id, status, step);
    };
    step();
  });
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

  // Key changes re-render: every degree option's label ("V · G") depends on
  // the key, so the whole assignment list has to be rebuilt.
  const setKey = partial => { chordmode.setKey(partial); rerender(); };
  document.getElementById('ck-root')?.addEventListener('change', e => setKey({ root: e.target.value }));
  document.getElementById('ck-mode')?.addEventListener('change', e => setKey({ mode: e.target.value }));
  document.getElementById('ck-oct') ?.addEventListener('change', e => setKey({ octave: Number(e.target.value) }));
  document.getElementById('ck-follow')?.addEventListener('click', () => {
    // Turning follow off keeps whatever key was being followed, so the sound
    // doesn't jump the moment you take manual control.
    const eff = chordmode.effectiveKey();
    setKey(chordmode.key().follow
      ? { follow: false, root: eff.root, mode: eff.mode }
      : { follow: true });
  });

  document.querySelectorAll('.ch-deg').forEach(sel =>
    sel.addEventListener('change', e =>
      chordmode.assign(e.target.dataset.gid, { degree: Number(e.target.value) })));

  document.querySelectorAll('.ch-sev').forEach(btn =>
    btn.addEventListener('click', () => {
      const on = !(chordmode.assignments()[btn.dataset.gid]?.seventh);
      chordmode.assign(btn.dataset.gid, { seventh: on });
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    }));
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
