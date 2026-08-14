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
import { devmode }                    from './devmode.js';

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
// `palm` is absent because it is the default RELEASE shape. IV moves to `asl4`
// (four fingers up) rather than being dropped: losing the subdominant from the
// default set would be a musical regression, not a tidy-up.
const DEFAULT_ASSIGNMENTS = {
  fist:   0,   // I
  thumbs: 1,   // ii
  horns:  2,   // iii7
  asl4:   3,   // IV
  peace:  4,   // V7
  point:  5,   // vi
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
  // Gesture that releases a held chord. Defaults to the open palm — the
  // natural "let go" shape — but is a setting, not a reservation: see tick().
  const DEFAULT_RELEASE_GESTURE = 'palm';
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
      if (!enabled) { engine.releaseChord(); playing = null; latched = null; gateOpen = false; voiced = null; }
    },

    key: () => ({ ...key }),
    effectiveKey,
    // True only when Pitch Quantize is actually overriding the panel's key —
    // with quantise off, FOLLOW is armed but inert, so the manual selects stay
    // live rather than being greyed out for no reason.
    isFollowing: () => !!key.follow && !!engine.getTuning?.().enabled,
    setKey(partial) {
      key = { ...key, ...partial };
      if (playing) this._sound(playing);      // live-transpose a held chord
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
      if (playing && assignments[playing] === undefined) { engine.releaseChord(); playing = null; }
      else if (playing) this._sound(playing);
    },

    setSeventh(degree, on) {
      const d = normDegree(degree);
      sevenths[d] = !!on;
      const id = gestureFor(d);
      if (id && playing === id) this._sound(id);               // live-update a held chord
    },

    unassign(gestureId) {
      delete assignments[gestureId];
      if (playing === gestureId) { engine.releaseChord(); playing = null; }
    },

    // Human-readable "gesture → chord" for the live readout ('' when silent).
    currentLabel() {
      const c = playing && chordFor(playing);
      if (!c) return '';
      const g = gesture.list().find(x => x.id === playing);
      return `${g ? gestureLabel(g) : playing} → ${c.numeral} · ${c.rootName} ${c.quality}`;
    },

    _sound(id) {
      const c = chordFor(id);
      if (c) engine.playChord(c.freqs);
    },

    tick() {
      // Chord mode is an under-construction feature — only active in dev mode.
      //
      // Deliberately NOT gated on engine.started: every engine call below is a
      // no-op until the context exists, and gating the whole state machine on
      // it meant the recognition and expression logic could only be exercised
      // with real audio. The engine starts with the page anyway, so this costs
      // a few bus reads in the window before it does.
      if (!enabled || !devmode.enabled) {
        if (playing) { engine.releaseChord(); playing = null; }
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
        if (playing) { engine.releaseChord(); playing = null; }
        return;
      }

      // First currently-held gesture that has a chord assigned wins.
      // `!== undefined`, not truthy: degree 0 is the tonic.
      const id = held.find(g => assignments[g] !== undefined) ?? null;
      if (id === playing) return;
      if (id) this._sound(id);
      else engine.releaseChord();
      playing = id;
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
        // Only re-point the voices when the chord actually changes. Ramping
        // four oscillator frequencies every frame is the same never-settling
        // glide that made continuous volume unplayable in the first place.
        const sig = `${latched}|${assignments[latched]}|${sevenths[assignments[latched]]}|${JSON.stringify(effectiveKey())}`;
        if (sig !== voiced) { engine.setChordVoices(chordFor(latched)?.freqs); voiced = sig; }
        engine.setChordLevel(level);
        gateOpen = level > 0;
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
      if (on === gateOpen && !changed) return;
      gateOpen = on;
      if (on) { this._sound(latched); voiced = latched; }
      else { engine.releaseChord(); voiced = null; }
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
               sevenths: sevenths.slice(), releaseGesture, expression: { ...expr } };
    },

    load(data) {
      if (!data) return;
      key = { ...DEFAULT_KEY, ...(data.key ?? {}) };
      sevenths = Array.isArray(data.sevenths)
        ? Array.from({ length: DEGREES }, (_, i) => !!data.sevenths[i])
        : [...DEFAULT_SEVENTHS];

      if (data.assignments) {
        // Merge over the defaults rather than replacing them, so gestures added
        // in a later version still arrive with a chord for existing users.
        const merged = { ...DEFAULT_ASSIGNMENTS };
        for (const [id, a] of Object.entries(data.assignments)) {
          if (typeof a === 'number') { merged[id] = normDegree(a); continue; }
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
      this.setExpression({ ...DEFAULT_EXPRESSION, ...(data.expression ?? {}) });

      // Enforce the bijection on the way in. Loaded data predates it — the same
      // shape could be a chord and the release, and two shapes could share a
      // degree — and leaving that to the tick loop is what produced a panel
      // that showed one thing and played another. First writer of a degree
      // wins; the release shape always gives up its chord.
      const seen = new Set();
      for (const id of Object.keys(assignments)) {
        const d = assignments[id];
        if (id === releaseGesture || seen.has(d)) delete assignments[id];
        else seen.add(d);
      }
      this.setEnabled(!!data.enabled);
    },
  };
})();
