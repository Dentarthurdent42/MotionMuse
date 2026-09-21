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
//           'audio' (synth started), 'dev' (dev mode), 'chord' (gesture mode
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
// One tour covering everything meant a first-timer who picked gesture mode sat
// through the patchbay, the cable editor and the play-along game before
// reaching the one panel they were going to use. The tour is now scoped to the
// mode you chose, and the mode is what the starting-point picker sets.
export const TOUR_STEPS = [
  // Welcome, then the split: Gesture Mode and Tone Mode are the two output
  // types, so each mode's block comes first in its own tour and the shared
  // app steps follow. stepsForMode() keeps array order, which is what makes
  // this ordering BE the structure.
  {
    id: 'welcome', target: null, title: 'Welcome to MotionMuse',
    body: 'Your webcam is the instrument. Two ways to play: <b>Gesture Mode</b> ' +
          '— handshapes play chords, or single notes — and <b>Tone Mode</b> ' +
          '— movement drives the synth continuously. Nothing is uploaded; ' +
          'everything runs on your machine.<br><br>This tour follows the mode ' +
          'you picked. Re-open it any time with the <b>?</b> button.',
  },

  // ── Gesture Mode ──
  {
    id: 'chords-key', section: 'gesture-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'Gesture Mode',
    body: 'Handshapes play chords, always in key. Set <b>root, mode and ' +
          'octave</b>; the panel lists the seven chords in that key ' +
          '(<b>I ii iii IV V vi vii°</b>). Change the key and they all ' +
          'transpose. <b>FOLLOW</b> uses the melody’s key.',
  },
  {
    id: 'chords-assign', section: 'gesture-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'Assign handshapes',
    body: 'By default the degree is the ASL number: <b>I</b> is a 1, <b>ii</b> ' +
          'a 2, up to <b>vii°</b> as a 7. A closed fist releases. Reassign any ' +
          'row you like — a shape already in use swaps. <b>7th</b> adds the ' +
          'seventh; the dot lights while the chord sounds.',
  },
  {
    id: 'chords-voicing', section: 'gesture-mode', modes: ['chords'], target: '#ck-voicing', needs: ['audio', 'chord'],
    title: 'Chords or single notes',
    body: '<b>PLAY</b> decides what a shape sounds: the whole <b>chord</b> on ' +
          'that degree, or just that degree’s own <b>note</b>. Everything else ' +
          '— key, shapes, expression, arpeggiator — applies either way. On ' +
          'single notes your <b>other hand</b> bends it: one shape for ' +
          '<b>♯ sharp</b>, one for <b>♭ flat</b>, neither for natural. Seven ' +
          'shapes plus that is the whole chromatic scale.',
  },
  {
    id: 'chords-express', section: 'gesture-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'Play it',
    body: '<b>PLAY WITH</b> sets what sounds the chord: hold the handshape, ' +
          'open and close the <b>other hand</b> (the chord latches while you ' +
          'pick the next one), or raise your <b>eyebrows</b>.',
  },
  {
    id: 'chords-range', section: 'gesture-mode', modes: ['chords'], target: '#chord-assigns', needs: ['audio', 'chord'],
    title: 'Set your range',
    body: '<b>OFF AT</b> and <b>FULL AT</b> map your hand’s real travel onto ' +
          'silence-to-full. Open and close while watching the meter; if it ' +
          'never empties, raise OFF AT.',
  },

  // ── Tone Mode ──
  {
    id: 'patch-nodes', section: 'camera', modes: ['osc'], target: '#cam-signals', title: 'Tone Mode',
    body: 'Signals drive the synth continuously, and the wiring is on the ' +
          'canvas: every <b>signal</b> is an output socket ● on the node that ' +
          'measures it, every <b>parameter</b> an input socket ● on the node ' +
          'that owns it, and a cable between them is the connection. Drag ● ' +
          'to ● to connect. One signal can drive several parameters.',
  },
  {
    id: 'cable-editor-node', modes: ['osc'], target: '#add-node-btn', title: 'Edit a cable',
    body: 'Click a cable, or right-click the input it runs into: its editor ' +
          'opens with range, curve, steps and invert. Oscillator-frequency ' +
          'cables add a piano keyboard for picking note ranges. A <b>ƒ</b> ' +
          'function node (from <b>+ NODE</b>) computes between cables.',
  },
  {
    id: 'preset', modes: ['osc'], target: '#preset-btn', title: 'Presets',
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
    id: 'signals', section: 'camera', target: '#cam-signals', title: 'Signals',
    body: 'Everything the camera measures, live, as this node’s outputs: wrist ' +
          'height, pinch, finger curl, elbow angle, fingertip touches. Most read ' +
          'on two channels — <b>displacement</b> is where you are, <b>velocity</b> ' +
          'is how fast you are moving. A held pose and a flick are different ' +
          'controls. Each channel ends in a socket ●: drag it to a parameter’s ' +
          '● anywhere on the canvas to wire it. Click a row to copy its key.',
  },
  {
    id: 'looper', section: 'looper', target: '#loop-state', needs: ['audio'], title: 'Loop pedal',
    body: 'Play a phrase, drop it, and it repeats under you while you play the ' +
          'next one over the top. The pedal is a <b>sharp nod</b> — a real loop ' +
          'pedal is a foot switch because your hands are busy, and here your ' +
          'hands <i>are</i> the instrument. One press cycles ' +
          '<b>record → play → overdub</b>; <b>STOP</b>, <b>UNDO</b> and ' +
          '<b>CLEAR</b> are buttons, so the motion that starts a take can never ' +
          'end one. It reads how <i>fast</i> you move, not where you are, so ' +
          'holding a pose never trips it — nudge <b>SENSITIVITY</b> while ' +
          'watching the meter to set it for your neck. The gesture starts ' +
          '<b>off</b> (a nod is also just a nod); the buttons work either way.',
  },
  {
    id: 'save-load', target: '#preset-btn', title: 'Save and load',
    body: 'At the foot of the PRESET menu, <b>SAVE</b> downloads the whole ' +
          'setup as one file and <b>LOAD</b> restores it. The session also ' +
          'auto-saves locally.',
  },
  {
    id: 'audio', target: '#audio-btn', title: 'Sound',
    body: 'The synth runs from page load, muted. Click here or press ' +
          '<b>Space</b> to unmute.',
  },
  {
    id: 'audio-group', target: '[data-node="group:audio"]', needs: ['audio'], title: 'The audio engine',
    body: 'Oscillators, filter, reverb, both quantizers — one node each, ' +
          'framed as a group. Every control here can also be driven by a ' +
          'cable. Each node’s <b>?</b> explains that node; the group’s caret ' +
          'collapses the whole engine into one node.',
  },
  {
    id: 'sec-visualizer', section: 'output', target: '#viz-wrap', needs: ['audio'],
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
    id: 'sec-radial', section: 'radial-mode', target: '#radial-toggle', needs: ['audio'],
    title: 'Radial Mode',
    body: 'A ring worn on your wrist or shoulder — one section per scale ' +
          'degree. Point your index finger into a section to play it, stay ' +
          'to sustain; the faster you enter, the harder the attack.',
  },
  {
    id: 'sec-metronome', section: 'metronome', target: '#metro-toggle', needs: ['audio'],
    title: 'Metronome',
    body: 'A beat clock you can hear and see: it clicks (MUTE silences just ' +
          'the click), and its beat strip pulses on the camera view — one ' +
          'marker per beat, the diamond the downbeat. Both play modes offer ' +
          'a “Metronome beats” volume mode that strikes only on the beats ' +
          'you light in the SAMPLE row.',
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
    id: 'sec-inputs', section: 'output', target: '#output-params', needs: ['audio'],
    title: 'Inputs',
    body: 'Every slider, switch and choice carries an input socket ● beside ' +
          'it. Drag to set a value by hand; wire a signal into the socket and ' +
          'the control follows it — a filter type, the key, the tempo included.',
  },
  {
    // Rearranging is invisible until someone tries it, so the tour is the
    // place a user finds out the canvas is theirs.
    id: 'workspace', target: '#ws', title: 'Everything is a node',
    body: 'The whole interface is one canvas. Drag empty space to <b>pan</b>, ' +
          'scroll to <b>zoom</b>, <b>⌂ FIT</b> to see it all. Drag a node by ' +
          'its <b>header</b>; its corner <b>grip</b> resizes it, the ' +
          '<b>caret</b> folds it, <b>⌖</b> pins it to the screen, <b>×</b> ' +
          'closes it (<b>+ NODE</b> brings anything back). Select several and ' +
          'press <b>Ctrl+G</b> to fold them into one group node; ' +
          '<b>⋮⋮ TIDY</b> lays them out. Right-click anything for more. ' +
          'The layout is remembered.',
  },
  {
    // No modes gate any more: the game now has a chart for every way of
    // playing, so every tour gets to hear about it.
    id: 'playalong', section: 'play-along', target: '#game-btn', needs: ['audio'], title: 'Play along',
    body: 'A falling-note game with a chart for every way of playing: songs ' +
          'for the quantised lead, and <b>generated</b> charts — fresh every ' +
          'start, in your key — for handshapes and the radial ring. ' +
          '<b>IMPORT</b> turns your own MIDI files into charts. Best scores ' +
          'are kept.',
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
    id: 'gestures', section: 'gesture-mode', target: '#gesture-lib', needs: ['audio'],
    title: 'Gesture configurations',
    body: 'The library behind Gesture Mode — unfold it to see every gesture ' +
          'the app knows. The dot lights while you hold one. <b>est</b> marks ' +
          'an estimated template; <b>⊙</b> records that gesture from your own ' +
          'body and sharpens recognition, and <b>✎</b> renames it. <b>● REC</b> ' +
          'adds one of your own — a handshape, or, with the picker beside it, ' +
          'a face or whole-body pose — which also becomes a signal the ' +
          'patchbay can wire.',
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

// { done, seen: [stepId], offered: [helpId] }
//
// `seen` is what has actually been READ — a step counts once it has been
// rendered on screen. `offered` is what has been PRESSED, which is a
// different question and is why it is stored separately: pressing a `?` and
// closing it after one step should stop that button clamouring for attention
// (you have been shown it) without claiming you read the rest of it.
const LS_KEY = 'motionmuse-tour';

const loadState = () => {
  try { return { done: false, seen: [], offered: [], ...JSON.parse(lsGet(LS_KEY) || '{}') }; }
  catch { return { done: false, seen: [], offered: [] }; }
};
const saveState = s => lsSet(LS_KEY, JSON.stringify(s));

// ── Which `?` buttons are asking to be pressed ───────────────────────────
//
// The tour used to open itself on a first visit. It no longer does: a modal
// walkthrough in front of an instrument you have not touched yet is an
// interruption, and on a phone it lands as a sheet over the whole app with
// one small × to find. So the help waits to be asked for, and the asking is
// made obvious instead — every `?` carries its own state:
//
//   pulsing   unread AND relevant to how you are set up to play right now.
//             Gently, and only until you press it once.
//   marked    unread, but about something you are not using. A dot, no
//             motion: "there is something here you have not read", said
//             quietly enough to ignore.
//   plain     read.
//
// The header's own `?` is one of these too, under the id below.
export const APP_HELP = 'app';
const stepsOf = id => (id === APP_HELP ? appSteps() : stepsForSection(id));

// Read as in rendered: a section with three steps of which you saw one is
// still unread, and keeps its dot.
export function helpUnread(id) {
  const seen = new Set(loadState().seen);
  return stepsOf(id).some(t => !seen.has(t.id));
}

// Pulsing is the stronger claim, so it takes much more.
//
// The obvious rule — "in the tour for the current mode" — turns out to
// select everything: almost every panel's steps carry no `modes` tag at all,
// because they are true however you are playing. Eleven buttons pulsing at
// once is a worse interruption than the one modal this replaced.
//
// So pulsing needs a step tagged for the way you are ACTUALLY set up to
// play: the handshape steps when gesture mode is on, the patchbay ones when
// it is not. That is two or three buttons at most, and they are the ones a
// walkthrough would have opened on. Everything else is unread, not urgent,
// and says so with a dot.
//
// The header's `?` is the exception: it is where "start here" lives, so any
// unread step in it is worth pointing at.
export function helpPulses(id) {
  const st = loadState();
  if (st.offered.includes(id)) return false;
  const seen = new Set(st.seen);
  const mode = currentMode();
  return stepsOf(id).some(t =>
    !seen.has(t.id) && (id === APP_HELP ? true : t.modes?.includes(mode)));
}

export function markHelpOffered(id) {
  const st = loadState();
  if (st.offered.includes(id)) return;
  st.offered = [...st.offered, id];
  saveState(st);
}

// The canvas draws the `?` buttons and the header owns its own, so both
// listen rather than poll: reading the help changes what every other button
// should look like.
let helpCbs = [];
export function onHelpChange(cb) { helpCbs.push(cb); }
export function refreshHelp() { helpCbs.forEach(cb => { try { cb(); } catch { /* one listener must not stop the rest */ } }); }

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
// than remembered from the picker: a user who turned gesture mode on afterwards
// should get the chord tour from the ? button, not the one they first chose.
const currentMode = () => chordmode.enabled ? 'chords' : 'osc';

export const tour = (() => {
  let idx = -1;          // current step index, -1 = closed
  let els = null;        // { backdrop, ring, card } while open
  let raf = 0;           // rect-tracking loop, alive only while open
  let lastBox = '';      // last target rect the ring was drawn against
  let seenThisRun = new Set();
  // The steps this run walks. Scoped by mode, so picking gesture mode does not
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

  // A full-viewport rectangle with a rectangular hole in it, as one polygon.
  //
  // The outer edge is traced clockwise and the hole anticlockwise, which is
  // what makes the non-zero fill rule read the inner loop as a hole; the two
  // are joined by a zero-width slit running left from the hole to the edge of
  // the screen, so it is a single closed path. `polygon(evenodd, …)` would say
  // the same thing in fewer points, but its fill-rule argument is not
  // everywhere yet, and a scrim that silently covered the thing it is meant to
  // be pointing at is not a failure worth risking for six points.
  const keyhole = (x, y, w, h) => `polygon(\
0 0, 100% 0, 100% 100%, 0 100%, \
0 ${y}px, ${x}px ${y}px, ${x}px ${y + h}px, \
${x + w}px ${y + h}px, ${x + w}px ${y}px, 0 ${y}px)`;

  // Position the ring around the (re-queried) target and the card near it.
  // Selectors are re-resolved every time so a re-rendered panel — the app
  // rebuilds sections wholesale — can't leave the spotlight on a dead node.
  function position() {
    if (!els || idx < 0) return;
    const st = step();
    const t = resolve(st.target);
    const { backdrop, ring, card } = els;
    // One dimmer for both kinds of step: the backdrop is always up, and when
    // a step points at something the app cuts that rectangle out of it (see
    // keyhole below). The dimmer used to be two things — this backdrop for
    // the targetless cards and the ring's own 9999px shadow for the spotlit
    // ones — which was fine while the dimming was a light wash and stopped
    // being fine once it blurred: a blur cannot be painted by a box-shadow,
    // and blurring the whole screen would take the target with it.
    backdrop.style.display = 'block';
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
      const x = (r.left - pad) / z, y = (r.top - pad) / z;
      const w = (r.width + 2 * pad) / z, h = (r.height + 2 * pad) / z;
      ring.style.display = 'block';
      ring.style.left   = x + 'px';
      ring.style.top    = y + 'px';
      ring.style.width  = w + 'px';
      ring.style.height = h + 'px';
      // The same box the ring outlines, cut out of the scrim. Computed from
      // the ring's own numbers so the two can never drift apart.
      backdrop.style.clipPath = keyhole(x, y, w, h);
    } else {
      ring.style.display = 'none';
      backdrop.style.clipPath = 'none';
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
    // Two ways out, both of them thumb-sized. The × alone was 17×16 css px
    // in the corner of a bottom sheet — on a phone there is no Escape key and
    // the scrim deliberately lets presses through to the app, so missing that
    // one target meant being stuck in the tour with no visible way out.
    els.card.innerHTML = `
      <div class="tour-head">
        <span class="tour-count">${idx + 1}/${steps.length}</span>
        <button class="rm-btn tour-x" id="tour-close" title="Close tour" aria-label="Close tour">×</button>
      </div>
      <div class="tour-title">${st.title}</div>
      <div class="tour-body">${st.body}</div>
      <div class="tour-nav">
        <button class="btn" id="tour-skip">${last ? 'CLOSE' : 'SKIP'}</button>
        <span class="tour-nav-end">
          <button class="btn" id="tour-back" ${firstShowable(idx - 1, -1) === -1 ? 'disabled' : ''}>BACK</button>
          <button class="btn on" id="tour-next">${last ? 'DONE' : 'NEXT'}</button>
        </span>
      </div>`;
    els.card.querySelector('#tour-close').addEventListener('click', () => close(false));
    els.card.querySelector('#tour-skip').addEventListener('click', () => close(last));
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
    refreshHelp();          // reading it changes how every `?` should look
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
    //
    // The same three states every panel's `?` has. It used to require
    // `done` — the tour having run once — which was reachable only because
    // the tour opened itself; now that nothing does, this button would have
    // stayed silent forever on a first visit, which is the one visit where
    // it has the most to say.
    const fresh = appSteps().filter(t => !loadState().seen.includes(t.id));
    const unread = fresh.length > 0;
    const pulse = helpPulses(APP_HELP);
    btn.classList.toggle('tour-unread', unread && !pulse);
    btn.classList.toggle('tour-new', pulse);
    btn.title = unread
      ? `Getting started — ${fresh.length} step${fresh.length > 1 ? 's' : ''} you have not read`
      : 'Getting started — the camera, sound, and saving. Each panel has its own ?';
  }

  return { start, close: () => close(false), get open() { return !!els; }, syncButton };
})();

export function initTutorial() {
  // The header `?` is no longer "restart the whole tutorial". Every panel
  // explains itself now, so this one keeps what belongs to no panel: the
  // welcome, the header buttons, the sign-off.
  document.getElementById('tour-btn')?.addEventListener('click', () => {
    if (tour.open) { tour.close(); return; }
    markHelpOffered(APP_HELP);
    tour.start({ steps: appSteps() });
    refreshHelp();
  });
  onHelpChange(() => tour.syncButton());
  tour.syncButton();
}

// Run one panel's help. Exported for ui/workspace.js, which owns the header button
// it hangs off; keeping the wiring there means a panel added later gets a `?`
// for free, the same way it gets a fold caret and a grip.
export function startSectionHelp(sectionId) {
  const steps = stepsForSection(sectionId);
  if (!steps.length) return false;
  if (tour.open) tour.close();
  markHelpOffered(sectionId);
  tour.start({ steps });
  refreshHelp();
  return true;
}

// ── A setup that arrived by link ─────────────────────────────────────────
//
// Following a link is not opening the app for the first time. The link
// already chose the way of playing and brought a patch with it, so the
// welcome that asks which mode you want is answering a question nobody
// asked, and the panels this particular setup never touches are noise
// standing in front of the thing you were actually handed.
//
// What is left is the mode's own tour minus both — and steps whose target is
// missing or hidden are skipped at runtime anyway, so a setup with no face
// tracking never reaches the face step without this having to know about it.
export const stepsForSharedSetup = () => stepsForMode(currentMode()).filter(t =>
  t.id !== 'welcome' && !(t.id === 'patch-nodes' && !mapper.mappings.length));

// Nothing here opens the tour any more.
//
// It used to open itself: on a first visit, on picking a starting point, on
// following a shared link. Each of those is a moment when someone has just
// said what they want to do, and answering that with a modal walkthrough
// puts twenty-nine steps between them and doing it. On a phone it was worse
// than an interruption — the card lands as a full-width sheet over the app,
// and the only way out was a 17-pixel × in its corner.
//
// So the help stays where it is and asks to be read instead: the `?` for
// anything relevant and unread pulses gently until it is pressed, and every
// other `?` carries a quiet dot if there is something behind it you have not
// seen. Pressing one is a choice; a sheet landing on you is not.
//
// These are called at the same moments the tour used to open, because those
// are still exactly the moments when what counts as "relevant" has changed.
export const flagHelpForMode = () => refreshHelp();
export const flagHelpForSharedSetup = () => refreshHelp();
