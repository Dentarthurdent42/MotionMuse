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
export const TOUR_STEPS = [
  {
    id: 'welcome', target: null, title: 'Welcome to MotionMuse',
    body: 'MotionMuse turns your webcam into an instrument: hand position, ' +
          'gestures and body pose become sound, live in the browser. Nothing ' +
          'is uploaded — all processing happens on your machine.<br><br>' +
          'This tour points at everything once. Re-open it any time with the ' +
          '<b>?</b> button up top.',
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
    id: 'signals', target: '#sig-list', title: 'Signals',
    body: 'Every measurement MotionMuse extracts — wrist height, pinch, finger ' +
          'curl, elbow angle, thumb-to-finger touches — appears here as a live ' +
          'signal once the camera runs. Anything in this list can drive sound.',
  },
  {
    id: 'patchbay', target: '.panel-map', title: 'The patchbay',
    body: 'This is where the instrument is built: <b>inputs</b> (signals) on ' +
          'the left wire to <b>outputs</b> (sound parameters) on the right. ' +
          'Drag from one socket ● to another to connect them — one signal can ' +
          'fan out to as many parameters as you like.',
  },
  {
    id: 'cable-editor', target: '.panel-map', title: 'Shaping a connection',
    body: 'Tap a cable or node to open its editor: set the output range, bend ' +
          'the response curve, or quantise it into discrete steps. ' +
          'Oscillator-frequency cables get a piano keyboard for picking exact ' +
          'note ranges.',
  },
  {
    id: 'preset', target: '#preset-btn', title: 'Instant instrument',
    body: 'No need to wire everything yourself — <b>PRESET</b> applies a ' +
          'ready-made mapping so you can play immediately: right hand height ' +
          'is pitch, pinch controls volume.',
  },
  {
    id: 'save-load', target: '#save-btn', title: 'Save your setup',
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
    body: 'Oscillators, filter, reverb — and the two quantisers: <b>Pitch ' +
          'Quantize</b> snaps notes onto a scale so gestures play in key, and ' +
          '<b>Volume Quantize</b> steps loudness so notes articulate cleanly ' +
          'instead of smearing. Every slider here can also be driven from the ' +
          'patchbay.',
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
    id: 'playalong', target: '#audio-panel', needs: ['audio'], title: 'Play along',
    body: 'The <b>Play Along</b> section is a falling-note game: pick a song ' +
          'and difficulty, and hit the notes with whatever gesture controls ' +
          'pitch. Timing is scored — PERFECT beats GOOD — and best scores stick.',
  },
  {
    id: 'dev', target: '#dev-btn', title: 'Under construction',
    body: 'MotionMuse is in active development. <b>DEV</b> reveals the ' +
          'experimental features — gesture recognition, chord mode, pose-model ' +
          'comparison, the shader visualiser — all marked 🚧. They work, but ' +
          'expect rough edges and frequent change.',
  },
  {
    id: 'gestures', target: '#gesture-list', needs: ['audio', 'dev'], title: 'Gestures',
    body: 'Hand poses become discrete triggers: six classics plus the ASL ' +
          'number handshapes. Templates marked <b>est</b> are estimates — ' +
          'run <b>CALIBRATE</b> once to record each from your own hand, which ' +
          'makes recognition dramatically more reliable.',
  },
  {
    id: 'chords', target: '#chord-assigns', needs: ['audio', 'dev', 'chord'], title: 'Chord mode',
    body: 'Hold a gesture, sustain a chord. Chords are named by <b>scale ' +
          'degree</b> (I–vii) in a key you pick once — change the key and every ' +
          'assignment transposes together. FOLLOW keeps chords in the same key ' +
          'your melody is quantised to.',
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

export const tour = (() => {
  let idx = -1;          // current step index, -1 = closed
  let els = null;        // { backdrop, ring, card } while open
  let seenThisRun = new Set();

  const step = () => TOUR_STEPS[idx];
  const resolve = t => (t ? document.querySelector(t) : null);
  // Present AND visible — a dev-gated section exists in the DOM at
  // display:none, and spotlighting a zero-size box helps nobody.
  const showable = st => !st.target || (el => el && el.getClientRects().length > 0)(resolve(st.target));

  // Nearest showable step from `from` walking `dir` (+1/-1), or -1. Steps
  // whose UI a redesign removed — or whose state isn't active — just skip;
  // the tour must never break because it lagged a release.
  const firstShowable = (from, dir) => {
    for (let i = from; i >= 0 && i < TOUR_STEPS.length; i += dir) {
      if (showable(TOUR_STEPS[i])) return i;
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
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    document.addEventListener('keydown', onKey);
  }

  function teardown() {
    if (!els) return;
    Object.values(els).forEach(e => e.remove());
    els = null;
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
    document.removeEventListener('keydown', onKey);
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
    if (t) {
      const r = t.getBoundingClientRect();
      const pad = 6;
      ring.style.display = 'block';
      ring.style.left   = (r.left - pad) + 'px';
      ring.style.top    = (r.top - pad) + 'px';
      ring.style.width  = (r.width + 2 * pad) + 'px';
      ring.style.height = (r.height + 2 * pad) + 'px';
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
    card.style.width = cw + 'px';
    const ch = card.offsetHeight || 180;
    const below = r.bottom + 14 + ch < window.innerHeight;
    card.style.top  = (below ? r.bottom + 14 : Math.max(12, r.top - 14 - ch)) + 'px';
    card.style.left = Math.max(12, Math.min(r.left, window.innerWidth - cw - 12)) + 'px';
  }

  function render() {
    const st = step();
    seenThisRun.add(st.id);
    const t = resolve(st.target);
    t?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const last = firstShowable(idx + 1, 1) === -1;
    els.card.innerHTML = `
      <div class="tour-head">
        <span class="tour-count">${idx + 1}/${TOUR_STEPS.length}</span>
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

  function start() {
    if (els) return;                    // already open
    seenThisRun = new Set();
    build();
    idx = Math.max(0, firstShowable(0, 1));
    render();
  }

  function syncButton() {
    const btn = document.getElementById('tour-btn');
    if (!btn) return;
    const fresh = unseenSteps();
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
  document.getElementById('tour-btn')?.addEventListener('click', () =>
    tour.open ? tour.close() : tour.start());
  tour.syncButton();
  // First visit: offer the tour after the app has settled. Skipping marks it
  // offered — it never auto-opens twice. Automation (navigator.webdriver:
  // the ui-ux screenshot harness, the tutorial test itself) never gets the
  // auto-offer; tests drive tour.start() explicitly.
  if (!loadState().done && !navigator.webdriver) setTimeout(() => tour.start(), 700);
}
