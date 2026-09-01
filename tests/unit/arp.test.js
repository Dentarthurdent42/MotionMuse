// The arpeggiator's musical decisions, none of which need an AudioContext:
// which note a step plays, how many notes there are to choose from, and how
// the step clock behaves when the frame loop that drives it stops and starts.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARP_PATTERNS, ARP_MAX_OCTAVES, ARP_MAX_GATE, ARP_MAX_RING,
         ARP_MAX_SUSTAIN, notePool, stepIndex,
         stepSeconds, noteSeconds, noteEnvelope, dueSteps } from '../../src/arp.js';

// The first `len` steps of a pattern over `n` notes, as a plain array — the
// shape a player would hum back.
const run = (n, pattern, len, rnd) =>
  Array.from({ length: len }, (_, i) => stepIndex(i, n, pattern, rnd));

// ── Pattern order ────────────────────────────────────────────────────────

test('up walks the pool and wraps', () => {
  assert.deepEqual(run(3, 'up', 7), [0, 1, 2, 0, 1, 2, 0]);
});

test('down starts at the top', () => {
  assert.deepEqual(run(3, 'down', 7), [2, 1, 0, 2, 1, 0, 2]);
});

// The bug this pins: concatenating an up-run with a down-run repeats both
// endpoints (0 1 2 2 1 0 0 …), which is heard as a stumble twice a cycle.
// Reflection is what makes the turn sound like a turn.
test('updown reflects at the ends rather than repeating them', () => {
  assert.deepEqual(run(3, 'updown', 8), [0, 1, 2, 1, 0, 1, 2, 1]);
});

test('downup is updown from the other end, and also does not repeat', () => {
  assert.deepEqual(run(3, 'downup', 8), [2, 1, 0, 1, 2, 1, 0, 1]);
});

test('a four-note chord reflects over its full span', () => {
  assert.deepEqual(run(4, 'updown', 6), [0, 1, 2, 3, 2, 1]);
});

test('every pattern is a no-op on a one-note pool', () => {
  for (const p of ARP_PATTERNS) {
    assert.deepEqual(run(1, p, 4), [0, 0, 0, 0], p);
  }
});

test('every pattern stays inside the pool', () => {
  for (const p of ARP_PATTERNS) {
    for (const n of [2, 3, 4, 5, 12]) {
      for (const i of run(n, p, 60, () => 0.999999)) {
        assert.ok(i >= 0 && i < n, `${p}/${n} produced ${i}`);
      }
    }
  }
});

// A generator that returns exactly 1 is legal by the Math.random contract's
// letter in some engines' edge cases; indexing past the end here would be a
// silent undefined frequency inside the audio scheduler.
test('random cannot index past the end', () => {
  assert.equal(stepIndex(0, 4, 'random', () => 1), 3);
  assert.equal(stepIndex(0, 4, 'random', () => 0), 0);
});

test('an unknown pattern falls back to up rather than breaking', () => {
  assert.deepEqual(run(3, 'sideways', 4), [0, 1, 2, 0]);
});

// ── The note pool ────────────────────────────────────────────────────────

test('one octave is the chord itself', () => {
  assert.deepEqual(notePool([100, 200, 300], 1), [100, 200, 300]);
});

test('extra octaves double, in order', () => {
  assert.deepEqual(notePool([100, 125], 3), [100, 125, 200, 250, 400, 500]);
});

test('the octave count is clamped, not trusted', () => {
  assert.equal(notePool([100], 99).length, ARP_MAX_OCTAVES);
  assert.equal(notePool([100], 0).length, 1);
  assert.equal(notePool([100], -4).length, 1);
});

test('no chord means no notes', () => {
  assert.deepEqual(notePool([], 2), []);
  assert.deepEqual(notePool(null, 2), []);
});

// ── Step timing ──────────────────────────────────────────────────────────

test('rate is steps per second', () => {
  assert.equal(stepSeconds(4), 0.25);
  assert.equal(stepSeconds(0.5), 2);
});

test('a nonsense rate cannot become an infinite or negative step', () => {
  assert.equal(stepSeconds(0), 10);
  assert.equal(stepSeconds(-5), 10);
  assert.equal(stepSeconds(NaN), 10);
});

test('gate is the note length in steps, floored above a click', () => {
  assert.equal(noteSeconds(0.25, 0.5), 0.125);
  assert.equal(noteSeconds(0.25, 1), 0.25);
  assert.equal(noteSeconds(0.25, 2), 0.5);       // rings past its own step
  assert.equal(noteSeconds(0.04, 0.05), 0.02);   // 2 ms would be a click
});

// The engine round-robins four chord voices, so a note has to be done before
// the fourth-next step reclaims its voice — that is what ARP_MAX_GATE holds.
test('a note never outlasts the voice-recycle horizon', () => {
  assert.ok(ARP_MAX_GATE < 4);
  for (const rate of [0.5, 4, 11, 24]) {
    const step = stepSeconds(rate);
    assert.ok(noteSeconds(step, 99) <= ARP_MAX_GATE * step + 1e-9, `rate ${rate}`);
  }
});

// ── The step clock ───────────────────────────────────────────────────────

test('a fresh clock schedules the steps inside the horizon', () => {
  const { steps, state } = dueSteps({ at: 10, i: 0 }, 10, 0.3, 4);   // 0.25s steps
  assert.deepEqual(steps.map(s => s.i), [0, 1]);
  assert.deepEqual(steps.map(s => s.at), [10, 10.25]);
  assert.equal(state.i, 2);
  assert.equal(state.at, 10.5);
});

test('a step already scheduled is not scheduled twice', () => {
  let st = { at: 10, i: 0 };
  ({ state: st } = dueSteps(st, 10, 0.3, 4));
  const { steps } = dueSteps(st, 10.01, 0.3, 4);
  assert.deepEqual(steps.map(s => s.i), []);      // 10.5 is still past the horizon
});

test('the clock advances one step at a time as now moves', () => {
  let st = { at: 100, i: 0 }, got = [];
  for (let t = 100; t < 101; t += 1 / 60) {
    const r = dueSteps(st, t, 0.12, 4);
    st = r.state;
    got.push(...r.steps.map(s => s.i));
  }
  assert.deepEqual(got, [0, 1, 2, 3, 4]);         // 1 second at 4 steps/s
});

// The bug this pins: rAF stops in a backgrounded tab. Coming back two minutes
// later, a clock that insisted on catching up would owe 480 steps and fire the
// whole burst into one frame — a noise, not an arpeggio.
test('a clock left far behind resyncs instead of firing a burst', () => {
  const { steps, state } = dueSteps({ at: 10, i: 0 }, 130, 0.12, 4);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].at, 130);
  assert.equal(state.i, 1);
});

test('a clock only slightly behind keeps its place, so the pulse holds', () => {
  // A dropped frame, not a gap. The late step is still played, and — the part
  // that matters — it keeps its place on the original grid rather than being
  // dragged to `now`, which would shift the beat permanently every time a
  // frame is missed.
  const { steps } = dueSteps({ at: 10, i: 7 }, 10.2, 0.12, 4);
  assert.equal(steps[0].i, 7);
  assert.equal(steps[0].at, 10);                  // its proper time, not "now"
  assert.deepEqual(steps.map(s => s.at), [10, 10.25]);
});

test('the burst is bounded even with an absurd horizon', () => {
  const { steps } = dueSteps({ at: 0, i: 0 }, 0, 3600, 24);
  assert.ok(steps.length <= 16, `got ${steps.length}`);
});


// ── Sustain: the tail a gate cannot give ──
//
// Reported as "the arpeggiator is too staccato by default". It was, at every
// setting: the engine cut each note dead at its gate with a fade of at most
// 90 ms, so however long a note was held it ended square. SUSTAIN is the ring
// AFTER the gate, and the two share one budget — see ARP_MAX_RING.
test('sustain rings on after the gate closes', () => {
  const { hold, tail } = noteEnvelope(0.25, 1, 0.5);
  assert.equal(hold, 0.25, 'the gate is unchanged by a tail');
  assert.equal(tail, 0.125, 'and the tail is half a step on top');
});

test('both are in steps, so the shape survives a tempo change', () => {
  const slow = noteEnvelope(0.5, 0.9, 0.6);
  const fast = noteEnvelope(0.05, 0.9, 0.6);
  assert.ok(Math.abs(slow.tail / slow.hold - fast.tail / fast.hold) < 1e-9,
    'the ratio of tail to hold is the same at 2/s and 20/s');
});

test('no sustain is the old behaviour — a note that ends at its gate', () => {
  assert.equal(noteEnvelope(0.25, 0.55, 0).tail, 0);
  assert.equal(noteEnvelope(0.25, 0.55).tail, 0, 'and omitting it entirely');
});

test('gate and tail share one budget, so a voice is never cut mid-ring', () => {
  // The engine round-robins four chord voices; a note alive past ARP_MAX_RING
  // steps would be silenced by the fourth-next note taking its voice back.
  for (const step of [0.04, 0.25, 2]) {
    for (const gate of [0.05, 0.5, 1, 2, ARP_MAX_GATE, 99]) {
      for (const sustain of [0, 0.5, 1, ARP_MAX_SUSTAIN, 99]) {
        const { hold, tail } = noteEnvelope(step, gate, sustain);
        assert.ok(hold + tail <= ARP_MAX_RING * step + 1e-9,
          `step ${step} gate ${gate} sustain ${sustain} → ${hold + tail}`);
        assert.ok(tail >= 0, 'a tail is never negative');
      }
    }
  }
});

test('a gate that eats the whole budget leaves no tail, rather than overrunning', () => {
  assert.equal(noteEnvelope(0.25, ARP_MAX_RING, 1).tail, 0);
});

test('junk sustain reads as none', () => {
  for (const bad of [NaN, undefined, null, 'x', -1])
    assert.equal(noteEnvelope(0.25, 1, bad).tail, 0, String(bad));
});
