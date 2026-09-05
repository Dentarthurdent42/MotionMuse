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
import { metronome }                  from './metronome.js';
import { gesture, gestureLabel }      from './gesture.js';
import { diatonicChord, diatonicNote, isDiatonic, isDegreeScale, degreeCountOf,
         NATURAL, SHARP, FLAT }       from './chords.js';
import { NOTE_NAMES }                 from './scale.js';
import { notePool }                   from './arp.js';
import { arpvoice }                   from './arpvoice.js';

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

// The MOST degrees any key offers — array sizes and the storage format. How
// many are LIVE depends on the key's scale: five over a pentatonic, seven over
// the diatonic modes (degreeCount() below). An assignment to a degree beyond
// the live count is dormant, not deleted — switch back to a 7-note mode and
// the shape plays its chord again.
export const DEGREES = 7;

// ── Voicing: what a degree sounds as ──────────────────────────────────────
//
// The same handshapes, the same key, the same expression — sounding either the
// whole chord on a degree or just that degree's own note. A voicing rather
// than a second mode with its own assignments, because "play the melody over
// what I was just comping" should not mean teaching the app the seven shapes
// again; every setting made for chords is already the right setting for notes.
//
// Seven shapes name seven degrees, which leaves the five notes between them
// out of reach — so the hand that is NOT naming the note says what to do to
// it: nothing, sharp, or flat. That is the whole chromatic scale from shapes
// you already know, and it is the off hand's only job, so it can say it at any
// time, including under a note that is already sounding.
export const VOICINGS = ['chord', 'note'];

// Thumb up for sharp, thumb down for flat: the two shapes whose everyday
// meaning is already "raise" and "lower", and neither is a numeral, so the
// degree shapes keep every ASL number to themselves.
//
// Both are classifier-backed rather than template-matched, and `thumbsdown`
// has no measured template at all — with MediaPipe's canned classifier off it
// cannot be recognized until someone records one. That is why these are
// settings and not constants.
export const DEFAULT_ACCIDENTAL_GESTURES = { sharp: 'thumbs', flat: 'thumbsdown' };

// ♯ / ♭ / nothing, for a readout.
export const accidentalSign = a => (a > 0 ? '♯' : a < 0 ? '♭' : '');

// ── Expression ────────────────────────────────────────────────────────────
//
// What makes the chord sound, once a handshape has said WHICH chord.
//
//   'gesture'  hold the shape, hear the chord; a release shape stops it. One
//              hand does everything, and the shape is doing two jobs.
//   'hand'     two-handed: one hand names the chord, the other's OPENNESS
//              plays it. The chord latches, so the naming hand can relax.
//   'brow'     one-handed: the hand names the chord, your eyebrows play it.
//   'beat'     the metronome plays it: the shape held when a SAMPLE beat
//              lands is struck then, and only then. Shapes changed between
//              beats cost nothing — the clock is the articulation, the hand
//              only chooses. Needs the metronome running; silent otherwise.
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
export const EXPRESSION_MODES = ['gesture', 'hand', 'brow', 'beat'];
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
  let voicing = 'chord';
  let accGestures = { ...DEFAULT_ACCIDENTAL_GESTURES };
  let playingAcc = NATURAL;   // accidental the sounding note was voiced with
  let latched = null;   // chord handshape held over, in hand/brow modes
  let latchedSide = null;     // which hand latched it — the OTHER one bends it
  let gateOpen = false; // gate control: is the envelope currently attacked
  let voiced = null;    // what the voice bank is currently pointed at
  let exprRaw = 0, exprLevel = 0;   // last read, for the panel's readout

  // ── Arpeggiator ─────────────────────────────────────────────────────────
  //
  // The arpeggiator is the INSTRUMENT's now, not gesture mode's — radial mode
  // runs the same one, and two arpeggiators for two modes that park each
  // other would be redundant on their face. State and transport live in
  // arpvoice.js; these aliases keep this file reading as it always did.
  const stopArp    = () => arpvoice.stop();
  const restartArp = () => arpvoice.restart();
  const runArp     = (freqs, level = 1) => arpvoice.run(freqs, level);
  // An arp flip invalidates this mode's private chord state (the flip itself
  // already released the chord and silenced the voices).
  arpvoice.onFlip(() => { voiced = null; gateOpen = false; });

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
  // drives it so chords land in the same key the melody snaps to — for any
  // scale the degree system can address (the 7-note modes and the
  // pentatonics). Blues and whole-tone still fall back to the panel's own
  // mode: their six degrees stack into clusters, not chords.
  const effectiveKey = () => {
    if (!key.follow) return { root: key.root, mode: key.mode, octave: key.octave };
    const t = engine.getTuning?.() ?? {};
    return {
      root:   t.enabled ? (t.root ?? key.root) : key.root,
      mode:   t.enabled && isDegreeScale(t.scale) ? t.scale : key.mode,
      octave: key.octave,
    };
  };

  // How many degrees the current key actually offers (5 or 7), and whether a
  // stored degree is one of them. A shape assigned to vi over a pentatonic is
  // DORMANT — it names nothing, plays nothing, and comes back with the mode.
  const degreeCount = () => degreeCountOf(effectiveKey().mode);
  const liveDegree = d => d !== undefined && d < degreeCount();

  const chordAt = degree => {
    const k = effectiveKey();
    const d = normDegree(degree);
    return diatonicChord(k.root, k.octave, k.mode, d, sevenths[d]);
  };
  const chordFor = id => {
    const d = assignments[id];
    return liveDegree(d) ? chordAt(d) : null;
  };
  const gestureFor = degree =>
    Object.keys(assignments).find(id => assignments[id] === normDegree(degree)) ?? null;

  // ── Notes and accidentals ───────────────────────────────────────────────

  const noteAt = (degree, accidental = NATURAL) => {
    const k = effectiveKey();
    return diatonicNote(k.root, k.octave, k.mode, normDegree(degree), accidental);
  };
  const noteFor = (id, accidental = NATURAL) => {
    const d = assignments[id];
    return liveDegree(d) ? noteAt(d, accidental) : null;
  };

  // What the voice bank should be pointed at for this handshape — the whole
  // chord, or the one note. The single place the voicing decides anything;
  // everything downstream just plays the frequencies it is given.
  const soundFreqs = (id, accidental = NATURAL) => {
    if (voicing !== 'note') return chordFor(id)?.freqs ?? null;
    const n = noteFor(id, accidental);
    return n ? [n.freq] : null;
  };

  // The accidental a hand is signalling, or NATURAL for any other shape —
  // including no shape at all, which is what makes "natural" the resting
  // state rather than a third thing to hold.
  const accidentalOn = side => {
    const held = gesture.activeOn(side);
    if (held === null) return NATURAL;
    if (held === accGestures.sharp) return SHARP;
    if (held === accGestures.flat) return FLAT;
    return NATURAL;
  };

  // Read from whichever hand is not naming the note. In 'hand' expression that
  // hand is already playing the note's loudness — asking it to hold a thumb as
  // well would be asking for a specific openness, i.e. a specific volume — so
  // there the accidental stays natural and the panel says so.
  const accidentalFor = namingSide => {
    if (voicing !== 'note' || namingSide === null) return NATURAL;
    if (expr.mode === 'hand') return NATURAL;
    return accidentalOn(namingSide === 'L' ? 'R' : 'L');
  };

  // The held shape that names a degree, and the hand holding it. Same L-then-R
  // precedence as gesture.current(), so which shape wins is unchanged — this
  // just also reports where it is, which is what the off hand is measured
  // against.
  const namedWithSide = () => {
    for (const side of ['L', 'R']) {
      const id = gesture.activeOn(side);
      if (id !== null && liveDegree(assignments[id])) return { id, side };
    }
    return null;
  };

  return {
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) {
        engine.releaseChord(); stopArp();
        playing = null; latched = null; latchedSide = null;
        gateOpen = false; voiced = null; playingAcc = NATURAL;
      }
    },

    key: () => ({ ...key }),
    effectiveKey,
    degreeCount,
    // True only when Pitch Quantize is actually overriding the panel's key —
    // with quantise off, FOLLOW is armed but inert, so the manual selects stay
    // live rather than being greyed out for no reason.
    isFollowing: () => !!key.follow && !!engine.getTuning?.().enabled,
    setKey(partial) {
      key = { ...key, ...partial };
      // A held chord live-transposes — unless the new mode has fewer degrees
      // and this one just went dormant, which is a release, not a null sound.
      if (playing && !liveDegree(assignments[playing])) {
        engine.releaseChord(); stopArp(); playing = null; playingAcc = NATURAL;
      } else if (playing) this._sound(playing, { restart: false });
    },

    assignments: () => ({ ...assignments }),
    sevenths: () => sevenths.slice(),
    chordFor,
    chordAt,
    gestureFor,
    noteAt,
    noteFor,

    // ── Voicing ───────────────────────────────────────────────────────────
    getVoicing: () => voicing,
    setVoicing(next) {
      const v = VOICINGS.includes(next) ? next : 'chord';
      if (v === voicing) return voicing;
      voicing = v;
      // A triad and a single note are two different sounds on the same four
      // voices, so the switch hands the bank over cleanly instead of leaving
      // the other one's notes ringing underneath.
      engine.releaseChord(); stopArp();
      playing = null; latched = null; latchedSide = null;
      gateOpen = false; voiced = null; playingAcc = NATURAL;
      return voicing;
    },

    accidentalGestures: () => ({ ...accGestures }),
    // One shape cannot mean both, or whichever were read second would be
    // unreachable. The shape just set wins and the other goes free — the same
    // rule the chord assignments use, for the same reason.
    setAccidentalGestures(partial) {
      const next = { ...accGestures, ...partial };
      for (const k of ['sharp', 'flat']) next[k] = next[k] || null;
      if (next.sharp && next.sharp === next.flat) {
        if (partial.sharp !== undefined) next.flat = null;
        else next.sharp = null;
      }
      accGestures = next;
      return { ...accGestures };
    },
    // What the off hand is saying right now, for the panel's indicator.
    currentAccidental() {
      if (voicing !== 'note') return NATURAL;
      if (playing) return playingAcc;
      if (latchedSide !== null) return accidentalFor(latchedSide);
      // Nothing is named yet, so neither hand is the off hand — report either
      // of them. The indicator's job before you commit to a note is to say
      // that the shape is being recognized at all, and which hand will end up
      // holding it is not decided until the other one names a degree.
      if (expr.mode === 'hand') return NATURAL;
      return accidentalOn('L') || accidentalOn('R');
    },

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
      if (!playing) return '';
      const g = gesture.list().find(x => x.id === playing);
      const who = g ? gestureLabel(g) : playing;
      if (voicing === 'note') {
        const n = noteFor(playing, playingAcc);
        return n ? `${who} → ${n.numeral}${accidentalSign(n.accidental)} · ${n.name}` : '';
      }
      const c = chordFor(playing);
      return c ? `${who} → ${c.numeral} · ${c.rootName} ${c.quality}` : '';
    },

    // What is sounding right now, for anything that wants to DRAW it rather
    // than name it (the fullscreen keyboard overlay). Null when nothing is
    // held. A single note reports as a one-note chord: the overlay lights the
    // keys it is given, and one is a legal number of keys.
    currentChord() {
      if (!playing) return null;
      if (voicing !== 'note') return chordFor(playing);
      const n = noteFor(playing, playingAcc);
      return n ? { ...n, midi: [n.midi], freqs: [n.freq], rootName: n.name, quality: 'note' } : null;
    },

    // `restart: false` for a chord that is already sounding and has merely
    // been transposed or re-voiced — the arpeggio should carry on in time
    // rather than jumping back to the root, which would be heard as a stumble
    // every time the key select moves.
    _sound(id, { restart = true, accidental = playingAcc } = {}) {
      const freqs = soundFreqs(id, accidental);
      if (!freqs) return;
      if (!arpvoice.enabled) { engine.playChord(freqs); return; }
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
      if (expr.mode === 'beat') return this._tickBeat();
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
      // `!== undefined`, not truthy: degree 0 is the tonic — which is why this
      // is resolved by namedWithSide rather than by scanning `held`.
      const named = namedWithSide();
      const id = named?.id ?? null;
      const acc = accidentalFor(named?.side ?? null);
      // In note voicing the accidental is part of WHICH note this is, so a
      // thumb turning over under a held shape is a new note and re-attacks. In
      // chord voicing it is always natural and this reads as it always did.
      if (id !== playing || acc !== playingAcc) {
        if (id) this._sound(id, { restart: id !== playing, accidental: acc });
        else { engine.releaseChord(); stopArp(); }
        playing = id;
        playingAcc = id ? acc : NATURAL;
      }
      // A block chord is set up once and sustains itself; an arpeggio has to be
      // fed. This is why the early-out above became a branch — the state may be
      // unchanged and there can still be notes owed.
      if (playing && arpvoice.enabled) runArp(soundFreqs(playing, playingAcc));
    },

    // 'beat' mode: the metronome is the articulation. On each SAMPLE beat the
    // currently-held shape is read and struck through the chord ADSR — the
    // same _sound() a handshape attack uses, arpeggiator included — and a
    // beat that finds no shape (or the release shape) is a rest, which
    // releases whatever the previous beat struck. Between beats nothing is
    // read at all: that is the feature, not an optimisation. With the
    // metronome off there is no clock to strike on, so the mode is silent —
    // the panel says so rather than leaving a mystery.
    _tickBeat() {
      if (!metronome.on) {
        if (playing) { engine.releaseChord(); stopArp(); playing = null; }
        return;
      }
      if (playing && arpvoice.enabled) runArp(soundFreqs(playing, playingAcc));
      const ev = metronome.sampleThisFrame();
      if (!ev) return;
      const named = namedWithSide();
      const id = named?.id ?? null;
      const acc = accidentalFor(named?.side ?? null);
      if (id !== null && liveDegree(assignments[id])) {
        this._sound(id, { restart: id !== playing, accidental: acc });
        playing = id;
        playingAcc = acc;
      } else if (playing) {
        engine.releaseChord(); stopArp(); playing = null;
      }
    },

    // hand / brow modes. The handshape names the chord and LATCHES — dropping
    // it does not stop the sound, because the sound is not what it controls.
    // That separation is the point: one hand chooses, the other plays.
    _tickExpressed() {
      // Which hand named it is remembered, not re-read: the shape latches, so
      // by the time the accidental matters the naming hand may have relaxed —
      // and the off hand is defined against the hand that CHOSE the note.
      let named = null, namedSide = null;
      if (expr.mode === 'brow') {
        for (const side of ['R', 'L']) {
          const id = gesture.activeOn(side);
          if (id !== null) { named = id; namedSide = side; break; }
        }
      } else {
        namedSide = chordHand();
        named = gesture.activeOn(namedSide);
      }
      // A key change can strand the latched shape on a degree the new mode no
      // longer has. That is a release: a latch pointing at nothing is not a
      // chord waiting to sound, it is a note nothing could ever stop.
      if (latched !== null && !liveDegree(assignments[latched])) {
        engine.releaseChord(); stopArp();
        latched = null; latchedSide = null; gateOpen = false; voiced = null;
      }
      if (named !== null && liveDegree(assignments[named]) && named !== latched) {
        latched = named;
        latchedSide = namedSide;
        voiced = null;                 // the new chord has not been sounded yet
      }
      const acc = accidentalFor(latchedSide);
      const level = readExpression();
      playing = latched;
      if (!latched) return;

      if (expr.control === 'volume') {
        engine.setChordLevel(level);
        gateOpen = level > 0;
        playingAcc = acc;
        if (arpvoice.enabled) {
          // The hand owns loudness on the shared gain and the arp owns rhythm
          // underneath it, so the notes go out at full voice level. Silence is
          // a real state here, not a quiet one: at zero the run stops and
          // restarts from the root when the hand opens again.
          if (level > 0) runArp(soundFreqs(latched, acc));
          else stopArp();
          voiced = null;         // block-chord voicing is stale while the arp drives
          return;
        }
        // Only re-point the voices when the chord actually changes. Ramping
        // four oscillator frequencies every frame is the same never-settling
        // glide that made continuous volume unplayable in the first place.
        // The accidental is in the signature because bending a note IS the
        // chord changing, and it is the one part of it the off hand can move
        // without touching the naming hand.
        const sig = `${latched}|${assignments[latched]}|${sevenths[assignments[latched]]}|${acc}|${JSON.stringify(effectiveKey())}`;
        if (sig !== voiced) { engine.setChordVoices(soundFreqs(latched, acc)); voiced = sig; }
        return;
      }
      // Gate: one attack on the way up, one release on the way down, with a
      // band between them so a hand resting near the threshold does not
      // machine-gun the envelope.
      const on = gateOpen ? level > expr.trigger - TRIGGER_HYST
                          : level > expr.trigger + TRIGGER_HYST;
      // A chord swapped while the gate is already open re-attacks on the new
      // one, which is what playing a progression through a held note means.
      // A note bent while the gate is open is the same swap as a chord changed
      // under a held hand, so it re-attacks on the new pitch rather than
      // waiting for the gate to close and open again.
      const changed = on && gateOpen && (voiced !== latched || playingAcc !== acc);
      if (on !== gateOpen || changed) {
        gateOpen = on;
        // A swap mid-gate is one chord becoming another under a hand that never
        // let go, so the arpeggio carries on in time; a fresh attack starts the
        // pattern at the root.
        if (on) {
          this._sound(latched, { restart: !changed, accidental: acc });
          voiced = latched;
          playingAcc = acc;
        }
        else { engine.releaseChord(); stopArp(); voiced = null; }
      }
      if (gateOpen && arpvoice.enabled) runArp(soundFreqs(latched, playingAcc));
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

    // The arpeggiator itself is shared (arpvoice.js); what stays HERE is the
    // one question only this mode can answer — which chord the pattern walks.
    // How many notes the current chord gives the pattern, so the panel can
    // say "3 of 6" rather than leaving the octave setting abstract.
    arpPoolSize() {
      const id = playing ?? latched;
      return notePool(id ? soundFreqs(id, playingAcc) ?? [] : [], arpvoice.state().octaves).length;
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
      latched = null; latchedSide = null;
      gateOpen = false; playing = null; voiced = null; playingAcc = NATURAL;
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
               voicing, accidentals: { ...accGestures } };
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
      // The arpeggiator is the instrument's now (arpvoice.js) and saves under
      // its own key; a chord blob saved while it lived here still carries it.
      if (data.arp) arpvoice.load(data.arp);
      // Same for the voicing: everything saved before single notes existed was
      // playing chords, which is what the default says.
      this.setVoicing(data.voicing ?? 'chord');
      this.setAccidentalGestures({ ...DEFAULT_ACCIDENTAL_GESTURES, ...data.accidentals });

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
