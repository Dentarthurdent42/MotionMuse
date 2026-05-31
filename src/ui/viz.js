import { engine } from '../engine.js';

let canvas, ctx;

function init() {
  canvas = document.getElementById('viz-canvas');
  ctx    = canvas.getContext('2d');
}

export function drawViz() {
  if (!canvas) init();
  const W = canvas.offsetWidth, H = 72;
  if (canvas.width !== W) canvas.width = W;
  canvas.height = H;

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

  ctx.strokeStyle = '#00e5cc';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = '#00e5cc';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  const step = W / wave.length;
  for (let i = 0; i < wave.length; i++) {
    const x = i * step;
    const y = (0.5 + wave[i] * 0.45) * H;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#00e5cc0a';
  ctx.lineTo(W, H / 2);
  ctx.lineTo(0, H / 2);
  ctx.fill();
}
