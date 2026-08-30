// The metronome: a beat clock the whole instrument can see and hear.
//
// One clock, three faces. It CLICKS (a short blip through the engine's master
// chain, accented on the downbeat), it is DRAWN on the camera view (one marker
// per beat of the bar, so the time signature is a picture rather than a
// fraction), and it is READ by the play modes: gesture and radial mode each
// offer a volume mode that samples the current selection only on the
// metronome's chosen beats — the SAMPLE mask, one toggle per beat of the bar.
//
// The clock runs on the frame clock (performance.now), because everything it
// gates — handshapes, the ring's pointer — only changes once per frame anyway.
// The CLICKS are the one part of it ears will hold to a higher standard than
// eyes, so they are scheduled ahead on the audio clock (`LOOKAHEAD` seconds)
// rather than fired from whichever frame noticed the beat: a frame is ~16 ms
// of jitter, which a listener hears as a drunk drummer long before a player
// sees it.
//
// MUTE silences the click and nothing else: the clock keeps counting, the
// picture keeps pulsing, the beat-sampled modes keep sampling. A metronome
// you can hear OR just watch is two practice tools for the price of one.

import { bus }    from './bus.js';
import { engine } from './engine.js';
import { isRecord } from './is.js';

// Offered signatures. The numerator is what the instrument actually consumes
// — beats per bar, mask length, markers on screen; the denominator names the
// note the BPM counts. Compound meters click every division rather than the
// dotted pulse: this is a practice clock, not a conductor.
export const SIGNATURES = ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8'];
export const BPM_MIN = 30, BPM_MAX = 300;
export const BPM_STEP = 4;            // one press of the nudge buttons

const LOOKAHEAD = 0.12;               // seconds of clicks scheduled ahead

export const numOf = sig => Number(String(sig).split('/')[0]) || 4;

// ── The camera-view control tokens ────────────────────────────────────────
// Mirrored from CSS (main.css, "Controls on the picture") so the canvas
// readout below can sit on the same line as the DOM controls around it. Read
// from the custom properties themselves rather than copied as numbers: the
// fullscreen view redefines them, and a hardcoded 26 would quietly stop
// matching there. Falls back to the small-view values when there is no
// document to ask (unit tests) or the property is missing.
const camToken = (name, fallback) => {
  const el = globalThis.document?.getElementById('video-wrap');
  if (!el) return fallback;
  const v = parseFloat(getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
};

export const metronome = (() => {
  const DEFAULTS = { on: false, bpm: 100, sig: '4/4', muted: false };

  let on    = DEFAULTS.on;
  let bpm   = DEFAULTS.bpm;
  let sig   = DEFAULTS.sig;
  let muted = DEFAULTS.muted;
  // Which beats of the bar the beat-sampled volume modes strike on. All of
  // them by default: "every beat" is the pattern you can hear before you
  // have opinions, and switching beats OFF is how the opinions arrive.
  let mask = Array(numOf(DEFAULTS.sig)).fill(true);

  // ── Transport ───────────────────────────────────────────────────────────
  let count    = 0;      // total beats elapsed since start, fractional
  let fired    = -1;     // last integer beat announced to the frame
  let lastT    = null;   // perf-seconds of the previous tick
  let clickIdx = 0;      // next beat (total index) not yet given a click
  let ev       = null;   // this frame's beat crossing, or null

  function resetTransport() {
    count = 0; fired = -1; lastT = null; clickIdx = 0; ev = null;
  }

  const resizeMask = n => {
    mask = Array.from({ length: n }, (_, i) => mask[i] ?? true);
  };

  // The clock as bus signals, so the patchbay can wire it anywhere: a pulse
  // per beat (and per downbeat), the phase within the beat and within the
  // bar. Wire metro_beat into a Sample & Hold's gate and ANY signal becomes
  // beat-quantized — the graph's version of the beat-sampled volume modes.
  const publish = () => {
    if (!bus.signals.has('metro_beat')) return;   // panel not registered yet
    const n = numOf(sig);
    bus.update('metro_beat', ev ? 1 : 0);
    bus.update('metro_downbeat', ev?.downbeat ? 1 : 0);
    bus.update('metro_phase', on ? count - Math.floor(count) : 0);
    bus.update('metro_bar', on ? (count % n) / n : 0);
  };

  return {
    get on() { return on; },

    registerSignals() {
      const meta = (label) => ({ label, min: 0, max: 1, group: 'metro', source: 'metronome' });
      bus.register('metro_beat',     meta('Metro Beat (pulse)'));
      bus.register('metro_downbeat', meta('Metro Downbeat (pulse)'));
      bus.register('metro_phase',    meta('Metro Beat Phase'));
      bus.register('metro_bar',      meta('Metro Bar Phase'));
    },

    // ── Per-frame drive (main.js RAF loop, BEFORE the play modes' ticks,
    //    so a beat that lands this frame is visible to them this frame) ────
    tick(now = performance.now() / 1000) {
      if (!on) { ev = null; publish(); return; }
      const n = numOf(sig);
      if (lastT !== null) count += (now - lastT) * (bpm / 60);
      lastT = now;

      // The beat crossing, announced once. The first tick after starting is
      // beat 0: a metronome that waits a whole beat before its first click
      // reads as broken, and "start on ONE" is what counting in means.
      const idx = Math.floor(count);
      if (idx > fired) {
        fired = idx;
        const b = idx % n;
        ev = { beat: b, downbeat: b === 0, sampled: !!mask[b] };
      } else ev = null;

      // Clicks, scheduled ahead on the audio clock. The grid is recomputed
      // from the live tempo each tick, so a tempo change bends the upcoming
      // beats rather than waiting out the old ones.
      publish();
      if (muted) { clickIdx = Math.ceil(count); return; }
      const spb = 60 / bpm;
      if (clickIdx < count - 0.02) clickIdx = Math.ceil(count - 0.02);
      while ((clickIdx - count) * spb < LOOKAHEAD) {
        engine.click((clickIdx - count) * spb, clickIdx % n === 0);
        clickIdx++;
      }
    },

    // ── What the play modes read ───────────────────────────────────────────
    // The beat that landed THIS frame, or null. `sampleThisFrame` narrows it
    // to beats the mask has switched on — the ones the beat-sampled volume
    // modes strike on.
    beatThisFrame:   () => ev,
    sampleThisFrame: () => (ev && ev.sampled ? ev : null),

    // ── What the overlay draws ─────────────────────────────────────────────
    // Null when off — no clock, no picture. `beat` is where the bar stands,
    // `phase` how far into that beat (0..1, drives the pulse).
    view() {
      if (!on) return null;
      const n = numOf(sig);
      const idx = Math.max(0, fired);
      return { num: n, beat: idx % n, phase: count - Math.floor(count), mask: [...mask] };
    },

    // ── Controls ───────────────────────────────────────────────────────────
    config: () => ({ on, bpm, sig, muted, mask: [...mask] }),
    setOn(v) {
      on = !!v;
      resetTransport();
    },
    setBpm(v) {
      const b = Number(v);
      if (Number.isFinite(b)) bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, b));
      return bpm;
    },
    nudge(dir) { return this.setBpm(bpm + Math.sign(dir) * BPM_STEP); },
    setSig(s) {
      if (!SIGNATURES.includes(s)) return;
      sig = s;
      resizeMask(numOf(sig));
      // A new bar length restarts the bar: carrying beat 7 into a bar of
      // three is not a musical statement, it is a modulo artefact.
      if (on) resetTransport();
    },
    setMuted(v) { muted = !!v; },
    toggleMaskBeat(i) {
      if (i >= 0 && i < mask.length) mask[i] = !mask[i];
    },

    // ── The camera-view face (cv.js drawOverlay, every frame) ─────────────
    // One marker per beat of the bar, top-centre: the time signature drawn
    // as a row you can count. The DOWNBEAT is a diamond where the others are
    // circles, SAMPLE beats are filled where masked-off beats are hollow,
    // and the current beat swells and lights as it lands — so meter, mask
    // and "where are we" are all one glance. The canvas is CSS-mirrored, so
    // the markers are laid out right-to-left in canvas space to read
    // left-to-right on screen. Self-contained contrast, radial mode's
    // lesson: a scrim band and dark halos, owing nothing to the background.
    draw(ctx, w) {
      const view = this.view();
      if (!view) return;
      const { num, beat, phase, mask } = view;
      // A readout, not a control — but it shares the top edge of the frame
      // with the ones that are, so it takes its height, its inset and its
      // corner radius from the same tokens they do. The overlay canvas is
      // sized in CSS pixels (cv.js writes wrap.offsetWidth), same units.
      const ctrl  = camToken('--cam-ctrl-h', 26);
      const inset = camToken('--cam-inset', 8);
      const r   = Math.max(4, Math.min(9, ctrl * 0.26));
      const gap = r * 3.2;
      const y   = inset + ctrl / 2;                // centred in the same band
      const x0  = w / 2 + ((num - 1) * gap) / 2;   // beat 0, screen-left
      const HALO = 'rgba(6, 10, 14, 0.75)';
      const INK  = 'rgba(255, 255, 255, 0.92)';
      const LIT  = '#ffd166';                      // the beat that is landing

      ctx.save();
      // The scrim band behind the whole strip — a control's height and radius,
      // so the three things on this line read as one line.
      ctx.fillStyle = 'rgba(6, 10, 14, 0.5)';
      ctx.beginPath();
      const padX = Math.max(r * 2, ctrl * 0.42);
      ctx.roundRect(x0 - (num - 1) * gap - padX, y - ctrl / 2,
                    (num - 1) * gap + padX * 2, ctrl, camToken('--cam-radius', 4));
      ctx.fill();

      for (let i = 0; i < num; i++) {
        const x = x0 - i * gap;
        const lit = i === beat;
        const rr = lit ? r * (1.35 - 0.35 * Math.min(1, phase)) : r;
        ctx.beginPath();
        if (i === 0) {   // the downbeat: a diamond
          ctx.moveTo(x, y - rr * 1.25); ctx.lineTo(x + rr * 1.25, y);
          ctx.lineTo(x, y + rr * 1.25); ctx.lineTo(x - rr * 1.25, y);
          ctx.closePath();
        } else ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.strokeStyle = HALO;
        ctx.lineWidth = 3;
        ctx.stroke();
        if (mask[i]) {   // a sample beat: filled
          ctx.fillStyle = lit ? LIT : INK;
          ctx.fill();
        } else {         // masked off: hollow — the clock passes, nothing strikes
          ctx.strokeStyle = lit ? LIT : 'rgba(255, 255, 255, 0.55)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      ctx.restore();
    },

    // ── Persistence ────────────────────────────────────────────────────────
    serialize: () => ({ on, bpm, sig, muted, mask: [...mask] }),
    load(data) {
      const d = isRecord(data) ? data : {};
      sig   = SIGNATURES.includes(d.sig) ? d.sig : DEFAULTS.sig;
      muted = d.muted === true;
      bpm   = DEFAULTS.bpm; this.setBpm(d.bpm ?? DEFAULTS.bpm);
      mask  = Array(numOf(sig)).fill(true);
      if (Array.isArray(d.mask)) mask = mask.map((v, i) => d.mask[i] === undefined ? v : d.mask[i] === true);
      this.setOn(d.on === true);
    },
  };
})();
