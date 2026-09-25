// What every node does, in a few lines — the documentation behind each `?`.
//
// This replaced a guided tour: a spotlight walkthrough of up to twenty-nine
// steps that stood between someone and the instrument they had just opened.
// Help is now a short card per node, opened from that node's own `?` and
// closed with a tap, and each `?` says whether you have read it:
//
//   pulsing   unread, and about the way you are set up to play right now.
//   dot       unread.
//   plain     read.
//
// ══ HOW TO UPDATE ══
// A new panel needs an entry in PANEL_DOCS under its `data-sec` id — the
// docs suite (tests/tutorial) fails for any node on the canvas without one.
// Keep each card to what a person needs to use the node: what it is, the
// two or three controls that matter, one tip. The README is for the rest.
//
// Read state is kept per KIND of node, not per node: reading about one Math
// node is reading about all of them.

import { lsGet, lsSet }  from '../storage.js';
import { isRecord, isString } from '../is.js';
import { chordmode }     from '../chordmode.js';
import { graph, NODE_TYPES } from '../graph.js';
import { shadergraph, SHADER_NODES } from '../shadergraph.js';

// Each doc: title, body (short HTML: <p>, <b>, <ul><li>), and optionally
// `modes` — the ways of playing it is essential to, which is what lets its
// `?` pulse rather than just carry a dot. 'osc' is Tone Mode (signals wired
// to the synth), 'chords' is Gesture Mode (handshapes play chords).
export const PANEL_DOCS = {
  camera: {
    title: 'Camera Input', modes: ['osc'],
    body: `<p>Your webcam, turned into signals. Press the frame to start it; the
      picture comes up at once and hand and pose tracking join a few seconds
      later. Nothing leaves your device.</p>
      <ul>
        <li>Every row below the picture is a <b>signal</b> — wrist height,
          pinch, elbow angle… Each ends in a socket ●: drag it to a control's ●
          anywhere on the canvas to make that movement drive it.</li>
        <li>Most signals come in two flavours: <b>where</b> you are and
          <b>how fast</b> you are moving (Δ).</li>
        <li><b>✋ L / R ✋, POSE, FACE, GAZE</b> choose what is tracked. Fewer
          trackers, smoother tracking.</li>
        <li><b>⛶ FULL</b> goes fullscreen; <b>⏹ STOP</b> releases the camera.</li>
      </ul>
      <p>Click a signal's row to copy its key.</p>`,
  },
  mic: {
    title: 'Microphone Input',
    body: `<p>Your microphone as another set of signals: <b>level</b>,
      <b>pitch</b>, <b>clarity</b> and <b>brightness</b>. Switch it on with the
      button in the header — sound is analysed in the browser, never recorded
      or uploaded, and never played back.</p>
      <p>Wire its sockets like the camera's: hum to steer a filter, clap to
      trigger something.</p>`,
  },
  models: {
    title: 'Models (DEV)',
    body: `<p>Which pose-tracking model runs, and on what hardware. Lighter
      models are faster; heavier ones are steadier. <b>DELEGATE</b> picks GPU or
      CPU for both the hand and pose models. Live timings appear once the
      camera runs.</p>`,
  },
  eeg: {
    title: 'EEG Input (under construction)',
    body: `<p>A placeholder for brain-activity signals. Not implemented yet;
      when it is, its signals will wire like the camera's.</p>`,
  },
  emg: {
    title: 'EMG Input (under construction)',
    body: `<p>A placeholder for muscle-activation signals. Not implemented yet;
      when it is, its signals will wire like the camera's.</p>`,
  },
  output: {
    title: 'Output',
    body: `<p>Where every sound ends up. The scope shows the waveform — it keeps
      moving while muted, so you can tell "silent" from "broken". Tap it to
      mute or unmute (so does <b>Space</b>).</p>
      <ul>
        <li><b>Main Vol</b>, <b>Reverb Mix</b>, <b>Loop Vol</b>: the master
          levels.</li>
        <li>Every slider has a socket ●: wire a signal in and the slider follows
          your movement.</li>
      </ul>`,
  },
  oscillators: {
    title: 'Oscillators',
    body: `<p>The lead synth. <b>− n +</b> sets how many oscillators run (0–8);
      each has its own waveform, pitch, detune and level, and a socket on each.</p>
      <ul>
        <li>Wire a hand's height into <b>Osc1 Freq</b> and you are playing
          pitch.</li>
        <li><b>SHEPARD</b> turns each into an endlessly rising (or falling)
          tone.</li>
        <li>Zero oscillators is allowed — Gesture Mode plays on its own.</li>
      </ul>`,
  },
  filter: {
    title: 'Filter',
    body: `<p>Shapes the tone of the lead oscillators. Pick a type, then
      <b>cutoff</b> (brightness) and <b>Q</b> (resonance). <b>Osc Volume</b> is the
      whole lead bank's level. The <b>LFO</b> wobbles the cutoff on its own.</p>
      <p>A classic: wire hand openness into cutoff.</p>`,
  },
  'chord-filter': {
    title: 'Chord Filter',
    body: `<p>The same kind of filter as the lead's, but for the chord voices
      that Gesture Mode and Radial Mode play — so chords and lead can be shaped
      separately. <b>Chord Volume</b> is the chords' level.</p>`,
  },
  'chord-voice': {
    title: 'Chord Voice',
    body: `<p>The voice that Gesture Mode and Radial Mode sound through: the
      key, the envelope (attack, decay, sustain, release), the 7ths, and the
      <b>arpeggiator</b>, which plays a held chord one note at a time.</p>
      <p>Change the key here and every chord transposes with it.</p>`,
  },
  'gesture-mode': {
    title: 'Gesture Mode', modes: ['chords'],
    body: `<p><b>Handshapes play chords</b>, always in key. By default the degree
      is the ASL number you show — a 1 is <b>I</b>, a 2 is <b>ii</b>, up to 7 for
      <b>vii°</b> — and a closed fist lets go.</p>
      <ul>
        <li><b>PLAY</b>: the whole chord, or just that degree's note. On single
          notes your other hand bends it ♯ or ♭.</li>
        <li><b>PLAY WITH</b>: what sounds it — holding the shape, opening the
          other hand, or raising your eyebrows.</li>
        <li><b>OFF AT / FULL AT</b>: fit the loudness range to your hand's real
          travel.</li>
        <li>Reassign any row; unfold the gesture library to record your own
          shapes.</li>
      </ul>`,
  },
  'chord-quality': {
    title: 'Chord Quality', modes: ['chords'],
    body: `<p>Your <b>other hand</b> — the one not naming the degree — sets the
      chord's quality. The root stays the degree's; the chord becomes this.</p>
      <ul>
        <li><b>Thumbs up</b> major, <b>thumbs down</b> minor (the same shapes
          that sharpen and flatten single notes), the <b>O</b> diminished,
          <b>rock horns</b> 7, <b>I love you</b> maj7.</li>
        <li>Hold nothing and the chord is the key's own.</li>
        <li>Pick a shape per row, or wire any signal into a row's socket.</li>
      </ul>`,
  },
  'radial-mode': {
    title: 'Radial Mode',
    body: `<p>A ring worn on your wrist or shoulder, one section per note of the
      scale. <b>Point your index finger</b> into a section to play it and stay to
      sustain; the faster you enter, the harder the attack.</p>
      <p>Pick the <b>JOINT</b> the ring sits on and the <b>FINGER</b> that points.</p>`,
  },
  metronome: {
    title: 'Metronome',
    body: `<p>A beat clock. Switched on, it gives the instrument a tempo to lock
      to — the quantizer, the looper and the “Metronome beats” volume modes all
      follow it — and its beat strip pulses on the camera view.</p>
      <ul>
        <li>The click starts <b>muted</b>; press <b>MUTE</b> to hear it.</li>
        <li><b>SAMPLE</b> picks which beats the beat-sampled modes strike on.</li>
        <li>Its beat is also a signal ● you can wire.</li>
      </ul>`,
  },
  'sound-kit': {
    title: 'Sound Kit',
    body: `<p>Ready-made instrument tones for the oscillators. A kit only sets
      the <b>timbre</b> — how many oscillators run and how loud stays yours.
      Tweak the tone and the selector reads Custom.</p>`,
  },
  'play-along': {
    title: 'Play Along',
    body: `<p>A falling-note game. Songs for the lead, and freshly generated
      charts in your key for handshapes and the radial ring. <b>IMPORT</b> turns
      your own MIDI file into a chart. Best scores are kept.</p>`,
  },
  looper: {
    title: 'Loop Pedal',
    body: `<p>Play a phrase, loop it, play over it. One press of <b>PEDAL</b>
      cycles <b>record → play → overdub</b>; <b>STOP</b>, <b>UNDO</b> and
      <b>CLEAR</b> are buttons of their own.</p>
      <p>Your hands are busy playing, so the pedal can also be a <b>sharp
      nod</b> — switch the gesture on and set <b>SENSITIVITY</b> while watching
      the meter.</p>`,
  },
  'pitch-quantize': {
    title: 'Pitch Quantize',
    body: `<p>Snaps pitch onto a scale so a wandering hand plays in tune. Pick
      <b>root</b>, <b>scale</b> and tuning; the keyboard shows which notes are
      in play. Off, pitch slides freely.</p>`,
  },
  'volume-quantize': {
    title: 'Volume Quantize',
    body: `<p>Steps the volume instead of sliding it, so each change is a note
      rather than a swell. <b>GATE</b> makes the lowest step true silence;
      <b>PLUCK / KEY / BOW</b> set how each step attacks.</p>`,
  },
  'shader-visual-output': {
    title: 'Shader — Visual Output',
    body: `<p>A picture that moves with you, built from shader nodes on the same
      canvas. <b>STARTER</b> builds a working example; <b>+ NODE</b> adds your own
      from the Shader sections of the menu.</p>
      <ul>
        <li>Number inputs take ordinary signal cables — wire a wrist to a noise
          node's scale.</li>
        <li>Shader sockets are coloured by type: number, coordinate,
          colour.</li>
      </ul>`,
  },
};

export const GROUP_DOC = {
  title: 'Groups',
  body: `<p>A frame around nodes that belong together. Drag its header to move
    them as one; the caret <b>collapses</b> it into a single node that shows only
    the cables crossing its edge. Double-click the name to rename.</p>
    <ul>
      <li>The slider in its header is the group's <b>volume</b>: it scales
        everything inside that makes sound, and multiplies with any group
        around it.</li>
      <li>Select nodes and press <b>Ctrl+G</b> to make a group; drag a node in
        or out to change who is in it; <b>×</b> ungroups.</li>
    </ul>`,
};

const FN_DOCS = {
  const: 'A fixed value you set with its slider — a knob you can wire anywhere.',
  math:  'Combines A and B: add, subtract, multiply, min, max or average.',
  mix:   'Crossfades between A and B; MIX is how far toward B.',
  smooth:'Glides toward its input instead of jumping. AMOUNT 0 is a plain wire, 1 is about a two-second glide.',
  quant: 'Snaps its input to a number of even steps.',
  hold:  'Samples its input when GATE rises and holds it until the next rise. Wire the metronome beat to GATE to make any signal move on the beat.',
  lfo:   'A slow wave of its own: RATE is how fast, DEPTH how far.',
};
const fnDoc = type => {
  const t = NODE_TYPES[type];
  if (!t) return null;
  return {
    title: `ƒ ${t.name}`,
    body: `<p>${FN_DOCS[type] ?? ''}</p>
      <p>A function node computes on signals: wire signals into its inputs on
        the left, and its output ● on the right into any control.</p>`,
  };
};

const TYPE_WORD = { float: 'number', vec2: 'coordinate', vec3: 'colour' };
const shxDoc = type => {
  const t = SHADER_NODES[type];
  if (!t) return null;
  const ins = t.ins.length
    ? `<p>Inputs: ${t.ins.map(s => `<b>${s.name}</b> (${TYPE_WORD[s.type] ?? s.type})`).join(', ')}.
       Number inputs also take signal cables.</p>` : '';
  return {
    title: `▨ ${t.name}`,
    body: `<p>${t.help ?? 'A shader node.'}</p>${ins}
      <p>Its output is a ${TYPE_WORD[t.out] ?? t.out}; wire it into other shader
        inputs, ending at <b>Output</b>.</p>`,
  };
};

export const APP_KEY = 'app';
export const APP_DOC = {
  title: 'MotionMuse',
  body: `<p>Your webcam is the instrument. Everything runs on your device.</p>
    <p><b>Quick start:</b> press the camera frame, pick a <b>PRESET</b>, and move —
      right hand up and down for pitch, pinch for volume.</p>
    <ul>
      <li>The screen is one <b>canvas</b> of nodes. Drag empty space to pan,
        scroll or pinch to zoom, drag a header to move a node.</li>
      <li><b>Cables</b> connect a signal ● to a control ●. Click a cable to set
        its range and curve.</li>
      <li><b>+ NODE</b> adds nodes, <b>FIND</b> searches everything,
        <b>⌂ FIT</b> shows it all, <b>⋮⋮ TIDY</b> lays it out.</li>
      <li><b>PRESET</b> loads, saves and restores setups; <b>SHARE</b> turns
        yours into a QR code.</li>
      <li><b>🔊</b> or <b>Space</b> mutes; <b>⚙</b> holds the theme, hotkeys and
        DEV features.</li>
    </ul>
    <p>Every node has its own <b>?</b>. A dot on one means you have not read it
      yet.</p>`,
};

// The doc behind a node id, and the key its read-state is kept under.
export function docFor(id) {
  const s = String(id);
  const kind = s.slice(0, s.indexOf(':'));
  const key = s.slice(s.indexOf(':') + 1);
  if (s === APP_KEY) return { key: APP_KEY, ...APP_DOC };
  if (kind === 'panel' && PANEL_DOCS[key]) return { key: `panel:${key}`, ...PANEL_DOCS[key] };
  if (kind === 'group') return { key: 'group', ...GROUP_DOC };
  if (kind === 'fn') {
    const n = graph.nodes().find(x => String(x.id) === key);
    const d = n && fnDoc(n.type);
    return d ? { key: `fn:${n.type}`, ...d } : null;
  }
  if (kind === 'shx') {
    const n = shadergraph.nodes().find(x => String(x.id) === key);
    const d = n && shxDoc(n.type);
    return d ? { key: `shx:${n.type}`, ...d } : null;
  }
  return null;
}

// ── Read state ───────────────────────────────────────────────────────────
//
// { read: [docKey] }. Someone who read panels in the old tour has read them:
// a section whose every tour step they saw is carried over, once.
const LS_KEY = 'motionmuse-docs';
const TOUR_KEY = 'motionmuse-tour';
const TOUR_SECTIONS = {
  'gesture-mode': ['chords-key', 'chords-assign', 'chords-voicing', 'chords-express', 'chords-range', 'gestures'],
  camera: ['patch-nodes', 'signals'],
  looper: ['looper'],
  output: ['sec-visualizer', 'sec-inputs'],
  'sound-kit': ['sec-soundkit'],
  oscillators: ['sec-oscillators'],
  'radial-mode': ['sec-radial'],
  metronome: ['sec-metronome'],
  'pitch-quantize': ['sec-pitch-quant'],
  'volume-quantize': ['sec-vol-quant'],
  'play-along': ['playalong'],
};

function load() {
  let st = null;
  try { st = JSON.parse(lsGet(LS_KEY) || 'null'); } catch { st = null; }
  if (isRecord(st) && Array.isArray(st.read)) return { read: st.read.filter(isString) };
  // First load since the tour went: carry over what it had shown.
  let seen = [];
  try {
    const t = JSON.parse(lsGet(TOUR_KEY) || 'null');
    if (isRecord(t) && Array.isArray(t.seen)) seen = t.seen;
  } catch { seen = []; }
  const read = Object.entries(TOUR_SECTIONS)
    .filter(([, ids]) => ids.every(i => seen.includes(i)))
    .map(([sec]) => `panel:${sec}`);
  const out = { read };
  lsSet(LS_KEY, JSON.stringify(out));
  return out;
}

export const isRead = key => load().read.includes(key);

export function markRead(key) {
  const st = load();
  if (st.read.includes(key)) return;
  st.read.push(key);
  lsSet(LS_KEY, JSON.stringify(st));
  changed();
}

// The way of playing the app is set up for right now — read from state, so
// switching Gesture Mode on later moves the pulse to its node.
const currentMode = () => (chordmode.enabled ? 'chords' : 'osc');

// Pulsing takes more than unread: the doc has to be about how you are
// playing. That is one or two buttons, not every one on the canvas.
export function pulses(doc) {
  if (!doc || isRead(doc.key)) return false;
  if (doc.key === APP_KEY) return true;
  return !!doc.modes?.includes(currentMode());
}

const cbs = [];
export function onDocsChange(cb) { cbs.push(cb); }
export function changed() { cbs.forEach(cb => { try { cb(); } catch { /* one listener must not stop the rest */ } }); }
