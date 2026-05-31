export const engine = (() => {
  let ctx, analyser, osc1, osc2, osc1g, osc2g, filt, lfo, lfog, revb, revgain, drygain, mastg;
  let started = false;

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

    osc1 = ctx.createOscillator(); osc1.type = 'sine';
    osc2 = ctx.createOscillator(); osc2.type = 'triangle';
    osc1g = ctx.createGain(); osc1g.gain.value = 1;
    osc2g = ctx.createGain(); osc2g.gain.value = 0;
    filt  = ctx.createBiquadFilter(); filt.type = 'lowpass';
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

    osc1.start(); osc2.start(); lfo.start();
    started = true;
  }

  function set(key, raw) {
    const p = PARAMS[key];
    if (!p) return;
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

  function setOsc1Type(t)   { if (osc1) osc1.type = t; }
  function setOsc2Type(t)   { if (osc2) osc2.type = t; }
  function setFilterType(t) { if (filt) filt.type = t; }

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
    setOsc1Type, setOsc2Type, setFilterType,
    getWaveform,
    get started() { return started; },
  };
})();
