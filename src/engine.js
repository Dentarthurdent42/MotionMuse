import { makeQuantizer } from './scale.js';
import { makeDynamics, EDGES, GATE_AT_DEFAULT } from './dynamics.js';

export const engine = (() => {
  let ctx, analyser, filt, oscVol, lfo, lfog,
      cfilt, chordVol, revb, revgain, drygain, maing, outg;
  let started = false;

  // Muted on launch, always. The engine now starts with the page so every
  // control is live from the first paint, and starting a synth that makes
  // noise at someone before they have asked for any would be hostile — on a
  // phone, in a shared room, most of all on a page they opened to read about.
  // Deliberately NOT persisted: "it was unmuted last time" is not consent to
  // make noise now, and the state is one keypress to change.
  let muted = true;

  // Chord voice bank (chord mode): 4 oscillators with per-voice gains into a
  // shared gain, feeding the same filter/reverb chain as the main oscillators.
  const CHORD_VOICES = 4;
  let chordOscs = [], chordVGains = [], chordGain = null, chordOn = false;

  // Chord ADSR. Seconds, except `sustain`, which is the fraction of peak the
  // note settles to while the gesture is held — the one ADSR value that is a
  // level and not a time, and the reason a chord can now fade to a bed under
  // the lead instead of sitting at full tilt until released.
  //
  // Held on the shared chordGain rather than per voice: the whole chord is one
  // note here (the voices are its intervals), so one envelope is what a player
  // means by "the chord's attack". Nothing else automates chordGain, which is
  // what makes cancelScheduledValues safe below — keep that invariant.
  const CHORD_ENV_MIN = 0.001;
  let chordEnv = { attack: 0.02, decay: 0.12, sustain: 0.7, release: 0.35 };

  // ── Oscillator bank ──────────────────────────────────────────────────
  // Dynamic: ONE oscillator by default, up to MAX_OSCS, each with its own
  // frequency, detune, waveform and level. It used to be exactly two, balanced
  // by a single `osc_mix` crossfade — which meant a single oscillator was not
  // expressible (mix could lean but the other voice was always in the graph)
  // and three were impossible. Per-oscillator level replaces the crossfade
  // outright; `osc_volume` remains the level of the whole bank, the lead's
  // counterpart to `chord_volume`.
  const MAX_OSCS = 8;
  // Starting pitch per slot: a harmonic series over 110 Hz, so slots 1 and 2
  // keep their old 220/330 defaults and an added one lands somewhere musical
  // rather than in unison with what is already sounding.
  const oscFreqDefault = i => 110 * (i + 2);
  const OSC_TYPE_CYCLE = ['sine', 'triangle', 'sawtooth', 'square'];
  // Added oscillators arrive at HALF level. Everything downstream — the volume
  // ladder's headroom, the reverb send, the master default — is tuned around
  // one voice at unity, and two unity sawtooths into it clip.
  const oscVolDefault = i => (i === 0 ? 1 : 0.5);

  let oscCount = 1;
  let oscs = [], oscGains = [];      // live nodes; length === oscCount once started
  // Waveform per slot, kept for every slot rather than only the live ones, so
  // shrinking the bank and growing it again brings back the timbre you chose
  // instead of resetting it.
  let oscTypes = Array.from({ length: MAX_OSCS }, (_, i) => OSC_TYPE_CYCLE[i % OSC_TYPE_CYCLE.length]);

  // Pitch quantisation: snap oscillator frequencies onto a scale + tuning.
  const OSC_KEY_RE = /^osc(\d+)_(freq|detune|volume)$/;
  const isFreqKey = k => /^osc\d+_freq$/.test(k);
  let tuning = { enabled: false, root: 'C', scale: 'chromatic', system: 'equal (12-TET)' };
  let quant  = makeQuantizer({ root: tuning.root, scale: tuning.scale, tuning: tuning.system });

  // Filter selections. Kept as state (not only on the live nodes) so they
  // survive save/load and a stop→start cycle.
  let filterType = 'lowpass', chordFilterType = 'lowpass';

  // Custom waveforms ('custom:<name>') for the sound kit — harmonic tables
  // registered up front, resolved to PeriodicWaves lazily per AudioContext.
  const waveSpecs = new Map();       // name → { real, imag } Float32Arrays
  let periodicCache = new Map();     // name → PeriodicWave (this ctx only)
  function defineWave(name, { real, imag }) {
    waveSpecs.set(name, {
      real: Float32Array.from(real ?? new Array(imag.length).fill(0)),
      imag: Float32Array.from(imag),
    });
  }
  function applyType(osc, type) {
    if (typeof type === 'string' && type.startsWith('custom:')) {
      const spec = waveSpecs.get(type.slice(7));
      if (!spec) { osc.type = 'sine'; return; }   // unknown name degrades safely
      let pw = periodicCache.get(type);
      if (!pw) { pw = ctx.createPeriodicWave(spec.real, spec.imag); periodicCache.set(type, pw); }
      osc.setPeriodicWave(pw);
    } else {
      osc.type = type;
    }
  }

  // Audio parameter definitions — name, display label, min, max, default value.
  // `snaps` marks musically meaningful values the slider magnetically detents
  // to when dragged near them (center detune, half volume, unity Q, …).
  const PARAMS = {};

  // Three params per oscillator slot, generated rather than written out: the
  // bank is resizable, so a hand-written list would cap it at whatever someone
  // last typed.
  const oscParamDefs = i => {
    const n = i + 1;
    return {
      [`osc${n}_freq`]:   { label: `Osc${n} Freq`,   min: 40,   max: 2000, val: oscFreqDefault(i), unit: 'Hz' },
      [`osc${n}_detune`]: { label: `Osc${n} Detune`, min: -100, max: 100,  val: 0, unit: '¢', snaps: [-50, 0, 50] },
      [`osc${n}_volume`]: { label: `Osc${n} Vol`,    min: 0,    max: 1,    val: oscVolDefault(i), snaps: [0.5] },
    };
  };

  // Everything downstream of the bank. Defined once: these exact objects become
  // the live PARAMS entries, so anything holding a reference (the volume
  // ladder's `snaps`, a cached slider ref) keeps working across a rebuild.
  const TAIL_DEFS = {
    filter_freq: { label: 'Filter Cutoff', min: 80,   max: 16000, val: 3000, unit: 'Hz' },
    filter_q:    { label: 'Filter Q',      min: 0.1,  max: 18,    val: 1,     snaps: [1] },
    osc_volume:  { label: 'Osc Vol',       min: 0,    max: 1,     val: 1,     snaps: [0.5] },
    // Chord mode has its own filter + level so the two sources can be shaped
    // independently (chords darker than the lead, lead quieter than the
    // chords, …). Defaults match the old shared chain exactly.
    chord_filter_freq: { label: 'Chord Cutoff', min: 80,  max: 16000, val: 3000, unit: 'Hz' },
    chord_filter_q:    { label: 'Chord Q',      min: 0.1, max: 18,    val: 1,    snaps: [1] },
    // Ceiling of 4, not 1. The chord bank is voiced well under the lead on
    // purpose — it was always a bed beneath it — but the bank can now be
    // emptied to play chords alone, and at unity that is a whisper: measured
    // -31 dBFS against a unity lead's -6. The extra 12 dB puts chord-only at
    // about -17 dBFS, a healthy standalone level. Deliberately NOT enough to
    // match the lead exactly, which would mean a ceiling of ~16 and squash
    // unity into the bottom 6% of the slider; the lead is the hot one, not the
    // chords the quiet one. Default and old behaviour are unchanged, and 1 is
    // a detent so unity is still where the thumb lands.
    chord_volume:      { label: 'Chord Vol',    min: 0,   max: 4,     val: 1,    snaps: [0.5, 1, 2] },
    lfo_rate:    { label: 'LFO Rate',      min: 0.05, max: 20,    val: 1,    unit: 'Hz' },
    lfo_depth:   { label: 'LFO Depth',     min: 0,    max: 1,     val: 0,     snaps: [0.5] },
    reverb_mix:  { label: 'Reverb Mix',    min: 0,    max: 1,     val: 0.12,  snaps: [0.25, 0.5] },
    volume:      { label: 'Main Vol',      min: 0,    max: 1,     val: 0.55,  snaps: [0.25, 0.5, 0.75] },
  };

  // Every oscillator param object ever built, by key. A slot's values outlive
  // its removal for the same reason its waveform does: shrinking the bank to
  // hear one voice and growing it back should return the sound you had, not
  // reset the slot you were mid-way through dialling in.
  const oscParamCache = {};

  // PARAMS is mutated in place, never reassigned: the mapper, the slider panel
  // and the tests all hold this exact object. Rebuilt end-to-end rather than
  // patched so the key ORDER stays canonical — deleting slot 2 and adding it
  // back would otherwise leave its rows sitting after Main Vol in the panel.
  // Entries are the same objects each time, so values and any live reference to
  // them (the volume ladder writes through `snaps`) survive a resize.
  function rebuildParams() {
    for (const k in PARAMS) delete PARAMS[k];
    for (let i = 0; i < oscCount; i++)
      for (const [k, def] of Object.entries(oscParamDefs(i)))
        PARAMS[k] = oscParamCache[k] ??= def;
    for (const [k, def] of Object.entries(TAIL_DEFS)) PARAMS[k] = def;
  }
  rebuildParams();

  // Volume articulation. Every other param re-schedules a 25 ms ramp on every
  // frame, which never settles — a permanent glide. That's fine for a filter
  // sweep and fatal for volume: it's why gesture-driven loudness smeared and
  // notes couldn't be re-attacked. Quantising the gain onto a dB ladder makes
  // changes rare, so here we fire ONE anchored envelope per level change and
  // let it complete. See src/dynamics.js.
  const VOL_SNAPS = PARAMS.volume.snaps;   // restored when stepping is off
  let volStep = { enabled: true, steps: 6, floorDb: -30, gate: true,
                  hysteresis: 0.3, edge: 'key', gateAt: GATE_AT_DEFAULT };
  let dyn = makeDynamics(volStep);
  let volIdx = null;    // rung currently scheduled on maing (null = unknown)
  let volEdges = 0;     // envelopes fired — observability, and what the tests assert on

  // Tick/detent positions for the volume slider: drop rungs closer together
  // than snapTo's 1.5%-of-range tolerance, or at -48 dB / 12 steps the bottom
  // rungs collapse into each other and the notches turn to mush.
  const tickLevels = levels => levels.filter((v, i, a) => v > 0 && (i === 0 || v - a[i - 1] >= 0.02));
  // Reflect the ladder on the slider from the very first paint — otherwise the
  // notches show the old hand-picked detents until something calls setVolStep.
  if (volStep.enabled) PARAMS.volume.snaps = tickLevels(dyn.levels);

  const makeImpulse = (ctx) => {
    const len = ctx.sampleRate * 1.8;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    return buf;
  };

  async function start() {
    ctx      = new AudioContext();
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024;

    periodicCache = new Map();               // PeriodicWaves are per-context
    filt  = ctx.createBiquadFilter(); filt.type = filterType;
    oscVol = ctx.createGain(); oscVol.gain.value = PARAMS.osc_volume.val;
    cfilt = ctx.createBiquadFilter(); cfilt.type = chordFilterType;
    chordVol = ctx.createGain(); chordVol.gain.value = PARAMS.chord_volume.val;
    lfo   = ctx.createOscillator(); lfo.type = 'sine';
    lfog  = ctx.createGain(); lfog.gain.value = 0;
    revb  = ctx.createConvolver(); revb.buffer = makeImpulse(ctx);
    revgain = ctx.createGain(); revgain.gain.value = PARAMS.reverb_mix.val;
    drygain = ctx.createGain(); drygain.gain.value = 1 - PARAMS.reverb_mix.val;
    maing   = ctx.createGain(); maing.gain.value = PARAMS.volume.val;
    // Mute sits AFTER the analyser (see the graph below), which is what lets
    // the visualiser keep drawing a live waveform while nothing is audible —
    // the difference between "muted" and "broken" made visible. It also keeps
    // mute completely clear of the volume ladder and its silence gate, which
    // live on maing and are measured at the analyser.
    outg    = ctx.createGain(); outg.gain.value = muted ? 0 : 1;

    // Apply stored param values
    filt.frequency.value  = PARAMS.filter_freq.val;
    filt.Q.value          = PARAMS.filter_q.val;
    cfilt.frequency.value = PARAMS.chord_filter_freq.val;
    cfilt.Q.value         = PARAMS.chord_filter_q.val;
    lfo.frequency.value   = PARAMS.lfo_rate.val;

    // Graph — the two sources get their own filter and level, then share the
    // reverb/main/mute tail, so each can be shaped without touching the other
    // while Main Vol (and its step ladder) still governs everything:
    //
    //   osc_i → oscGain_i ┐
    //                     ├→ filt  → oscVol   ┐
    //                     ┘                   ├→ [dry + reverb] → main → analyser → mute → out
    //   chords → cfilt → chordVol             ┘
    filt.connect(oscVol);
    oscVol.connect(drygain); oscVol.connect(revb);
    revb.connect(revgain);
    drygain.connect(maing); revgain.connect(maing);
    maing.connect(analyser); analyser.connect(outg); outg.connect(ctx.destination);

    // LFO → the *lead* filter's cutoff only. Chords deliberately keep a steady
    // filter — a wobble that suits a lead line turns sustained chords to mud;
    // map a signal to chord_filter_freq for movement there instead.
    lfo.connect(lfog); lfog.connect(filt.frequency);

    // Chord voice bank → shared gain (silent until playChord) → its own chain.
    chordGain = ctx.createGain(); chordGain.gain.value = 0;
    chordGain.connect(cfilt);
    cfilt.connect(chordVol);
    chordVol.connect(drygain); chordVol.connect(revb);
    chordOscs = []; chordVGains = []; chordOn = false;
    for (let i = 0; i < CHORD_VOICES; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      applyType(o, oscTypes[0]);
      o.frequency.value = 220;
      g.gain.value = 0;
      o.connect(g); g.connect(chordGain);
      chordOscs.push(o); chordVGains.push(g);
    }

    lfo.start();
    chordOscs.forEach(o => o.start());
    // The bank last, so `started` is already meaningful to addOsc() and the
    // node it builds reads its values from PARAMS like any other resize.
    started = true;
    oscs = []; oscGains = [];
    for (let i = 0; i < oscCount; i++) addOsc(i);
  }

  // One oscillator slot: node, its level gain, into the shared lead filter.
  function addOsc(i) {
    const n = i + 1;
    const o = ctx.createOscillator(), g = ctx.createGain();
    applyType(o, oscTypes[i]);
    o.frequency.value = PARAMS[`osc${n}_freq`].val;
    o.detune.value    = PARAMS[`osc${n}_detune`].val;
    g.gain.value      = PARAMS[`osc${n}_volume`].val;
    o.connect(g); g.connect(filt);
    o.start();
    oscs[i] = o; oscGains[i] = g;
  }

  // Drop every slot from `from` up. Stopped as well as disconnected: a running
  // OscillatorNode with no outputs is still a node the context keeps alive.
  function dropOscs(from) {
    for (let i = from; i < oscs.length; i++) {
      try { oscs[i].stop(); } catch { /* already stopped */ }
      oscs[i].disconnect();
      oscGains[i].disconnect();
    }
    oscs.length = Math.max(0, from);
    oscGains.length = Math.max(0, from);
  }

  // Resize the bank. Params are rebuilt either way; the live nodes only when
  // the engine is running, so this works before start() too (the panel is
  // interactive from the first paint).
  //
  // Zero is a legal size: chord mode has its own voice bank, filter and level,
  // so it is a complete instrument on its own, and leaving a lead oscillator
  // running under it is a drone nobody asked for. `|| 1` on the parse would
  // quietly turn 0 into 1, hence the explicit finite check.
  function setOscCount(n) {
    const v = Math.round(Number(n));
    const next = Number.isFinite(v) ? Math.max(0, Math.min(MAX_OSCS, v)) : oscCount;
    if (next === oscCount) return oscCount;
    const prev = oscCount;
    oscCount = next;
    rebuildParams();
    if (started) {
      if (next > prev) for (let i = prev; i < next; i++) addOsc(i);
      else dropOscs(next);
    }
    return oscCount;
  }
  const getOscCount = () => oscCount;

  function set(key, raw) {
    const p = PARAMS[key];
    if (!p) return;
    if (tuning.enabled && isFreqKey(key)) raw = quant.quantize(raw);
    if (volStep.enabled && key === 'volume') return setVolume(raw);
    p.val = Math.max(p.min, Math.min(p.max, raw));
    if (!started) return;
    const t = ctx.currentTime, sm = 0.025; // 25 ms smoothing

    // Oscillator params are matched, not enumerated — there are 3 per slot and
    // the number of slots is a runtime value.
    const om = OSC_KEY_RE.exec(key);
    if (om) {
      const i = +om[1] - 1;
      const o = oscs[i], g = oscGains[i];
      if (!o) return;                       // slot removed while a cable still drove it
      if (om[2] === 'freq')   o.frequency.linearRampToValueAtTime(p.val, t + sm);
      if (om[2] === 'detune') o.detune.linearRampToValueAtTime(p.val, t + sm);
      if (om[2] === 'volume') g.gain.linearRampToValueAtTime(p.val, t + sm);
      return;
    }

    switch (key) {
      case 'filter_freq': filt.frequency.linearRampToValueAtTime(p.val, t + sm); break;
      case 'filter_q':    filt.Q.linearRampToValueAtTime(p.val, t + sm); break;
      case 'osc_volume':  oscVol.gain.linearRampToValueAtTime(p.val, t + sm); break;
      case 'chord_filter_freq': cfilt.frequency.linearRampToValueAtTime(p.val, t + sm); break;
      case 'chord_filter_q':    cfilt.Q.linearRampToValueAtTime(p.val, t + sm); break;
      case 'chord_volume':      chordVol.gain.linearRampToValueAtTime(p.val, t + sm); break;
      case 'lfo_rate':    lfo.frequency.linearRampToValueAtTime(p.val, t + sm); break;
      case 'lfo_depth':   lfog.gain.linearRampToValueAtTime(p.val * 800, t + sm); break;
      case 'reverb_mix':
        revgain.gain.linearRampToValueAtTime(p.val, t + sm);
        drygain.gain.linearRampToValueAtTime(1 - p.val, t + sm);
        break;
      case 'volume': maing.gain.linearRampToValueAtTime(p.val, t + sm); break;
    }
  }

  // Stepped main gain. The early-out is the whole point: while a rung is held
  // the AudioParam is not touched at all, so the envelope scheduled on entry
  // actually completes — that's the crisp attack and the real silence.
  // Safe to cancelScheduledValues here only because nothing else automates
  // maing.gain (sole writers: start() and set()); keep that invariant.
  function setVolume(raw) {
    const p = PARAMS.volume;
    const q = dyn.quantize(Math.max(p.min, Math.min(p.max, raw)), volIdx);
    if (q.idx === volIdx) return;                  // rung held → leave the ramp alone
    const prev = volIdx;
    volIdx = q.idx;
    p.val = Math.max(p.min, Math.min(p.max, q.gain));
    volEdges++;
    if (!started) return;
    const e = EDGES[volStep.edge] ?? EDGES.key;
    // Fixed duration regardless of how many rungs are crossed, so a fast
    // crescendo doesn't take longer than a small step.
    const ms = (prev === null || q.idx > prev) ? e.attackMs
             : (q.gain === 0 ? e.gateMs : e.releaseMs);
    const t = ctx.currentTime;
    const cur = maing.gain.value;                  // read before cancelling
    maing.gain.cancelScheduledValues(t);
    maing.gain.setValueAtTime(cur, t);              // anchor where we actually are
    maing.gain.linearRampToValueAtTime(p.val, t + Math.max(0.005, ms / 1000));
  }

  function setTuning(partial) {
    tuning = { ...tuning, ...partial };
    quant  = makeQuantizer({ root: tuning.root, scale: tuning.scale, tuning: tuning.system });
    // Re-apply current oscillator pitches so a scale/root change is audible at once.
    for (let i = 1; i <= oscCount; i++) set(`osc${i}_freq`, PARAMS[`osc${i}_freq`].val);
  }
  function getTuning() { return { ...tuning }; }
  // Snapped note name for a frequency param, or null when quantisation is off.
  function noteFor(key) {
    return (tuning.enabled && isFreqKey(key)) ? quant.noteName(PARAMS[key].val) : null;
  }

  // Same shape as setTuning: merge, rebuild, re-apply so the change is
  // immediately audible. The slider's detent notches follow the ladder.
  function setVolStep(partial) {
    volStep = { ...volStep, ...partial };
    dyn = makeDynamics(volStep);
    volIdx = null;                       // force the next write to re-ramp
    PARAMS.volume.snaps = volStep.enabled ? tickLevels(dyn.levels) : VOL_SNAPS;
    set('volume', PARAMS.volume.val);
  }
  function getVolStep() { return { ...volStep }; }

  // Live rung, for the panel readout and the articulation tests.
  function volLevel() {
    if (!volStep.enabled) return null;
    const idx = volIdx ?? dyn.indexOf(PARAMS.volume.val);
    return { idx, count: dyn.levels.length, gain: dyn.levels[idx],
             db: dyn.dbAt(idx), stepDb: dyn.stepDb, edges: volEdges,
             // Where the gate switches, in the same 0-1 units as the incoming
             // cable value, so the panel can name the number the player is
             // hunting for instead of leaving them to find it by trial.
             gateGain: dyn.gate ? dyn.gateGain : null };
  }

  // Waveform per slot. Slot 0 also sets the chord voices' timbre, which is why
  // it is applied to them too — chords ride the lead's tone by design.
  function setOscType(i, t) {
    if (!(i >= 0 && i < MAX_OSCS) || !t) return;
    oscTypes[i] = t;
    if (oscs[i]) applyType(oscs[i], t);
    if (i === 0 && started) chordOscs.forEach(o => applyType(o, t));
  }
  const getOscType  = i => oscTypes[i];
  const getOscTypes = () => oscTypes.slice(0, oscCount);
  function setFilterType(t) { filterType = t; if (filt) filt.type = t; }
  function setChordFilterType(t) { chordFilterType = t; if (cfilt) cfilt.type = t; }
  function getChordFilterType() { return chordFilterType; }
  function getFilterType()  { return filterType; }

  // ── Full audio-engine state for save/load ────────────────────────────
  function snapshot() {
    const params = {};
    for (const k in PARAMS) params[k] = PARAMS[k].val;
    return { params, tuning: { ...tuning }, volStep: { ...volStep },
             oscCount, oscTypes: getOscTypes(),
             filterType, chordFilterType,
             chordEnv: { ...chordEnv } };
  }
  function restore(s) {
    if (!s) return;
    // Bank size FIRST: the params a snapshot carries only exist once their
    // slots do, and setOscCount rebuilds PARAMS.
    setOscCount(oscCountOf(s));
    (s.oscTypes ?? [s.osc1Type, s.osc2Type]).forEach((t, i) => setOscType(i, t));
    if (s.filterType) setFilterType(s.filterType);
    if (s.chordFilterType) setChordFilterType(s.chordFilterType);
    if (s.chordEnv) setChordEnv(s.chordEnv);
    if (s.tuning) setTuning(s.tuning);
    if (s.volStep) setVolStep(s.volStep);   // before params, so volume quantises on the way in
    if (s.params) for (const k in s.params) if (PARAMS[k]) set(k, s.params[k]);
    // `osc_mix` was a 1↔2 crossfade, which per-oscillator level replaced.
    // Translating it is exact — the old graph WAS osc1 at 1-mix and osc2 at mix
    // — and without this every saved preset comes back with both oscillators at
    // their new defaults, i.e. a different sound than the one that was saved.
    const mix = s.params?.osc_mix;
    if (mix !== undefined && s.params.osc1_volume === undefined) {
      const m = Math.max(0, Math.min(1, Number(mix) || 0));
      set('osc1_volume', 1 - m);
      if (oscCount > 1) set('osc2_volume', m);
    }
  }

  // How many slots a snapshot wants. Explicit when it was written by this
  // version; otherwise inferred, because a pre-resize snapshot always described
  // exactly two oscillators and would silently lose the second one.
  function oscCountOf(s) {
    if (Number.isFinite(s.oscCount)) return s.oscCount;
    if (Array.isArray(s.oscTypes) && s.oscTypes.length) return s.oscTypes.length;
    const highest = Object.keys(s.params ?? {})
      .map(k => OSC_KEY_RE.exec(k)?.[1])
      .filter(Boolean)
      .reduce((a, n) => Math.max(a, +n), 0);
    return Math.max(1, highest || (s.osc2Type ? 2 : 1));
  }

  // One-shot tone voice — used by play-along for the guide melody and
  // hit/miss feedback. Own gain straight to the destination, so it never
  // interferes with the player's synth chain or its parameter smoothing.
  function playTone({ freq, when = 0, dur = 0.25, type = 'triangle', gain = 0.12 } = {}) {
    if (!started || !(freq > 0)) return;
    const t0 = ctx.currentTime + Math.max(0, when);
    const o = ctx.createOscillator(), g = ctx.createGain();
    applyType(o, type);
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    g.gain.setValueAtTime(gain, t0 + Math.max(0.012, dur - 0.08));
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }

  // Audio-clock now (seconds) — the play-along scheduler's timeline anchor.
  function now() { return started ? ctx.currentTime : 0; }

  // ── Chord voice bank (chord mode) ────────────────────────────────────
  // Sustains a chord while a gesture is held. Voices ride the same timbre
  // as oscillator 1 and run through the filter/reverb/main chain, so the sound
  // kit and gesture-driven filter sweeps shape chords too.
  function playChord(freqs, { gain = 0.18 } = {}) {
    if (!started || !freqs?.length) return;
    const t = ctx.currentTime, sm = 0.02;
    chordOscs.forEach((o, i) => {
      const audible = i < freqs.length;
      if (audible) o.frequency.linearRampToValueAtTime(freqs[i], t + sm);
      chordVGains[i].gain.linearRampToValueAtTime(audible ? 1 / Math.max(3, freqs.length) : 0, t + sm);
    });
    // Attack to peak, then decay to the sustain level, both anchored at the
    // gain we are actually at — retriggering mid-release has to start from the
    // dying value, not snap to zero first, or fast chord changes click.
    const a = Math.max(CHORD_ENV_MIN, chordEnv.attack);
    const d = Math.max(0, chordEnv.decay);
    const sus = gain * Math.max(0, Math.min(1, chordEnv.sustain));
    const g = chordGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(gain, t + a);
    if (d > 0) g.linearRampToValueAtTime(sus, t + a + d);
    chordOn = true;
  }

  function releaseChord() {
    if (!started || !chordOn) return;
    const t = ctx.currentTime;
    const g = chordGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + Math.max(CHORD_ENV_MIN, chordEnv.release));
    chordOn = false;
  }

  // Times are clamped to a sane musical span rather than the full float range:
  // a 30-second attack on a gesture-held chord is not a setting, it is a way
  // to make the instrument look broken.
  const CHORD_ENV_RANGE = { attack: [0, 2], decay: [0, 3], sustain: [0, 1], release: [0.005, 5] };
  function setChordEnv(partial = {}) {
    const next = { ...chordEnv };
    for (const [k, [lo, hi]] of Object.entries(CHORD_ENV_RANGE)) {
      if (partial[k] === undefined) continue;
      const v = Number(partial[k]);
      if (Number.isFinite(v)) next[k] = Math.max(lo, Math.min(hi, v));
    }
    chordEnv = next;
    return { ...chordEnv };
  }
  const getChordEnv = () => ({ ...chordEnv });

  function chordActive() { return chordOn; }

  function getWaveform() {
    if (!analyser) return null;
    const buf = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatTimeDomainData(buf);
    return buf;
  }

  function stop() {
    ctx?.close();
    started = false;
    volIdx = null;
    // The nodes belong to the closed context; keeping references would have
    // set() ramping AudioParams that no longer run.
    oscs = []; oscGains = [];
  }

  // Mute / unmute the output. A short ramp rather than a jump, because a step
  // change on a running oscillator is an audible click — the very artefact the
  // rest of the dynamics work exists to remove.
  const MUTE_RAMP = 0.015;
  function setMuted(m) {
    muted = !!m;
    if (!started) return muted;
    const t = ctx.currentTime;
    outg.gain.cancelScheduledValues(t);
    outg.gain.setValueAtTime(outg.gain.value, t);
    outg.gain.linearRampToValueAtTime(muted ? 0 : 1, t + MUTE_RAMP);
    return muted;
  }
  const toggleMuted = () => setMuted(!muted);

  // An AudioContext created without a user gesture starts suspended, and the
  // page auto-starts the engine, so this is the normal case rather than an
  // error path: the graph exists and every control works, but the clock is
  // frozen until the browser sees a gesture. Callers hand that gesture over by
  // calling this. Safe to call repeatedly.
  async function resume() {
    if (!started) return null;
    try { await ctx.resume(); } catch { /* no gesture yet, or context closed */ }
    return ctx.state;
  }

  return {
    PARAMS,
    start, set, stop,
    setTuning, getTuning, noteFor,
    setVolStep, getVolStep, volLevel,
    setOscCount, getOscCount, MAX_OSCS,
    setOscType, getOscType, getOscTypes,
    setFilterType, getFilterType,
    setChordFilterType, getChordFilterType,
    snapshot, restore,
    defineWave, playTone, now,
    playChord, releaseChord, chordActive,
    setChordEnv, getChordEnv, CHORD_ENV_RANGE,
    getWaveform,
    setMuted, toggleMuted, resume,
    get started() { return started; },
    get muted() { return muted; },
    get ctxState() { return started ? ctx.state : 'closed'; },
  };
})();
