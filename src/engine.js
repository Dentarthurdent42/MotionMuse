import { makeQuantizer } from './scale.js';
import { makeDynamics, EDGES, GATE_AT_DEFAULT } from './dynamics.js';

export const engine = (() => {
  let ctx, analyser, osc1, osc2, osc1g, osc2g, filt, oscVol, lfo, lfog,
      cfilt, chordVol, revb, revgain, drygain, mastg, outg;
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

  // Pitch quantisation: snap oscillator frequencies onto a scale + tuning.
  const FREQ_KEYS = new Set(['osc1_freq', 'osc2_freq']);
  let tuning = { enabled: false, root: 'C', scale: 'chromatic', system: 'equal (12-TET)' };
  let quant  = makeQuantizer({ root: tuning.root, scale: tuning.scale, tuning: tuning.system });

  // Waveform / filter selections. Kept as state (not only on the live nodes)
  // so they survive save/load and a stop→start cycle.
  let osc1Type = 'sine', osc2Type = 'triangle', filterType = 'lowpass',
      chordFilterType = 'lowpass';

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
  const PARAMS = {
    osc1_freq:   { label: 'Osc1 Freq',     min: 40,   max: 2000,  val: 220,  unit: 'Hz' },
    osc1_detune: { label: 'Osc1 Detune',   min: -100, max: 100,   val: 0,    unit: '¢',  snaps: [-50, 0, 50] },
    osc2_freq:   { label: 'Osc2 Freq',     min: 40,   max: 2000,  val: 330,  unit: 'Hz' },
    osc2_detune: { label: 'Osc2 Detune',   min: -100, max: 100,   val: 0,    unit: '¢',  snaps: [-50, 0, 50] },
    osc_mix:     { label: 'Osc Mix 1↔2',  min: 0,    max: 1,     val: 0.0,   snaps: [0.5] },
    filter_freq: { label: 'Filter Cutoff', min: 80,   max: 16000, val: 3000, unit: 'Hz' },
    filter_q:    { label: 'Filter Q',      min: 0.1,  max: 18,    val: 1,     snaps: [1] },
    osc_volume:  { label: 'Osc Vol',       min: 0,    max: 1,     val: 1,     snaps: [0.5] },
    // Chord mode has its own filter + level so the two sources can be shaped
    // independently (chords darker than the lead, lead quieter than the
    // chords, …). Defaults match the old shared chain exactly.
    chord_filter_freq: { label: 'Chord Cutoff', min: 80,  max: 16000, val: 3000, unit: 'Hz' },
    chord_filter_q:    { label: 'Chord Q',      min: 0.1, max: 18,    val: 1,    snaps: [1] },
    chord_volume:      { label: 'Chord Vol',    min: 0,   max: 1,     val: 1,    snaps: [0.5] },
    lfo_rate:    { label: 'LFO Rate',      min: 0.05, max: 20,    val: 1,    unit: 'Hz' },
    lfo_depth:   { label: 'LFO Depth',     min: 0,    max: 1,     val: 0,     snaps: [0.5] },
    reverb_mix:  { label: 'Reverb Mix',    min: 0,    max: 1,     val: 0.12,  snaps: [0.25, 0.5] },
    volume:      { label: 'Master Vol',    min: 0,    max: 1,     val: 0.55,  snaps: [0.25, 0.5, 0.75] },
  };

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
  let volIdx = null;    // rung currently scheduled on mastg (null = unknown)
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
    osc1 = ctx.createOscillator(); applyType(osc1, osc1Type);
    osc2 = ctx.createOscillator(); applyType(osc2, osc2Type);
    osc1g = ctx.createGain(); osc1g.gain.value = 1 - PARAMS.osc_mix.val;
    osc2g = ctx.createGain(); osc2g.gain.value = PARAMS.osc_mix.val;
    filt  = ctx.createBiquadFilter(); filt.type = filterType;
    oscVol = ctx.createGain(); oscVol.gain.value = PARAMS.osc_volume.val;
    cfilt = ctx.createBiquadFilter(); cfilt.type = chordFilterType;
    chordVol = ctx.createGain(); chordVol.gain.value = PARAMS.chord_volume.val;
    lfo   = ctx.createOscillator(); lfo.type = 'sine';
    lfog  = ctx.createGain(); lfog.gain.value = 0;
    revb  = ctx.createConvolver(); revb.buffer = makeImpulse(ctx);
    revgain = ctx.createGain(); revgain.gain.value = PARAMS.reverb_mix.val;
    drygain = ctx.createGain(); drygain.gain.value = 1 - PARAMS.reverb_mix.val;
    mastg   = ctx.createGain(); mastg.gain.value = PARAMS.volume.val;
    // Mute sits AFTER the analyser (see the graph below), which is what lets
    // the visualiser keep drawing a live waveform while nothing is audible —
    // the difference between "muted" and "broken" made visible. It also keeps
    // mute completely clear of the volume ladder and its silence gate, which
    // live on mastg and are measured at the analyser.
    outg    = ctx.createGain(); outg.gain.value = muted ? 0 : 1;

    // Apply stored param values
    osc1.frequency.value = PARAMS.osc1_freq.val;
    osc1.detune.value    = PARAMS.osc1_detune.val;
    osc2.frequency.value = PARAMS.osc2_freq.val;
    osc2.detune.value    = PARAMS.osc2_detune.val;
    filt.frequency.value  = PARAMS.filter_freq.val;
    filt.Q.value          = PARAMS.filter_q.val;
    cfilt.frequency.value = PARAMS.chord_filter_freq.val;
    cfilt.Q.value         = PARAMS.chord_filter_q.val;
    lfo.frequency.value   = PARAMS.lfo_rate.val;

    // Graph — the two sources get their own filter and level, then share the
    // reverb/master/mute tail, so each can be shaped without touching the
    // other while Master Vol (and its step ladder) still governs everything:
    //
    //   oscs   → filt  → oscVol   ┐
    //                             ├→ [dry + reverb] → master → analyser → mute → out
    //   chords → cfilt → chordVol ┘
    osc1.connect(osc1g); osc2.connect(osc2g);
    osc1g.connect(filt); osc2g.connect(filt);
    filt.connect(oscVol);
    oscVol.connect(drygain); oscVol.connect(revb);
    revb.connect(revgain);
    drygain.connect(mastg); revgain.connect(mastg);
    mastg.connect(analyser); analyser.connect(outg); outg.connect(ctx.destination);

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
      applyType(o, osc1Type);
      o.frequency.value = 220;
      g.gain.value = 0;
      o.connect(g); g.connect(chordGain);
      chordOscs.push(o); chordVGains.push(g);
    }

    osc1.start(); osc2.start(); lfo.start();
    chordOscs.forEach(o => o.start());
    started = true;
  }

  function set(key, raw) {
    const p = PARAMS[key];
    if (!p) return;
    if (tuning.enabled && FREQ_KEYS.has(key)) raw = quant.quantize(raw);
    if (volStep.enabled && key === 'volume') return setVolume(raw);
    p.val = Math.max(p.min, Math.min(p.max, raw));
    if (!started) return;
    const t = ctx.currentTime, sm = 0.025; // 25 ms smoothing
    switch (key) {
      case 'osc1_freq':   osc1.frequency.linearRampToValueAtTime(p.val, t + sm); break;
      case 'osc1_detune': osc1.detune.linearRampToValueAtTime(p.val, t + sm); break;
      case 'osc2_freq':   osc2.frequency.linearRampToValueAtTime(p.val, t + sm); break;
      case 'osc2_detune': osc2.detune.linearRampToValueAtTime(p.val, t + sm); break;
      case 'osc_mix':
        osc1g.gain.linearRampToValueAtTime(1 - p.val, t + sm);
        osc2g.gain.linearRampToValueAtTime(p.val, t + sm);
        break;
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
      case 'volume': mastg.gain.linearRampToValueAtTime(p.val, t + sm); break;
    }
  }

  // Stepped master gain. The early-out is the whole point: while a rung is
  // held the AudioParam is not touched at all, so the envelope scheduled on
  // entry actually completes — that's the crisp attack and the real silence.
  // Safe to cancelScheduledValues here only because nothing else automates
  // mastg.gain (sole writers: start() and set()); keep that invariant.
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
    const cur = mastg.gain.value;                  // read before cancelling
    mastg.gain.cancelScheduledValues(t);
    mastg.gain.setValueAtTime(cur, t);              // anchor where we actually are
    mastg.gain.linearRampToValueAtTime(p.val, t + Math.max(0.005, ms / 1000));
  }

  function setTuning(partial) {
    tuning = { ...tuning, ...partial };
    quant  = makeQuantizer({ root: tuning.root, scale: tuning.scale, tuning: tuning.system });
    // Re-apply current oscillator pitches so a scale/root change is audible at once.
    set('osc1_freq', PARAMS.osc1_freq.val);
    set('osc2_freq', PARAMS.osc2_freq.val);
  }
  function getTuning() { return { ...tuning }; }
  // Snapped note name for a frequency param, or null when quantisation is off.
  function noteFor(key) {
    return (tuning.enabled && FREQ_KEYS.has(key)) ? quant.noteName(PARAMS[key].val) : null;
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

  function setOsc1Type(t)   { osc1Type = t; if (osc1) applyType(osc1, t); }
  function setOsc2Type(t)   { osc2Type = t; if (osc2) applyType(osc2, t); }
  function setFilterType(t) { filterType = t; if (filt) filt.type = t; }
  function setChordFilterType(t) { chordFilterType = t; if (cfilt) cfilt.type = t; }
  function getChordFilterType() { return chordFilterType; }
  function getOsc1Type()    { return osc1Type; }
  function getOsc2Type()    { return osc2Type; }
  function getFilterType()  { return filterType; }

  // ── Full audio-engine state for save/load ────────────────────────────
  function snapshot() {
    const params = {};
    for (const k in PARAMS) params[k] = PARAMS[k].val;
    return { params, tuning: { ...tuning }, volStep: { ...volStep },
             osc1Type, osc2Type, filterType, chordFilterType };
  }
  function restore(s) {
    if (!s) return;
    if (s.osc1Type) setOsc1Type(s.osc1Type);
    if (s.osc2Type) setOsc2Type(s.osc2Type);
    if (s.filterType) setFilterType(s.filterType);
    if (s.chordFilterType) setChordFilterType(s.chordFilterType);
    if (s.tuning) setTuning(s.tuning);
    if (s.volStep) setVolStep(s.volStep);   // before params, so volume quantises on the way in
    if (s.params) for (const k in s.params) if (PARAMS[k]) set(k, s.params[k]);
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
  // as osc1 and run through the filter/reverb/master chain, so the sound
  // kit and gesture-driven filter sweeps shape chords too.
  function playChord(freqs, { gain = 0.18 } = {}) {
    if (!started || !freqs?.length) return;
    const t = ctx.currentTime, sm = 0.02;
    chordOscs.forEach((o, i) => {
      const audible = i < freqs.length;
      if (audible) o.frequency.linearRampToValueAtTime(freqs[i], t + sm);
      chordVGains[i].gain.linearRampToValueAtTime(audible ? 1 / Math.max(3, freqs.length) : 0, t + sm);
    });
    chordGain.gain.cancelScheduledValues(t);
    chordGain.gain.setValueAtTime(chordGain.gain.value, t);
    chordGain.gain.linearRampToValueAtTime(gain, t + 0.015);
    chordOn = true;
  }

  function releaseChord() {
    if (!started || !chordOn) return;
    const t = ctx.currentTime;
    chordGain.gain.cancelScheduledValues(t);
    chordGain.gain.setValueAtTime(chordGain.gain.value, t);
    chordGain.gain.linearRampToValueAtTime(0, t + 0.12);
    chordOn = false;
  }

  function chordActive() { return chordOn; }

  function getWaveform() {
    if (!analyser) return null;
    const buf = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatTimeDomainData(buf);
    return buf;
  }

  function stop() { ctx?.close(); started = false; volIdx = null; }

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
    setOsc1Type, setOsc2Type, setFilterType,
    getOsc1Type, getOsc2Type, getFilterType,
    setChordFilterType, getChordFilterType,
    snapshot, restore,
    defineWave, playTone, now,
    playChord, releaseChord, chordActive,
    getWaveform,
    setMuted, toggleMuted, resume,
    get started() { return started; },
    get muted() { return muted; },
    get ctxState() { return started ? ctx.state : 'closed'; },
  };
})();
