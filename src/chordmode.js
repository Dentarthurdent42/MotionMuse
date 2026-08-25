// Chord mode — maps recognized gestures to sustained chords. While enabled,
// holding an assigned gesture plays its chord through the engine's chord
// voice bank; dropping the gesture releases it (hold-to-sound).
//
// Chords are addressed by *scale degree in a key* (I…vii), not by absolute
// root pitch. Changing the key transposes every assignment at once, every
// chord is guaranteed to be in the key, and one degree select replaces the
// old root/octave/quality trio — which is what makes a long gesture list
// (e.g. the ASL numbers) manageable.

import { bus }                        from './bus.js';
import { engine }                     from './engine.js';
import { gesture, gestureLabel }      from './gesture.js';
import { diatonicChord, isDiatonic }  from './chords.js';
import { NOTE_NAMES }                 from './scale.js';
import { ARP_PATTERNS, ARP_MAX_OCTAVES, ARP_DEFAULTS,
         notePool, stepIndex, stepSeconds, noteSeconds, dueSteps } from './arp.js';

export const DEFAULT_KEY = {
  root: 'C',
  mode: 'major (ionian)',
  octave: 4,
  follow: true,        // take root/mode from Pitch Quantize when it's diatonic
};

// gestureId → degree 0..6. Starter assignments walking a familiar progression
// so the mode makes sound out of the box.
//
// The mapping is a BIJECTION and is enforced as one: a handshape drives exactly
// one thing, and a chord is driven by exactly one handshape. It used to be
// keyed the other way round with no uniqueness at all, so the same shape could
// be a chord *and* the release — which is not a configuration, it is a
// contradiction the tick loop had to break by fiat.
//
// Degree N is the ASL handshape for N: I is a 1, ii is a 2, up to vii° as a 7.
// The scale degrees are already numbered and the handshapes already are numbers
// — the previous set (fist, thumbs, horns…) made you memorise seven arbitrary
// pairings, when a mapping nobody has to learn was sitting right there.
//
// This is why `fist` is the RELEASE shape rather than a chord: ASL S is not a
// numeral, so it is the one classic shape the numbering does not claim.
const DEFAULT_ASSIGNMENTS = {
  point:  0,   // I    · ASL 1
  peace:  1,   // ii   · ASL 2
  asl3:   2,   // iii7 · ASL 3
  asl4:   3,   // IV   · ASL 4
  palm:   4,   // V7   · ASL 5
  asl6:   5,   // vi   · ASL 6
  asl7:   6,   // vii° · ASL 7
};

// Whether each degree adds its diatonic 7th. A property of the CHORD, not of
// the handshape that plays it — which is what the panel now says too, and why
// it survives unassigning the shape.
const DEFAULT_SEVENTHS = [false, false, true, false, true, false, false];

export const DEGREES = 7;

// ── Expression ────────────────────────────────────────────────────────────
//
// What makes the chord sound, once a handshape has said WHICH chord.
//
//   'gesture'  hold the shape, hear the chord; a release shape stops it. One
//              hand does everything, and the shape is doing two jobs.
//   'hand'     two-handed: one hand names the chord, the other's OPENNESS
//              plays it. The chord latches, so the naming hand can relax.
//   'brow'     one-handed: the hand names the chord, your eyebrows play it.
//
// and how that signal is read:
//
//   'gate'     past the threshold attacks, below it releases — the ADSR runs.
//   'volume'   the signal IS the level, continuously. There is no envelope to
//              run; you are the envelope.
//
// `lo`/`hi` map the raw signal onto 0..1 travel, and they matter more than
// they look. Hand openness does NOT reach 0 with a closed fist — it bottoms
// out near 0.38 — so feeding it straight in would mean the quietest thing you
// can do is "fairly loud", and silence would be unreachable. Mapping the range
// the signal actually occupies is what makes fully-off a place your hand can
// get to. `deadzone` then rounds the bottom of that travel down to true
// silence, so it does not need to be hit exactly.
export const EXPRESSION_MODES = ['gesture', 'hand', 'brow'];
export const EXPRESSION_CONTROLS = ['gate', 'volume'];

// Per-mode defaults for the raw range, measured from the signals themselves:
// hand openness runs ~0.38 (fist) to ~0.92 (open palm); browInnerUp rests near
// zero and a comfortable raise is about half scale, so asking for a full 1.0
// would mean straining.
export const EXPRESSION_RANGE = {
  hand: { lo: 0.42, hi: 0.90 },
  brow: { lo: 0.06, hi: 0.55 },
};

const DEFAULT_EXPRESSION = {
  mode: 'gesture',
  hand: 'L',        // the hand that EXPRESSES; the other names the chord
  control: 'gate',
  lo: EXPRESSION_RANGE.hand.lo,
  hi: EXPRESSION_RANGE.hand.hi,
  deadzone: 0.12,   // share of travel at the bottom that reads as silence
  trigger: 0.45,    // gate control: where along the travel it attacks
};

// Hysteresis on the gate, so a hand hovering at the threshold does not
// re-attack the chord several times a second.
const TRIGGER_HYST = 0.07;

// Old-format assignments stored an absolute { root, octave, quality }. Map the
// root onto the nearest degree of the current key so an existing user's setup
// keeps playing something recognisable instead of silently resetting.
export function degreeFromRoot(root, keyRoot, mode, quality) {
  const scale = isDiatonic(mode) ? mode : DEFAULT_KEY.mode;
  const want = ((NOTE_NAMES.indexOf(root) - NOTE_NAMES.indexOf(keyRoot)) % 12 + 12) % 12;
  let best = 0, bestD = 99;
  for (let i = 0; i < 7; i++) {
    const d = Math.abs(diatonicChord(keyRoot, 4, scale, i).root - want);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { degree: best, seventh: /7/.test(quality ?? '') };
}

const normDegree = d => Math.min(DEGREES - 1, Math.max(0, Math.round(Number(d) || 0)));

export const chordmode = (() => {
  // Gesture that releases a held chord. The closed fist: the numbering above
  // gives every ASL numeral to a degree, and ASL S is the one classic shape it
  // does not claim. Closing your hand to stop is also the obvious reading.
  // Still a setting, not a reservation: see tick().
  const DEFAULT_RELEASE_GESTURE = 'fist';
  let releaseGesture = DEFAULT_RELEASE_GESTURE;
  let enabled = false;
  let key = { ...DEFAULT_KEY };
  let assignments = { ...DEFAULT_ASSIGNMENTS };   // gestureId → degree
  let sevenths = [...DEFAULT_SEVENTHS];
  let playing = null;   // gestureId currently sounding
  let expr = { ...DEFAULT_EXPRESSION };
  let latched = null;   // chord handshape held over, in hand/brow modes
  let gateOpen = false; // gate control: is the envelope currently attacked
  let voiced = null;    // what the voice bank is currently pointed at
  let exprRaw = 0, exprLevel = 0;   // last read, for the panel's readout

  // ── Arpeggiator ─────────────────────────────────────────────────────────
  //
  // An alternative to sounding the chord as a block: the same chord, the same
  // gesture, the same expression — played one note at a time. It replaces the
  // block chord rather than layering over it, which is why it is a property of
  // chord mode and not a separate instrument.
  //
  // Rate and gate live in engine.PARAMS (`arp_rate`, `arp_gate`) so they can be
  // driven from the patchbay; pattern and octaves are discrete choices and live
  // here. The clock is the audio clock, read through engine.now(): rAF decides
  // when we look, never when a note sounds.
  let arp = { ...ARP_DEFAULTS };
  let arpClock = null;              // { at, i } while running; null when idle
  let arpSched = [];                // recently scheduled {at, idx}, for the panel

  // How far ahead steps are scheduled. Long enough that a dropped frame cannot
  // leave a hole in the pulse (a 60 Hz frame is 17 ms), short enough that a
  // chord change is heard on the next step rather than the one after it.
  const ARP_HORIZON = 0.12;

  const arpRate = () => engine.PARAMS.arp_rate?.val ?? 4;
  const arpGate = () => engine.PARAMS.arp_gate?.val ?? 0.55;

  // Hand the voices back and forget the clock. Stopping the clock alone is not
  // enough: the arp schedules into the future, so notes are already queued.
  const stopArp = () => {
    if (!arpClock && !arpSched.length) return;
    arpClock = null;
    arpSched = [];
    engine.silenceChordVoices?.();
  };

  // Start the run from the top of the pattern on the next look.
  const restartArp = () => { arpClock = null; arpSched = []; };

  // Schedule whatever is due. `level` is 1 in the envelope-driven modes: there
  // the ADSR on the shared gain already owns loudness, and a second multiplier
  // here would only fight it.
  const runArp = (freqs, level = 1) => {
    if (!engine.started) return;
    const pool = notePool(freqs, arp.octaves);
    if (!pool.length) return;
    const now = engine.now();
    if (!arpClock) arpClock = { at: now, i: 0 };
    const rate = arpRate();
    const { steps, state } = dueSteps(arpClock, now, ARP_HORIZON, rate);
    arpClock = state;
    if (!steps.length) return;
    const dur = noteSeconds(stepSeconds(rate), arpGate());
    for (const s of steps) {
      const idx = stepIndex(s.i, pool.length, arp.pattern);
      engine.arpNote({ freq: pool[idx], when: s.at, dur, gain: level });
      arpSched.push({ at: s.at, idx });
    }
    // Only the recent past is interesting, and this runs every frame.
    if (arpSched.length > 24) arpSched = arpSched.slice(-12);
  };

  // Raw signal → 0..1 travel, with the bottom rounded down to silence.
  const readExpression = () => {
    const key = expr.mode === 'brow' ? 'brow_raise' : `hand_${expr.hand}_open`;
    exprRaw = bus.signals.get(key)?.value ?? 0;
    const span = Math.max(0.01, expr.hi - expr.lo);
    const t = Math.max(0, Math.min(1, (exprRaw - expr.lo) / span));
    exprLevel = t <= expr.deadzone ? 0 : (t - expr.deadzone) / (1 - expr.deadzone);
    return exprLevel;
  };

  // Which hand names the chord: the one that is not expressing. In brow mode
  // both hands are free to, since the eyebrows are doing the expressing.
  const chordHand = () => (expr.hand === 'L' ? 'R' : 'L');

  // The key actually used to build chords. With `follow` on, Pitch Quantize
  // drives it so chords land in the same key the melody snaps to — but only
  // when that scale has seven notes; roman numerals are meaningless over a
  // pentatonic or whole-tone scale, so those fall back to the panel's own mode.
  const effectiveKey = () => {
    if (!key.follow) return { root: key.root, mode: key.mode, octave: key.octave };
    const t = engine.getTuning?.() ?? {};
    return {
      root:   t.enabled ? (t.root ?? key.root) : key.root,
      mode:   t.enabled && isDiatonic(t.scale) ? t.scale : key.mode,
      octave: key.octave,
    };
  };

  const chordAt = degree => {
    const k = effectiveKey();
    const d = normDegree(degree);
    return diatonicChord(k.root, k.octave, k.mode, d, sevenths[d]);
  };
  const chordFor = id => {
    const d = assignments[id];
    return d === undefined ? null : chordAt(d);
  };
  const gestureFor = degree =>
    Object.keys(assignments).find(id => assignments[id] === normDegree(degree)) ?? null;

  return {
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) { engine.releaseChord(); stopArp(); playing = null; latched = null; gateOpen = false; voiced = null; }
    },

    key: () => ({ ...key }),
    effectiveKey,
    // True only when Pitch Quantize is actually overriding the panel's key —
    // with quantise off, FOLLOW is armed but inert, so the manual selects stay
    // live rather than being greyed out for no reason.
    isFollowing: () => !!key.follow && !!engine.getTuning?.().enabled,
    setKey(partial) {
      key = { ...key, ...partial };
      if (playing) this._sound(playing, { restart: false });      // live-transpose a held chord
    },

    assignments: () => ({ ...assignments }),
    sevenths: () => sevenths.slice(),
    chordFor,
    chordAt,
    gestureFor,

    // Put a handshape on a chord. Every write goes through here, so the
    // bijection cannot be broken.
    //
    // The shape that was on this chord SWAPS into the one the newcomer just
    // left, rather than being dropped. Dropping it is the obvious reading of
    // "one shape, one job" and it is worse to use: moving Peace from V to ii
    // would silently leave V unplayable and Thumbs Up doing nothing, so a
    // two-second rearrangement costs you an assignment you have to notice and
    // put back. A swap keeps the count and is what the gesture of dragging one
    // onto another already means. With nothing to swap into — the newcomer was
    // unassigned, or was the release shape — the displaced one does go free.
    setDegreeGesture(degree, gestureId) {
      const d = normDegree(degree);
      const prev = gestureFor(d);
      const from = gestureId ? assignments[gestureId] : undefined;
      if (prev) delete assignments[prev];
      if (gestureId) {
        if (releaseGesture === gestureId) releaseGesture = null;   // it cannot be both
        assignments[gestureId] = d;
        if (prev && prev !== gestureId && from !== undefined) assignments[prev] = from;
      }
      // A held chord may have just changed hands, or stopped existing.
      if (playing && assignments[playing] === undefined) { engine.releaseChord(); stopArp(); playing = null; }
      else if (playing) this._sound(playing, { restart: false });
    },

    setSeventh(degree, on) {
      const d = normDegree(degree);
      sevenths[d] = !!on;
      const id = gestureFor(d);
      if (id && playing === id) this._sound(id, { restart: false });               // live-update a held chord
    },

    unassign(gestureId) {
      delete assignments[gestureId];
      if (playing === gestureId) { engine.releaseChord(); stopArp(); playing = null; }
    },

    // Human-readable "gesture → chord" for the live readout ('' when silent).
    currentLabel() {
      const c = playing && chordFor(playing);
      if (!c) return '';
      const g = gesture.list().find(x => x.id === playing);
      return `${g ? gestureLabel(g) : playing} → ${c.numeral} · ${c.rootName} ${c.quality}`;
    },

    // The chord sounding right now, for anything that wants to DRAW it rather
    // than name it (the fullscreen keyboard overlay). Null when nothing is held.
    currentChord() { return playing ? chordFor(playing) : null; },

    // `restart: false` for a chord that is already sounding and has merely
    // been transposed or re-voiced — the arpeggio should carry on in time
    // rather than jumping back to the root, which would be heard as a stumble
    // every time the key select moves.
    _sound(id, { restart = true } = {}) {
      const c = chordFor(id);
      if (!c) return;
      if (!arp.enabled) { engine.playChord(c.freqs); return; }
      if (restart) restartArp();
      engine.attackChord();
    },

    tick() {
      // Deliberately NOT gated on engine.started: every engine call below is a
      // no-op until the context exists, and gating the whole state machine on
      // it meant the recognition and expression logic could only be exercised
      // with real audio. The engine starts with the page anyway, so this costs
      // a few bus reads in the window before it does.
      //
      // No longer gated on dev mode either: chord mode is a way of playing the
      // instrument, not an experiment, and hiding it behind DEV meant the one
      // starting point that needs no wiring was the one nobody could find.
      if (!enabled) {
        if (playing) { engine.releaseChord(); stopArp(); playing = null; }
        return;
      }
      if (expr.mode !== 'gesture') return this._tickExpressed();

      const held = gesture.current();

      // A dedicated release gesture: hold it and the chord lets go, so a chord
      // can be cut deliberately rather than only by dropping the gesture that
      // started it — which matters once the release is long enough to hear.
      //
      // Checked first, but the assignment writers now guarantee the release
      // shape carries no chord, so this is a belt-and-braces ordering rather
      // than a rule that resolves a real conflict.
      if (releaseGesture && held.includes(releaseGesture)) {
        if (playing) { engine.releaseChord(); stopArp(); playing = null; }
        return;
      }

      // First currently-held gesture that has a chord assigned wins.
      // `!== undefined`, not truthy: degree 0 is the tonic.
      const id = held.find(g => assignments[g] !== undefined) ?? null;
      if (id !== playing) {
        if (id) this._sound(id);
        else { engine.releaseChord(); stopArp(); }
        playing = id;
      }
      // A block chord is set up once and sustains itself; an arpeggio has to be
      // fed. This is why the early-out above became a branch — the state may be
      // unchanged and there can still be notes owed.
      if (playing && arp.enabled) runArp(chordFor(playing)?.freqs);
    },

    // hand / brow modes. The handshape names the chord and LATCHES — dropping
    // it does not stop the sound, because the sound is not what it controls.
    // That separation is the point: one hand chooses, the other plays.
    _tickExpressed() {
      const named = expr.mode === 'brow'
        ? (gesture.activeOn('R') ?? gesture.activeOn('L'))
        : gesture.activeOn(chordHand());
      if (named !== null && assignments[named] !== undefined && named !== latched) {
        latched = named;
        voiced = null;                 // the new chord has not been sounded yet
      }
      const level = readExpression();
      playing = latched;
      if (!latched) return;

      if (expr.control === 'volume') {
        engine.setChordLevel(level);
        gateOpen = level > 0;
        if (arp.enabled) {
          // The hand owns loudness on the shared gain and the arp owns rhythm
          // underneath it, so the notes go out at full voice level. Silence is
          // a real state here, not a quiet one: at zero the run stops and
          // restarts from the root when the hand opens again.
          if (level > 0) runArp(chordFor(latched)?.freqs);
          else stopArp();
          voiced = null;         // block-chord voicing is stale while the arp drives
          return;
        }
        // Only re-point the voices when the chord actually changes. Ramping
        // four oscillator frequencies every frame is the same never-settling
        // glide that made continuous volume unplayable in the first place.
        const sig = `${latched}|${assignments[latched]}|${sevenths[assignments[latched]]}|${JSON.stringify(effectiveKey())}`;
        if (sig !== voiced) { engine.setChordVoices(chordFor(latched)?.freqs); voiced = sig; }
        return;
      }
      // Gate: one attack on the way up, one release on the way down, with a
      // band between them so a hand resting near the threshold does not
      // machine-gun the envelope.
      const on = gateOpen ? level > expr.trigger - TRIGGER_HYST
                          : level > expr.trigger + TRIGGER_HYST;
      // A chord swapped while the gate is already open re-attacks on the new
      // one, which is what playing a progression through a held note means.
      const changed = on && gateOpen && voiced !== latched;
      if (on !== gateOpen || changed) {
        gateOpen = on;
        // A swap mid-gate is one chord becoming another under a hand that never
        // let go, so the arpeggio carries on in time; a fresh attack starts the
        // pattern at the root.
        if (on) { this._sound(latched, { restart: !changed }); voiced = latched; }
        else { engine.releaseChord(); stopArp(); voiced = null; }
      }
      if (gateOpen && arp.enabled) runArp(chordFor(latched)?.freqs);
    },

    // Which degree is sounding, or -1 — for the row indicators. `playing` is a
    // gesture id; the panel lists chords, so it needs the degree.
    soundingDegree() {
      if (!playing) return -1;
      const d = assignments[playing];
      return d === undefined ? -1 : d;
    },
    // Is the release shape being held right now (gesture mode only).
    releaseHeld() {
      return expr.mode === 'gesture' && !!releaseGesture
        && gesture.current().includes(releaseGesture);
    },
    // The chord's real loudness, straight off the audio graph — not the input
    // signal, which differs from it whenever an envelope is in between.
    chordLevel: () => engine.chordLevel?.() ?? 0,

    arpState: () => ({ ...arp }),
    // Which note of the pool is sounding, or -1. Steps are scheduled ahead of
    // the audio clock, so "the last one scheduled" is the wrong answer by up to
    // a step — this reports the last one that has actually started, which is
    // what a player watching the panel is hearing.
    arpSounding() {
      if (!arp.enabled || !arpClock) return -1;
      const t = engine.now?.() ?? 0;
      let idx = -1;
      for (const s of arpSched) if (s.at <= t) idx = s.idx;
      return idx;
    },
    // How many notes the current chord gives the pattern to walk, so the panel
    // can say "3 of 6" rather than leaving the octave setting abstract.
    arpPoolSize() {
      const c = playing ? chordFor(playing) : (latched ? chordFor(latched) : null);
      return notePool(c?.freqs ?? [], arp.octaves).length;
    },
    setArp(partial) {
      const next = { ...arp, ...partial };
      next.enabled = !!next.enabled;
      if (!ARP_PATTERNS.includes(next.pattern)) next.pattern = ARP_DEFAULTS.pattern;
      const o = Math.round(Number(next.octaves));
      next.octaves = Number.isFinite(o) ? Math.max(1, Math.min(ARP_MAX_OCTAVES, o)) : 1;
      const flipped = next.enabled !== arp.enabled;
      arp = next;
      // Block chord and arpeggio are two owners of the same voice gains, so a
      // switch hands them over cleanly instead of leaving whatever the other
      // one last scheduled ringing under the new one.
      if (flipped) {
        stopArp();
        engine.releaseChord();
        voiced = null;
        gateOpen = false;
      }
      return { ...arp };
    },

    expression: () => ({ ...expr }),
    // Live values for the panel's meter — the only way to see whether your
    // range actually reaches both ends without guessing.
    expressionLevel: () => ({ raw: exprRaw, level: exprLevel, gateOpen, latched }),
    setExpression(partial) {
      const next = { ...expr, ...partial };
      if (!EXPRESSION_MODES.includes(next.mode)) next.mode = 'gesture';
      if (!EXPRESSION_CONTROLS.includes(next.control)) next.control = 'gate';
      next.hand = next.hand === 'R' ? 'R' : 'L';
      // Changing mode re-seeds the range: a span measured for hand openness is
      // meaningless for eyebrows, and leaving it would make the new mode look
      // broken. An explicit lo/hi in the same call still wins.
      if (partial.mode && partial.mode !== expr.mode && EXPRESSION_RANGE[partial.mode]) {
        Object.assign(next, EXPRESSION_RANGE[partial.mode], partial);
      }
      for (const k of ['lo', 'hi', 'deadzone', 'trigger']) {
        const v = Number(next[k]);
        next[k] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : DEFAULT_EXPRESSION[k];
      }
      if (next.hi <= next.lo) next.hi = Math.min(1, next.lo + 0.05);
      expr = next;
      // Leaving an expressed chord ringing after switching away from it would
      // be a note nothing can now stop.
      engine.releaseChord();
      latched = null; gateOpen = false; playing = null; voiced = null;
      return { ...expr };
    },

    getReleaseGesture() { return releaseGesture; },
    // Taking a shape for the release takes it off whatever chord it played —
    // the same bijection, from the other side.
    setReleaseGesture(id) {
      releaseGesture = id || null;
      if (releaseGesture) this.unassign(releaseGesture);
      return releaseGesture;
    },

    serialize() {
      return { enabled, key: { ...key }, assignments: { ...assignments },
               sevenths: sevenths.slice(), releaseGesture, expression: { ...expr },
               arp: { ...arp } };
    },

    load(data) {
      if (!data) return;
      key = { ...DEFAULT_KEY, ...data.key };
      sevenths = Array.isArray(data.sevenths)
        ? Array.from({ length: DEGREES }, (_, i) => !!data.sevenths[i])
        : [...DEFAULT_SEVENTHS];

      if (data.assignments) {
        // Merge over the defaults rather than replacing them, so gestures added
        // in a later version still arrive with a chord for existing users.
        const merged = { ...DEFAULT_ASSIGNMENTS };
        for (const [id, a] of Object.entries(data.assignments)) {
          if (Number.isFinite(a)) { merged[id] = normDegree(a); continue; }
          // Older formats: { degree, seventh } and, older still, an absolute
          // { root, octave, quality }. The 7th moves from the handshape to the
          // chord it plays, which is where it now lives.
          const conv = a && a.degree === undefined && a.root !== undefined
            ? degreeFromRoot(a.root, key.root, key.mode, a.quality)
            : { degree: normDegree(a?.degree), seventh: !!a?.seventh };
          merged[id] = conv.degree;
          if (!Array.isArray(data.sevenths) && conv.seventh) sevenths[conv.degree] = true;
        }
        assignments = merged;
      }
      if (data.releaseGesture !== undefined) releaseGesture = data.releaseGesture || null;
      // Absent in setups saved before expression existed, which were all
      // gesture-driven — so the default is the old behaviour exactly.
      this.setExpression({ ...DEFAULT_EXPRESSION, ...data.expression });
      // Absent in setups saved before the arpeggiator existed, which all played
      // block chords — so the default is off, and the old behaviour exactly.
      this.setArp({ ...ARP_DEFAULTS, ...data.arp });

      // Enforce the bijection on the way in. Loaded data predates it — the same
      // shape could be a chord and the release, and two shapes could share a
      // degree — and leaving that to the tick loop is what produced a panel
      // that showed one thing and played another. First writer of a degree
      // wins; the release shape always gives up its chord.
      // What the user SAVED outranks what we merged in underneath it. Plain key
      // order would decide it instead, and that is not a rule — it is an
      // accident: a saved gesture that happens to be a default key updates in
      // place and wins, while a genuinely new one is appended last and loses
      // the chord it was saved with. Same file, different outcome depending on
      // which shape you picked.
      const loaded = new Set(Object.keys(data.assignments ?? {}));
      const byPrecedence = Object.keys(assignments)
        .sort((a, b) => (loaded.has(b) ? 1 : 0) - (loaded.has(a) ? 1 : 0));
      const seen = new Set();
      for (const id of byPrecedence) {
        const d = assignments[id];
        if (id === releaseGesture || seen.has(d)) delete assignments[id];
        else seen.add(d);
      }
      this.setEnabled(!!data.enabled);
    },
  };
})();
