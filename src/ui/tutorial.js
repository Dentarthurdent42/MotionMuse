// Guided tour — the in-app tutorial.
//
// ══ HOW TO UPDATE (read this first — this file is expected to change often) ══
//
// The tutorial is DATA, not prose scattered through the app: every step is one
// entry in TOUR_STEPS below. When the UI changes:
//
//   - New feature?          Add a step. Give it a fresh, stable `id` (never
//                           reuse an old one) — users who already finished the
//                           tour get a "tour updated" pulse on the ? button
//                           for step ids they haven't seen.
//   - Feature moved?        Update that step's `target` selector.
//   - Feature removed?      Delete the step. Old ids in users' storage are
//                           harmless.
//
// `npm run test:tutorial` (also in CI) boots the app and fails if any step's
// target no longer resolves, so a UI change that orphans a step turns the
// build red instead of shipping a tour that points at nothing. If you add a
// step whose target only exists in a particular state (dev mode, audio on…),
// set `ensure` so the test — and a user re-running the tour — can get there.
//
// At runtime a missing target just skips the step (the app must never break
// because the tour lagged a release); the test is what keeps that honest.
// ═════════════════════════════════════════════════════════════════════════

import { lsGet, lsSet } from '../storage.js';
import { isString }     from '../is.js';
import { chordmode }    from '../chordmode.js';
import { mapper }       from '../mapper.js';

// Each step:
//   id      stable unique key (drives "seen"/"new" tracking — never reuse)
//   target  CSS selector to spotlight; null = centered card (welcome/finish)
//   title   short heading
//   body    1–3 sentences; plain text with occasional <b>/<br>
//   needs   optional list of app states the target only exists in, from:
//           'audio' (synth started), 'dev' (dev mode), 'chord' (chord mode
//           toggled on). The tour itself NEVER changes app state — at runtime
//           a step whose target is absent or hidden is simply skipped, and
//           shows up when the user re-runs the tour with that state active.
//           `needs` is for tests/tutorial/index.js, which enables those
//           states and then asserts the target really resolves.
//   modes   which way of playing this step is about: 'osc' (signals wired to
//           oscillator parameters) or 'chords' (handshapes play chords). Absent
//           = shown in both, i.e. it is about the app rather than a mode.
//   section which panel this step explains, by its `data-sec` id. That panel
//           grows a `?` in its header which runs just its own steps. Absent =
//           the step is about the app rather than one panel (the header
//           buttons, the welcome and the sign-off), and it belongs to the
//           header's own `?` instead.
//
// One tour covering everything meant a first-timer who picked chord mode sat
// through the patchbay, the cable editor and the play-along game before
// reaching the one panel they were going to use. The tour is now scoped to the
// mode you chose, and the mode is what the starting-point picker sets.
export const TOUR_STEPS = [
  // Welcome, then the split: Chord Mode and Tone Mode are the two output
  // types, so each mode's block comes first in its own tour and the shared
  // app steps follow. stepsForMode() keeps array order, which is what makes
  // this ordering BE the structure.
  {
    id: 'welcome', target: null, title: 'Welcome to MotionMuse',
    body: 'Your webcam is the instrument. Two ways to play: <b>Chord Mode</b> ' +
          '— handshapes play chords, or single notes — and <b>Tone Mode</b> ' +
          '— movement drives the synth continuously. Nothing is uploaded; ' +
          'everything runs on your machine.<br><br>This tour follows the mode ' +
          'you picked. Re-open it any time with the <b>?</b> button.',
  },

  // ── Chord Mode ──
  {
    id: 'chords-key', section: 'chord-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'Chord Mode',
    body: 'Handshapes play chords, always in key. Set <b>root, mode and ' +
          'octave</b>; the panel lists the seven chords in that key ' +
          '(<b>I ii iii IV V vi vii°</b>). Change the key and they all ' +
          'transpose. <b>FOLLOW</b> uses the melody’s key.',
  },
  {
    id: 'chords-assign', section: 'chord-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'Assign handshapes',
    body: 'By default the degree is the ASL number: <b>I</b> is a 1, <b>ii</b> ' +
          'a 2, up to <b>vii°</b> as a 7. A closed fist releases. Reassign any ' +
          'row you like — a shape already in use swaps. <b>7th</b> adds the ' +
          'seventh; the dot lights while the chord sounds.',
  },
  {
    id: 'chords-voicing', section: 'chord-mode', modes: ['chords'], target: '#ck-voicing', needs: ['audio', 'chord'],
    title: 'Chords or single notes',
    body: '<b>PLAY</b> decides what a shape sounds: the whole <b>chord</b> on ' +
          'that degree, or just that degree’s own <b>note</b>. Everything else ' +
          '— key, shapes, expression, arpeggiator — applies either way. On ' +
          'single notes your <b>other hand</b> bends it: one shape for ' +
          '<b>♯ sharp</b>, one for <b>♭ flat</b>, neither for natural. Seven ' +
          'shapes plus that is the whole chromatic scale.',
  },
  {
    id: 'chords-express', section: 'chord-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'Play it',
    body: '<b>PLAY WITH</b> sets what sounds the chord: hold the handshape, ' +
          'open and close the <b>other hand</b> (the chord latches while you ' +
          'pick the next one), or raise your <b>eyebrows</b>.',
  },
  {
    id: 'chords-range', section: 'chord-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'Set your range',
    body: '<b>OFF AT</b> and <b>FULL AT</b> map your hand’s real travel onto ' +
          'silence-to-full. Open and close while watching the meter; if it ' +
          'never empties, raise OFF AT.',
  },

  // ── Tone Mode ──
  {
    id: 'patchbay', section: 'patchbay', modes: ['osc'], target: '.panel-map', title: 'Tone Mode',
    body: 'Signals drive the synth continuously; the patchbay wires them. ' +
          '<b>Inputs</b> left, <b>outputs</b> right — drag socket ● to ' +
          'socket ● to connect. One signal can drive several parameters.',
  },
  {
    id: 'cable-editor', section: 'patchbay', modes: ['osc'], target: '.panel-map', title: 'Edit a cable',
    body: 'Tap a cable: range, curve, steps, invert. Oscillator-frequency ' +
          'cables add a piano keyboard for picking note ranges.',
  },
  {
    id: 'preset', section: 'patchbay', modes: ['osc'], target: '#preset-btn', title: 'Presets',
    body: '<b>PRESET</b> loads a complete patch: right hand height plays ' +
          'pitch, pinch controls volume. <b>Your setups</b> sit above the ' +
          'built-in ones — anything you named in SHARE, or opened from a ' +
          'named link, is kept there and restores the whole instrument. ' +
          'The <b>×</b> forgets one.',
  },

  // ── The app around both ──
  {
    id: 'camera', target: '#cv-btn', title: 'Start the camera',
    body: 'The first start downloads the vision models (a few MB, cached ' +
          'after that); tracking then runs locally. Click it now if you like ' +
          '— the tour waits.',
  },
  {
    id: 'video', target: '#video-wrap', title: 'Camera view',
    body: 'Your mirrored feed, tracking drawn on top. The corner buttons add ' +
          'face and gaze tracking; ⛶ goes fullscreen.',
  },
  {
    id: 'hand-cursor', target: '#uic-btn', needs: ['dev'], title: 'Hand cursor',
    body: '🚧 <b>Under construction</b>, so it lives in <b>DEV</b> — it works, ' +
          'but expect rough edges. ' +
          'Drive the app itself by hand: enable <b>HAND CURSOR</b> in ⚙ ' +
          'settings (the button reads <b>READY</b>), then <b>CLAP</b> — palms ' +
          'together, fingers up — and hold up a hand. It becomes a cursor ' +
          '(pinch = click and drag) and stops playing the instrument. Clap ' +
          'again to toggle back; the cursor key disarms everything.',
  },
  {
    id: 'signals', section: 'signals', target: '#sig-list', title: 'Signals',
    body: 'Everything the camera measures, live: wrist height, pinch, finger ' +
          'curl, elbow angle, fingertip touches. Most read on two channels — ' +
          '<b>displacement</b> is where you are, <b>velocity</b> is how fast ' +
          'you are moving. A held pose and a flick are different controls. ' +
          'Any channel can drive any sound parameter; click one to copy its key.',
  },
  {
    id: 'save-load', section: 'patchbay', target: '#save-btn', title: 'Save and load',
    body: '<b>SAVE</b> downloads the whole setup as one file; <b>LOAD</b> ' +
          'restores it. The session also auto-saves locally.',
  },
  {
    id: 'audio', target: '#audio-btn', title: 'Sound',
    body: 'The synth runs from page load, muted. Click here or press ' +
          '<b>Space</b> to unmute.',
  },
  {
    id: 'audio-panel', target: '#audio-panel', needs: ['audio'], title: 'The audio engine',
    body: 'Oscillators, filter, reverb, both quantizers. Every control here ' +
          'can also be driven from the patchbay. Each panel’s <b>?</b> ' +
          'explains that panel.',
  },
  {
    id: 'sec-visualizer', section: 'visualizer', target: '#viz-wrap', needs: ['audio'],
    title: 'Oscilloscope',
    body: 'The output waveform. It keeps moving while muted. Tap it to mute ' +
          'or unmute.',
  },
  {
    id: 'sec-soundkit', section: 'sound-kit', target: '#kit-select', needs: ['audio'],
    title: 'Sound Kit',
    body: 'Synthesized instrument timbres. A kit sets tone only — oscillator ' +
          'count and levels stay yours. Editing tone switches the selector ' +
          'to Custom.',
  },
  {
    id: 'sec-oscillators', section: 'oscillators', target: '#osc-count', needs: ['audio'],
    title: 'Oscillators',
    body: '<b>− n +</b> sets how many oscillators run, zero to eight. Each ' +
          'picks its waveform here; pitch, detune and level are under ' +
          'Parameters.',
  },
  {
    id: 'sec-pitch-quant', section: 'pitch-quantize', target: '#quant-toggle', needs: ['audio'],
    title: 'Pitch Quantize',
    body: 'Snaps pitch to a scale. Pick root, scale and tuning; the keyboard ' +
          'shows which notes are in play.',
  },
  {
    id: 'sec-vol-quant', section: 'volume-quantize', target: '#vq-toggle', needs: ['audio'],
    title: 'Volume Quantize',
    body: 'Steps the volume instead of sliding it. <b>GATE</b> makes the ' +
          'bottom step true silence; <b>PLUCK / KEY / BOW</b> set the attack.',
  },
  {
    id: 'sec-sliders', section: 'sliders', target: '.sec[data-sec-id="sliders"]', needs: ['audio'],
    title: 'Parameters',
    body: 'Every audio parameter, grouped like the patchbay’s outputs. Drag ' +
          'to set a value; a mapped parameter follows its signal.',
  },
  {
    // Rearranging is invisible until someone tries it — there is no button for
    // it — so the tour is the only place a user finds out it exists.
    id: 'layout', target: '#audio-panel', needs: ['audio'], title: 'Rearrange anything',
    body: 'Drag a section’s <b>header</b> to move it, its bottom <b>grip</b> ' +
          'to resize (double-click to fit), the <b>caret</b> to collapse. ' +
          'The layout is remembered.',
  },
  {
    id: 'playalong', section: 'play-along', modes: ['osc'], target: '#audio-panel', needs: ['audio'], title: 'Play along',
    body: 'A falling-note game. Pick a song and difficulty; hit the notes ' +
          'with whatever plays pitch. Best scores are kept.',
  },
  {
    id: 'share', target: '#share-btn', title: 'SHARE',
    body: '<b>SHARE</b> turns everything you have set up into a QR code — ' +
          'point a phone at it and the app opens configured the same way. ' +
          'No file, no account, no server: the setup rides in the link. ' +
          '<b>Name it</b> and two things happen: the name travels with the ' +
          'code, so whoever scans it knows what they got, and the setup is ' +
          'kept in <b>PRESET</b> under that name. Which trackers are running ' +
          'goes too — hands, pose, face and gaze — because a patch wired to ' +
          'your eyebrows is silent without the face model.',
  },
  {
    id: 'dev', target: '#settings-btn', title: 'DEV',
    body: 'Everything marked 🚧 <b>under construction</b> lives in <b>DEV</b>, ' +
          'inside <b>⚙</b>: the hand cursor and gesture stage, pose-model ' +
          'comparison, the shader, EEG/EMG, LiDAR, inference timings. Switch ' +
          'it off and they go away — and stop running.',
  },
  {
    id: 'gestures', section: 'gestures', target: '#gesture-list', needs: ['audio'], title: 'Gestures',
    body: 'Hold a handshape to trigger it — each row shows its shape. ' +
          '<b>est</b> marks an estimated template; <b>CALIBRATE</b> records ' +
          'the shape from your own hand and sharpens recognition.',
  },
  {
    id: 'donate', target: '#donate-btn', title: 'Support the project',
    body: 'The ♥ lists ways to support development. Optional.',
  },
  {
    id: 'finish', target: null, title: 'That’s the tour',
    body: 'Quick start: <b>START CAMERA → PRESET → Space</b>, then right ' +
          'hand up and down for pitch, pinch for volume.<br><br>When new ' +
          'features land, the <b>?</b> pulses and the tour gains steps.',
  },
];

const LS_KEY = 'motionmuse-tour';   // { done: bool, seen: [stepId] }

const loadState = () => {
  try { return { done: false, seen: [], ...JSON.parse(lsGet(LS_KEY) || '{}') }; }
  catch { return { done: false, seen: [] }; }
};
const saveState = s => lsSet(LS_KEY, JSON.stringify(s));

// Step ids shipped since this user last finished the tour.
export const unseenSteps = () => {
  const s = loadState();
  return TOUR_STEPS.map(t => t.id).filter(id => !s.seen.includes(id));
};

export const MODES = ['osc', 'chords'];

// Steps belonging to one panel, and the panels that have any. A `?` in a
// panel's header runs just these — which is the whole point: re-reading the
// welcome and the camera button to find out what GATE does is not help.
export const stepsForSection = id => TOUR_STEPS.filter(t => t.section === id);
export const sectionsWithHelp = () =>
  [...new Set(TOUR_STEPS.map(t => t.section).filter(Boolean))];
// The rest: the header buttons, the welcome, the sign-off. These belong to no
// panel, so the header's own `?` keeps them.
export const appSteps = () => TOUR_STEPS.filter(t => !t.section);
// Steps for one way of playing: the untagged ones (about the app) plus the ones
// tagged for this mode. Order is preserved, so the shared steps still frame the
// mode-specific ones rather than being appended after them.
export const stepsForMode = mode =>
  TOUR_STEPS.filter(t => !t.modes || t.modes.includes(mode));

// Which way of playing the app is currently set up for. Read from state rather
// than remembered from the picker: a user who turned chord mode on afterwards
// should get the chord tour from the ? button, not the one they first chose.
const currentMode = () => chordmode.enabled ? 'chords' : 'osc';

export const tour = (() => {
  let idx = -1;          // current step index, -1 = closed
  let els = null;        // { backdrop, ring, card } while open
  let raf = 0;           // rect-tracking loop, alive only while open
  let lastBox = '';      // last target rect the ring was drawn against
  let seenThisRun = new Set();
  // The steps this run walks. Scoped by mode, so picking chord mode does not
  // march you through the patchbay and the falling-note game first.
  let steps = TOUR_STEPS;

  const step = () => steps[idx];
  const resolve = t => (t ? document.querySelector(t) : null);
  // Present AND visible — a dev-gated section exists in the DOM at
  // display:none, and spotlighting a zero-size box helps nobody.
  const showable = st => !st.target || (el => el && el.getClientRects().length > 0)(resolve(st.target));

  // Nearest showable step from `from` walking `dir` (+1/-1), or -1. Steps
  // whose UI a redesign removed — or whose state isn't active — just skip;
  // the tour must never break because it lagged a release.
  const firstShowable = (from, dir) => {
    for (let i = from; i >= 0 && i < steps.length; i += dir) {
      if (showable(steps[i])) return i;
    }
    return -1;
  };

  function build() {
    const backdrop = document.createElement('div');
    backdrop.id = 'tour-backdrop';
    const ring = document.createElement('div');
    ring.id = 'tour-ring';
    const card = document.createElement('div');
    card.id = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Guided tour');
    document.body.append(backdrop, ring, card);
    els = { backdrop, ring, card };
    lastBox = '';
    raf = requestAnimationFrame(track);
    document.addEventListener('keydown', onKey);
  }

  function teardown() {
    if (!els) return;
    Object.values(els).forEach(e => e.remove());
    els = null;
    cancelAnimationFrame(raf);
    raf = 0;
    document.removeEventListener('keydown', onKey);
  }

  // Follow the target instead of guessing when it might have moved. `resize`
  // plus `scroll` was not enough, and zoom is where it showed:
  //   • a pinch moves only the visual viewport, so no resize event ever fires
  //     and the ring simply stays where it was;
  //   • a zoom change (or a font swap, or a panel re-measuring itself) reflows
  //     *after* the resize handler has already run, so the ring is placed
  //     against a layout that then shifts out from under it — and nothing
  //     fires again to correct it.
  // Both are the same mistake: treating "the layout changed" as an event.
  // It isn't one, so watch the rect. This is one getBoundingClientRect per
  // frame for a single element while the tour is open — nothing beside the CV
  // pipeline — and it re-queries the selector, so a panel rebuilt underneath
  // the spotlight is picked up too.
  function track() {
    raf = requestAnimationFrame(track);
    if (!els || idx < 0) return;
    const r = resolve(step().target)?.getBoundingClientRect();
    // Card placement reads the viewport as well, so fold that into the key.
    const box = `${r ? `${r.left},${r.top},${r.width},${r.height}` : 'none'}` +
                `|${window.innerWidth},${window.innerHeight}`;
    if (box === lastBox) return;
    lastBox = box;
    position();
  }

  function onKey(e) {
    if (e.key === 'Escape') close(false);
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') back();
  }

  // Position the ring around the (re-queried) target and the card near it.
  // Selectors are re-resolved every time so a re-rendered panel — the app
  // rebuilds sections wholesale — can't leave the spotlight on a dead node.
  function position() {
    if (!els || idx < 0) return;
    const st = step();
    const t = resolve(st.target);
    const { backdrop, ring, card } = els;
    // The ring's oversized box-shadow doubles as the dimmer when a target is
    // spotlit; the plain backdrop covers the targetless (welcome/finish) cards.
    backdrop.style.display = t ? 'none' : 'block';
    // getBoundingClientRect answers in real screen pixels, but a length we
    // write back is read in the element's own zoomed units. Under a page zoom
    // (a browser extension, a user stylesheet — not Ctrl+/−, which resizes the
    // viewport instead) those differ, and the ring lands scaled-squared away
    // from its target. Dividing by the zoom the ring itself inherits puts both
    // sides in the same units; it is 1 wherever no zoom applies, and undefined
    // on browsers without the property, hence the fallback.
    const z = ring.currentCSSZoom || 1;
    if (t) {
      const r = t.getBoundingClientRect();
      const pad = 6;
      ring.style.display = 'block';
      ring.style.left   = (r.left - pad) / z + 'px';
      ring.style.top    = (r.top - pad) / z + 'px';
      ring.style.width  = (r.width + 2 * pad) / z + 'px';
      ring.style.height = (r.height + 2 * pad) / z + 'px';
    } else {
      ring.style.display = 'none';
    }
    // Card: below the target if there's room, else above; centered when no
    // target. Small screens get a bottom sheet instead.
    card.classList.toggle('sheet', window.innerWidth < 560);
    if (window.innerWidth < 560 || !t) {
      card.style.left = ''; card.style.top = '';
      card.classList.toggle('centered', !t && window.innerWidth >= 560);
      return;
    }
    card.classList.remove('centered');
    const r = t.getBoundingClientRect();
    const cw = Math.min(340, window.innerWidth - 24);
    card.style.width = cw / z + 'px';
    // offsetHeight is in the card's own units; the rect it is measured against
    // is in screen pixels, so scale it up before comparing the two.
    const ch = (card.offsetHeight || 180) * z;
    const below = r.bottom + 14 + ch < window.innerHeight;
    card.style.top  = (below ? r.bottom + 14 : Math.max(12, r.top - 14 - ch)) / z + 'px';
    card.style.left = Math.max(12, Math.min(r.left, window.innerWidth - cw - 12)) / z + 'px';
  }

  function render() {
    const st = step();
    seenThisRun.add(st.id);
    const t = resolve(st.target);
    t?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const last = firstShowable(idx + 1, 1) === -1;
    els.card.innerHTML = `
      <div class="tour-head">
        <span class="tour-count">${idx + 1}/${steps.length}</span>
        <button class="rm-btn" id="tour-close" title="Close tour" aria-label="Close tour">×</button>
      </div>
      <div class="tour-title">${st.title}</div>
      <div class="tour-body">${st.body}</div>
      <div class="tour-nav">
        <button class="btn" id="tour-back" ${firstShowable(idx - 1, -1) === -1 ? 'disabled' : ''}>BACK</button>
        <button class="btn on" id="tour-next">${last ? 'DONE' : 'NEXT'}</button>
      </div>`;
    els.card.querySelector('#tour-close').addEventListener('click', () => close(false));
    els.card.querySelector('#tour-back').addEventListener('click', back);
    els.card.querySelector('#tour-next').addEventListener('click', () => last ? close(true) : next());
    position();
  }

  function next() {
    const i = firstShowable(idx + 1, 1);
    if (i === -1) return close(true);
    idx = i; render();
  }
  function back() {
    const i = firstShowable(idx - 1, -1);
    if (i === -1) return;
    idx = i; render();
  }

  function close(finished) {
    // Whatever was actually shown counts as seen — including a partial run,
    // so the "updated" pulse never nags about steps the user already read.
    const s = loadState();
    s.seen = [...new Set([...s.seen, ...seenThisRun])];
    if (finished || !s.done) s.done = true;   // skipping also counts as "offered"
    saveState(s);
    seenThisRun = new Set();
    idx = -1;
    teardown();
    syncButton();
  }

  // Either a mode name, or `{ steps }` for an explicit list (a panel's own
  // help). Omitted, it follows what the app is actually set up for, so the
  // header button shows the tour for what you are playing rather than for
  // whatever you first chose.
  function start(what) {
    if (els) return;                    // already open
    steps = Array.isArray(what?.steps) ? what.steps
          : stepsForMode(isString(what) ? what : currentMode());
    if (!steps.length) return;
    seenThisRun = new Set();
    build();
    idx = Math.max(0, firstShowable(0, 1));
    render();
  }

  function syncButton() {
    const btn = document.getElementById('tour-btn');
    if (!btn) return;
    // Only the steps THIS button runs. It used to count every unseen step,
    // which now includes every panel's own help — so it would promise "23 new
    // steps" and then show nine.
    const seen = new Set(loadState().seen);
    const fresh = appSteps().filter(t => !seen.has(t.id)).map(t => t.id);
    const s = loadState();
    const updated = s.done && fresh.length > 0;
    btn.classList.toggle('tour-new', updated);
    btn.title = updated
      ? `Guided tour — updated! ${fresh.length} new step${fresh.length > 1 ? 's' : ''}`
      : 'Guided tour';
  }

  return { start, close: () => close(false), get open() { return !!els; }, syncButton };
})();

export function initTutorial() {
  // The header `?` is no longer "restart the whole tutorial". Every panel
  // explains itself now, so this one keeps what belongs to no panel: the
  // welcome, the header buttons, the sign-off.
  document.getElementById('tour-btn')?.addEventListener('click', () =>
    tour.open ? tour.close() : tour.start({ steps: appSteps() }));
  const btn = document.getElementById('tour-btn');
  if (btn) btn.title = 'Getting started — the camera, sound, and saving. Each panel has its own ?';
  tour.syncButton();
}

// Run one panel's help. Exported for sections.js, which owns the header button
// it hangs off; keeping the wiring there means a panel added later gets a `?`
// for free, the same way it gets a fold caret and a grip.
export function startSectionHelp(sectionId) {
  const steps = stepsForSection(sectionId);
  if (!steps.length) return false;
  if (tour.open) tour.close();
  tour.start({ steps });
  return true;
}

// ── The tour for a setup that arrived by link ────────────────────────────
//
// Following a link is not opening the app for the first time. The link already
// chose the way of playing and brought a patch with it, so the welcome that
// asks which mode you want is answering a question nobody asked, and the
// panels this particular setup never touches are noise standing in front of
// the thing you were actually handed.
//
// What is left is the mode's own tour minus both — and steps whose target is
// missing or hidden are skipped at runtime anyway, so a setup with no face
// tracking never reaches the face step without this having to know about it.
export const stepsForSharedSetup = () => stepsForMode(currentMode()).filter(t =>
  t.id !== 'welcome' && !(t.section === 'patchbay' && !mapper.mappings.length));

// Offered only on the FIRST open of a given link (share.js fingerprints them)
// and only when it has something to say: someone who has already seen these
// steps does not need them again because a friend sent the same patch.
export function offerTourForSharedSetup() {
  if (navigator.webdriver) return false;
  const steps = stepsForSharedSetup();
  const seen = new Set(loadState().seen);
  if (!steps.some(t => !seen.has(t.id))) return false;
  // Longer than the picker's wait: a shared link reloads the page and toasts
  // what it opened, and a modal landing on top of that reads as a glitch.
  setTimeout(() => tour.start({ steps }), 1200);
  return true;
}

// Offer the tour for a way of playing, after the app has settled. Skipping
// marks it offered — it never auto-opens twice. Automation
// (navigator.webdriver: the ui-ux screenshot harness, the tutorial test itself)
// never gets the auto-offer; tests drive tour.start() explicitly.
//
// Called by main.js rather than from initTutorial, because the starting-point
// picker comes first: the tour is *for* the choice made there, and two modals
// racing each other is not a welcome.
export function maybeOfferTour(mode) {
  if (!loadState().done && !navigator.webdriver) setTimeout(() => tour.start(mode), 700);
}

// Offer it again for a different mode. Picking a starting point is a statement
// about what you are about to do, so the tour for THAT is worth offering even to
// someone who has seen the other one — but only once per mode, tracked through
// the same `seen` list the "updated" pulse uses.
export function offerTourForMode(mode) {
  if (navigator.webdriver) return false;
  const seen = new Set(loadState().seen);
  const fresh = stepsForMode(mode).filter(t => !seen.has(t.id));
  if (!fresh.length) return false;
  setTimeout(() => tour.start(mode), 700);
  return true;
}
