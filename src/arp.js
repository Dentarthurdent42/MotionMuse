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

// A note may ring past its own step (gate above 1) but must be done before its
// voice comes around again: the engine round-robins four chord voices, so a
// tail longer than three steps would be cut mid-ring by the fourth-next note
// reclaiming the voice.
export const ARP_MAX_GATE = 3;

// How long a note sounds, with `gate` in steps: below 1 is staccato inside the
// step, 1 is wall-to-wall, above 1 lets each note ring under the ones that
// follow. Floored well above zero: a gate of 0.05 at 24 steps/second is 2 ms,
// which is a click, not a note.
export const noteSeconds = (step, gate) =>
  Math.max(0.02, step * Math.max(0, Math.min(ARP_MAX_GATE, Number(gate) || 0)));

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
