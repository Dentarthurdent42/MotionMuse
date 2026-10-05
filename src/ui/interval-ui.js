// The INTERVAL MODE node — handshapes name the distance to the next note
// (src/interval.js). A sibling of Gesture Mode and Radial Mode: another way of
// playing the chord voice bank, in the same key, and only one of the three
// is on at a time.
//
// The shape rows are the same shape as Gesture Mode's degree rows and Chord
// Quality's quality rows — dot, name, picker, calibrate — so a player who has
// set one up already knows how to read this one.

import { interval, SIZES } from '../interval.js';
import { gesture, gestureLabel } from '../gesture.js';
import { cvSource }  from '../cv.js';
import { metronome } from '../metronome.js';
import { inPort }    from './mapper-ui.js';
import { syncControls } from '../controls.js';
import { calibrateGesture } from './gesture-ui.js';

const HANDS_LABEL = { one: 'ONE HAND', two: 'TWO — L down, R up' };
const TRIGGER_LABEL = { beat: 'Metronome beats', step: 'STEP input', change: 'Each new shape' };
const UNIT_LABEL = { scale: 'Scale steps', semitone: 'Semitones' };
const HAND_NAME = { L: 'left', R: 'right' };

const arrow = dir => (dir < 0 ? '↓' : '↑');

// What still has to be switched on — said in the node, because a mode that
// waits on a stopped clock is otherwise indistinguishable from a broken one.
function needsLine(cfg) {
  const missing = [];
  if (!cvSource.running) missing.push('the camera');
  const sides = cfg.hands === 'two' ? ['L', 'R'] : [cfg.hand];
  for (const s of sides) {
    if (s === 'L' ? !cvSource.handsL : !cvSource.handsR) missing.push(`${HAND_NAME[s]}-hand tracking`);
  }
  if (cfg.trigger === 'beat' && !metronome.on) missing.push('the metronome (switch it on)');
  return missing.length ? `Needs ${missing.join(' + ')}.` : '';
}

// What one hand's reading means, in a few characters.
const readingText = r => {
  if (!r || r.kind === 'none') return '—';
  if (r.kind === 'silence') return 'silence';
  if (r.kind === 'sustain') return 'sustain';
  return `${arrow(r.dir)} ${interval.sizeName(r.size)}`;
};

export function intervalSection() {
  const on = interval.enabled;
  const cfg = interval.config();
  const assigned = interval.gestures();
  const gestures = gesture.list();

  const options = sel => `<option value=""${!sel ? ' selected' : ''}>—</option>`
    + gestures.map(g => `<option value="${g.id}"${g.id === sel ? ' selected' : ''}>`
                      + `${gestureLabel(g)}${g.est ? ' · est' : ''}</option>`).join('');

  const row = (slot, name, hint) => {
    const gid = assigned[slot];
    const g = gid ? gestures.find(x => x.id === gid) : null;
    return `
    <div class="chord-assign" data-islot="${slot}" title="${hint}">
      <span class="gesture-dot" id="idot-${slot}"></span>
      <span class="chord-degree">${name}</span>
      <select class="iv-shape" data-slot="${slot}" aria-label="Gesture for ${name}"
              title="The handshape that means this">${options(gid)}</select>
      <button class="rm-btn iv-cal" data-gid="${g ? g.id : ''}" ${g ? '' : 'disabled'}
              title="${g ? `Re-record ${gestureLabel(g)} from your own hand` : 'Choose a gesture first'}"
              aria-label="${g ? `Calibrate ${gestureLabel(g)}` : 'Calibrate'}">⊙</button>
      <span class="ch-sev-gap"></span>
    </div>`;
  };

  const sel = (id, key, label, values, current, labels, extra = '') => `
    <div class="chord-voicing">
      <span class="chord-key-lbl">${inPort(key)}${label}</span>
      <select id="${id}" ${extra}>
        ${values.map(v => `<option value="${v}"${v === current ? ' selected' : ''}>${labels[v]}</option>`).join('')}
      </select>
    </div>`;

  return `
    <div class="audio-section" data-sec="interval-mode">
      <div class="audio-section-label">
        Interval Mode
        <span class="head-sock">${inPort('interval_on')}</span>
        <button class="wave-btn${on ? ' on' : ''}" id="interval-toggle" aria-pressed="${on}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${on ? 'ON' : 'OFF'}</button>
      </div>
      ${sel('iv-hands', 'interval_hands', 'HANDS', ['one', 'two'], cfg.hands, HANDS_LABEL,
            'aria-label="One hand or two" title="One hand: the shape says how far, leaning the hand over to your left says down (upright is up). Two hands: the right hand\'s shapes go up, the left hand\'s go down."')}
      ${sel('iv-hand', 'interval_hand', 'HAND', ['L', 'R'], cfg.hand, { L: 'LEFT', R: 'RIGHT' },
            `aria-label="Which hand plays" ${cfg.hands === 'two' ? 'disabled title="Both hands play in two-handed mode"' : 'title="The hand whose shapes and lean are read"'}`)}
      ${sel('iv-trigger', 'interval_trigger', 'TRIGGER', ['beat', 'step', 'change'], cfg.trigger, TRIGGER_LABEL,
            'aria-label="When the hands are read" title="Metronome beats: every SAMPLE beat moves by what the hands show — hold a 2 and it climbs the scale. STEP input: a pulse on the STEP socket (wire another gesture, a pinch, a nod) or the button. Each new shape: forming a shape moves once."')}
      ${sel('iv-unit', 'interval_unit', 'COUNT', ['scale', 'semitone'], cfg.unit, UNIT_LABEL,
            'aria-label="What a size counts" title="Scale steps: a 2 is a second, the key\'s next note; a 1 is the same note again; 8 is the octave. Semitones: a shape N moves N semitones."')}
      <div class="met-row"><span class="chord-key-lbl">${inPort('interval_step')}STEP</span>
        <button type="button" class="wave-btn" id="iv-step" title="Move once by what the hands show now — wire any signal into this socket to make it your trigger gesture">▶ STEP</button></div>
      <div class="met-row"><span class="chord-key-lbl">${inPort('interval_home')}HOME</span>
        <button type="button" class="wave-btn" id="iv-home" title="Back to the key's tonic">⌂ TONIC</button></div>
      ${SIZES.map(n => row(String(n), `${n} · ${interval.sizeName(n)}`,
          cfg.unit === 'semitone' ? `${n} semitone${n > 1 ? 's' : ''}` : `A ${interval.sizeName(n)} — ${n - 1} scale step${n === 2 ? '' : 's'}`)).join('')}
      ${row('sustain', 'SUSTAIN', 'Keep whatever is ringing, and do not move')}
      ${row('silence', 'SILENCE', 'Let go — the note stops, and the melody stays where it was')}
      <div id="iv-cal-status" class="quant-notes" role="status" aria-live="polite"></div>
      <div class="quant-notes" id="iv-readout" role="status" aria-live="polite">${on ? (needsLine(cfg) || '—')
        : 'switch on to play the distance to the next note — a 3 is a third from where you are'}</div>
    </div>`;
}

let rerenderPanel = null;

export function wireIntervalSection(rerender) {
  rerenderPanel = rerender;
  document.getElementById('interval-toggle')?.addEventListener('click', () => {
    interval.setEnabled(!interval.enabled);   // enabling parks the other modes
    syncControls();
    rerender();
  });
  const onSel = (id, fn) => document.getElementById(id)?.addEventListener('change', e => {
    fn(e.target.value); syncControls(); rerender();
  });
  onSel('iv-hands', v => interval.setHands(v));
  onSel('iv-hand', v => interval.setHand(v));
  onSel('iv-trigger', v => interval.setTrigger(v));
  onSel('iv-unit', v => interval.setUnit(v));
  document.getElementById('iv-step')?.addEventListener('click', () => interval.step());
  document.getElementById('iv-home')?.addEventListener('click', () => interval.home());
  document.querySelectorAll('.iv-shape').forEach(s =>
    s.addEventListener('change', e => {
      interval.setGesture(e.target.dataset.slot, e.target.value || null);
      rerender();   // taking a shape for one slot frees it from another
    }));
  const status = document.getElementById('iv-cal-status');
  document.querySelectorAll('.iv-cal').forEach(b =>
    b.addEventListener('click', () => calibrateGesture(b.dataset.gid, status, () => rerender())));
}

// Per frame: light the rows the hands are showing, and say where the melody is.
export function updateIntervalPanel() {
  const btn = document.getElementById('interval-toggle');
  if (!btn) return;
  // Parked from elsewhere (another mode's switch, a starter, a preset): the
  // node follows on the next frame rather than showing ON over silence.
  if (btn.classList.contains('on') !== interval.enabled) { rerenderPanel?.(); return; }
  if (!interval.enabled) return;
  const cfg = interval.config();
  const live = interval.live();
  const lit = new Set();
  for (const r of Object.values(live)) {
    if (r.kind === 'step') lit.add(String(r.size));
    else if (r.kind === 'sustain' || r.kind === 'silence') lit.add(r.kind);
  }
  document.querySelectorAll('[data-islot]').forEach(el => {
    const dot = document.getElementById(`idot-${el.dataset.islot}`);
    if (dot) dot.classList.toggle('on', lit.has(el.dataset.islot));
  });

  const el = document.getElementById('iv-readout');
  if (!el) return;
  const needs = needsLine(cfg);
  const note = `${interval.sounding() ? '●' : '○'} ${interval.noteName()}`;
  const hands = Object.entries(live).map(([s, r]) =>
    cfg.hands === 'two' ? `${s} ${readingText(r)}` : readingText(r)).join(' · ');
  const txt = needs || `${note}   next: ${hands}`;
  if (el.textContent !== txt) el.textContent = txt;
}
