// The shader runtime: the GL context that runs whatever the node graph
// compiled to.
//
// src/shadergraph.js decides what the picture IS and hands back GLSL source.
// This module owns the one thing that cannot be unit-tested — a live WebGL
// context — and keeps it fed:
//
//   • it recompiles when, and only when, the graph's shape changes. Turning a
//     knob does NOT recompile: a knob is a uniform, and uniforms are uploaded
//     every frame for nothing. Adding a node, rewiring a cable or changing a
//     node's choice is what rebuilds the program.
//   • a program that fails to link is REFUSED rather than installed, and the
//     last one that worked keeps drawing. A patch mid-edit is often briefly
//     nonsense, and a black panel that stays black is much harder to get out
//     of than a picture that simply has not caught up yet.
//   • uniforms are read straight out of engine.PARAMS, which is where the
//     cables have already written this frame's values. So a signal reaches
//     the GPU through exactly the machinery that drives an oscillator.
//
// Honors prefers-reduced-motion by freezing the time term — the picture keeps
// reacting to what you play, it just stops moving on its own.

import { engine }      from './engine.js';
import { shadergraph, VERTEX } from './shadergraph.js';

export const shader = (() => {
  let gl = null, canvas = null, prog = null;
  let builtRevision = -1;
  let uniforms = [];               // { key, name, loc }
  let builtins = {};               // u_res / u_time / u_level locations
  let t0 = 0, active = false;
  let lastError = null;
  let listeners = [];

  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function compileStage(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(log || 'shader failed to compile');
    }
    return s;
  }

  // Build a program from source. Everything it allocates is freed on the way
  // out, success or failure: a patch being edited recompiles on almost every
  // keystroke-equivalent, and leaked programs are how a long session ends up
  // out of GPU memory.
  function build(fragSrc) {
    const vs = compileStage(gl.VERTEX_SHADER, VERTEX);
    let fs;
    try {
      fs = compileStage(gl.FRAGMENT_SHADER, fragSrc);
    } catch (e) {
      gl.deleteShader(vs);
      throw e;
    }
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    // Attached shaders are reference-counted by the program; deleting them
    // here means they go the moment the program does.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(log || 'shader failed to link');
    }
    return p;
  }

  function bindAttributes(p) {
    const loc = gl.getAttribLocation(p, 'p');
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  // Bring the GL program into step with the graph. Returns true if there is
  // something to draw with.
  function sync() {
    if (!gl) return false;
    if (prog && builtRevision === shadergraph.revision) return true;
    const built = shadergraph.compile();
    // Take the revision even when the compile is refused, so a patch that
    // cannot compile is attempted once rather than on every single frame.
    builtRevision = shadergraph.revision;
    if (!built.frag) { lastError = built.error; notify(); return !!prog; }
    let next;
    try {
      next = build(built.frag);
    } catch (e) {
      lastError = String(e.message || e);
      notify();
      return !!prog;                       // keep drawing the last good one
    }
    if (prog) gl.deleteProgram(prog);
    prog = next;
    gl.useProgram(prog);
    bindAttributes(prog);
    builtins = {
      res:   gl.getUniformLocation(prog, 'u_res'),
      time:  gl.getUniformLocation(prog, 'u_time'),
      level: gl.getUniformLocation(prog, 'u_level'),
    };
    // The uniform list comes from the compile that produced THIS program —
    // recompiling to ask again could hand back a different list if the graph
    // changed in between, and the locations would name the wrong sockets.
    uniforms = built.uniforms.map(u => ({
      ...u, loc: gl.getUniformLocation(prog, u.name),
    }));
    lastError = null;
    notify();
    return true;
  }

  const notify = () => listeners.forEach(fn => { try { fn(lastError); } catch { /* a listener must not stop the draw */ } });

  function init(canvasId) {
    const el = document.getElementById(canvasId);
    if (!el) return false;
    canvas = el;
    prog = null; builtRevision = -1; uniforms = []; lastError = null;
    gl = canvas.getContext('webgl', { antialias: false, depth: false, alpha: false })
      || canvas.getContext('experimental-webgl', { antialias: false, depth: false, alpha: false });
    if (!gl) { lastError = 'This device has no WebGL.'; notify(); return false; }
    // One triangle big enough to cover the screen — cheaper than two, and
    // there is no seam down the diagonal for a pattern to catch on.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    t0 = performance.now();
    return sync();
  }

  // RMS of the current waveform, the same measure the oscilloscope draws.
  function level() {
    const w = engine.getWaveform?.();
    if (!w) return 0;
    let s = 0;
    for (let i = 0; i < w.length; i++) s += w[i] * w[i];
    return Math.min(1, Math.sqrt(s / w.length) * 3);
  }

  function render() {
    if (!active || !gl || !canvas) return;
    if (!sync() || !prog) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round((canvas.clientWidth || 240) * dpr));
    const h = Math.max(1, Math.round((canvas.clientHeight || 120) * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.useProgram(prog);
    if (builtins.res)   gl.uniform2f(builtins.res, w, h);
    if (builtins.time)  gl.uniform1f(builtins.time, reduced() ? 0 : (performance.now() - t0) / 1000);
    if (builtins.level) gl.uniform1f(builtins.level, level());
    for (const u of uniforms) {
      if (!u.loc) continue;
      const p = engine.PARAMS[u.key];
      // A parameter that has gone (its node was deleted between compile and
      // draw) reads as its resting zero rather than as NaN, which would
      // blank the picture.
      gl.uniform1f(u.loc, Number.isFinite(p?.val) ? p.val : 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    init,
    render,
    setActive(on) { active = !!on; },
    get active() { return active; },
    get error() { return lastError; },
    get ready() { return !!prog; },
    // The UI shows compile errors beside the picture; this is how it hears.
    onStatus(fn) { listeners.push(fn); return () => { listeners = listeners.filter(f => f !== fn); }; },
    // Force a rebuild — for a context that was lost and restored.
    invalidate() { builtRevision = -1; },

    serialize: () => ({ v: 2, active, graph: shadergraph.serialize() }),
    load(s) {
      if (!s) return;
      active = !!s.active;
      // v1 patches were three fixed patterns and two signal choices, with no
      // graph in them. There is no honest translation of "Plasma" into nodes,
      // so such a patch opens on the starter graph — the shader is the one
      // part of a saved preset that changes shape here, and a working picture
      // is a better landing than an empty canvas.
      if (s.graph) shadergraph.load(s.graph);
      else shadergraph.reset();
      builtRevision = -1;
    },
  };
})();
