// UI for the Radial Menu panel section — the joint-anchored ring of scale
// degrees (src/radial.js). Markup + handlers + the cheap per-frame readout,
// kept beside gesture-ui.js because the two sections are siblings: both are
// ways of playing the chord voice bank, and both speak the same key.
//
// The KEY row here EDITS THE SAME KEY as gesture mode's — chordmode owns it,
// both rows render from it, and a change in either re-renders the whole
// panel, so the two can never disagree. That is deliberate: nobody plays two
// scales at once, so there is one scale to pick, reachable from wherever you
// happen to be looking.

import { radial, FINGERS }       from '../radial.js';
import { chordmode }             from '../chordmode.js';
import { DEGREE_SCALES }         from '../chords.js';
import { NOTE_NAMES }            from '../scale.js';
import { engine }                from '../engine.js';
import { cvSource }              from '../cv.js';
import { faceSource }            from '../face.js';

const opt = (v, sel) => `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`;

// Same abbreviations the gesture panel uses for its (equally narrow) select.
const MODE_LABELS = {
  'major (ionian)':   'major',
  'natural minor':    'minor',
  'harmonic minor':   'harm min',
  'major pentatonic': 'maj pent',
  'minor pentatonic': 'min pent',
};

const JOINT_LABELS = {
  wrist_L:    'Left wrist',
  wrist_R:    'Right wrist',
  shoulder_L: 'Left shoulder',
  shoulder_R: 'Right shoulder',
};

// What still has to be switched on for the chosen joint to track — said in
// the panel, because a ring that never appears is otherwise indistinguishable
// from a broken one.
function needsLine({ joint, side, volume }) {
  const missing = [];
  if (!cvSource.running) missing.push('the camera');
  if (joint === 'wrist') {
    if (side === 'L' ? !cvSource.handsL : !cvSource.handsR) {
      missing.push(`${side === 'L' ? 'left' : 'right'}-hand tracking`);
    }
    if (!cvSource.poseOn) {
      return missing.length
        ? `Needs ${missing.join(' + ')}. Pose is off, so the ring faces the camera instead of riding the forearm.`
        : 'Pose is off, so the ring faces the camera instead of riding the forearm.';
    }
  } else if (!cvSource.poseOn) {
    missing.push('pose tracking');
  }
  // Eyebrow volume reads brow_raise, which only the face model feeds — a
  // volume control wired to a tracker that is off is silence with no
  // explanation.
  if (volume === 'brow' && !faceSource.faceOn) missing.push('face tracking');
  return missing.length ? `Needs ${missing.join(' + ')}.` : '';
}

export function radialMenuSection() {
  const on = radial.enabled;
  const cfg = radial.config();
  const key = chordmode.key();
  const eff = chordmode.effectiveKey();
  const flw = chordmode.isFollowing();
  const jointVal = `${cfg.joint}_${cfg.side}`;
  const sevenths = chordmode.sevenths();
  const vol = radial.volumeState();
  const needs = on ? needsLine(cfg) : '';

  const keyRow = !on ? '' : `
    <div class="chord-key">
      <span class="chord-key-lbl">KEY</span>
      <select id="rk-root" ${flw ? 'disabled' : ''} aria-label="Radial menu key root"
              title="${flw ? 'Following Pitch Quantize' : 'Root of the key — shared with Gesture Mode'}"
        >${NOTE_NAMES.map(n => opt(n, eff.root)).join('')}</select>
      <select id="rk-mode" ${flw ? 'disabled' : ''} aria-label="Radial menu key mode"
              title="The scale — its degree count is the section count: seven arcs for a diatonic mode, five for a pentatonic"
        >${DEGREE_SCALES.map(s => `<option value="${s}"${s === eff.mode ? ' selected' : ''}>${MODE_LABELS[s] ?? s}</option>`).join('')}</select>
      <select id="rk-oct" aria-label="Radial menu octave" title="Octave of the degrees"
        >${[2, 3, 4, 5].map(o => opt(o, key.octave)).join('')}</select>
      <button class="wave-btn${key.follow ? ' on' : ''}" id="rk-follow" aria-pressed="${key.follow}"
              title="${key.follow && !flw
                ? 'Following Pitch Quantize — inactive until quantise is on'
                : 'Take the key from Pitch Quantize, so the fan matches the melody'}">FOLLOW</button>
    </div>`;

  // ── 7ths ────────────────────────────────────────────────────────────
  //
  // The 7th belongs to the CHORD, and chordmode owns that table — so these
  // buttons write the same state gesture mode's per-chord 7th buttons do, and
  // a 7th set in either place is set in both. They live here because gesture
  // mode's rows are hidden whenever it is switched off, and enabling the
  // radial menu switches it off: without this row, the radial menu's chords
  // honoured a 7ths table nothing on screen could reach.
  //
  // One button per section rather than a row per chord — the ring's sections
  // have no rows to hang them on — labelled with the numeral each degree
  // currently sounds, so the label says what the toggle did ("V" → "V7").
  const seventhsRow = (!on || cfg.voicing !== 'chord') ? '' : `
    <div class="chord-voicing">
      <span class="chord-key-lbl" title="Add the diatonic 7th to a degree. Shared with Gesture Mode.">7THS</span>
      <div class="wave-btns" style="flex:1;flex-wrap:wrap;">
        ${Array.from({ length: chordmode.degreeCount() }, (_, i) => {
          const c = chordmode.chordAt(i);
          return `<button type="button" class="wave-btn rad-sev${sevenths[i] ? ' on' : ''}"
                  data-degree="${i}" aria-pressed="${sevenths[i]}"
                  title="${sevenths[i] ? 'Remove' : 'Add'} the diatonic 7th on ${c.rootName}"
            >${c.numeral}</button>`;
        }).join('')}
      </div>
    </div>`;

  const controls = !on ? '' : `
    <div class="chord-voicing">
      <span class="chord-key-lbl">JOINT</span>
      <select id="radial-joint" aria-label="Which joint the ring is worn on"
              title="Wrist: the ring rides the forearm — its plane is square to the arm — and a fingertip points around it. Shoulder: the ring lies on the torso and the whole arm points.">
        ${Object.entries(JOINT_LABELS).map(([v, l]) =>
          `<option value="${v}"${v === jointVal ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="chord-voicing">
      <span class="chord-key-lbl">PLAY</span>
      <select id="radial-voicing" aria-label="Whether a section sounds one note or its chord"
              title="The same sections, sounding either the degree's own note or the whole chord built on it — as in Gesture Mode.">
        <option value="note"${cfg.voicing === 'note' ? ' selected' : ''}>SINGLE NOTES</option>
        <option value="chord"${cfg.voicing === 'chord' ? ' selected' : ''}>CHORDS</option>
      </select>
    </div>
    <div class="chord-voicing">
      <span class="chord-key-lbl">FINGER</span>
      <select id="radial-finger" ${cfg.joint === 'wrist' ? '' : 'disabled'}
              aria-label="Which fingertip points"
              title="${cfg.joint === 'wrist'
                ? 'The fingertip that reaches into the ring. Index is the pointing finger; curling it back releases the note.'
                : 'On the shoulder the whole arm is the pointer, so there is no finger to choose.'}">
        ${Object.keys(FINGERS).map(f =>
          `<option value="${f}"${f === cfg.finger ? ' selected' : ''}>${f.toUpperCase()}</option>`).join('')}
      </select>
    </div>
    <div class="chord-voicing">
      <span class="chord-key-lbl">VOLUME</span>
      <select id="radial-volume" aria-label="What sets the loudness"
              title="Entry speed: how fast the pointer crosses into a section sets the attack, and the chord ADSR shapes the note. The other two hand loudness to a signal, as in Gesture Mode — the ring still names and holds the note, but the signal IS the level, continuously; there is no envelope to run, you are the envelope. With the other hand playing the volume, accidentals stand down.">
        ${[['off', 'Entry speed'], ['hand', 'Other hand — openness'], ['brow', 'Eyebrows']]
          .map(([m, l]) => `<option value="${m}"${m === vol.mode ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${vol.mode === 'off' ? '' : `
    <div class="chord-expr-cal">
      <label class="ctrl-lbl">OFF AT<input type="range" id="radial-vol-lo" min="0" max="1" step="0.01" value="${vol.lo}"></label>
      <label class="ctrl-lbl">FULL AT<input type="range" id="radial-vol-hi" min="0" max="1" step="0.01" value="${vol.hi}"></label>
      <div class="expr-meter" id="radial-vol-meter" title="Live: the raw signal, and where it lands after the range above. If the bar never empties, raise OFF AT.">
        <div class="expr-fill" id="radial-vol-fill"></div>
        <span class="expr-read" id="radial-vol-read">—</span>
      </div>
    </div>`}
    ${seventhsRow}
    <div class="wave-btns" style="margin-top:4px;">
      <button type="button" class="wave-btn${engine.getShepard().chord ? ' on' : ''}" id="radial-shep"
           aria-pressed="${engine.getShepard().chord}"
           title="Shepard tones — this mode's default voice: every note becomes a stack of octaves under a fixed loudness curve, so runs around the ring climb without ever leaving their register.">SHEPARD</button>
    </div>
    <div class="quant-notes" id="radial-readout" role="status" aria-live="polite">${needs || '—'}</div>`;

  return `
    <div class="audio-section" data-sec="radial-menu">
      <div class="audio-section-label">
        Radial Menu
        <button class="wave-btn${on ? ' on' : ''}" id="radial-toggle" aria-pressed="${on}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${on ? 'ON' : 'OFF'}</button>
      </div>
      ${keyRow}
      ${controls}
      ${on ? '' : `<div class="quant-notes">switch on to play scale degrees by pointing — a ring of sections around your wrist or shoulder</div>`}
    </div>`;
}

// rerender: renderAudioPanel — structural changes rebuild the whole panel,
// exactly as the gesture section does, so the shared key rows stay in step.
export function wireRadialSection(rerender) {
  document.getElementById('radial-toggle')?.addEventListener('click', () => {
    radial.setEnabled(!radial.enabled);     // enabling parks gesture mode
    rerender();
  });

  document.getElementById('radial-joint')?.addEventListener('change', e => {
    const [joint, side] = e.target.value.split('_');
    radial.setJoint(joint, side);
    rerender();                             // the finger select follows the joint
  });
  document.getElementById('radial-voicing')?.addEventListener('change', e => {
    radial.setVoicing(e.target.value);
    rerender();
  });
  document.getElementById('radial-finger')?.addEventListener('change', e => {
    radial.setFinger(e.target.value);
  });
  document.getElementById('radial-volume')?.addEventListener('change', e => {
    radial.setVolume({ mode: e.target.value });
    rerender();                             // the range sliders appear with it
  });
  // The range sliders mutate in place — a re-render mid-drag drops the
  // pointer, and these are exactly the controls you adjust while watching
  // the meter move.
  document.getElementById('radial-vol-lo')?.addEventListener('input', e =>
    radial.setVolume({ lo: +e.target.value }));
  document.getElementById('radial-vol-hi')?.addEventListener('input', e =>
    radial.setVolume({ hi: +e.target.value }));

  // Re-renders: the button relabels itself with the numeral it now sounds
  // ("V" → "V7"), and a 7th is a property of the chord, so nothing else in
  // the panel has to move.
  document.querySelectorAll('.rad-sev').forEach(btn =>
    btn.addEventListener('click', () => {
      const d = Number(btn.dataset.degree);
      chordmode.setSeventh(d, !chordmode.sevenths()[d]);
      rerender();
    }));

  document.getElementById('radial-shep')?.addEventListener('click', () => {
    radial.toggleShepard();
    rerender();
  });

  // The shared key — same state the gesture panel's KEY row writes.
  const setKey = partial => { chordmode.setKey(partial); rerender(); };
  document.getElementById('rk-root')?.addEventListener('change', e => setKey({ root: e.target.value }));
  document.getElementById('rk-mode')?.addEventListener('change', e => setKey({ mode: e.target.value }));
  document.getElementById('rk-oct') ?.addEventListener('change', e => setKey({ octave: Number(e.target.value) }));
  document.getElementById('rk-follow')?.addEventListener('click', () => {
    const eff = chordmode.effectiveKey();
    setKey(chordmode.key().follow
      ? { follow: false, root: eff.root, mode: eff.mode }
      : { follow: true });
  });
}

// Cheap per-frame update: what the pointer is on, and whether it is sounding.
export function updateRadialPanel() {
  if (!radial.enabled) return;
  const el = document.getElementById('radial-readout');
  if (!el) return;
  const s = radial.soundingSection();
  const geo = radial.geometry();
  const cfg = radial.config();
  let txt;
  if (s !== null) txt = `● ${radial.sectionLabel(s, { long: true })}`;
  else if (!geo) txt = needsLine(cfg) || `waiting for tracking — bring the ${cfg.joint} into frame`;
  else txt = 'in reach — extend into the ring to play';
  if (el.textContent !== txt) el.textContent = txt;

  // Live volume meter. Without it, calibrating the range is guesswork: you
  // cannot see that a closed fist still reads 0.42 and so never reaches
  // silence, which is the whole reason the range exists.
  const fill = document.getElementById('radial-vol-fill');
  if (fill) {
    const { raw, level } = radial.volumeLevel();
    const pct = `${Math.round(level * 100)}%`;
    if (fill.style.width !== pct) fill.style.width = pct;
    fill.classList.toggle('on', level > 0 && s !== null);
    const read = document.getElementById('radial-vol-read');
    const rtxt = `${raw.toFixed(2)} → ${Math.round(level * 100)}%`;
    if (read && read.textContent !== rtxt) read.textContent = rtxt;
  }
}
