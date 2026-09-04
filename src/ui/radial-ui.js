// UI for the Radial Mode panel section — the joint-anchored ring of scale
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
import { cvSource }              from '../cv.js';
import { metronome }             from '../metronome.js';
import { faceSource }            from '../face.js';
import { rows }                  from './rows.js';
import { inPort }                from './mapper-ui.js';
import { syncControls }          from '../controls.js';

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
  // Beat-sampled volume with the clock stopped is silence with no
  // explanation, same story.
  if (volume === 'beat' && !metronome.on) missing.push('the metronome (switch it on)');
  return missing.length ? `Needs ${missing.join(' + ')}.` : '';
}

export function radialMenuSection() {
  const on = radial.enabled;
  const cfg = radial.config();
  const jointVal = `${cfg.joint}_${cfg.side}`;
  const vol = radial.volumeState();
  const needs = on ? needsLine(cfg) : '';

  const controls = `
    <div class="chord-voicing">
      <span class="chord-key-lbl">${inPort('radial_joint')}JOINT</span>
      <select id="radial-joint" aria-label="Which joint the ring is worn on"
              title="Wrist: the ring rides the forearm — its plane is square to the arm — and a fingertip points around it. Shoulder: the ring lies on the torso and the whole arm points.">
        ${Object.entries(JOINT_LABELS).map(([v, l]) =>
          `<option value="${v}"${v === jointVal ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="chord-voicing">
      <span class="chord-key-lbl">${inPort('radial_voicing')}PLAY</span>
      <select id="radial-voicing" aria-label="Whether a section sounds one note or its chord"
              title="The same sections, sounding either the degree's own note or the whole chord built on it — as in Gesture Mode.">
        <option value="note"${cfg.voicing === 'note' ? ' selected' : ''}>SINGLE NOTES</option>
        <option value="chord"${cfg.voicing === 'chord' ? ' selected' : ''}>CHORDS</option>
      </select>
    </div>
    <div class="chord-voicing">
      <span class="chord-key-lbl">${inPort('radial_finger')}FINGER</span>
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
      <span class="chord-key-lbl">${inPort('radial_volume')}VOLUME</span>
      <select id="radial-volume" aria-label="What sets the loudness"
              title="Entry speed: how fast the pointer crosses into a section sets the attack, and the chord ADSR shapes the note. The signal modes hand loudness to a signal, as in Gesture Mode — the degree you point at latches, the signal is level and gate; there is no envelope to run, you are the envelope (with the other hand playing the volume, accidentals stand down). Metronome beats strikes whatever the pointer names when a SAMPLE beat lands — the clock plays, the ring chooses.">
        ${[['off', 'Entry speed'], ['hand', 'Other hand — openness'], ['brow', 'Eyebrows'], ['beat', 'Metronome beats']]
          .map(([m, l]) => `<option value="${m}"${m === vol.mode ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${vol.mode === 'beat' ? `
    <div class="quant-notes">strikes the pointed section on the metronome's SAMPLE beats — set them in the Metronome section, and switch it on</div>` : ''}
    <div class="chord-expr-cal">
      ${rows(['radial_vol_lo', 'radial_vol_hi'])}
      ${vol.mode === 'hand' || vol.mode === 'brow' ? `
      <div class="expr-meter" id="radial-vol-meter" title="Live: the raw signal, and where it lands after the range above. If the bar never empties, raise OFF AT.">
        <div class="expr-fill" id="radial-vol-fill"></div>
        <span class="expr-read" id="radial-vol-read">—</span>
      </div>` : ''}
    </div>
    <div class="quant-notes" id="radial-readout" role="status" aria-live="polite">${needs || '—'}</div>`;

  return `
    <div class="audio-section" data-sec="radial-mode">
      <div class="audio-section-label">
        Radial Mode
        <span class="head-sock">${inPort('radial_on')}</span>
        <button class="wave-btn${on ? ' on' : ''}" id="radial-toggle" aria-pressed="${on}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${on ? 'ON' : 'OFF'}</button>
      </div>
      ${controls}
      ${on ? '' : `<div class="quant-notes">switch on to play scale degrees by pointing — a ring of sections around your wrist or shoulder</div>`}
    </div>`;
}

// rerender: renderAudioPanel — structural changes rebuild the whole panel,
// exactly as the gesture section does, so the shared key rows stay in step.
export function wireRadialSection(rerender) {
  document.getElementById('radial-toggle')?.addEventListener('click', () => {
    radial.setEnabled(!radial.enabled);     // enabling parks gesture mode
    syncControls();
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
}

// Cheap per-frame update: what the pointer is on, and whether it is sounding.
export function updateRadialPanel() {
  if (!radial.enabled) return;
  const el = document.getElementById('radial-readout');
  if (!el) return;
  const s = radial.soundingSection();
  const geo = radial.geometry();
  const cfg = radial.config();
  const held = cfg.volume.mode !== 'off' ? radial.latchedSection() : null;
  let txt;
  if (s !== null) txt = `● ${radial.sectionLabel(s, { long: true })}`;
  // A silent latch: the ring has named the note, the signal just hasn't
  // opened yet. Saying which note is armed is what makes aiming-in-silence
  // usable — without it, the first articulation is a surprise.
  else if (held !== null) txt = `${radial.sectionLabel(held, { long: true })} armed — ${cfg.volume.mode === 'brow' ? 'raise your brow' : 'open your hand'} to sound it`;
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
