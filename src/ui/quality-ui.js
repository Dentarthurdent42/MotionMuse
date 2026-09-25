// The CHORD QUALITY node — what the other hand says about a chord.
//
// Gesture Mode (or the radial ring) names a DEGREE, and the key decides what
// chord lives there. This node lets the hand that is not naming override
// that: one row per quality, each an input socket a handshape's cable plugs
// into, and holding the shape turns the named degree into that quality with
// its root unchanged. It sits between the modes and the Chord Voice because
// that is where it acts — after WHICH degree, before HOW it sounds.
//
// The rows are the same shape as Gesture Mode's degree rows on purpose: the
// same socket-dot-name-picker-calibrate order, so a player who has wired one
// already knows how to read the other.

import { gesture, gestureLabel } from '../gesture.js';
import { chordmode, QUALITY_KEYS } from '../chordmode.js';
import { radial } from '../radial.js';
import { QUALITY_SYMBOL } from '../chords.js';
import { QUALITY_CABLE_KEYS, isCableId } from '../chordcables.js';
import { inPort } from './mapper-ui.js';
import { calibrateGesture } from './gesture-ui.js';

// What each quality does, for the row's tooltip — in the terms a player hears.
const QUALITY_HINT = {
  major: 'Major — the bright triad. The same shape raises a note a semitone in SINGLE NOTES',
  minor: 'Minor — the dark triad. The same shape lowers a note a semitone in SINGLE NOTES',
  dim:   'Diminished — a minor third and a flat fifth; written with a °, an O',
  aug:   'Augmented — a major third and a sharp fifth; written with a +',
  sus2:  'Suspended 2nd — the third replaced by the 2nd, open and unresolved',
  sus4:  'Suspended 4th — the third replaced by the 4th, leaning towards home',
  dom7:  'Dominant 7th — major with a flat seventh; the blues and rock seventh',
  maj7:  'Major 7th — major with a major seventh; lush, the love-song chord',
  min7:  'Minor 7th — minor with a flat seventh',
};

// Which play mode the node is currently serving, and whether it is voicing
// chords — a single note has no quality, so the rows dim in note voicing.
const chordVoiced = () => (radial.enabled ? radial.config().voicing === 'chord'
                                          : chordmode.getVoicing() === 'chord');
// The off hand is the volume in 'other hand' expression, the same stand-down
// the accidentals take.
const offHandBusy = () => (radial.enabled ? radial.config().volume === 'hand'
                                          : chordmode.expression().mode === 'hand');

export function chordQualitySection() {
  const gestures = gesture.list();
  const qual = chordmode.qualityGestures();
  const voiced = chordVoiced();
  const busy = offHandBusy();

  const options = sel => isCableId(sel) ? `<option value="" selected>WIRED</option>`
    : `<option value=""${!sel ? ' selected' : ''}>—</option>`
    + gestures.map(g => `<option value="${g.id}"${g.id === sel ? ' selected' : ''}>`
                      + `${gestureLabel(g)}${g.est ? ' · est' : ''}</option>`).join('');

  const row = q => {
    const gid = qual[q];
    const g = gid && !isCableId(gid) ? gestures.find(x => x.id === gid) : null;
    return `
    <div class="chord-assign${voiced ? '' : ' dimmed'}" data-quality="${q}" title="${QUALITY_HINT[q]}">
      ${inPort(QUALITY_CABLE_KEYS[q])}<span class="gesture-dot" id="qdot-${q}"></span>
      <span class="chord-degree">${QUALITY_SYMBOL[q]}</span>
      <select class="cq-shape" data-quality="${q}" ${voiced && !isCableId(gid) ? '' : 'disabled'}
              aria-label="Gesture that makes the chord ${q}"
              title="${isCableId(gid) ? 'Held by the cable on its socket — unplug it to choose a shape'
                                      : 'The handshape that asks for this quality — a cable from its signal'}"
        >${options(gid)}</select>
      <button class="rm-btn cq-cal" data-gid="${g ? g.id : ''}" ${g ? '' : 'disabled'}
              title="${g ? `Re-record ${gestureLabel(g)} from your own hand` : 'Choose a gesture first'}"
              aria-label="${g ? `Calibrate ${gestureLabel(g)}` : 'Calibrate'}">⊙</button>
      <span class="ch-sev-gap"></span>
    </div>`;
  };

  return `
    <div class="audio-section" data-sec="chord-quality">
      <div class="audio-section-label">
        Chord Quality
        <span class="acc-read" id="cq-read" style="margin-left:auto;"
              title="The quality your other hand is holding right now — — is the key's own">—</span>
      </div>
      ${QUALITY_KEYS.map(row).join('')}
      <div id="cq-cal-status" class="quant-notes" role="status" aria-live="polite"></div>
      <div class="quant-notes">${!voiced
        ? 'a single note has no quality — in SINGLE NOTES the thumbs sharpen and flatten instead'
        : busy
          ? 'the other hand is playing the volume, so every chord keeps the key\'s own quality'
          : 'hold one on the hand that is NOT naming the degree: the chord keeps its root and takes this quality — none held is the key\'s own'}</div>
    </div>`;
}

export function wireChordQualitySection(rerender) {
  document.querySelectorAll('.cq-shape').forEach(sel =>
    sel.addEventListener('change', e => {
      chordmode.setQualityGestures({ [e.target.dataset.quality]: e.target.value || null });
      rerender();   // taking a shape for one quality frees it from another
    }));
  const status = document.getElementById('cq-cal-status');
  document.querySelectorAll('.cq-cal').forEach(b =>
    b.addEventListener('click', () => calibrateGesture(b.dataset.gid, status, () => rerender())));
}

// Per frame: light the row of the quality being held, and name it up top.
export function updateChordQualityPanel() {
  const q = radial.enabled ? radial.currentQuality()
          : chordmode.enabled ? chordmode.currentQuality() : null;
  for (const k of QUALITY_KEYS) {
    const dot = document.getElementById(`qdot-${k}`);
    if (dot) dot.classList.toggle('on', k === q);
  }
  const read = document.getElementById('cq-read');
  if (read) {
    const txt = q ? QUALITY_SYMBOL[q] : '—';
    if (read.textContent !== txt) read.textContent = txt;
    read.classList.toggle('on', !!q);
  }
}
