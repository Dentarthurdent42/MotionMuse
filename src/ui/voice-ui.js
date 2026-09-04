// The CHORD VOICE node — what both play modes sound through.
//
// Gesture Mode and Radial Mode each used to carry a KEY row, an envelope, an
// arpeggiator row, a 7ths row and a Shepard switch of their own. All of it
// was one state: the chord bank in the engine, the key and 7ths in chordmode,
// the one arpeggiator — the same controls drawn twice, so a change in one
// panel silently moved the other. Now it is one node, between the modes and
// the Chord Filter: the modes decide WHICH chord or note sounds and WHAT
// makes it sound; this node is the voice they sound through, and the Chord
// Filter next door shapes that. Every control here is an input socket, one
// per row, on the node's edge.

import { chordmode } from '../chordmode.js';
import { radial }    from '../radial.js';
import { engine }    from '../engine.js';
import { DEGREE_SCALES } from '../chords.js';
import { NOTE_NAMES } from '../scale.js';
import { arpRowHTML, wireArpRow, updateArpRow } from './arp-ui.js';
import { inPort } from './mapper-ui.js';
import { rows } from './rows.js';

const opt = (v, sel) => `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`;
export const MODE_LABELS = {
  'major (ionian)':   'major',
  'natural minor':    'minor',
  'harmonic minor':   'harm min',
  'major pentatonic': 'maj pent',
  'minor pentatonic': 'min pent',
};

export function chordVoiceSection() {
  const key = chordmode.key();
  const eff = chordmode.effectiveKey();
  const flw = chordmode.isFollowing();     // armed *and* actually overriding
  const sevenths = chordmode.sevenths();
  const shep = engine.getShepard().chord;

  // One input per row, so each socket has the node's edge to itself.
  const keyRows = `
    <div class="met-row">
      <span class="chord-key-lbl">${inPort('chord_root')}KEY</span>
      <select id="cv-root" ${flw ? 'disabled' : ''} aria-label="Chord key root"
              title="${flw ? 'Following Pitch Quantize' : 'Root of the key the chords are built in — shared by both play modes'}"
        >${NOTE_NAMES.map(n => opt(n, eff.root)).join('')}</select>
    </div>
    <div class="met-row">
      <span class="chord-key-lbl">${inPort('chord_mode')}MODE</span>
      <select id="cv-mode" ${flw ? 'disabled' : ''} aria-label="Chord key mode"
              title="The scale — its degree count is the chord count: seven for a diatonic mode, five for a pentatonic"
        >${DEGREE_SCALES.map(s => `<option value="${s}"${s === eff.mode ? ' selected' : ''}>${MODE_LABELS[s] ?? s}</option>`).join('')}</select>
    </div>
    <div class="met-row">
      <span class="chord-key-lbl">${inPort('chord_octave')}OCTAVE</span>
      <select id="cv-oct" aria-label="Chord octave" title="Octave of the chord roots"
        >${[2, 3, 4, 5].map(o => opt(o, key.octave)).join('')}</select>
    </div>
    <div class="met-row">
      <span class="chord-key-lbl">${inPort('chord_follow')}FOLLOW</span>
      <button class="wave-btn${key.follow ? ' on' : ''}" id="cv-follow" aria-pressed="${key.follow}"
              title="${key.follow && !flw
                ? 'Following Pitch Quantize — inactive until quantise is on'
                : 'Take the key from Pitch Quantize, so chords match the melody'}">${key.follow ? 'ON' : 'OFF'}</button>
      <span class="quant-notes" style="flex:1 1 auto;margin:0;">${key.follow ? 'the key follows Pitch Quantize' : ''}</span>
    </div>`;

  // The 7th belongs to the chord, and chordmode owns that table — so these
  // buttons write the same state Gesture Mode's per-chord 7th buttons do.
  // One button per degree, labelled with the numeral it now sounds.
  const seventhsRow = `
    <div class="chord-voicing">
      <span class="chord-key-lbl" title="Add the diatonic 7th to a degree — the chord's own, whichever mode plays it">7THS</span>
      <div class="wave-btns" style="flex:1;flex-wrap:wrap;">
        ${Array.from({ length: chordmode.degreeCount() }, (_, i) => {
          const c = chordmode.chordAt(i);
          return `<button type="button" class="wave-btn cv-sev${sevenths[i] ? ' on' : ''}"
                  data-degree="${i}" aria-pressed="${sevenths[i]}"
                  title="${sevenths[i] ? 'Remove' : 'Add'} the diatonic 7th on ${c.rootName}"
            >${c.numeral}</button>`;
        }).join('')}
      </div>
    </div>`;

  return `
    <div class="audio-section" data-sec="chord-voice">
      <div class="audio-section-label">Chord Voice</div>
      ${keyRows}
      ${seventhsRow}
      <div class="audio-section-label" style="margin-top:8px;">Envelope</div>
      ${rows(['chord_attack', 'chord_decay', 'chord_sustain', 'chord_release'])}
      ${arpRowHTML('cv')}
      <div class="wave-btns" style="margin-top:4px;">
        <span class="head-sock">${inPort('shepard_chord')}</span>
        <button type="button" class="wave-btn${shep ? ' on' : ''}" id="shep-chord"
             aria-pressed="${shep}"
             title="Shepard tones: every chord note becomes a stack of octaves under a fixed loudness curve, so a progression can climb without ever running out of register.">SHEPARD</button>
      </div>
      <div class="quant-notes">what Gesture Mode and Radial Mode both sound through — the key, the envelope, the arpeggiator; the Chord Filter shapes it</div>
    </div>`;
}

// rerender: renderAudioPanel — the key relabels every degree in both modes.
export function wireChordVoiceSection(rerender) {
  const setKey = partial => { chordmode.setKey(partial); rerender(); };
  document.getElementById('cv-root')?.addEventListener('change', e => setKey({ root: e.target.value }));
  document.getElementById('cv-mode')?.addEventListener('change', e => setKey({ mode: e.target.value }));
  document.getElementById('cv-oct') ?.addEventListener('change', e => setKey({ octave: Number(e.target.value) }));
  document.getElementById('cv-follow')?.addEventListener('click', () => {
    // Turning follow off keeps whatever key was being followed, so the sound
    // doesn't jump the moment you take manual control.
    const eff = chordmode.effectiveKey();
    setKey(chordmode.key().follow
      ? { follow: false, root: eff.root, mode: eff.mode }
      : { follow: true });
  });
  document.querySelectorAll('.cv-sev').forEach(btn =>
    btn.addEventListener('click', () => {
      const d = Number(btn.dataset.degree);
      chordmode.setSeventh(d, !chordmode.sevenths()[d]);
      rerender();
    }));
  document.getElementById('shep-chord')?.addEventListener('click', () => {
    engine.setShepard({ chord: !engine.getShepard().chord });
    rerender();
  });
  wireArpRow('cv', rerender);
}

// Per frame: the arpeggiator row reports the pool of whichever mode is playing.
export function updateChordVoicePanel() {
  const pool = chordmode.enabled ? chordmode.arpPoolSize()
             : radial.enabled ? radial.arpPoolSize() : 0;
  updateArpRow('cv', pool);
}
