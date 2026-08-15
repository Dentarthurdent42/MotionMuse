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
import { chordmode }    from '../chordmode.js';

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
  {
    id: 'welcome', target: null, title: 'Welcome to MotionMuse',
    body: 'MotionMuse turns your webcam into an instrument: hand position, ' +
          'gestures and body pose become sound, live in the browser. Nothing ' +
          'is uploaded — all processing happens on your machine.<br><br>' +
          'This tour covers the way of playing you just picked. Re-open it any ' +
          'time with the <b>?</b> button up top.',
  },
  {
    id: 'camera', target: '#cv-btn', title: 'Start the camera',
    body: 'Everything begins here. The first start downloads the vision ' +
          'models (a few MB — they cache for next time), then hand and pose ' +
          'tracking run locally. Feel free to click it now; the tour will wait.',
  },
  {
    id: 'video', target: '#video-wrap', title: 'Camera view',
    body: 'Your mirrored camera feed, with the detected hand and body ' +
          'skeleton drawn on top. The buttons in the corner add optional ' +
          'trackers — face, gaze — and ⛶ makes the view fullscreen.',
  },
  {
    id: 'signals', section: 'signals', target: '#sig-list', title: 'Signals',
    body: 'Every measurement MotionMuse extracts — wrist height, pinch, finger ' +
          'curl, elbow angle, thumb-to-finger touches — appears here as a live ' +
          'signal once the camera runs. Anything in this list can drive sound.',
  },
  {
    id: 'patchbay', section: 'patchbay', modes: ['osc'], target: '.panel-map', title: 'The patchbay',
    body: 'This is where the instrument is built: <b>inputs</b> (signals) on ' +
          'the left wire to <b>outputs</b> (sound parameters) on the right. ' +
          'Drag from one socket ● to another to connect them — one signal can ' +
          'fan out to as many parameters as you like.',
  },
  {
    id: 'cable-editor', section: 'patchbay', modes: ['osc'], target: '.panel-map', title: 'Shaping a connection',
    body: 'Tap a cable or node to open its editor: set the output range, bend ' +
          'the response curve, or quantise it into discrete steps. ' +
          'Oscillator-frequency cables get a piano keyboard for picking exact ' +
          'note ranges.',
  },
  {
    id: 'preset', section: 'patchbay', modes: ['osc'], target: '#preset-btn', title: 'Instant instrument',
    body: 'No need to wire everything yourself — <b>PRESET</b> applies a ' +
          'ready-made mapping so you can play immediately: right hand height ' +
          'is pitch, pinch controls volume.',
  },
  {
    id: 'save-load', section: 'patchbay', target: '#save-btn', title: 'Save your setup',
    body: '<b>SAVE</b> downloads the entire instrument — wiring, tuning, ' +
          'gestures, everything — as one file; <b>LOAD</b> restores it. Your ' +
          'session also auto-saves locally, so a reload picks up where you left off.',
  },
  {
    id: 'audio', target: '#audio-btn', title: 'Muted, but running',
    body: 'The synthesiser starts with the page, so every control is live from ' +
          'the moment you arrive — but the output is muted, so setting up a ' +
          'patch stays silent until you ask for sound. This unmutes it, and so ' +
          'does the spacebar. The waveform keeps moving while muted, which is ' +
          'how you can tell it is silent rather than stuck.',
  },
  {
    id: 'audio-panel', target: '#audio-panel', needs: ['audio'], title: 'The audio engine',
    body: 'Oscillators, filter, reverb and the two quantisers live here. Every ' +
          'slider can also be driven from the patchbay, and every panel has its ' +
          'own <b>?</b> explaining just that panel.',
  },
  {
    id: 'sec-visualizer', section: 'visualizer', target: '#viz-wrap', needs: ['audio'],
    title: 'Oscilloscope',
    body: 'The output waveform, live. It keeps moving while muted — the mute ' +
          'sits after the analyser — which is how you can tell the engine is ' +
          'silent rather than stuck. Tap it to mute or unmute.',
  },
  {
    id: 'sec-soundkit', section: 'sound-kit', target: '#kit-select', needs: ['audio'],
    title: 'Sound Kit',
    body: 'Instrument timbres built from harmonic waveforms and filter ' +
          'settings — synthesised, not sampled, so nothing downloads. A kit ' +
          'changes <b>tone only</b>: it never adds oscillators or touches your ' +
          'levels. Editing any of those flips the selector to Custom.',
  },
  {
    id: 'sec-oscillators', section: 'oscillators', target: '#osc-count', needs: ['audio'],
    title: 'Oscillators',
    body: 'The lead voice. <b>− n +</b> sets how many oscillators run, from ' +
          'none (chord mode alone) up to eight, and each gets its own ' +
          'waveform here plus its own pitch, detune and level under ' +
          'Parameters. Added ones arrive at half level so they do not clip.',
  },
  {
    id: 'sec-pitch-quant', section: 'pitch-quantize', target: '#quant-toggle', needs: ['audio'],
    title: 'Pitch Quantize',
    body: 'Snaps oscillator pitch onto a scale, so a continuous gesture plays ' +
          'in key instead of sliding between notes. Pick root, scale and ' +
          'tuning system; the keyboard below shows where you are.',
  },
  {
    id: 'sec-vol-quant', section: 'volume-quantize', target: '#vq-toggle', needs: ['audio'],
    title: 'Volume Quantize',
    body: 'Loudness in steps rather than a continuous slide, so notes ' +
          'articulate instead of smearing into each other. <b>GATE</b> makes ' +
          'the bottom step true silence — that is what lets you re-attack a ' +
          'note rather than only swell it.',
  },
  {
    id: 'sec-sliders', section: 'sliders', target: '.sec[data-sec-id="sliders"]', needs: ['audio'],
    title: 'Parameters',
    body: 'Every audio parameter, grouped the same way the patchbay groups its ' +
          'outputs. Drag one to set where it rests; a mapped parameter is ' +
          'driven from the patchbay and its slider follows along live.',
  },
  {
    // Rearranging is invisible until someone tries it — there is no button for
    // it — so the tour is the only place a user finds out it exists.
    id: 'layout', target: '#audio-panel', needs: ['audio'], title: 'Make it yours',
    body: 'Every section is a container you can rearrange. <b>Drag its ' +
          'header</b> to move it up, down, or into another column; drag the ' +
          '<b>grip along its bottom edge</b> to set a height (double-click to ' +
          'fit); click the <b>caret</b> to collapse it. Where you leave things ' +
          'is remembered.',
  },
  {
    id: 'playalong', section: 'play-along', modes: ['osc'], target: '#audio-panel', needs: ['audio'], title: 'Play along',
    body: 'The <b>Play Along</b> section is a falling-note game: pick a song ' +
          'and difficulty, and hit the notes with whatever gesture controls ' +
          'pitch. Timing is scored — PERFECT beats GOOD — and best scores stick.',
  },
  {
    id: 'dev', target: '#dev-btn', title: 'Under construction',
    body: 'MotionMuse is in active development. <b>DEV</b> reveals the ' +
          'still-experimental parts — pose-model comparison, the shader ' +
          'visualiser, the planned EEG/EMG inputs, and the inference timings ' +
          'under the camera — all marked 🚧. Everything else, gestures and ' +
          'chord mode included, is here without it.',
  },
  {
    id: 'gestures', section: 'gestures', target: '#gesture-list', needs: ['audio'], title: 'Gestures',
    body: 'Hand poses become discrete triggers: fist, point, peace, thumbs up ' +
          'and down, open palm, rock horns, finger gun, I-love-you, plus the ' +
          'ASL number handshapes. Templates marked <b>est</b> are estimates — ' +
          'run <b>CALIBRATE</b> once to record each from your own hand, which ' +
          'makes recognition dramatically more reliable.',
  },
  {
    id: 'chords-key', section: 'chord-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'Chords by degree, not by note',
    body: 'Pick a <b>key</b> once — root, mode, octave — and the panel lists the ' +
          'seven chords in it (<b>I ii iii IV V vi vii°</b>). Change the key and ' +
          'every chord transposes together; nothing can land outside it. ' +
          '<b>FOLLOW</b> keeps them in the same key your melody is quantised to.',
  },
  {
    id: 'chords-assign', section: 'chord-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'One handshape per chord',
    body: 'Each row picks the handshape that plays that chord, and <b>7th</b> ' +
          'adds the diatonic seventh. A shape does exactly one job: give it to ' +
          'another chord and it swaps with whatever was there. The dot on the ' +
          'left lights when that chord is sounding — hollow means it is chosen ' +
          'but silent.',
  },
  {
    id: 'chords-express', section: 'chord-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'What plays the chord',
    body: '<b>PLAY WITH</b> decides that. Hold the shape and hear it, or go ' +
          'two-handed — one hand names the chord, the other\'s <b>openness</b> ' +
          'plays it, and the chord latches so the naming hand can go and pick ' +
          'the next one. Or use your <b>eyebrows</b> and keep a hand free. ' +
          'Either drives an attack/release or the volume directly.',
  },
  {
    id: 'chords-range', section: 'chord-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'Reaching silence',
    body: 'A closed fist does not read as zero — hand openness bottoms out ' +
          'around 0.38 — so <b>OFF AT</b> and <b>FULL AT</b> map the range your ' +
          'hand actually covers onto the full travel. Watch the meter while you ' +
          'open and close: if the bar never empties, raise OFF AT.',
  },
  {
    id: 'donate', target: '#donate-btn', title: 'Support the project',
    body: 'If MotionMuse is useful or fun, the ♥ lists ways to support ' +
          'development. Entirely optional, always will be.',
  },
  {
    id: 'finish', target: null, title: 'That’s the tour',
    body: 'Quick start: <b>START CAMERA → PRESET → Space</b> to unmute, then ' +
          'move your right hand up and down and pinch to shape notes.<br><br>' +
          'MotionMuse updates often — when new features land, the <b>?</b> ' +
          'button pulses and the tour gains steps. The README covers ' +
          'everything here in depth.',
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
          : stepsForMode(typeof what === 'string' ? what : currentMode());
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
