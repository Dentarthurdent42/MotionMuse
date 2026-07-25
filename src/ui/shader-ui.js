// Shader panel section — a WebGL visual output whose pattern reacts to the
// audio level and two chosen signals. Kept separate from audio-ui to stay
// focused; audio-ui drops in the markup and calls the wire/refresh helpers.

import { bus }            from '../bus.js';
import { shader, SHADERS } from '../shader.js';

function sigOptions(sel) {
  let o = '';
  const groups = new Map();
  bus.signals.forEach((s, k) => {
    const g = s.group || 'misc';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ k, s });
  });
  groups.forEach((sigs, g) => {
    o += `<optgroup label="${g}">`;
    sigs.forEach(({ k, s }) => { o += `<option value="${k}"${k === sel ? ' selected' : ''}>${s.label}</option>`; });
    o += `</optgroup>`;
  });
  return o;
}

export function shaderSectionHTML() {
  const shaderOpts = SHADERS
    .map(s => `<option value="${s.id}"${s.id === shader.shaderId ? ' selected' : ''}>${s.name}</option>`).join('');
  return `
    <div class="audio-section">
      <div class="audio-section-label">Shader — Visual Output</div>
      <canvas id="shader-canvas" class="shader-canvas" aria-label="Reactive shader visualisation"></canvas>
      <div class="scale-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:4px;">
        <select id="shader-select" title="Shader pattern" aria-label="Shader pattern">${shaderOpts}</select>
        <select id="shader-x" title="Signal driving the X axis" aria-label="Shader X signal">${sigOptions(shader.xKey)}</select>
        <select id="shader-y" title="Signal driving the Y axis" aria-label="Shader Y signal">${sigOptions(shader.yKey)}</select>
      </div>
    </div>`;
}

let initedCanvas = null;
export function wireShaderSection() {
  const c = document.getElementById('shader-canvas');
  if (!c) return;
  // The panel (and its canvas) is recreated on every audio start — rebind
  // the GL context whenever a fresh canvas appears.
  if (c !== initedCanvas) { shader.init('shader-canvas'); initedCanvas = c; }
  shader.setActive(true);
  document.getElementById('shader-select').addEventListener('change', e => shader.setShader(e.target.value));
  document.getElementById('shader-x').addEventListener('change', e => shader.setX(e.target.value));
  document.getElementById('shader-y').addEventListener('change', e => shader.setY(e.target.value));
}
