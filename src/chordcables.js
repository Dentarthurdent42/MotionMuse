// Gesture mode's assignments ARE cables.
//
// Which handshape plays which degree used to be a table inside chord mode
// and a row of pickers in its panel — the one configuration on the canvas
// that no cable showed, so a setup that plays chords looked unwired. Now
// each degree, the RELEASE and the two accidentals are INPUT sockets on the
// Gesture Mode node, and the assignment is the cable from the handshape's
// signal (gesture_<id>, an output on the camera) into that socket. The
// pickers in the rows are still there: choosing a shape strings the cable,
// and stringing the cable (from the socket, or from a preset) sets the
// picker. Any other signal can be wired in too — a metronome pulse, a
// function node — and then the cable itself holds the degree while it reads
// high; the row shows WIRED.
//
// Two directions, one source of truth at a time: a change to the patch
// (mapper) writes the assignments; a change to the assignments (a picker, a
// loaded setup, the defaults arriving) writes the cables. Each is silent
// while the other runs, so they cannot chase each other.

import { mapper } from './mapper.js';
import { chordmode, DEGREES } from './chordmode.js';
import { isString } from './is.js';

export const DEGREE_KEYS = Array.from({ length: DEGREES }, (_, i) => `chord_trig_${i}`);
export const RELEASE_KEY = 'chord_trig_release';
export const ACC_KEYS = { sharp: 'chord_acc_sharp', flat: 'chord_acc_flat' };
export const CHORD_CABLE_KEYS = [...DEGREE_KEYS, RELEASE_KEY, ACC_KEYS.sharp, ACC_KEYS.flat];

// What a socket is held by when its cable is not a handshape's.
export const CABLE_ID = what => `cable:${what}`;
export const isCableId = id => isString(id) && id.startsWith('cable:');

const sigOf = gid => `gesture_${gid}`;
const gidOf = signal => (isString(signal) && signal.startsWith('gesture_') ? signal.slice(8) : null);
const cableOn = key => mapper.mappings.find(m => m.audioParam === key && m.signal) ?? null;

// The socket each slot is; the slots each socket is.
const SLOTS = [
  ...DEGREE_KEYS.map((key, i) => ({ key, what: i, get: () => chordmode.gestureFor(i), set: id => chordmode.setDegreeGesture(i, id) })),
  { key: RELEASE_KEY, what: 'release', get: () => chordmode.getReleaseGesture(), set: id => chordmode.setReleaseGesture(id) },
  { key: ACC_KEYS.sharp, what: 'sharp', get: () => chordmode.accidentalGestures().sharp, set: id => chordmode.setAccidentalGestures({ sharp: id }) },
  { key: ACC_KEYS.flat,  what: 'flat',  get: () => chordmode.accidentalGestures().flat,  set: id => chordmode.setAccidentalGestures({ flat: id }) },
];

let busy = false;

// Patch → assignments: the cables say what names what. Then back again:
// chord mode keeps one shape to one slot (a shape plugged into a second
// degree leaves its first), and the patch has to show what it decided.
export function applyCables() {
  if (busy) return;
  busy = true;
  try {
    for (const s of SLOTS) {
      const m = cableOn(s.key);
      const want = m ? (gidOf(m.signal) ?? CABLE_ID(s.what)) : null;
      if ((s.get() ?? null) !== want) s.set(want);
    }
  } finally { busy = false; }
  drawCables();
}

// Assignments → patch: a cable for every shape that names something. A
// slot held by some other cable keeps it — that cable is the assignment.
// Drawn while the mode is on: switched off, the shapes are kept but the
// patch is not strung with ten cables for an instrument that is not playing
// — they arrive with the switch (setEnabled notifies).
export function drawCables() {
  if (busy || !chordmode.enabled) return;
  busy = true;
  try {
    for (const s of SLOTS) {
      const id = s.get() ?? null;
      const m = cableOn(s.key);
      if (!id) { if (m) mapper.remove(m.id); continue; }
      if (isCableId(id)) continue;
      if (m && m.signal === sigOf(id)) continue;
      if (m) mapper.remove(m.id);
      mapper.add(s.key, sigOf(id), 0, 1, 'linear', 0, false);
    }
  } finally { busy = false; }
}

export function initChordCables() {
  mapper.onChange(applyCables);
  chordmode.onAssign(drawCables);
  drawCables();
}

// What a saved setup carries: a shape's cable is implied by the assignment
// chord mode saves, so only the cables from OTHER signals need keeping —
// a shared link's code stays scannable.
export const impliedCable = m => CHORD_CABLE_KEYS.includes(m.audioParam) && !!gidOf(m.signal);
