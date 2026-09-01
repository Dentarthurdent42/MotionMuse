import { engine } from '../engine.js';
import { isDesktop } from './viewport.js';
import { themeToken } from './theme.js';

let canvas, ctx;

// ── Auto-gain ─────────────────────────────────────────────────────────────
//
// The scope drew the waveform at its raw amplitude, which is honest about the
// signal and useless as a display: the master fader sits well below 1, a
// gesture-driven filter takes more, and the result was a flat line with some
// squiggle in it. A scope is an instrument for reading SHAPE, so it normalises
// — like every hardware scope's volts/div, just chosen automatically.
//
// The follower rises instantly and falls slowly. Rising instantly means a
// transient is on screen the frame it happens rather than clipping off the
// top; falling slowly means a decaying note keeps its shape shrinking away
// instead of being visibly pumped back up to full height as it dies.
export function followPeak(prev, framePeak, { release = 0.05 } = {}) {
  return framePeak > prev ? framePeak : prev + (framePeak - prev) * release;
}

// Silence must read as silence. Below the floor there is nothing but dither
// and denormals down there, and a normaliser pointed at those draws a
// full-height waveform out of a signal nobody can hear — which is a worse lie
// than the flat line this replaces. The gain cap does the same job one step
// up: a signal that IS there but 60 dB down is drawn as far as the cap allows
// and no further, so "very quiet" still looks quieter than "loud".
export const SCOPE_FLOOR = 0.0015;
export function scopeScale(peak, { floor = SCOPE_FLOOR, target = 0.92, maxGain = 50 } = {}) {
  if (!(peak > floor)) return 0;
  return Math.min(maxGain, target / peak);
}

let peakFollow = 0;

// The scope is a screen, so it paints on the theme's glass rather than on a
// fixed black — light in the light themes — and its trace is the theme's LED
// accent, so Ember's burns orange instead of staying the one cyan element in
// a warm palette. The canvas is opaque: it repaints its own ground every
// frame, so the CSS background only shows before the first draw.
function init() {
  canvas = document.getElementById('viz-canvas');
  ctx    = canvas.getContext('2d');
}

export function drawViz() {
  if (!canvas) init();
  const W = canvas.offsetWidth, H = isDesktop() ? 96 : 72;   // matches #viz-canvas CSS height
  // Assigning width/height reallocates the backing store — only on change.
  if (canvas.width !== W)  canvas.width  = W;
  if (canvas.height !== H) canvas.height = H;

  ctx.fillStyle = themeToken('--glass', '#020204');
  ctx.fillRect(0, 0, W, H);

  const wave = engine.getWaveform();
  let peak = 0;
  if (wave) for (let i = 0; i < wave.length; i++) {
    const a = Math.abs(wave[i]);
    if (a > peak) peak = a;
  }
  peakFollow = wave ? followPeak(peakFollow, peak) : 0;
  const gain = wave ? scopeScale(peakFollow) : 0;

  if (!wave || gain === 0) {
    ctx.strokeStyle = themeToken('--glass-line', '#1c1c2e');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    return;
  }

  // Glow via a second wide low-alpha stroke — shadowBlur costs a full-canvas
  // blur pass per frame; two strokes are far cheaper and look near-identical.
  ctx.beginPath();
  const step = W / wave.length;
  for (let i = 0; i < wave.length; i++) {
    const x = i * step;
    // Clamped, not just scaled: the follower lags a rising transient by a
    // frame, and a spike drawn past the edge would leave the trace jumping
    // off the top of the panel rather than flattening against it.
    const y = (0.5 + Math.max(-1, Math.min(1, wave[i] * gain)) * 0.45) * H;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  const accent = themeToken('--led-accent', '#00e5cc');
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.2;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.04;
  ctx.lineTo(W, H / 2);
  ctx.lineTo(0, H / 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}
