// UI for the Gestures and Chord Mode panel sections. Markup + handlers +
// cheap per-frame live updates (match dots, chord readout). Kept separate so
// audio-ui.js stays focused on the synth panel.

import { gesture, gestureLabel } from '../gesture.js';
import { chordmode, DEGREES } from '../chordmode.js';
import { diatonicChord, DIATONIC_SCALES } from '../chords.js';
import { NOTE_NAMES } from '../scale.js';
import { cvSource }   from '../cv.js';
import { engine }     from '../engine.js';
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
  const relId = chordmode.getReleaseGesture();
  const env = engine.getChordEnv();
  const on = chordmode.enabled;

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
  const sevenths = chordmode.sevenths();
  const flw  = chordmode.isFollowing();   // armed *and* actually overriding
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

  // One row per CHORD, not per handshape.
  //
  // It was the other way round, and that let the same shape be a chord *and*
  // the release — a configuration the panel would happily show and the tick
  // loop then had to break by fiat, so what you saw was not what you heard.
  // Listing the chords instead makes the mapping a function by construction:
  // seven degrees plus RELEASE, one handshape each, and choosing a shape takes
  // it off whatever it was doing before.
  const shapeOptions = sel => `<option value=""${!sel ? ' selected' : ''}>—</option>`
    + gesture.list().map(g =>
        `<option value="${g.id}"${g.id === sel ? ' selected' : ''}>${gestureLabel(g)}</option>`).join('');

  const chordRow = i => {
    const c = diatonicChord(eff.root, eff.octave, eff.mode, i, sevenths[i]);
    const gid = chordmode.gestureFor(i);
    return `
    <div class="chord-assign" data-degree="${i}">
      <span class="chord-degree" title="${c.numeral} · ${c.rootName} ${c.quality}"
        >${c.numeral} · ${c.rootName}</span>
      <select class="ch-shape" data-degree="${i}"
              aria-label="Handshape that plays ${c.numeral}"
        >${shapeOptions(gid)}</select>
      <button class="wave-btn ch-sev${sevenths[i] ? ' on' : ''}" data-degree="${i}"
              aria-pressed="${sevenths[i]}" title="Add the diatonic 7th">7th</button>
    </div>`;
  };

  const assignRows = !on ? '' :
    Array.from({ length: DEGREES }, (_, i) => chordRow(i)).join('') + `
    <div class="chord-assign" data-degree="release">
      <span class="chord-degree" title="Holding this shape lets a held chord go">RELEASE</span>
      <select class="ch-shape" data-degree="release" aria-label="Handshape that releases a held chord"
        >${shapeOptions(relId)}</select>
      <span class="ch-sev-gap"></span>
    </div>`;

  return `
    <div class="audio-section uc-feature" data-sec="gestures">
      <div class="audio-section-label">
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
      <div class="audio-section-label">
        Chord Mode <span class="uc-badge">under construction</span>
        <button class="wave-btn${on ? ' on' : ''}" id="chord-toggle" aria-pressed="${on}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${on ? 'ON' : 'OFF'}</button>
      </div>
      ${keyRow}
      <div id="chord-assigns">${assignRows}</div>
      <div class="scale-grid" style="grid-template-columns:1fr 1fr 1fr 1fr;margin-top:6px;">
        ${['attack', 'decay', 'sustain', 'release'].map(k => `
          <label class="ctrl-lbl" style="display:flex;flex-direction:column;gap:2px;">
            ${k.slice(0, 3).toUpperCase()}
            <input type="range" class="ck-env" data-env="${k}"
              min="${engine.CHORD_ENV_RANGE[k][0]}" max="${engine.CHORD_ENV_RANGE[k][1]}"
              step="0.005" value="${env[k]}">
            <span class="ctrl-val" id="ck-env-${k}">${k === 'sustain' ? Math.round(env[k] * 100) + '%' : env[k].toFixed(2) + 's'}</span>
          </label>`).join('')}
      </div>
      <div id="chord-readout" class="quant-notes">${on ? '—' : 'hold a gesture to play its chord'}</div>
    </div>`;
}

// How to make each shape, shown during calibration. A template recorded from
// the wrong pose is worse than the estimate it replaces, so the prompt has to
// say exactly what to hold.
const HOW_TO = {
  palm:  'Open hand, all five fingers spread',
  horns: 'Index and pinky up, middle and ring down, thumb tucked',
  gun:   'Index pointing forward, thumb up and clear of the palm — an L',
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
  // ADSR sliders mutate in place: a re-render mid-drag would drop the pointer
  // capture and the slider would stop following the finger.
  document.querySelectorAll('.ck-env').forEach(el => {
    el.addEventListener('input', e => {
      const k = e.target.dataset.env;
      const v = engine.setChordEnv({ [k]: +e.target.value })[k];
      const out = document.getElementById(`ck-env-${k}`);
      if (out) out.textContent = k === 'sustain' ? `${Math.round(v * 100)}%` : `${v.toFixed(2)}s`;
    });
  });

  document.getElementById('ck-follow')?.addEventListener('click', () => {
    // Turning follow off keeps whatever key was being followed, so the sound
    // doesn't jump the moment you take manual control.
    const eff = chordmode.effectiveKey();
    setKey(chordmode.key().follow
      ? { follow: false, root: eff.root, mode: eff.mode }
      : { follow: true });
  });

  // Choosing a handshape for a chord (or for RELEASE) always re-renders:
  // the shape is taken off whatever it was doing, so at least one other row
  // changes too. Updating only the row that was touched is what would let the
  // panel disagree with the state again.
  document.querySelectorAll('.ch-shape').forEach(sel =>
    sel.addEventListener('change', e => {
      const where = e.target.dataset.degree;
      const id = e.target.value || null;
      if (where === 'release') chordmode.setReleaseGesture(id);
      else chordmode.setDegreeGesture(Number(where), id);
      rerender?.();
    }));

  // The 7th belongs to the chord, so it needs no re-render — nothing else moves.
  document.querySelectorAll('.ch-sev').forEach(btn =>
    btn.addEventListener('click', () => {
      const d = Number(btn.dataset.degree);
      const on = !chordmode.sevenths()[d];
      chordmode.setSeventh(d, on);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      // The row label carries the quality ("V" vs "V7"), so it moves with it.
      const lbl = btn.parentElement?.querySelector('.chord-degree');
      const c = chordmode.chordAt(d);
      if (lbl && c) { lbl.textContent = `${c.numeral} · ${c.rootName}`; lbl.title = `${c.numeral} · ${c.rootName} ${c.quality}`; }
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
