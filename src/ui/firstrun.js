// First run: pick a starting point.
//
// A fresh install had no mappings at all, so the app opened as one oscillator
// at 220 Hz with nothing wired to it — unmute and you get a static sine. That
// is not a starting point, it is the absence of one, and it makes the first
// thirty seconds a hunt for where the instrument is.
//
// So the first visit asks. Every mapping preset is offered, plus the four
// in-key ways of playing — handshapes or radial mode, each sounding
// chords or single notes; ways of playing rather than patches — and an
// explicit blank.

import { mapper, PRESETS, trackersFor } from '../mapper.js';
import { chordmode } from '../chordmode.js';
import { radial } from '../radial.js';
import { engine } from '../engine.js';
import { lsGet, lsSet } from '../storage.js';
import { readShareUrl } from '../share.js';

const KEY = 'motionmuse-started';

// Choices, in the order they are offered. The mapping presets come from the
// same table the PRESET menu uses, so a preset added later appears here too
// without anyone remembering to add it.
//
// The in-key entries are two choices crossed, stated as four cards: WHAT
// names a degree (a handshape, or pointing at a section of the radial ring)
// × WHAT it sounds (the whole chord, or the one note). Cards rather than two
// toggles because a first-run picker is a list you tap once, not a form —
// and every combination states its whole self, so nothing is inherited from
// whatever was set before. All four start in Shepard tones, explicitly: it
// is the in-key modes' default voice, and a default that depends on what the
// last user left switched on is not a default.
export const STARTERS = [
  {
    id: 'chords', kind: 'chords', mode: 'chords', voicing: 'chord',
    name: 'Handshapes · Chords',
    hint: 'Handshapes play chords in a key — no lead oscillator, no wiring',
  },
  // The same seven shapes, the same key, one note at a time. Offered here
  // rather than left as a switch inside the panel because "I want to play a
  // melody" is a different intention from "I want to comp", and someone who
  // arrives with the first one should not have to pick the second and then
  // discover the setting that undoes it.
  {
    id: 'notes', kind: 'chords', mode: 'chords', voicing: 'note',
    name: 'Handshapes · Single Notes',
    hint: 'The same shapes, one note each — your other hand sharpens or flattens',
  },
  {
    id: 'radial-notes', kind: 'radial', mode: 'chords', voicing: 'note',
    name: 'Radial Mode · Single Notes',
    hint: 'A ring of notes around your wrist — point with your index finger to play',
  },
  {
    id: 'radial-chords', kind: 'radial', mode: 'chords', voicing: 'chord',
    name: 'Radial Mode · Chords',
    hint: 'The same ring, each section a chord of the key',
  },
  ...PRESETS.map(p => ({ id: p.id, kind: 'preset', mode: 'osc',
                         name: p.name, hint: p.hint })),
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
  { mode: 'chords', label: 'PLAY IN A KEY — a handshape or a radial ring names a degree' },
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

  // The remaining kinds all start from nothing wired.
  mapper.load([]);

  if (s.kind === 'chords') {
    // Enabling parks radial mode — the two share the chord voice bank —
    // and every in-key start states its whole self: voicing AND Shepard
    // tones, rather than inheriting whatever the last setup left switched.
    radial.setEnabled(false);
    chordmode.setEnabled(true);
    chordmode.setVoicing(s.voicing ?? 'chord');
    engine.setShepard({ chord: true });
    // No lead oscillator: gesture mode has its own voice bank, filter and level,
    // and a drone underneath the chords is not what anyone picked this for.
    engine.setOscCount(0);
    return applyTrackers({ handsL: true, handsR: true, pose: false, face: false, gaze: false })
      .then(() => s);
  }

  if (s.kind === 'radial') {
    radial.setEnabled(true);            // parks gesture mode from its side
    radial.setVoicing(s.voicing ?? 'note');
    engine.setShepard({ chord: true }); // stated, same as the handshape starts
    engine.setOscCount(0);
    // Both hands: one wears the ring, the other bends notes with the
    // accidental shapes. Pose too — the forearm axis is what the ring rides.
    return applyTrackers({ handsL: true, handsR: true, pose: true, face: false, gaze: false })
      .then(() => s);
  }

  chordmode.setEnabled(false);
  radial.setEnabled(false);
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
