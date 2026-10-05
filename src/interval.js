// Interval mode — play the DISTANCE to the next note, not the note.
//
// Gesture mode names a degree: an ASL 3 is always the third degree of the
// key, wherever you were before. Here the same handshape is a MOVE: a 3 is
// "a third from where I am", so a melody is played the way it is sung — by
// its steps and leaps — and the same shapes walk it in any key, from any
// starting note.
//
// A move has to happen at a moment, not for as long as the shape is held —
// a held "up a second" re-read sixty times a second would run off the top of
// the keyboard in a blink. So a TRIGGER decides when the hands are read:
//
//   'beat'   the metronome's SAMPLE beats. Hold a 2 and every beat climbs a
//            step — a scale run, one shape. Needs the metronome running.
//   'step'   the STEP input: a pulse on its socket (any signal — the other
//            hand's pinch, a nod, a stamp) or its button. The "separate
//            gesture" trigger.
//   'change' each new shape moves once, when it is formed. Holding it does
//            nothing more; to repeat a move, drop the shape and make it again.
//
// Where the direction comes from depends on how many hands play:
//
//   one hand   the shape says how far, the hand's LEAN says which way —
//              upright is up, tipped over to your left (towards the low end
//              of a keyboard) is down. ASL 0 sustains: whatever is ringing
//              keeps ringing and nothing moves. A closed fist is silence.
//   two hands  the right hand's shapes go UP, the left hand's go DOWN. Both
//              at once add up: up a 3rd and down a 2nd is up a step.
//
// Either way a hand showing nothing is silence too — losing tracking must fail
// quiet — and a resting fist on the idle hand does not cancel the other.
//
// Sizes are counted the way intervals are named: in SCALE STEPS (the default)
// an ASL 2 is a second — the next note of the key — and an ASL 1 is the
// unison, the same note struck again; 8 is the octave. In SEMITONES an ASL N
// is N semitones, for chromatic lines the key would not allow.
//
// The note sounds through the chord voice bank as a single note, like gesture
// mode's SINGLE NOTES, so the Chord Voice's envelope and arpeggiator shape it.
// One instrument on that bank at a time: switching this on parks gesture and
// radial mode, and switching either of them on parks this.
//
// The musical decisions are exported pure functions (stepPitch, planMove,
// directionFrom) so tests/unit/interval.test.js drives them without a camera.

import { bus }        from './bus.js';
import { engine }     from './engine.js';
import { metronome }  from './metronome.js';
import { arpvoice }   from './arpvoice.js';
import { chordmode }  from './chordmode.js';
import { radial }     from './radial.js';
import { gesture }    from './gesture.js';
import { rootMidi }   from './chords.js';
import { SCALES, NOTE_NAMES, mtof, midiName } from './scale.js';
import { isRecord, isString } from './is.js';

export const INTERVAL_HANDS    = ['one', 'two'];
export const INTERVAL_TRIGGERS = ['beat', 'step', 'change'];
export const INTERVAL_UNITS    = ['scale', 'semitone'];

// The largest interval a shape names: ASL 1–10 are the numerals the gesture
// set has (10 is the thumbs-up).
export const MAX_SIZE = 10;
export const SIZES = Array.from({ length: MAX_SIZE }, (_, i) => i + 1);

// Size N is the ASL handshape for N — the numbering nobody has to learn. ASL 0
// is the one numeral left, and "zero distance, keep going" is what sustain is.
export const DEFAULT_GESTURES = {
  1: 'point', 2: 'peace', 3: 'asl3', 4: 'asl4', 5: 'palm',
  6: 'asl6', 7: 'asl7', 8: 'asl8', 9: 'asl9', 10: 'thumbs',
  sustain: 'asl0', silence: 'fist',
};
export const SLOTS = [...SIZES.map(String), 'sustain', 'silence'];

// What a size is called, in each unit — for the rows and the readout.
const ORDINAL = ['unison', '2nd', '3rd', '4th', '5th', '6th', '7th', 'octave', '9th', '10th'];
const SEMI_NAME = ['m2', 'M2', 'm3', 'M3', 'P4', 'tritone', 'P5', 'm6', 'M6', 'm7'];
export const sizeName = (size, unit = 'scale') =>
  (unit === 'semitone' ? SEMI_NAME : ORDINAL)[size - 1] ?? String(size);

// The playable range. A walk that runs off either end folds back an octave
// rather than sticking at the edge — a stuck note would make every further
// move in that direction silent in effect, and nothing on screen would say why.
export const MIDI_LO = 36;   // C2
export const MIDI_HI = 96;   // C7
export const foldRange = (m, lo = MIDI_LO, hi = MIDI_HI) => {
  let x = m;
  while (x > hi) x -= 12;
  while (x < lo) x += 12;
  return x;
};

// ── Scale arithmetic ──────────────────────────────────────────────────────
//
// A key's notes as one integer line: index k is the (k mod n)th degree, k div
// n octaves up, counted from the root's pitch class in MIDI octave −1. Moving
// by an interval is then plain addition on k — which is what makes a third
// land on the key's own third, major or minor, with no table of qualities.
const scaleOf = mode => SCALES[mode] ?? SCALES['major (ionian)'];
const pcOf = root => Math.max(0, NOTE_NAMES.indexOf(root));

export const midiAtIndex = (k, root, mode) => {
  const s = scaleOf(mode), n = s.length;
  const oct = Math.floor(k / n);
  return pcOf(root) + 12 * oct + s[k - oct * n];
};

// The index of `midi` on that line. A note that is not in the key (the key
// changed under it, or semitone moves left it between two) counts as the
// scale note just below it, so the next move up lands on the key's next note
// above — nothing is ever pushed further off the scale.
export const scaleIndexOf = (midi, root, mode) => {
  const s = scaleOf(mode), n = s.length;
  const rel = Math.round(midi) - pcOf(root);
  const oct = Math.floor(rel / 12);
  const pc = rel - 12 * oct;
  let i = 0;
  for (let j = 0; j < n; j++) if (s[j] <= pc) i = j;
  return oct * n + i;
};

// Move `midi` by `steps` — scale steps in the key, or semitones.
export function stepPitch(midi, steps, unit, key) {
  if (unit === 'semitone') return foldRange(Math.round(midi) + steps);
  const k = scaleIndexOf(midi, key.root, key.mode) + steps;
  return foldRange(midiAtIndex(k, key.root, key.mode));
}

// How far an interval of `size` moves, in `unit`s: a second is one scale
// step (a unison none), while a size in semitones is itself.
export const stepsFor = (size, unit) => (unit === 'semitone' ? size : size - 1);

// ── Direction from the lean ───────────────────────────────────────────────
//
// Upright is up; tipped past TILT_AT towards your left is down. Hysteresis so
// a hand resting at the edge does not flip direction on every jitter — the
// move is only read on a trigger, but the readout shows it continuously and
// should not flicker.
export const TILT_AT = 0.35;      // ≈ 32° off vertical
export const TILT_HYST = 0.08;
export const directionFrom = (tilt, prev = 1, at = TILT_AT) => {
  const t = Number(tilt) || 0;
  if (prev < 0) return t < -(at - TILT_HYST) ? -1 : 1;
  return t < -(at + TILT_HYST) ? -1 : 1;
};

// ── What the hands ask for ────────────────────────────────────────────────
//
// Each hand reads as one of:
//   { kind: 'step', size, dir }   an interval shape
//   { kind: 'sustain' }           the sustain shape
//   { kind: 'silence' }           the silence shape
//   { kind: 'none' }              no shape this mode knows
//
// and a trigger turns what they ask for together into one action:
//   any interval   → move by the SUM of them, and strike
//   else sustain   → leave whatever is ringing (or not) alone
//   else           → silence.
// So a resting fist on the idle hand never cancels the other hand's move, and
// only a fist (or nothing) on EVERY hand stops the sound.
export function planMove(readings, unit = 'scale') {
  const steps = readings.filter(r => r?.kind === 'step');
  if (steps.length) {
    return { action: 'step', steps: steps.reduce((s, r) => s + r.dir * stepsFor(r.size, unit), 0) };
  }
  if (readings.some(r => r?.kind === 'sustain')) return { action: 'sustain' };
  return { action: 'silence' };
}

// The same, for the 'change' trigger, where only the hands whose shape just
// CHANGED act: a shape already held has already moved. `changed` are those
// hands' new readings, `all` every hand's.
export function planOnChange(changed, all, unit = 'scale') {
  const steps = changed.filter(r => r?.kind === 'step');
  if (steps.length) return planMove(steps, unit);
  if (changed.some(r => r?.kind === 'silence')) return { action: 'silence' };
  // A hand relaxing (to nothing, or to sustain) stops the note only once no
  // hand is still holding something that means "keep playing".
  if (all.some(r => r?.kind === 'step' || r?.kind === 'sustain')) return { action: 'sustain' };
  return { action: 'silence' };
}

const sameReading = (a, b) => a?.kind === b?.kind && a?.size === b?.size;

export const interval = (() => {
  let enabled = false;
  let hands = 'one';
  let hand = 'R';             // one-handed: the hand that plays
  let trigger = 'beat';
  let unit = 'scale';
  let assigned = { ...DEFAULT_GESTURES };

  let midi = null;            // where the melody is; null = not started (home)
  let sounding = false;
  let last = null;            // { steps, readings } of the last move, for the readout
  let pendingStep = false;    // the STEP input fired since the last tick
  let dirs = { L: 1, R: 1 };  // per-hand latched lean direction
  let prevReadings = { L: null, R: null };

  // Build the key the same way the other modes do: gesture mode owns it, and
  // it follows Pitch Quantize when that is on.
  const key = () => chordmode.effectiveKey();
  const home = () => foldRange(rootMidi(key().root, key().octave));
  const here = () => (midi === null ? home() : midi);

  const sizeOf = id => {
    if (!id) return null;
    for (const n of SIZES) if (assigned[n] === id) return n;
    return null;
  };

  const tiltOf = side => bus.signals.get(`hand_${side}_tilt`)?.value ?? 0;
  const dirOf = side => {
    if (hands === 'two') return side === 'R' ? 1 : -1;
    dirs[side] = directionFrom(tiltOf(side), dirs[side]);
    return dirs[side];
  };

  // Only a HAND's own shape counts — a face or stance is not "the left hand".
  const readHand = side => {
    const id = gesture.handOnly(side);
    if (id === null) return { kind: 'none' };
    if (id === assigned.silence) return { kind: 'silence' };
    if (id === assigned.sustain) return { kind: 'sustain' };
    const size = sizeOf(id);
    return size ? { kind: 'step', size, dir: dirOf(side) } : { kind: 'none' };
  };
  const sides = () => (hands === 'two' ? ['L', 'R'] : [hand]);
  const readAll = () => Object.fromEntries(sides().map(s => [s, readHand(s)]));

  const silence = () => {
    if (!sounding) return;
    engine.releaseChord();
    arpvoice.release();
    sounding = false;
  };
  const strike = () => {
    if (arpvoice.enabled) {
      arpvoice.restart();
      engine.attackChord();
    } else {
      engine.setChordVoices([mtof(midi)]);
      engine.attackChord();
    }
    sounding = true;
  };
  arpvoice.onFlip(() => { sounding = false; });

  const act = (plan, readings) => {
    if (plan.action === 'silence') { silence(); return; }
    if (plan.action === 'sustain') return;
    midi = stepPitch(here(), plan.steps, unit, key());
    last = { steps: plan.steps, readings };
    strike();
  };

  return {
    get enabled() { return enabled; },
    setEnabled(on) {
      const next = !!on;
      if (next === enabled) return enabled;
      enabled = next;
      if (enabled) {
        // One instrument on the chord bank at a time.
        chordmode.setEnabled(false);
        radial.setEnabled(false);
        midi = null; last = null;
        prevReadings = { L: null, R: null };
        pendingStep = false;
      } else {
        silence();
      }
      return enabled;
    },

    config: () => ({ hands, hand, trigger, unit }),
    setHands(v) { if (INTERVAL_HANDS.includes(v)) { hands = v; prevReadings = { L: null, R: null }; } return hands; },
    setHand(v) { if (v === 'L' || v === 'R') { hand = v; prevReadings = { L: null, R: null }; } return hand; },
    setTrigger(v) { if (INTERVAL_TRIGGERS.includes(v)) { trigger = v; pendingStep = false; } return trigger; },
    setUnit(v) { if (INTERVAL_UNITS.includes(v)) unit = v; return unit; },

    // slot: a size 1..10, 'sustain' or 'silence'. One shape, one job: a shape
    // taken for this slot is freed from whichever other slot held it.
    gestures: () => ({ ...assigned }),
    setGesture(slot, id) {
      const s = String(slot);
      if (!SLOTS.includes(s)) return { ...assigned };
      const gid = isString(id) && id ? id : null;
      if (gid) for (const k of SLOTS) if (k !== s && assigned[k] === gid) assigned[k] = null;
      assigned[s] = gid;
      return { ...assigned };
    },

    // The STEP input: acted on at the next tick, so a button press and a cable
    // pulse go through the same read of the hands.
    step() { pendingStep = true; },
    // Back to the key's tonic. Silent — the next move starts from there.
    home() { silence(); midi = null; last = null; },

    tick() {
      if (!enabled) { silence(); return; }
      // Another mode took the bank (its own switch, a starter, a preset).
      if (chordmode.enabled || radial.enabled) { this.setEnabled(false); return; }
      if (sounding && arpvoice.enabled) arpvoice.run([mtof(midi)]);

      if (trigger === 'change') {
        const now = readAll();
        const changed = sides().filter(s => !sameReading(now[s], prevReadings[s]));
        prevReadings = now;
        if (!changed.length) return;
        act(planOnChange(changed.map(s => now[s]), Object.values(now), unit), now);
        return;
      }
      let fire = false;
      if (trigger === 'beat') {
        if (!metronome.on) { silence(); return; }
        fire = !!metronome.sampleThisFrame();
      } else {
        fire = pendingStep;
        pendingStep = false;
      }
      if (!fire) return;
      const now = readAll();
      act(planMove(Object.values(now), unit), now);
    },

    // ── Readouts ─────────────────────────────────────────────────────────
    sounding: () => sounding,
    note: () => here(),
    noteName: () => midiName(here()),
    // What each playing hand is showing right now, and the way it would move.
    live: () => readAll(),
    tilt: side => tiltOf(side),
    lastMove: () => (last ? { ...last } : null),
    sizeName: size => sizeName(size, unit),

    serialize: () => ({ enabled, hands, hand, trigger, unit, gestures: { ...assigned } }),
    // Off, with every setting as it ships — what a save can leave out.
    isDefault: () => !enabled && hands === 'one' && hand === 'R' && trigger === 'beat' && unit === 'scale'
      && SLOTS.every(s => assigned[s] === DEFAULT_GESTURES[s]),
    load(data) {
      if (!isRecord(data)) return;
      this.setEnabled(false);
      hands = INTERVAL_HANDS.includes(data.hands) ? data.hands : 'one';
      hand = data.hand === 'L' ? 'L' : 'R';
      trigger = INTERVAL_TRIGGERS.includes(data.trigger) ? data.trigger : 'beat';
      unit = INTERVAL_UNITS.includes(data.unit) ? data.unit : 'scale';
      assigned = { ...DEFAULT_GESTURES };
      if (isRecord(data.gestures)) {
        // Through setGesture, so a hand-edited save cannot give one shape two jobs.
        for (const s of SLOTS) if (s in data.gestures) this.setGesture(s, data.gestures[s]);
      }
      if (data.enabled) this.setEnabled(true);
    },
  };
})();
