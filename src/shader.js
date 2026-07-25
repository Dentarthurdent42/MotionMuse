// Shader panel — WebGL fragment-shader visual output that reacts to the live
// audio level and two chosen signals. A single program branches between a few
// built-in patterns (u_mode) so there's only one compile. Honors
// prefers-reduced-motion by freezing the time term.

import { engine } from './engine.js';
import { bus }    from './bus.js';

export const SHADERS = [
  { id: 'plasma', name: 'Plasma' },
  { id: 'warp',   name: 'Warp'   },
  { id: 'bars',   name: 'Bars'   },
];
const MODE = { plasma: 0, warp: 1, bars: 2 };

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
uniform vec2  u_res;
uniform float u_time, u_level, u_x, u_y;
uniform int   u_mode;
#define TAU 6.28318530718
vec3 pal(float t){ return 0.55 + 0.45*cos(TAU*(vec3(0.0,0.33,0.67)+t)); }
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 c  = (uv - 0.5) * vec2(u_res.x/u_res.y, 1.0);
  float t = u_time, lv = 0.35 + u_level*1.6;
  vec3 col;
  if (u_mode == 0) {                                  // plasma
    float v = sin((uv.x+u_x)*8.0 + t)
            + sin((uv.y+u_y)*8.0 - t*1.3)
            + sin((uv.x+uv.y)*6.0 + t*0.7);
    col = pal(v*0.25 + u_x) * lv;
  } else if (u_mode == 1) {                           // warp
    float r = length(c) * (1.0 + u_y*1.5);
    float a = atan(c.y, c.x);
    float w = sin(a*6.0 + t + r*10.0 - u_x*TAU);
    col = pal(r - t*0.15 + u_x) * (0.4 + 0.6*w) * lv;
  } else {                                            // bars (spectrum-ish)
    float bars = 16.0;
    float i = floor(uv.x * bars);
    float h = 0.2 + 0.8*abs(sin(i*1.7 + t*2.0 + u_x*6.0)) * (0.4 + u_level*2.0);
    float on = step(uv.y, h);
    col = pal(i/bars + u_y) * on * lv;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export const shader = (() => {
  let gl, prog, canvas, U = {}, t0 = 0, mode = 0;
  let xKey = 'hand_R_x', yKey = 'hand_R_y';
  let active = false;
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function init(canvasId) {
    canvas = document.getElementById(canvasId);
    if (!canvas) return false;
    gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const u of ['u_res', 'u_time', 'u_level', 'u_x', 'u_y', 'u_mode']) U[u] = gl.getUniformLocation(prog, u);
    t0 = performance.now();
    return true;
  }

  function level() {
    const w = engine.getWaveform?.();
    if (!w) return 0;
    let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * w[i];
    return Math.min(1, Math.sqrt(s / w.length) * 3);
  }

  function render() {
    if (!active || !gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = (canvas.clientWidth || 240) * dpr, h = (canvas.clientHeight || 120) * dpr;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform2f(U.u_res, w, h);
    gl.uniform1f(U.u_time, reduced() ? 0 : (performance.now() - t0) / 1000);
    gl.uniform1f(U.u_level, level());
    gl.uniform1f(U.u_x, bus.norm(xKey));
    gl.uniform1f(U.u_y, bus.norm(yKey));
    gl.uniform1i(U.u_mode, mode);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    init,
    render,
    setActive(on) { active = on; },
    get active() { return active; },
    setShader(id) { mode = MODE[id] ?? 0; },
    setX(k) { xKey = k; }, setY(k) { yKey = k; },
    serialize: () => ({ mode, xKey, yKey, active }),
    load(s) { if (!s) return; mode = s.mode ?? 0; xKey = s.xKey ?? xKey; yKey = s.yKey ?? yKey; active = !!s.active; },
    get shaderId() { return SHADERS[mode]?.id ?? 'plasma'; },
    get xKey() { return xKey; }, get yKey() { return yKey; },
  };
})();
