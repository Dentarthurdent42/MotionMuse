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
// SYNC ties the run to the metronome instead of the free-running `arp_rate`,
// and it is the DEFAULT (two steps per beat — eighth notes, the division an
// arpeggiator is usually reaching for). It does two things, because rate
// alone is not sync: the steps take their tempo from the clock's BPM, AND
// the run is phase-locked, its first step landing on the next division of
// the beat rather than wherever the chord happened to be struck. An arp at
// exactly the right speed but a semiquaver off the grid still sounds like
// two musicians who have not met.
//
// Sync takes effect only while the metronome is ON: a setting that silently
// froze the rate with the clock stopped would read as a broken arpeggiator,
// so with the clock off the RATE slider stands, unchanged.

import { engine }    from './engine.js';
import { metronome } from './metronome.js';
import { ARP_DEFAULTS, ARP_PATTERNS, ARP_MAX_OCTAVES,
         notePool, stepIndex, stepSeconds, noteEnvelope, noteSpans,
         noteLevelAt, dueSteps } from './arp.js';

// Steps per metronome beat, 0 = free (use arp_rate). Whole subdivisions only:
// the point of syncing is landing ON the grid the click is sounding.
export const ARP_SYNCS = [0, 1, 2, 3, 4];
// Eighth notes: fast enough to read as an arpeggio rather than a chord
// spelled out, slow enough that a seventh chord's four notes still fit
// inside a bar.
export const ARP_SYNC_DEFAULT = 2;

export const arpvoice = (() => {
  let arp = { ...ARP_DEFAULTS, sync: ARP_SYNC_DEFAULT };
  let clock = null;               // { at, i } while running; null when idle
  // Recently scheduled notes: {at, idx, freq, spans}. `freq` and `spans` ride
  // along rather than being re-derived, because both can move under a note
  // that is already sounding — the pool changes with the chord, the envelope
  // with the gate, sustain or rate. A note is drawn the way it was PLAYED.
  let sched = [];
  // Notes still ringing after the chord was let go: release() hands the voices
  // to the engine's chord release, and the display has to follow them down
  // rather than going blank while the room is still sounding.
  let fading = null;              // { at, secs, notes: [freq] }
  let voicedSig = null;           // the chord the queued steps were planned for

  // How far ahead steps are scheduled. Long enough that a dropped frame cannot
  // leave a hole in the pulse, short enough that a chord change is heard on
  // the next step rather than the one after it.
  const HORIZON = 0.12;

  const synced = () => arp.sync > 0 && metronome.on;
  const rate = () => {
    if (synced()) return (metronome.config().bpm / 60) * arp.sync;
    return engine.PARAMS.arp_rate?.val ?? 4;
  };

  // How far the metronome is into the CURRENT step, 0..1 — what a starting
  // run has to wait out to land on the grid rather than beside it. Null when
  // there is no clock to lock to. The metronome advances on the frame clock
  // and the arp schedules on the audio clock, so this is at most one frame
  // stale (~16 ms, well under a step); every re-articulation re-aligns, so
  // the two cannot drift apart over a phrase.
  const stepPhase = () => {
    const v = metronome.view();
    if (!v) return null;
    return (v.phase * arp.sync) % 1;
  };
  const gate = () => engine.PARAMS.arp_gate?.val ?? 0.9;
  const sustain = () => engine.PARAMS.arp_sustain?.val ?? 0.6;

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
    //
    // This is the HARD stop, for a chord handing these voices to another owner
    // — anything left ringing would sound under the new one. A player letting
    // go of a chord is the other case; see release().
    stop() {
      if (!clock && !sched.length) return;
      clock = null;
      sched = [];
      fading = null;          // a cut leaves nothing ringing to draw
      voicedSig = null;
      engine.silenceChordVoices?.();
    },

    // The chord is over and nothing is replacing it, so what is already
    // sounding should fall with it. Same bookkeeping as stop(); the difference
    // is entirely in what happens to the sound — notes that have not started
    // are dropped (they belong to a chord that has ended), and the one still
    // ringing fades over the chord's release instead of being cut in 30 ms.
    //
    // Cutting it was audible before and is more so now: a note has a sustain
    // tail, and chopping the release threw exactly that away. Letting go of a
    // chord sounded like switching it off.
    release() {
      if (!clock && !sched.length) return;
      // Whatever is audible at this instant carries on falling, over the
      // chord's own release — so hand it to `fading` before dropping the
      // schedule, or the keyboard would go blank while the room is still
      // sounding. That is the same lie as showing every chord note at once,
      // just at the other end of the note.
      const live = this.voices();
      const secs = engine.getChordEnv?.().release ?? 0;
      fading = live.length && secs > 0
        ? { at: engine.now?.() ?? 0, secs, notes: live.map(v => ({ freq: v.freq, from: v.level })) }
        : null;
      clock = null;
      sched = [];
      voicedSig = null;
      engine.releaseChordVoices?.();
    },

    // Start the run from the top of the pattern on the next look — and drop
    // whatever is still queued, for the same reason stop() does: the notes
    // sitting in the horizon belong to the chord that just ended, and they
    // would sound over the top of the one replacing them.
    restart() {
      if (sched.some(s => s.at > (engine.now?.() ?? 0))) engine.silenceChordVoices?.();
      clock = null;
      sched = [];
      fading = null;
      voicedSig = null;
    },

    // Schedule whatever is due. `level` is 1 in the envelope-driven modes:
    // there the ADSR on the shared gain already owns loudness, and a second
    // multiplier here would only fight it.
    run(freqs, level = 1) {
      if (!engine.started) return;
      const pool = notePool(freqs, arp.octaves);
      if (!pool.length) return;
      const now = engine.now();
      const r = rate();

      // A chord change invalidates what is already queued. The scheduler runs
      // a horizon ahead, so at the moment the chord changes the OLD chord's
      // next notes are already sitting in the NEW chord's time — heard as the
      // last note of one chord overlapping the first note of the next, and
      // most obviously when the steps line up with the beat, because then the
      // two land on the very same division. Drop the queued notes and rewind
      // the clock to the first step that has not sounded yet, so the new
      // chord takes those steps instead.
      //
      // The pattern's POSITION is kept: a chord swapped under a held gate is
      // meant to carry on in time. Restarting from the root is restart()'s
      // job, and the modes call it when they mean it.
      const sig = pool.join(',');
      if (sig !== voicedSig) {
        voicedSig = sig;
        const queued = sched.filter(s => s.at > now);
        if (clock && queued.length) {
          engine.silenceChordVoices?.();
          clock = { at: Math.min(...queued.map(s => s.at)), i: clock.i - queued.length };
          sched = sched.filter(s => s.at <= now);
        }
      }
      if (!clock) {
        // Phase-lock the first step onto the metronome's grid when synced;
        // start immediately when free, which is where the clock has always
        // started. `(1 - p) % 1` so a run struck exactly on the beat waits
        // zero rather than a whole step.
        const p = synced() ? stepPhase() : null;
        const wait = p === null ? 0 : ((1 - p) % 1) * stepSeconds(r);
        clock = { at: now + wait, i: 0 };
      }
      const { steps, state } = dueSteps(clock, now, HORIZON, r);
      clock = state;
      if (!steps.length) return;
      const { hold, tail } = noteEnvelope(stepSeconds(r), gate(), sustain());
      const spans = noteSpans(hold, tail);
      for (const s of steps) {
        const idx = stepIndex(s.i, pool.length, arp.pattern);
        engine.arpNote({ freq: pool[idx], when: s.at, dur: hold, tail, gain: level });
        // The envelope is stored WITH the note: gate, sustain and rate are all
        // live patchbay outputs, so the one in force now is not necessarily the
        // one this note was struck under.
        sched.push({ at: s.at, idx, freq: pool[idx], spans });
      }
      fading = null;          // the run is sounding again; nothing is falling
      // Only the recent past is interesting, and this runs every frame.
      if (sched.length > 24) sched = sched.slice(-12);
    },

    // What is AUDIBLE right now, note by note, with how loud each is (0..1).
    //
    // The keyboard overlay used to be handed the whole chord whenever a chord
    // was held, which is true of a block chord and a lie about an arpeggio:
    // an arp sounds one note at a time, and the display claimed all four were
    // down for as long as you held the gesture. Reading the schedule instead
    // shows what the run is doing — a note struck, held for its gate, falling
    // through its tail, gone — because these are the same numbers the engine
    // scheduled the gain from (see noteSpans in arp.js).
    //
    // Notes still in the future are not "pressed" yet and are left out: the
    // scheduler runs a horizon ahead, so half of `sched` has not happened.
    voices() {
      const t = engine.now?.() ?? 0;
      // After the chord is let go the run is over, and what is left is the
      // engine's release carrying the last notes down.
      if (fading) {
        const k = 1 - (t - fading.at) / fading.secs;
        if (k <= 0) return [];
        return fading.notes.map(n => ({ freq: n.freq, level: n.from * k }));
      }
      if (!arp.enabled) return [];
      const live = new Map();     // freq → loudest level, so a repeat wins
      for (const s of sched) {
        const lvl = noteLevelAt(t - s.at, s.spans);
        if (lvl > 0) live.set(s.freq, Math.max(live.get(s.freq) ?? 0, lvl));
      }
      return [...live].map(([freq, level]) => ({ freq, level }));
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

    // What the run is actually doing, for the panel readout and for tests:
    // the live step rate, and how long a run starting now would wait to land
    // on the metronome's grid (0 when free-running).
    stepsPerSecond: () => rate(),
    gridWait() {
      const p = synced() ? stepPhase() : null;
      return p === null ? 0 : ((1 - p) % 1) * stepSeconds(rate());
    },

    serialize: () => ({ ...arp }),
    load(d) { this.set({ ...ARP_DEFAULTS, sync: ARP_SYNC_DEFAULT, ...d }); },
  };
})();
