// First run: pick a starting point.
//
// A fresh install had no mappings at all, so the app opened as one oscillator
// at 220 Hz with nothing wired to it — unmute and you get a static sine. That
// is not a starting point, it is the absence of one, and it makes the first
// thirty seconds a hunt for where the instrument is.
//
// So the first visit asks. Every mapping preset is offered, plus both handshape
// voicings — chords and single notes, which are ways of playing rather than
// patches, and so were previously unreachable without knowing to turn on DEV —
// and an explicit blank.

import { mapper, PRESETS, trackersFor } from '../mapper.js';
import { chordmode } from '../chordmode.js';
import { engine } from '../engine.js';
import { lsGet, lsSet } from '../storage.js';
import { readShareUrl } from '../share.js';

const KEY = 'motionmuse-started';

// Choices, in the order they are offered. The mapping presets come from the
// same table the PRESET menu uses, so a preset added later appears here too
// without anyone remembering to add it.
export const STARTERS = [
  ...PRESETS.map(p => ({ id: p.id, kind: 'preset', mode: 'osc',
                         name: p.name, hint: p.hint })),
  {
    id: 'chords', kind: 'chords', mode: 'chords', voicing: 'chord', name: 'Chord Mode',
    hint: 'Handshapes play chords in a key — no lead oscillator, no wiring',
  },
  // The same seven shapes, the same key, one note at a time. Offered here
  // rather than left as a switch inside the panel because "I want to play a
  // melody" is a different intention from "I want to comp", and someone who
  // arrives with the first one should not have to pick the second and then
  // discover the setting that undoes it.
  {
    id: 'notes', kind: 'chords', mode: 'chords', voicing: 'note', name: 'Single Notes',
    hint: 'The same shapes, one note each — your other hand sharpens or flattens',
  },
  {
    id: 'blank', kind: 'blank', mode: 'osc', name: 'Blank',
    hint: 'Nothing wired, nothing tracked, no sound sources — build it yourself',
  },
];

// The two ways of playing, kept apart in the picker. They are different
// instruments, not variations of one: an oscillator patch wires continuous
// signals to pitch and timbre, handshape mode triggers pitch from shapes. The
// guided tour follows whichever you choose, so the split is what tells it which
// tour to give you. Blank sits with the oscillator group because building from
// nothing means the patchbay.
// Handshapes lead. They are the entries that play music the moment you make a
// shape, so they are the best first thing to hand someone who has just arrived
// — and chords were bottom of the list, below a scroll on a phone.
export const STARTER_GROUPS = [
  { mode: 'chords', label: 'HANDSHAPES — a shape names a degree of the key' },
  { mode: 'osc',    label: 'OSCILLATOR — signals drive pitch and tone' },
];

export const startChosen = () => lsGet(KEY) === '1';
const markChosen = () => lsSet(KEY, '1');

// Offer only on a genuinely fresh start: no saved session, nothing already
// chosen, and not a shared link — a link IS a starting point, and it arrives
// mid-load, before the reload that applies it. `sharePending` is passed rather
// than re-read from the URL because the fragment is stripped synchronously the
// moment the link is recognised, so by now there is nothing there to see.
export function shouldOfferStart({ hasSession, sharePending } = {}) {
  return !hasSession && !sharePending && !startChosen() && !readShareUrl(location.href);
}

// `applyTrackers` is passed in rather than imported: it lives in main.js
// because it owns the header buttons and the deferred face/gaze intent, and
// duplicating that here is how the two would drift apart.
export function applyStarter(id, { applyTrackers }) {
  const s = STARTERS.find(x => x.id === id) ?? STARTERS.at(-1);
  markChosen();

  if (s.kind === 'preset') {
    const preset = mapper.applyPreset(s.id);
    return applyTrackers(trackersFor(preset)).then(() => s);
  }

  // Both remaining kinds start from nothing wired.
  mapper.load([]);

  if (s.kind === 'chords') {
    chordmode.setEnabled(true);
    // Stated rather than left at whatever it was: a starting point that only
    // half-decides is one the next choice inherits from the last.
    chordmode.setVoicing(s.voicing ?? 'chord');
    // No lead oscillator: chord mode has its own voice bank, filter and level,
    // and a drone underneath the chords is not what anyone picked this for.
    engine.setOscCount(0);
    return applyTrackers({ handsL: true, handsR: true, pose: false, face: false, gaze: false })
      .then(() => s);
  }

  chordmode.setEnabled(false);
  engine.setOscCount(0);
  return applyTrackers({ handsL: false, handsR: false, pose: false, face: false, gaze: false })
    .then(() => s);
}

// ── The dialogue ──────────────────────────────────────────────────────────
export function openStartPicker({ applyTrackers, onDone }) {
  const el = document.createElement('div');
  el.id = 'start-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="start-card">
      <div class="start-title">HOW DO YOU WANT TO PLAY?</div>
      <div class="start-sub">Pick a starting point — you can change any of it later.</div>
      <div class="start-list">
        ${STARTER_GROUPS.map(g => `
          <div class="start-group">${g.label}</div>
          ${STARTERS.filter(s => s.mode === g.mode).map(s => `
            <button class="start-item" data-start="${s.id}">
              <span class="start-name">${s.name}</span>
              <span class="start-hint">${s.hint}</span>
            </button>`).join('')}`).join('')}
      </div>
    </div>`;
  document.body.appendChild(el);

  let settled = false;
  const finish = async (id) => {
    if (settled) return;
    settled = true;
    el.remove();
    document.removeEventListener('keydown', onKey);
    const s = await applyStarter(id, { applyTrackers });
    onDone?.(s);
  };
  // Dismissing is the same as choosing Blank. A fresh app has nothing wired
  // anyway, so this is what dismissal already looked like — making it explicit
  // means the state after Escape is one of the listed options rather than an
  // extra, undescribed one.
  const onKey = e => { if (e.key === 'Escape') finish('blank'); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', e => { if (e.target === el) finish('blank'); });
  el.querySelectorAll('.start-item').forEach(b =>
    b.addEventListener('click', () => finish(b.dataset.start)));

  el.querySelector('.start-item')?.focus();
  return el;
}
