// The instrument's ONE arpeggiator.
//
// It used to live inside gesture mode, which made it a property of one way of
// playing — and the moment radial mode wanted runs too, the choice was two
// arpeggiators or none. Two is redundant on its face (nothing plays both
// modes at once; they park each other), so the state and the transport moved
// here: pattern, octaves and the step clock are the instrument's, and
// whichever mode currently owns the chord bank feeds it chords. The pure
// musical decisions stay in arp.js; engine.PARAMS keeps `arp_rate` and
// `arp_gate` as patchbay outputs, exactly as before.
//
// SYNC ties the rate to the metronome instead of the free-running `arp_rate`:
// a steps-per-beat division, taking effect only while the metronome is ON —
// a sync setting that silently froze the rate with the clock stopped would
// read as a broken arpeggiator, so with the clock off the free rate stands.

import { engine }    from './engine.js';
import { metronome } from './metronome.js';
import { ARP_DEFAULTS, ARP_PATTERNS, ARP_MAX_OCTAVES,
         notePool, stepIndex, stepSeconds, noteSeconds, dueSteps } from './arp.js';

// Steps per metronome beat, 0 = free (use arp_rate). Whole subdivisions only:
// the point of syncing is landing ON the grid the click is sounding.
export const ARP_SYNCS = [0, 1, 2, 3, 4];

export const arpvoice = (() => {
  let arp = { ...ARP_DEFAULTS, sync: 0 };
  let clock = null;               // { at, i } while running; null when idle
  let sched = [];                 // recently scheduled {at, idx}, for the panel

  // How far ahead steps are scheduled. Long enough that a dropped frame cannot
  // leave a hole in the pulse, short enough that a chord change is heard on
  // the next step rather than the one after it.
  const HORIZON = 0.12;

  const rate = () => {
    if (arp.sync > 0 && metronome.on) return (metronome.config().bpm / 60) * arp.sync;
    return engine.PARAMS.arp_rate?.val ?? 4;
  };
  const gate = () => engine.PARAMS.arp_gate?.val ?? 0.55;

  // The play modes each keep private chord state (an open gate, a voiced
  // signature) that an arp flip invalidates; they register here rather than
  // this module knowing either of them by name.
  const flipHandlers = new Set();

  return {
    get enabled() { return arp.enabled; },
    state: () => ({ ...arp }),

    set(partial) {
      const next = { ...arp, ...partial };
      next.enabled = !!next.enabled;
      if (!ARP_PATTERNS.includes(next.pattern)) next.pattern = ARP_DEFAULTS.pattern;
      const o = Math.round(Number(next.octaves));
      next.octaves = Number.isFinite(o) ? Math.max(1, Math.min(ARP_MAX_OCTAVES, o)) : 1;
      next.sync = ARP_SYNCS.includes(Number(next.sync)) ? Number(next.sync) : 0;
      const flipped = next.enabled !== arp.enabled;
      arp = next;
      // Block chord and arpeggio are two owners of the same voice gains, so a
      // switch hands them over cleanly instead of leaving whatever the other
      // one last scheduled ringing under the new one.
      if (flipped) {
        this.stop();
        engine.releaseChord();
        flipHandlers.forEach(fn => fn(arp.enabled));
      }
      return { ...arp };
    },
    onFlip(fn) { flipHandlers.add(fn); },

    // Hand the voices back and forget the clock. Stopping the clock alone is
    // not enough: the arp schedules into the future, so notes are already queued.
    stop() {
      if (!clock && !sched.length) return;
      clock = null;
      sched = [];
      engine.silenceChordVoices?.();
    },

    // Start the run from the top of the pattern on the next look.
    restart() { clock = null; sched = []; },

    // Schedule whatever is due. `level` is 1 in the envelope-driven modes:
    // there the ADSR on the shared gain already owns loudness, and a second
    // multiplier here would only fight it.
    run(freqs, level = 1) {
      if (!engine.started) return;
      const pool = notePool(freqs, arp.octaves);
      if (!pool.length) return;
      const now = engine.now();
      if (!clock) clock = { at: now, i: 0 };
      const r = rate();
      const { steps, state } = dueSteps(clock, now, HORIZON, r);
      clock = state;
      if (!steps.length) return;
      const dur = noteSeconds(stepSeconds(r), gate());
      for (const s of steps) {
        const idx = stepIndex(s.i, pool.length, arp.pattern);
        engine.arpNote({ freq: pool[idx], when: s.at, dur, gain: level });
        sched.push({ at: s.at, idx });
      }
      // Only the recent past is interesting, and this runs every frame.
      if (sched.length > 24) sched = sched.slice(-12);
    },

    // Which note of the pool is sounding, or -1. Steps are scheduled ahead of
    // the audio clock, so "the last one scheduled" is the wrong answer by up
    // to a step — this reports the last one that has actually started, which
    // is what a player watching the panel is hearing.
    sounding() {
      if (!arp.enabled || !clock) return -1;
      const t = engine.now?.() ?? 0;
      let idx = -1;
      for (const s of sched) if (s.at <= t) idx = s.idx;
      return idx;
    },

    serialize: () => ({ ...arp }),
    load(d) { this.set({ ...ARP_DEFAULTS, sync: 0, ...d }); },
  };
})();
