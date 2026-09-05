import { engine } from '../engine.js';
import { isDesktop } from './viewport.js';
import { themeToken } from './theme.js';

let canvas, ctx;

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
  if (!wave) {
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
    const y = (0.5 + wave[i] * 0.45) * H;
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
