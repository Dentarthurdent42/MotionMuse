import { makeQuantizer } from './scale.js';

export const engine = (() => {
  let ctx, analyser, osc1, osc2, osc1g, osc2g, filt, lfo, lfog, revb, revgain, drygain, mastg;
  let started = false;

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
  let osc1Type = 'sine', osc2Type = 'triangle', filterType = 'lowpass';

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

  // Audio parameter definitions — name, display label, min, max, default value
  const PARAMS = {
    osc1_freq:   { label: 'Osc1 Freq',     min: 40,   max: 2000,  val: 220,  unit: 'Hz' },
    osc1_detune: { label: 'Osc1 Detune',   min: -100, max: 100,   val: 0,    unit: '¢'  },
    osc2_freq:   { label: 'Osc2 Freq',     min: 40,   max: 2000,  val: 330,  unit: 'Hz' },
    osc2_detune: { label: 'Osc2 Detune',   min: -100, max: 100,   val: 0,    unit: '¢'  },
    osc_mix:     { label: 'Osc Mix 1↔2',  min: 0,    max: 1,     val: 0.0              },
    filter_freq: { label: 'Filter Cutoff', min: 80,   max: 16000, val: 3000, unit: 'Hz' },
    filter_q:    { label: 'Filter Q',      min: 0.1,  max: 18,    val: 1                },
    lfo_rate:    { label: 'LFO Rate',      min: 0.05, max: 20,    val: 1,    unit: 'Hz' },
    lfo_depth:   { label: 'LFO Depth',     min: 0,    max: 1,     val: 0                },
    reverb_mix:  { label: 'Reverb Mix',    min: 0,    max: 1,     val: 0.12             },
    volume:      { label: 'Master Vol',    min: 0,    max: 1,     val: 0.55             },
  };

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
    lfo   = ctx.createOscillator(); lfo.type = 'sine';
    lfog  = ctx.createGain(); lfog.gain.value = 0;
    revb  = ctx.createConvolver(); revb.buffer = makeImpulse(ctx);
    revgain = ctx.createGain(); revgain.gain.value = PARAMS.reverb_mix.val;
    drygain = ctx.createGain(); drygain.gain.value = 1 - PARAMS.reverb_mix.val;
    mastg   = ctx.createGain(); mastg.gain.value = PARAMS.volume.val;

    // Apply stored param values
    osc1.frequency.value = PARAMS.osc1_freq.val;
    osc1.detune.value    = PARAMS.osc1_detune.val;
    osc2.frequency.value = PARAMS.osc2_freq.val;
    osc2.detune.value    = PARAMS.osc2_detune.val;
    filt.frequency.value = PARAMS.filter_freq.val;
    filt.Q.value         = PARAMS.filter_q.val;
    lfo.frequency.value  = PARAMS.lfo_rate.val;

    // Graph: oscs → filter → [dry + reverb] → master → analyser → out
    osc1.connect(osc1g); osc2.connect(osc2g);
    osc1g.connect(filt); osc2g.connect(filt);
    filt.connect(drygain); filt.connect(revb);
    revb.connect(revgain);
    drygain.connect(mastg); revgain.connect(mastg);
    mastg.connect(analyser); analyser.connect(ctx.destination);

    // LFO → filter cutoff (default target)
    lfo.connect(lfog); lfog.connect(filt.frequency);

    // Chord voice bank → shared gain (silent until playChord) → filter.
    chordGain = ctx.createGain(); chordGain.gain.value = 0;
    chordGain.connect(filt);
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
      case 'lfo_rate':    lfo.frequency.linearRampToValueAtTime(p.val, t + sm); break;
      case 'lfo_depth':   lfog.gain.linearRampToValueAtTime(p.val * 800, t + sm); break;
      case 'reverb_mix':
        revgain.gain.linearRampToValueAtTime(p.val, t + sm);
        drygain.gain.linearRampToValueAtTime(1 - p.val, t + sm);
        break;
      case 'volume': mastg.gain.linearRampToValueAtTime(p.val, t + sm); break;
    }
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

  function setOsc1Type(t)   { osc1Type = t; if (osc1) applyType(osc1, t); }
  function setOsc2Type(t)   { osc2Type = t; if (osc2) applyType(osc2, t); }
  function setFilterType(t) { filterType = t; if (filt) filt.type = t; }
  function getOsc1Type()    { return osc1Type; }
  function getOsc2Type()    { return osc2Type; }
  function getFilterType()  { return filterType; }

  // ── Full audio-engine state for save/load ────────────────────────────
  function snapshot() {
    const params = {};
    for (const k in PARAMS) params[k] = PARAMS[k].val;
    return { params, tuning: { ...tuning }, osc1Type, osc2Type, filterType };
  }
  function restore(s) {
    if (!s) return;
    if (s.osc1Type) setOsc1Type(s.osc1Type);
    if (s.osc2Type) setOsc2Type(s.osc2Type);
    if (s.filterType) setFilterType(s.filterType);
    if (s.tuning) setTuning(s.tuning);
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

  function stop() { ctx?.close(); started = false; }

  return {
    PARAMS,
    start, set, stop,
    setTuning, getTuning, noteFor,
    setOsc1Type, setOsc2Type, setFilterType,
    getOsc1Type, getOsc2Type, getFilterType,
    snapshot, restore,
    defineWave, playTone, now,
    playChord, releaseChord, chordActive,
    getWaveform,
    get started() { return started; },
  };
})();
