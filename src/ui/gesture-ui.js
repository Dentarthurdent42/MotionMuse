// UI for the Gestures and Chord Mode panel sections. Markup + handlers +
// cheap per-frame live updates (match dots, chord readout). Kept separate so
// audio-ui.js stays focused on the synth panel.

import { gesture, gestureLabel } from '../gesture.js';
import { chordmode, DEGREES, EXPRESSION_MODES, EXPRESSION_CONTROLS } from '../chordmode.js';
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
      <span class="gesture-dot" id="cdot-${i}"></span>
      <span class="chord-degree" title="${c.numeral} · ${c.rootName} ${c.quality}"
        >${c.numeral} · ${c.rootName}</span>
      <select class="ch-shape" data-degree="${i}"
              aria-label="Handshape that plays ${c.numeral}"
        >${shapeOptions(gid)}</select>
      <button class="wave-btn ch-sev${sevenths[i] ? ' on' : ''}" data-degree="${i}"
              aria-pressed="${sevenths[i]}" title="Add the diatonic 7th">7th</button>
    </div>`;
  };

  const ex = chordmode.expression();
  const MODE_LABEL = {
    gesture: 'Handshape holds it',
    hand:    'Other hand — openness',
    brow:    'Eyebrows',
  };
  const CONTROL_LABEL = { gate: 'ATTACK / RELEASE', volume: 'VOLUME' };
  const exprRow = !on ? '' : `
    <div class="chord-expr">
      <span class="chord-key-lbl">PLAY WITH</span>
      <select id="ck-expr-mode" aria-label="What makes the chord sound"
              title="What sounds the chord once a handshape has named it. Two-handed play frees the shape from doing two jobs at once.">
        ${EXPRESSION_MODES.map(m => `<option value="${m}"${m === ex.mode ? ' selected' : ''}>${MODE_LABEL[m]}</option>`).join('')}
      </select>
      <select id="ck-expr-hand" aria-label="Which hand expresses"
              ${ex.mode === 'hand' ? '' : 'disabled'}
              title="The hand that plays; the other names the chord.">
        ${[['L', 'LEFT plays'], ['R', 'RIGHT plays']].map(([v, l]) =>
          `<option value="${v}"${v === ex.hand ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <select id="ck-expr-control" aria-label="How the signal is read"
              ${ex.mode === 'gesture' ? 'disabled' : ''}
              title="ATTACK / RELEASE runs the envelope past a threshold. VOLUME makes the signal the level itself — there is no envelope to run, you are the envelope.">
        ${EXPRESSION_CONTROLS.map(c => `<option value="${c}"${c === ex.control ? ' selected' : ''}>${CONTROL_LABEL[c]}</option>`).join('')}
      </select>
    </div>
    ${ex.mode === 'gesture' ? '' : `
    <div class="chord-expr-cal">
      <label class="ctrl-lbl">OFF AT<input type="range" id="ck-expr-lo" min="0" max="1" step="0.01" value="${ex.lo}"></label>
      <label class="ctrl-lbl">FULL AT<input type="range" id="ck-expr-hi" min="0" max="1" step="0.01" value="${ex.hi}"></label>
      <div class="expr-meter" id="ck-expr-meter" title="Live: the raw signal, and where it lands after the range above. If the bar never empties, raise OFF AT.">
        <div class="expr-fill" id="ck-expr-fill"></div>
        <span class="expr-read" id="ck-expr-read">—</span>
      </div>
    </div>`}`;

  const assignRows = !on ? '' :
    Array.from({ length: DEGREES }, (_, i) => chordRow(i)).join('') + `
    <div class="chord-assign${ex.mode === 'gesture' ? '' : ' dimmed'}" data-degree="release">
      <span class="gesture-dot" id="cdot-release"></span>
      <span class="chord-degree" title="${ex.mode === 'gesture'
        ? 'Holding this shape lets a held chord go'
        : 'Only used when a handshape holds the chord — here the signal above does the releasing'}"
        >RELEASE</span>
      <select class="ch-shape" data-degree="release" ${ex.mode === 'gesture' ? '' : 'disabled'}
              aria-label="Handshape that releases a held chord"
        >${shapeOptions(relId)}</select>
      <span class="ch-sev-gap"></span>
    </div>`;

  return `
    <div class="audio-section" data-sec="gestures">
      <div class="audio-section-label">
        Gestures
        <div class="wave-btn" id="record-gesture-btn"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">● REC</div>
      </div>
      <div id="gesture-list">${gestureRows}</div>
      <div id="gesture-cal-status" class="quant-notes"></div>
      ${calibrate}
      ${restore}
    </div>
    <div class="audio-section" data-sec="chord-mode">
      <div class="audio-section-label">
        Chord Mode
        <button class="wave-btn${on ? ' on' : ''}" id="chord-toggle" aria-pressed="${on}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${on ? 'ON' : 'OFF'}</button>
      </div>
      ${keyRow}
      ${exprRow}
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
      <div class="chord-live" id="chord-live" style="display:${on ? 'grid' : 'none'}">
        <div id="chord-readout" class="quant-notes">—</div>
        <div class="chord-vol" title="How loud the chord is right now">
          <div class="chord-vol-fill" id="chord-vol-fill"></div>
          <span class="chord-vol-read" id="chord-vol-read">—</span>
        </div>
      </div>
      ${on ? '' : '<div class="quant-notes">hold a gesture to play its chord</div>'}
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

  // Expression: every one of these changes which other controls are live (the
  // hand select only matters in two-handed play, the control select not at all
  // in gesture mode), so they all re-render.
  const setExpr = partial => { chordmode.setExpression(partial); rerender?.(); };
  document.getElementById('ck-expr-mode')?.addEventListener('change', e => setExpr({ mode: e.target.value }));
  document.getElementById('ck-expr-hand')?.addEventListener('change', e => setExpr({ hand: e.target.value }));
  document.getElementById('ck-expr-control')?.addEventListener('change', e => setExpr({ control: e.target.value }));
  // The range sliders mutate in place — a re-render mid-drag drops the pointer
  // capture, and these are exactly the controls you want to adjust while
  // watching the meter move.
  document.getElementById('ck-expr-lo')?.addEventListener('input', e =>
    chordmode.setExpression({ lo: +e.target.value }));
  document.getElementById('ck-expr-hi')?.addEventListener('input', e =>
    chordmode.setExpression({ hi: +e.target.value }));

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
    // Which chord is sounding, lit on its own row — the same dot the gestures
    // list uses, because it answers the same question ("is this the one?") and
    // a second visual language for it would be noise.
    // Two states, because latched-but-silent is a real one: in volume mode a
    // chord stays selected while your hand is closed. A single lit dot at 0%
    // volume would read as "this is playing" and be wrong.
    const sounding = chordmode.soundingDegree();
    const audible = chordmode.chordLevel() > 0.001;
    for (let i = 0; i < DEGREES; i++) {
      const d = document.getElementById(`cdot-${i}`);
      if (!d) continue;
      d.classList.toggle('on',  i === sounding && audible);
      d.classList.toggle('sel', i === sounding && !audible);
    }
    const rel = document.getElementById('cdot-release');
    if (rel) rel.classList.toggle('on', chordmode.releaseHeld());

    // …and how loud it actually is. The expression meter above shows the input;
    // this shows the result, which is not the same number once an ADSR is in
    // between — during a release the input is already at zero and the chord is
    // still sounding.
    const lvl = audible ? chordmode.chordLevel() : 0;
    const fillV = document.getElementById('chord-vol-fill');
    if (fillV) {
      const pct = `${Math.round(lvl * 100)}%`;
      if (fillV.style.width !== pct) fillV.style.width = pct;
      fillV.classList.toggle('on', lvl > 0.001);
      const r = document.getElementById('chord-vol-read');
      if (r && r.textContent !== pct) r.textContent = pct;
    }

    // Live expression meter. Without it, calibrating the range is guesswork:
    // you cannot see that a closed fist still reads 0.38 and so never reaches
    // silence, which is the whole reason the range exists.
    const fill = document.getElementById('ck-expr-fill');
    if (fill) {
      const { raw, level, gateOpen } = chordmode.expressionLevel();
      const pct = `${Math.round(level * 100)}%`;
      if (fill.style.width !== pct) fill.style.width = pct;
      fill.classList.toggle('on', gateOpen);
      const read = document.getElementById('ck-expr-read');
      const txt = `${raw.toFixed(2)} → ${Math.round(level * 100)}%`;
      if (read && read.textContent !== txt) read.textContent = txt;
    }
  }
}
