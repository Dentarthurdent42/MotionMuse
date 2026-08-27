import { engine } from '../engine.js';
import { isDesktop } from './viewport.js';
import { onThemeChange } from './theme.js';

let canvas, ctx;

// The scope is an emissive display: black glass in every theme, trace in the
// theme's LED accent — so Ember's trace burns orange instead of staying the
// one cyan element in a warm palette. Read once and on theme change, not per
// frame; getComputedStyle every frame is a layout-adjacent cost at 60 fps.
let accent = '#00e5cc';
function readAccent() {
  accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--led-accent').trim() || '#00e5cc';
}

function init() {
  canvas = document.getElementById('viz-canvas');
  ctx    = canvas.getContext('2d');
  readAccent();
  onThemeChange(readAccent);
}

export function drawViz() {
  if (!canvas) init();
  const W = canvas.offsetWidth, H = isDesktop() ? 96 : 72;   // matches #viz-canvas CSS height
  // Assigning width/height reallocates the backing store — only on change.
  if (canvas.width !== W)  canvas.width  = W;
  if (canvas.height !== H) canvas.height = H;

  ctx.fillStyle = '#020204';
  ctx.fillRect(0, 0, W, H);

  const wave = engine.getWaveform();
  if (!wave) {
    ctx.strokeStyle = '#1c1c2e';
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
