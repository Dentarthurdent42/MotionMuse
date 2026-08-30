// Arpeggiator — turns a held chord into a run of single notes.
//
// Everything here is pure: the pattern order, the note pool and the step
// clock are functions of their arguments, so the musically interesting part
// is testable without an AudioContext. chordmode.js owns the real clock and
// makes the engine calls; this file owns the decisions.
//
// The rate is steps per second, not BPM. There is no global tempo in this
// instrument to lock to, and as a plain number it can be an engine PARAM —
// which is what lets a hand drive the arp's speed the same way one drives the
// filter. `arp_rate` and `arp_gate` live in engine.js for exactly that reason.

export const ARP_PATTERNS = ['up', 'down', 'updown', 'downup', 'random'];

// Three is where it stops being a chord voicing and starts being a siren.
export const ARP_MAX_OCTAVES = 3;

export const ARP_DEFAULTS = { enabled: false, pattern: 'up', octaves: 1 };

const mod = (a, b) => ((a % b) + b) % b;

// The chord's notes, repeated up the octaves. Frequencies rather than MIDI
// because frequencies are what the voice bank takes, and doubling is exact.
export function notePool(freqs, octaves = 1) {
  if (!freqs?.length) return [];
  const n = Math.max(1, Math.min(ARP_MAX_OCTAVES, Math.round(Number(octaves)) || 1));
  const out = [];
  for (let o = 0; o < n; o++) for (const f of freqs) out.push(f * 2 ** o);
  return out;
}

// Which note of the pool step `i` plays, for an endless run.
//
// `updown` is the one with a real decision in it. The obvious reading — play
// up, then play down — sounds both endpoints twice (0 1 2 2 1 0 0 1 …), which
// lands as a limp on every turn. Reflecting instead of concatenating gives
// 0 1 2 1 0 1 2 …: a cycle of 2n-2 rather than 2n, and no repeated note.
export function stepIndex(i, n, pattern = 'up', rnd = Math.random) {
  if (n <= 1) return 0;
  const k = Math.floor(i);
  switch (pattern) {
    case 'down':   return n - 1 - mod(k, n);
    case 'updown': { const p = mod(k, 2 * n - 2); return p < n ? p : 2 * n - 2 - p; }
    case 'downup': { const p = mod(k, 2 * n - 2); return p < n ? n - 1 - p : p - n + 1; }
    // Bounded rather than trusted: a generator returning exactly 1 would index
    // past the end, and this runs inside the audio scheduler.
    case 'random': return Math.min(n - 1, Math.max(0, Math.floor(rnd() * n)));
    default:       return mod(k, n);
  }
}

export const stepSeconds = rate => 1 / Math.max(0.1, Number(rate) || 0.1);

// A note may ring past its own step, but must be done before its voice comes
// around again: the engine round-robins four chord voices, so a note alive for
// longer than three steps would be cut mid-ring by the fourth-next note
// reclaiming the voice.
//
// That budget covers the note's WHOLE life — the gate it is held for PLUS the
// tail it rings out over — which is why the two are clamped together below
// rather than each on its own.
export const ARP_MAX_RING = 3;
export const ARP_MAX_GATE = ARP_MAX_RING;
export const ARP_MAX_SUSTAIN = ARP_MAX_RING;

// How long a note is HELD, with `gate` in steps: below 1 is staccato inside the
// step, 1 is wall-to-wall, above 1 lets each note ring under the ones that
// follow. Floored well above zero: a gate of 0.05 at 24 steps/second is 2 ms,
// which is a click, not a note.
export const noteSeconds = (step, gate) =>
  Math.max(0.02, step * Math.max(0, Math.min(ARP_MAX_GATE, Number(gate) || 0)));

// The note's whole shape in seconds: how long it is held, and how long it
// rings out afterwards.
//
// SUSTAIN is the part a gate cannot express. Before it existed the engine cut
// every arp note at its gate with a fade of at most 90 ms, so the run was a
// procession of flat-topped blocks however long the gate was — the reason it
// read as staccato at any setting. A tail is what makes a note sound plucked
// or bowed rather than switched on and off.
//
// Both are in STEPS, so the shape holds when the tempo changes: an arpeggio
// that rings a half-step under the next note keeps doing that at 2/s and at
// 16/s. The tail takes whatever the gate leaves of the ring budget, so turning
// the gate up eats into it rather than pushing the note past the point where
// its own voice is reclaimed.
export function noteEnvelope(step, gate, sustain = 0) {
  const hold = noteSeconds(step, gate);
  const room = Math.max(0, ARP_MAX_RING * step - hold);
  const want = step * Math.max(0, Math.min(ARP_MAX_SUSTAIN, Number(sustain) || 0));
  return { hold, tail: Math.min(room, want) };
}

// ── The shape of one arp note ─────────────────────────────────────────────
//
// Stated ONCE, here, because two things need it and they must not disagree:
// engine.arpNote schedules its gain breakpoints from it, and the keyboard
// overlay draws each note's live loudness from it. A display that modelled
// the envelope separately would be a second opinion about the sound, and the
// first thing to go stale the next time the envelope changes.
export const ARP_ATTACK = 0.006;

// `dur` is the gate (noteEnvelope's `hold`), `tail` its ring.
// Returns the three spans of one note measured from its onset: the attack,
// the plateau's END, and the fall. With a tail the gate is held for all of `dur` and the fall happens
// after it; without one the fall has to happen INSIDE the gate, because the
// note still has to be over when the gate says it is.
export function noteSpans(dur, tail = 0) {
  const ring = Math.max(0, tail);
  const rel = ring > 0 ? ring : Math.min(0.09, dur * 0.5);
  const hold = ring > 0 ? Math.max(ARP_ATTACK, dur)
                        : Math.max(ARP_ATTACK, dur - rel);
  return { atk: ARP_ATTACK, hold, rel };
}

// Where that shape is, `age` seconds after the note was struck: 0 before it
// starts and after it has faded, 1 across the plateau, linear in between —
// the same piecewise line engine.arpNote asks the audio param for.
export function noteLevelAt(age, spans) {
  const { atk, hold, rel } = spans;
  if (age <= 0) return 0;
  if (age < atk) return age / atk;
  if (age < hold) return 1;
  if (age < hold + rel) return rel > 0 ? 1 - (age - hold) / rel : 0;
  return 0;
}

// Never schedule more than this in one pass. The catch-up rule below should
// make it unreachable; it is here because the alternative to a wrong number of
// notes is an unbounded loop inside a frame.
const MAX_BURST = 16;

/**
 * Advance the step clock and report which steps fall inside the window.
 *
 * Pure, so the timing can be tested without an audio clock: hand it a state
 * and a `now`, get back the steps to schedule and the state to keep.
 *
 * @param {{at: number, i: number}} state  next step's time and index
 * @param {number} now       audio-clock now, seconds
 * @param {number} horizon   how far ahead to schedule, seconds
 * @param {number} rate      steps per second
 */
export function dueSteps(state, now, horizon, rate) {
  const step = stepSeconds(rate);
  let { at, i } = state;
  // A backgrounded tab stops rAF, so `at` can come back minutes behind — and
  // every step in between would then fire at once, as a burst. Falling more
  // than one step behind is not a rhythm to catch up with, it is a gap: resync
  // to now and carry on in time.
  if (at < now - step) at = now;
  const steps = [];
  while (at < now + horizon && steps.length < MAX_BURST) {
    steps.push({ at, i });
    at += step;
    i++;
  }
  return { steps, state: { at, i } };
}
