// The NOTE QUALITY node — what the other hand says about a single note.
//
// Gesture Mode (or the radial ring), in SINGLE NOTES voicing, names a
// DEGREE's own pitch. Seven shapes name seven degrees, which leaves the five
// notes between them out of reach — so the hand that is NOT naming says
// what to do to the note it names: nothing, sharp, or flat. That is the
// whole chromatic scale from shapes already known, read the same way the
// Chord Quality node reads its off-hand shapes (this node is its sibling —
// same row shape, same rules — and the two never compete: one applies in
// CHORDS, the other in SINGLE NOTES, so a hand is never asked both at once).

import { gesture, gestureLabel } from '../gesture.js';
import { chordmode, accidentalSign } from '../chordmode.js';
import { radial } from '../radial.js';
import { ACC_KEYS, isCableId } from '../chordcables.js';
import { inPort } from './mapper-ui.js';
import { calibrateGesture } from './gesture-ui.js';

const ACC_SYMBOL = { sharp: '♯ SHARP', flat: '♭ FLAT' };
const ACC_HINT = {
  sharp: 'Sharp — raises the note a semitone (the same shape makes a chord MAJOR in the Chord Quality node)',
  flat:  'Flat — lowers the note a semitone (the same shape makes a chord MINOR in the Chord Quality node)',
};

// Which play mode the node is currently serving, and whether it is voicing
// single notes — a chord has no accidental, so the rows dim in chord voicing.
const noteVoiced = () => (radial.enabled ? radial.config().voicing === 'note'
                                         : chordmode.getVoicing() === 'note');
// The off hand is the volume in 'other hand' expression, the same stand-down
// the Chord Quality node's rows take.
const offHandBusy = () => (radial.enabled ? radial.config().volume === 'hand'
                                          : chordmode.expression().mode === 'hand');

export function noteQualitySection() {
  const gestures = gesture.list();
  const accG = chordmode.accidentalGestures();
  const voiced = noteVoiced();
  const busy = offHandBusy();

  const options = sel => isCableId(sel) ? `<option value="" selected>WIRED</option>`
    : `<option value=""${!sel ? ' selected' : ''}>—</option>`
    + gestures.map(g => `<option value="${g.id}"${g.id === sel ? ' selected' : ''}>`
                      + `${gestureLabel(g)}${g.est ? ' · est' : ''}</option>`).join('');

  const row = key => {
    const gid = accG[key];
    const g = gid && !isCableId(gid) ? gestures.find(x => x.id === gid) : null;
    const live = voiced && !busy;
    return `
    <div class="chord-assign${live ? '' : ' dimmed'}" data-acc="${key}"
         title="${!voiced ? 'Accidentals apply to SINGLE NOTES — a chord has none'
                 : busy ? 'Unavailable while the other hand is playing the volume'
                 : ACC_HINT[key]}">
      ${inPort(ACC_KEYS[key])}<span class="gesture-dot" id="adot-${key}"></span>
      <span class="chord-degree">${ACC_SYMBOL[key]}</span>
      <select class="nq-shape" data-acc="${key}" ${live && !isCableId(gid) ? '' : 'disabled'}
              aria-label="Gesture that ${key === 'sharp' ? 'sharpens' : 'flattens'} the note"
              title="${isCableId(gid) ? 'Held by the cable on its socket — unplug it to choose a shape'
                                      : 'The handshape that asks for this — a cable from its signal'}"
        >${options(gid)}</select>
      <button class="rm-btn nq-cal" data-gid="${g ? g.id : ''}" ${g && live ? '' : 'disabled'}
              title="${!g ? 'Choose a gesture first' : !live ? 'Unavailable while the picker beside it is'
                                                              : `Re-record ${gestureLabel(g)} from your own hand`}"
              aria-label="${g ? `Calibrate ${gestureLabel(g)}` : 'Calibrate'}">⊙</button>
      <span class="ch-sev-gap"></span>
    </div>`;
  };

  return `
    <div class="audio-section" data-sec="note-quality">
      <div class="audio-section-label">
        Note Quality
        <span class="acc-read" id="nq-read" style="margin-left:auto;"
              title="What your other hand is saying about the note right now — ♮ is natural">${voiced ? '♮' : '—'}</span>
      </div>
      ${row('sharp')}
      ${row('flat')}
      <div id="nq-cal-status" class="quant-notes" role="status" aria-live="polite"></div>
      <div class="quant-notes">${!voiced
        ? 'a chord has no accidental — in CHORDS the same two shapes set the Chord Quality node instead'
        : busy
          ? 'the other hand is playing the volume, so every note sounds natural'
          : 'hold one on the hand that is NOT naming the note: neither held is natural'}</div>
    </div>`;
}

export function wireNoteQualitySection(rerender) {
  document.querySelectorAll('.nq-shape').forEach(sel =>
    sel.addEventListener('change', e => {
      chordmode.setAccidentalGestures({ [e.target.dataset.acc]: e.target.value || null });
      rerender();   // taking a shape for one frees it from the other
    }));
  const status = document.getElementById('nq-cal-status');
  document.querySelectorAll('.nq-cal').forEach(b =>
    b.addEventListener('click', () => calibrateGesture(b.dataset.gid, status, () => rerender())));
}

// Per frame: light the row of the accidental being held, and name it up top.
export function updateNoteQualityPanel() {
  const a = radial.enabled ? radial.currentAccidental()
          : chordmode.enabled ? chordmode.currentAccidental() : 0;
  for (const key of ['sharp', 'flat']) {
    const dot = document.getElementById(`adot-${key}`);
    if (dot) dot.classList.toggle('on', key === 'sharp' ? a > 0 : a < 0);
  }
  const read = document.getElementById('nq-read');
  if (read) {
    const voiced = radial.enabled ? radial.config().voicing === 'note' : chordmode.getVoicing() === 'note';
    const txt = !voiced ? '—' : accidentalSign(a) || '♮';
    if (read.textContent !== txt) read.textContent = txt;
    read.classList.toggle('on', a !== 0);
  }
}
