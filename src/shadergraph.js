// Visual shaders, as nodes on the same canvas as everything else.
//
// The audio patchbay's function nodes (graph.js) compute ONE number per
// frame. A shader computes a number per PIXEL, sixty times a second, and no
// amount of JavaScript gets you there — so these nodes are not evaluated,
// they are COMPILED. The graph you wire is read once, turned into a GLSL
// fragment shader, and handed to the GPU; it recompiles only when the shape
// of the patch changes.
//
// What keeps that from being a separate world with its own everything is the
// deal struck at the sockets:
//
//   • every FLOAT input registers as an engine parameter (`shx_<id>_<in>`,
//     under the picker's SHADER category) exactly as a function node's input
//     does — so an ordinary cable from any signal drives it, curves, ranges
//     and all, and arrives as a `uniform float`. Wire a wrist to a noise
//     node's scale and the noise breathes with your arm.
//   • every node's OUTPUT is a socket too, but it carries a colour or a
//     coordinate rather than a number, so it is NOT a bus signal: shader
//     sockets connect to shader sockets, and those links live here.
//
// So an input socket accepts either kind of cable — a signal from the bus,
// or a colour from another shader node — and the canvas draws both the same
// way. The one thing that cannot happen is the reverse: a per-pixel colour
// has no single value, so it can never drive an audio parameter. connect()
// is where that rule lives.
//
// This module is the model and the compiler only. It touches no DOM and no
// WebGL — it returns shader SOURCE as a string — so it runs under
// `node --test` (tests/unit/shadergraph.test.js). src/shader.js owns the GL
// context that compiles what comes out of here, and src/ui/shadernode-ui.js
// draws the nodes.

import { engine }   from './engine.js';
import { isRecord } from './is.js';

// ── Types ────────────────────────────────────────────────────────────────
//
// Three, and no more. A shader graph could carry vec4s, matrices and
// samplers; a graph you wire with your thumb on a phone should carry the
// fewest types that still express "where am I", "how much" and "what
// colour". Alpha is not among them — the output is opaque.
export const TYPES = ['float', 'vec2', 'vec3'];

// Anything can feed anything: a socket that receives the wrong type converts
// rather than refusing. Refusing would mean explaining the type system
// through a disabled socket, and these conversions are all the obvious ones.
// A float spreads across every component, a colour collapses to its average,
// and a coordinate keeps the components it has.
const CAST = {
  'float:vec2': e => `vec2(${e})`,
  'float:vec3': e => `vec3(${e})`,
  'vec2:float': e => `(${e}).x`,
  'vec2:vec3':  e => `vec3(${e}, 0.0)`,
  'vec3:float': e => `dot(${e}, vec3(0.3333333))`,
  'vec3:vec2':  e => `(${e}).xy`,
};
export const cast = (expr, from, to) =>
  (from === to ? expr : (CAST[`${from}:${to}`]?.(expr) ?? expr));

// Cosine-palette coefficients, as GLSL literals: a, b, c, d in
// a + b·cos(τ(c·t + d)). Declared up here because the Palette node reads the
// key list for its own choice list, which is evaluated as the table below is
// built rather than when a shader is compiled.
const PALETTES = {
  spectrum: ['vec3(0.5)', 'vec3(0.5)', 'vec3(1.0)', 'vec3(0.0, 0.33, 0.67)'],
  warm:     ['vec3(0.6, 0.35, 0.25)', 'vec3(0.45, 0.3, 0.2)', 'vec3(1.0, 0.9, 0.8)', 'vec3(0.0, 0.1, 0.2)'],
  cool:     ['vec3(0.3, 0.45, 0.6)', 'vec3(0.3, 0.35, 0.45)', 'vec3(1.0, 1.0, 0.9)', 'vec3(0.4, 0.55, 0.7)'],
  mono:     ['vec3(0.55)', 'vec3(0.45)', 'vec3(1.0)', 'vec3(0.0)'],
  candy:    ['vec3(0.65, 0.5, 0.6)', 'vec3(0.35, 0.45, 0.4)', 'vec3(1.0, 0.9, 1.0)', 'vec3(0.0, 0.25, 0.55)'],
};

// ── The node catalogue ───────────────────────────────────────────────────
//
// Each entry declares its sockets and how to write itself as one GLSL
// expression. `glsl(node, a)` receives the input expressions already cast to
// the declared types, in declaration order, and returns an expression of the
// declared output type — so a node never has to care whether an input came
// from a cable, a uniform or a default.
//
// An input's `dflt` is what it reads with nothing wired:
//   • a NUMBER on a float input makes it a uniform — an engine parameter a
//     signal cable can drive, resting at that value. This is most of them.
//   • `'uv'` on a vec2 input means the pixel's own coordinate, so a pattern
//     node dropped on the canvas with nothing wired already paints something.
//   • a STRING elsewhere is a literal GLSL expression.
//
// `cat` groups the node in the add menu. Every function here is pure and
// every loop is bounded, because a fragment shader that branches unbounded
// stalls a phone GPU rather than running slowly.
export const SHADER_NODES = {

  // ── Sources ────────────────────────────────────────────────────────────
  uv: {
    name: 'UV', cat: 'Source', out: 'vec2', ins: [],
    glsl: () => `vUv`,
    help: 'The pixel’s place on the screen, 0–1 across and up.',
  },
  coord: {
    name: 'Centred', cat: 'Source', out: 'vec2', ins: [],
    // Aspect-corrected and centred on zero: what every distance field wants,
    // and getting it wrong is why circles come out as ellipses.
    glsl: () => `vCoord`,
    help: 'Centred on the middle, corrected for the panel’s shape.',
  },
  time: {
    name: 'Time', cat: 'Source', out: 'float',
    ins: [{ name: 'speed', type: 'float', dflt: 0.5 }],
    // Speed is a uniform like any other, so time itself is wirable: drive it
    // from the metronome's beat and the whole picture runs on the bar.
    glsl: (n, a) => `(u_time * ${a[0]} * 2.0)`,
    help: 'Seconds since the shader started, times speed.',
  },
  level: {
    name: 'Audio Level', cat: 'Source', out: 'float', ins: [],
    glsl: () => `u_level`,
    help: 'How loud the instrument is right now, 0–1.',
  },
  value: {
    name: 'Value', cat: 'Source', out: 'float',
    ins: [{ name: 'value', type: 'float', dflt: 0.5 }],
    glsl: (n, a) => a[0],
    help: 'A number. Wire a signal into it and it is that signal.',
  },
  rgb: {
    name: 'RGB', cat: 'Source', out: 'vec3',
    ins: [{ name: 'r', type: 'float', dflt: 0.9 },
          { name: 'g', type: 'float', dflt: 0.4 },
          { name: 'b', type: 'float', dflt: 0.2 }],
    glsl: (n, a) => `vec3(${a[0]}, ${a[1]}, ${a[2]})`,
    help: 'A colour from three numbers.',
  },

  // ── Coordinates ────────────────────────────────────────────────────────
  polar: {
    name: 'Polar', cat: 'Coordinate', out: 'vec2',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' }],
    // x is the distance from the centre, y is the angle as 0–1 rather than
    // radians, so it can feed a pattern node without scaling.
    glsl: (n, a) => `vec2(length(${a[0]}), atan((${a[0]}).y, (${a[0]}).x) / TAU + 0.5)`,
    help: 'Distance from the centre, and angle around it.',
  },
  rotate: {
    name: 'Rotate', cat: 'Coordinate', out: 'vec2',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' },
          { name: 'angle', type: 'float', dflt: 0 }],
    glsl: (n, a) => `sgRot(${a[0]}, ${a[1]} * TAU)`,
    help: 'Turns the coordinate about the centre.',
  },
  scale2: {
    name: 'Scale', cat: 'Coordinate', out: 'vec2',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' },
          { name: 'scale', type: 'float', dflt: 0.5 }],
    // 0.5 is unity so the slider opens in the middle and zooms both ways.
    glsl: (n, a) => `(${a[0]} * sgExp(${a[1]}, 8.0))`,
    help: 'Zooms the coordinate in or out. Half is unchanged.',
  },
  translate: {
    name: 'Offset', cat: 'Coordinate', out: 'vec2',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' },
          { name: 'x', type: 'float', dflt: 0.5 },
          { name: 'y', type: 'float', dflt: 0.5 }],
    glsl: (n, a) => `(${a[0]} + vec2(${a[1]} - 0.5, ${a[2]} - 0.5) * 2.0)`,
    help: 'Slides the coordinate. Half is unmoved.',
  },
  tile: {
    name: 'Tile', cat: 'Coordinate', out: 'vec2',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' },
          { name: 'count', type: 'float', dflt: 0.3 }],
    // Each tile gets the same -1..1 coordinate, so whatever is downstream
    // repeats without knowing it has been tiled.
    glsl: (n, a) => `(fract(${a[0]} * (1.0 + ${a[1]} * 11.0)) * 2.0 - 1.0)`,
    help: 'Repeats the coordinate in a grid.',
  },
  kaleido: {
    name: 'Kaleidoscope', cat: 'Coordinate', out: 'vec2',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' },
          { name: 'segments', type: 'float', dflt: 0.4 }],
    glsl: (n, a) => `sgKaleido(${a[0]}, floor(2.0 + ${a[1]} * 14.0))`,
    help: 'Mirrors the coordinate into a wedge, repeated round.',
  },
  swirl: {
    name: 'Swirl', cat: 'Coordinate', out: 'vec2',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' },
          { name: 'amount', type: 'float', dflt: 0.5 }],
    glsl: (n, a) => `sgRot(${a[0]}, (${a[1]} - 0.5) * 6.0 * length(${a[0]}))`,
    help: 'Twists harder the further from the centre.',
  },

  // ── Patterns ───────────────────────────────────────────────────────────
  gradient: {
    name: 'Gradient', cat: 'Pattern', out: 'float',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'uv' },
          { name: 'angle', type: 'float', dflt: 0 }],
    glsl: (n, a) => `clamp(dot(${a[0]} - 0.5, sgDir(${a[1]} * TAU)) + 0.5, 0.0, 1.0)`,
    help: 'A ramp from dark to light across a direction.',
  },
  radial: {
    name: 'Radial', cat: 'Pattern', out: 'float',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' }],
    glsl: (n, a) => `clamp(length(${a[0]}), 0.0, 1.0)`,
    help: 'Zero at the centre, one at the edge.',
  },
  checker: {
    name: 'Checker', cat: 'Pattern', out: 'float',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'uv' },
          { name: 'count', type: 'float', dflt: 0.3 }],
    glsl: (n, a) => `sgChecker(${a[0]}, floor(1.0 + ${a[1]} * 15.0))`,
    help: 'A chequerboard of squares.',
  },
  stripes: {
    name: 'Stripes', cat: 'Pattern', out: 'float',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'uv' },
          { name: 'count', type: 'float', dflt: 0.3 },
          { name: 'angle', type: 'float', dflt: 0 },
          { name: 'softness', type: 'float', dflt: 0.2 }],
    glsl: (n, a) =>
      `sgStripe(dot(${a[0]} - 0.5, sgDir(${a[2]} * TAU)) * (1.0 + ${a[1]} * 23.0), ${a[3]})`,
    help: 'Parallel bands, as hard or as soft as you like.',
  },
  circle: {
    name: 'Circle', cat: 'Pattern', out: 'float',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' },
          { name: 'radius', type: 'float', dflt: 0.4 },
          { name: 'softness', type: 'float', dflt: 0.1 }],
    glsl: (n, a) => `smoothstep(${a[1]} + ${a[2]} * 0.5 + 0.001, ${a[1]} - ${a[2]} * 0.5 - 0.001, length(${a[0]}))`,
    help: 'A filled disc. Wire the radius to make it pulse.',
  },
  ring: {
    name: 'Ring', cat: 'Pattern', out: 'float',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' },
          { name: 'radius', type: 'float', dflt: 0.4 },
          { name: 'width', type: 'float', dflt: 0.1 }],
    glsl: (n, a) => `(1.0 - smoothstep(0.0, ${a[2]} * 0.5 + 0.001, abs(length(${a[0]}) - ${a[1]})))`,
    help: 'The outline of a circle.',
  },
  box: {
    name: 'Box', cat: 'Pattern', out: 'float',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'coord' },
          { name: 'width', type: 'float', dflt: 0.4 },
          { name: 'height', type: 'float', dflt: 0.4 },
          { name: 'softness', type: 'float', dflt: 0.05 }],
    glsl: (n, a) => `sgBox(${a[0]}, vec2(${a[1]}, ${a[2]}), ${a[3]})`,
    help: 'A filled rectangle.',
  },
  wave: {
    name: 'Wave', cat: 'Pattern', out: 'float',
    ins: [{ name: 'x', type: 'float', dflt: 0 },
          { name: 'freq', type: 'float', dflt: 0.3 },
          { name: 'phase', type: 'float', dflt: 0 }],
    opts: { waveform: { kind: 'choice', of: ['sine', 'triangle', 'square', 'saw'], dflt: 'sine' } },
    glsl: (n, a) => {
      const p = `(${a[0]} * (1.0 + ${a[1]} * 23.0) + ${a[2]})`;
      switch (n.opts.waveform) {
        case 'triangle': return `(1.0 - abs(fract(${p}) * 2.0 - 1.0))`;
        case 'square':   return `step(0.5, fract(${p}))`;
        case 'saw':      return `fract(${p})`;
        default:         return `(0.5 + 0.5 * sin(${p} * TAU))`;
      }
    },
    help: 'Turns a number into a repeating wave.',
  },
  noise: {
    name: 'Noise', cat: 'Pattern', out: 'float',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'uv' },
          { name: 'scale', type: 'float', dflt: 0.35 }],
    glsl: (n, a) => `sgNoise(${a[0]} * (1.0 + ${a[1]} * 23.0))`,
    help: 'Smooth random blobs.',
  },
  fbm: {
    name: 'Clouds', cat: 'Pattern', out: 'float',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'uv' },
          { name: 'scale', type: 'float', dflt: 0.3 },
          { name: 'detail', type: 'float', dflt: 0.6 }],
    // Five octaves, fixed: the count has to be a compile-time constant for
    // the loop to unroll on every GL driver, so `detail` fades the later
    // octaves in rather than adding more of them.
    glsl: (n, a) => `sgFbm(${a[0]} * (1.0 + ${a[1]} * 15.0), ${a[2]})`,
    help: 'Noise stacked at several sizes — smoke, marble, cloud.',
  },
  voronoi: {
    name: 'Cells', cat: 'Pattern', out: 'float',
    ins: [{ name: 'uv', type: 'vec2', dflt: 'uv' },
          { name: 'scale', type: 'float', dflt: 0.3 }],
    glsl: (n, a) => `sgVoronoi(${a[0]} * (1.0 + ${a[1]} * 15.0))`,
    help: 'Scattered cells, like cracked glass or scales.',
  },

  // ── Maths ──────────────────────────────────────────────────────────────
  math: {
    name: 'Math', cat: 'Math', out: 'float',
    ins: [{ name: 'a', type: 'float', dflt: 0.5 },
          { name: 'b', type: 'float', dflt: 0.5 }],
    opts: { op: { kind: 'choice', of: ['add', 'sub', 'mul', 'div', 'min', 'max', 'pow', 'mod'], dflt: 'mul' } },
    glsl: (n, a) => {
      switch (n.opts.op) {
        case 'add': return `(${a[0]} + ${a[1]})`;
        case 'sub': return `(${a[0]} - ${a[1]})`;
        case 'div': return `(${a[0]} / max(${a[1]}, 1e-4))`;
        case 'min': return `min(${a[0]}, ${a[1]})`;
        case 'max': return `max(${a[0]}, ${a[1]})`;
        case 'pow': return `pow(max(${a[0]}, 0.0), max(${a[1]} * 4.0, 1e-3))`;
        case 'mod': return `mod(${a[0]}, max(${a[1]}, 1e-4))`;
        default:    return `(${a[0]} * ${a[1]})`;
      }
    },
    help: 'Two numbers in, one out.',
  },
  unary: {
    name: 'Curve', cat: 'Math', out: 'float',
    ins: [{ name: 'x', type: 'float', dflt: 0.5 }],
    opts: { op: { kind: 'choice', of: ['invert', 'sin', 'abs', 'fract', 'floor', 'sqrt', 'square', 'sign'], dflt: 'invert' } },
    glsl: (n, a) => {
      switch (n.opts.op) {
        case 'sin':    return `(0.5 + 0.5 * sin(${a[0]} * TAU))`;
        case 'abs':    return `abs(${a[0]} * 2.0 - 1.0)`;
        case 'fract':  return `fract(${a[0]})`;
        case 'floor':  return `floor(${a[0]})`;
        case 'sqrt':   return `sqrt(max(${a[0]}, 0.0))`;
        case 'square': return `(${a[0]} * ${a[0]})`;
        case 'sign':   return `step(0.5, ${a[0]})`;
        default:       return `(1.0 - ${a[0]})`;
      }
    },
    help: 'Bends one number.',
  },
  mix: {
    name: 'Mix', cat: 'Math', out: 'vec3',
    ins: [{ name: 'a', type: 'vec3', dflt: 'vec3(0.0)' },
          { name: 'b', type: 'vec3', dflt: 'vec3(1.0)' },
          { name: 'mix', type: 'float', dflt: 0.5 }],
    // Typed vec3 but a float feeds it happily through the cast, so this is
    // the blend node for numbers and for colours alike.
    glsl: (n, a) => `mix(${a[0]}, ${a[1]}, clamp(${a[2]}, 0.0, 1.0))`,
    help: 'Fades between two things.',
  },
  clamp: {
    name: 'Clamp', cat: 'Math', out: 'float',
    ins: [{ name: 'x', type: 'float', dflt: 0.5 },
          { name: 'low', type: 'float', dflt: 0 },
          { name: 'high', type: 'float', dflt: 1 }],
    glsl: (n, a) => `clamp(${a[0]}, min(${a[1]}, ${a[2]}), max(${a[1]}, ${a[2]}))`,
    help: 'Keeps a number inside a range.',
  },
  smoothstep: {
    name: 'Threshold', cat: 'Math', out: 'float',
    ins: [{ name: 'x', type: 'float', dflt: 0.5 },
          { name: 'edge', type: 'float', dflt: 0.5 },
          { name: 'softness', type: 'float', dflt: 0.1 }],
    glsl: (n, a) => `smoothstep(${a[1]} - ${a[2]} * 0.5 - 1e-4, ${a[1]} + ${a[2]} * 0.5 + 1e-4, ${a[0]})`,
    help: 'Turns a ramp into an edge, hard or soft.',
  },
  remap: {
    name: 'Remap', cat: 'Math', out: 'float',
    ins: [{ name: 'x', type: 'float', dflt: 0.5 },
          { name: 'out low', type: 'float', dflt: 0 },
          { name: 'out high', type: 'float', dflt: 1 }],
    glsl: (n, a) => `mix(${a[1]}, ${a[2]}, clamp(${a[0]}, 0.0, 1.0))`,
    help: 'Stretches 0–1 into a different range.',
  },

  // ── Vectors ────────────────────────────────────────────────────────────
  combine: {
    name: 'Combine', cat: 'Vector', out: 'vec3',
    ins: [{ name: 'x', type: 'float', dflt: 0 },
          { name: 'y', type: 'float', dflt: 0 },
          { name: 'z', type: 'float', dflt: 0 }],
    glsl: (n, a) => `vec3(${a[0]}, ${a[1]}, ${a[2]})`,
    help: 'Three numbers into one colour or coordinate.',
  },
  split: {
    name: 'Split', cat: 'Vector', out: 'float',
    ins: [{ name: 'in', type: 'vec3', dflt: 'vec3(0.5)' }],
    opts: { channel: { kind: 'choice', of: ['x', 'y', 'z'], dflt: 'x' } },
    glsl: (n, a) => `(${a[0]}).${n.opts.channel}`,
    help: 'Takes one component back out.',
  },
  length: {
    name: 'Length', cat: 'Vector', out: 'float',
    ins: [{ name: 'in', type: 'vec2', dflt: 'coord' }],
    glsl: (n, a) => `length(${a[0]})`,
    help: 'How far a coordinate is from zero.',
  },

  // ── Colour ─────────────────────────────────────────────────────────────
  palette: {
    name: 'Palette', cat: 'Colour', out: 'vec3',
    ins: [{ name: 't', type: 'float', dflt: 0.5 },
          { name: 'shift', type: 'float', dflt: 0 }],
    opts: { scheme: { kind: 'choice', of: Object.keys(PALETTES), dflt: 'spectrum' } },
    // Iñigo Quílez's cosine palettes: four vec3s make every smooth ramp
    // worth having, and they cost three cosines rather than a texture.
    glsl: (n, a) => {
      const P = PALETTES[n.opts.scheme] ?? PALETTES.spectrum;
      return `sgPal(${a[0]} + ${a[1]}, ${P[0]}, ${P[1]}, ${P[2]}, ${P[3]})`;
    },
    help: 'Turns a number into a colour along a ramp.',
  },
  hsv: {
    name: 'HSV', cat: 'Colour', out: 'vec3',
    ins: [{ name: 'hue', type: 'float', dflt: 0.5 },
          { name: 'saturation', type: 'float', dflt: 0.8 },
          { name: 'value', type: 'float', dflt: 1 }],
    glsl: (n, a) => `sgHsv(vec3(${a[0]}, ${a[1]}, ${a[2]}))`,
    help: 'A colour by hue, saturation and brightness.',
  },
  levels: {
    name: 'Levels', cat: 'Colour', out: 'vec3',
    ins: [{ name: 'colour', type: 'vec3', dflt: 'vec3(0.5)' },
          { name: 'brightness', type: 'float', dflt: 0.5 },
          { name: 'contrast', type: 'float', dflt: 0.5 }],
    glsl: (n, a) => `clamp((${a[0]} - 0.5) * (${a[2]} * 2.0) + 0.5 + (${a[1]} - 0.5), 0.0, 1.0)`,
    help: 'Brightness and contrast. Half of each leaves it alone.',
  },
  saturate: {
    name: 'Saturation', cat: 'Colour', out: 'vec3',
    ins: [{ name: 'colour', type: 'vec3', dflt: 'vec3(0.5)' },
          { name: 'amount', type: 'float', dflt: 0.5 }],
    glsl: (n, a) => `clamp(mix(vec3(dot(${a[0]}, vec3(0.2126, 0.7152, 0.0722))), ${a[0]}, ${a[1]} * 2.0), 0.0, 1.0)`,
    help: 'Drains the colour out, or pushes it further in.',
  },
  invert: {
    name: 'Invert', cat: 'Colour', out: 'vec3',
    ins: [{ name: 'colour', type: 'vec3', dflt: 'vec3(0.5)' }],
    glsl: (n, a) => `(1.0 - ${a[0]})`,
    help: 'The photographic negative.',
  },
  gamma: {
    name: 'Gamma', cat: 'Colour', out: 'vec3',
    ins: [{ name: 'colour', type: 'vec3', dflt: 'vec3(0.5)' },
          { name: 'gamma', type: 'float', dflt: 0.5 }],
    glsl: (n, a) => `pow(max(${a[0]}, 0.0), vec3(sgExp(1.0 - ${a[1]}, 8.0)))`,
    help: 'Lifts the shadows or crushes them.',
  },

  // ── Output ─────────────────────────────────────────────────────────────
  out: {
    name: 'Output', cat: 'Output', out: 'vec3',
    ins: [{ name: 'colour', type: 'vec3', dflt: 'vec3(0.0)' }],
    glsl: (n, a) => a[0],
    terminal: true,
    help: 'What you see. Everything upstream of this is the picture.',
  },
};


export const CATS = ['Source', 'Coordinate', 'Pattern', 'Math', 'Vector', 'Colour', 'Output'];

// ── Socket keys ──────────────────────────────────────────────────────────
// `shx_<id>` is a node's output; `shx_<id>_<in>` is one of its inputs, which
// is also the engine-parameter key a signal cable lands on. Input names are
// slugged because they become identifiers in GLSL as well as keys here.
export const slug = s => String(s).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
export const shxOutKey   = id => `shx_${id}`;
export const shxInKey    = (id, name) => `shx_${id}_${slug(name)}`;
export const nodeIdOf    = key => { const m = /^shx_(\d+)(?:_|$)/.exec(String(key)); return m ? +m[1] : null; };
export const isShaderKey = key => /^shx_\d+/.test(String(key));
export const isShaderOut = key => /^shx_\d+$/.test(String(key));

const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

// The helper functions every compiled shader carries. They are emitted whole
// rather than on demand: the whole preamble is under 2 KB, a driver strips
// what a shader does not call, and picking through which helper needs which
// other helper is a bug farm for no measurable gain.
const PRELUDE = `
precision highp float;
#define TAU 6.28318530718
uniform vec2  u_res;
uniform float u_time;
uniform float u_level;
varying vec2 vUv;
varying vec2 vCoord;

// 0..1 in, an exponential factor around 1.0 out: 0.5 is unity, 0 is 1/range
// and 1 is range. Every "scale" and "zoom" socket goes through this so the
// middle of a slider is "unchanged" and both halves feel the same.
float sgExp(float t, float range) { return pow(range, (t - 0.5) * 2.0); }
vec2  sgDir(float a) { return vec2(cos(a), sin(a)); }
vec2  sgRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

vec2 sgKaleido(vec2 p, float seg) {
  float a = atan(p.y, p.x), r = length(p);
  float w = TAU / seg;
  a = abs(mod(a + w * 0.5, w) - w * 0.5);
  return vec2(cos(a), sin(a)) * r;
}

float sgChecker(vec2 p, float n) {
  vec2 c = floor(p * n);
  return mod(c.x + c.y, 2.0);
}

// A band whose edge softness is a control rather than a constant: at 0 it is
// a hard stripe, at 1 it is a sine.
//
// The obvious anti-aliasing here is fwidth(), and it is deliberately not
// used: screen-space derivatives are an EXTENSION in WebGL 1
// (OES_standard_derivatives), so a shader calling fwidth fails to compile
// outright on a driver that lacks it — the whole picture, not just the edge.
// A small fixed epsilon costs one shimmering pixel on very fine stripes and
// compiles everywhere.
float sgStripe(float x, float soft) {
  float f = fract(x);
  float tri = abs(f * 2.0 - 1.0);
  return mix(smoothstep(0.52, 0.48, tri), 1.0 - tri, clamp(soft, 0.0, 1.0));
}

float sgBox(vec2 p, vec2 b, float soft) {
  vec2 d = abs(p) - b;
  float o = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  return smoothstep(soft * 0.5 + 1e-4, -soft * 0.5 - 1e-4, o);
}

float sgHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Value noise with a smoothstep fade — cheaper than gradient noise and, at
// the sizes a panel this big shows, indistinguishable from it.
float sgNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sgHash(i), sgHash(i + vec2(1.0, 0.0)), f.x),
             mix(sgHash(i + vec2(0.0, 1.0)), sgHash(i + vec2(1.0)), f.x), f.y);
}

float sgFbm(vec2 p, float detail) {
  float s = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 5; i++) {
    // Octaves past the first fade in with detail, so one control walks
    // from a soft blur to full grain without changing the loop count.
    float w = amp * clamp(detail * 5.0 - float(i) + 1.0, 0.0, 1.0);
    s += w * sgNoise(p);
    norm += w;
    p *= 2.02; amp *= 0.5;
  }
  return norm > 0.0 ? s / norm : 0.0;
}

float sgVoronoi(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float best = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = vec2(sgHash(i + g), sgHash(i + g + 17.0));
      best = min(best, length(g + o - f));
    }
  }
  return clamp(best, 0.0, 1.0);
}

vec3 sgPal(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return clamp(a + b * cos(TAU * (c * t + d)), 0.0, 1.0);
}

vec3 sgHsv(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
`;

export const VERTEX = `
attribute vec2 p;
uniform vec2 u_res;
varying vec2 vUv;
varying vec2 vCoord;
void main() {
  vUv = p * 0.5 + 0.5;
  vCoord = (vUv - 0.5) * vec2(max(u_res.x / max(u_res.y, 1.0), 1e-3), 1.0) * 2.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// The picture a brand-new patch shows: drifting cloud, coloured through a
// palette that cycles with time. Four nodes, because the first thing anyone
// sees should be a working image AND a readable example of how one is built —
// a pattern, a colouriser, something driving it, and the output.
//
// It moves on its own rather than waiting for sound: the app opens muted, so
// a starter that only reacted to the audio level would look broken until you
// unmuted. Someone who has asked their OS for reduced motion gets it still,
// because u_time is frozen for them at the runtime.
export const STARTER = [
  { id: 1, type: 'fbm',     opts: {} },
  { id: 2, type: 'palette', opts: { scheme: 'spectrum' } },
  { id: 3, type: 'out',     opts: {} },
  { id: 4, type: 'time',    opts: {} },
];
export const STARTER_LINKS = [
  { from: 1, to: shxInKey(2, 't') },
  { from: 4, to: shxInKey(2, 'shift') },
  { from: 2, to: shxInKey(3, 'colour') },
];

// ── The graph ────────────────────────────────────────────────────────────

export const shadergraph = (() => {
  let nodes = [];          // { id, type, opts }
  let links = [];          // { id, from: <nodeId>, to: <inputKey> }
  let nextId = 1, nextLink = 1;
  let revision = 0;        // bumped whenever the COMPILED shape changes
  const dirty = () => { revision++; };

  const byId = id => nodes.find(n => n.id === id) ?? null;
  const declOf = n => SHADER_NODES[n.type];
  const defaultOpts = type => Object.fromEntries(
    Object.entries(SHADER_NODES[type].opts ?? {}).map(([k, o]) => [k, o.dflt]));

  // A float input is an engine parameter, so an ordinary signal cable can
  // drive it. vec2 and vec3 inputs are not: there is no such thing as a
  // scalar signal that means "a colour", and offering the socket would only
  // invite a cable that cannot be honoured.
  const uniformIns = n => (declOf(n)?.ins ?? []).filter(s => s.type === 'float');

  const registerIO = node => {
    const t = declOf(node);
    const defs = {};
    for (const s of uniformIns(node)) {
      defs[shxInKey(node.id, s.name)] = {
        label: `▨${node.id} ${t.name} · ${s.name.toUpperCase()}`,
        min: 0, max: 1, val: clamp01(s.dflt),
      };
    }
    if (Object.keys(defs).length) engine.registerParams(defs);
  };
  const unregisterIO = node => {
    const keys = uniformIns(node).map(s => shxInKey(node.id, s.name));
    if (keys.length) engine.unregisterParams(keys);
  };

  const api = {
    nodes: () => nodes.map(n => ({ id: n.id, type: n.type, opts: { ...n.opts } })),
    links: () => links.map(l => ({ ...l })),
    get revision() { return revision; },

    // Every float input, for params.js — the SHADER category of the picker.
    inputKeys: () => nodes.flatMap(n => uniformIns(n).map(s => shxInKey(n.id, s.name))),

    // Every socket, for the canvas: inputs of all types plus the one output.
    socketsOf(id) {
      const n = byId(id);
      if (!n) return { ins: [], out: null };
      const t = declOf(n);
      return {
        ins: t.ins.map(s => ({ ...s, key: shxInKey(id, s.name), uniform: s.type === 'float' })),
        out: t.terminal ? null : { key: shxOutKey(id), type: t.out },
      };
    },

    typeOfKey(key) {
      const id = nodeIdOf(key);
      const n = id == null ? null : byId(id);
      if (!n) return null;
      if (isShaderOut(key)) return declOf(n).out;
      return declOf(n).ins.find(s => shxInKey(id, s.name) === key)?.type ?? null;
    },

    add(type, { id = null } = {}) {
      if (!SHADER_NODES[type]) return null;
      // One output node, always: two terminals would be two pictures, and
      // there is one panel. Adding a second returns the one already there.
      if (SHADER_NODES[type].terminal) {
        const existing = nodes.find(n => SHADER_NODES[n.type].terminal);
        if (existing) return existing.id;
      }
      const nid = id ?? nextId++;
      const node = { id: nid, type, opts: defaultOpts(type) };
      nodes.push(node);
      nextId = Math.max(nextId, nid + 1);
      registerIO(node);
      dirty();
      return nid;
    },

    remove(id) {
      const i = nodes.findIndex(n => n.id === id);
      if (i < 0) return false;
      unregisterIO(nodes[i]);
      nodes.splice(i, 1);
      links = links.filter(l => l.from !== id && nodeIdOf(l.to) !== id);
      dirty();
      return true;
    },

    // Wire a node's output into an input socket. Returns the link id, or
    // null if the patch would not make sense.
    connect(fromNodeId, toKey) {
      const from = byId(fromNodeId);
      const toId = nodeIdOf(toKey);
      const to = toId == null ? null : byId(toId);
      if (!from || !to || declOf(from).terminal) return null;
      if (!declOf(to).ins.some(s => shxInKey(toId, s.name) === toKey)) return null;
      // A node feeding itself is a one-frame feedback loop in an audio
      // graph and simply undefined in a shader, which has no frames to
      // remember. Refuse it, and refuse the longer loops in compile().
      if (from.id === to.id) return null;
      links = links.filter(l => l.to !== toKey);      // an input takes one cable
      const link = { id: nextLink++, from: from.id, to: toKey };
      links.push(link);
      dirty();
      return link.id;
    },

    disconnect(linkId) {
      const before = links.length;
      links = links.filter(l => l.id !== linkId);
      if (links.length !== before) dirty();
      return links.length !== before;
    },
    disconnectInput(key) {
      const before = links.length;
      links = links.filter(l => l.to !== key);
      if (links.length !== before) dirty();
      return links.length !== before;
    },

    setOpt(id, key, value) {
      const n = byId(id);
      const decl = n && declOf(n).opts?.[key];
      if (!decl) return;
      const was = n.opts[key];
      if (decl.kind === 'choice') n.opts[key] = decl.of.includes(value) ? value : decl.dflt;
      else n.opts[key] = clamp01(Number(value));
      // An option is baked into the source, so changing one recompiles —
      // unlike a uniform, which is uploaded every frame for free.
      if (n.opts[key] !== was) dirty();
    },

    outputId: () => nodes.find(n => SHADER_NODES[n.type].terminal)?.id ?? null,

    // ── The compiler ─────────────────────────────────────────────────────
    //
    // Walks back from the output node, emits one `<type> v<id> = <expr>;` per
    // node in dependency order, and returns the whole fragment source plus
    // the uniforms it wants filled each frame.
    //
    // Only nodes the output actually reaches are emitted: an experiment left
    // unplugged at the side of the canvas costs nothing, which is what makes
    // it reasonable to leave one there.
    compile() {
      const uniforms = [];        // { key, name } — engine param → GLSL name
      const seenUniform = new Set();
      const uniformFor = (id, s) => {
        const key = shxInKey(id, s.name);
        const name = `u_${key}`;
        if (!seenUniform.has(key)) { seenUniform.add(key); uniforms.push({ key, name }); }
        return name;
      };

      const outId = api.outputId();
      if (outId == null) {
        return { frag: null, uniforms: [], error: 'no output node', order: [] };
      }

      const linkInto = key => links.find(l => l.to === key) ?? null;
      const exprOfVar = id => `v${id}`;
      const emitted = new Map();  // id → glsl type
      const body = [];
      const visiting = new Set();

      // Depth-first, emitting children before parents. A cycle is broken at
      // the seam by falling back to the socket's default — a shader has no
      // previous frame to read, so a loop is a mistake rather than a
      // feedback path, and the picture stays up instead of failing to
      // compile.
      const emit = id => {
        if (emitted.has(id)) return true;
        if (visiting.has(id)) return false;          // cycle
        const n = byId(id);
        if (!n) return false;
        visiting.add(id);
        const t = declOf(n);
        const args = t.ins.map(s => {
          const key = shxInKey(id, s.name);
          const l = linkInto(key);
          if (l && emit(l.from)) {
            const srcType = declOf(byId(l.from)).out;
            return cast(exprOfVar(l.from), srcType, s.type);
          }
          // Nothing wired (or the wire was a loop): the socket's own default.
          if (s.type === 'float') return uniformFor(id, s);
          if (s.dflt === 'uv') return 'vUv';
          if (s.dflt === 'coord') return 'vCoord';
          return String(s.dflt ?? (s.type === 'vec2' ? 'vec2(0.0)' : 'vec3(0.0)'));
        });
        visiting.delete(id);
        body.push(`  ${t.out} ${exprOfVar(id)} = ${t.glsl(n, args)};`);
        emitted.set(id, t.out);
        return true;
      };

      emit(outId);
      const outExpr = emitted.has(outId) ? exprOfVar(outId) : 'vec3(0.0)';

      const decls = uniforms.map(u => `uniform float ${u.name};`).join('\n');
      const frag = `${PRELUDE}\n${decls}\nvoid main() {\n${body.join('\n')}\n  gl_FragColor = vec4(clamp(${outExpr}, 0.0, 1.0), 1.0);\n}\n`;
      return { frag, uniforms, error: null, order: [...emitted.keys()] };
    },

    // ── Persistence ──────────────────────────────────────────────────────
    serialize: () => ({
      v: 1,
      nodes: nodes.map(n => ({ id: n.id, type: n.type, opts: { ...n.opts } })),
      links: links.map(l => ({ from: l.from, to: l.to })),
    }),

    load(saved) {
      for (const n of nodes.slice()) unregisterIO(n);
      nodes = []; links = []; nextId = 1; nextLink = 1;
      const list = Array.isArray(saved?.nodes) ? saved.nodes : null;
      if (!list) { dirty(); return; }
      for (const raw of list) {
        if (!isRecord(raw) || !SHADER_NODES[raw.type]) continue;
        // Saved ids are kept: the saved cables — and the saved workspace
        // positions, which key off `shx:<id>` — point at them.
        const id = api.add(raw.type, { id: Number.isInteger(raw.id) && raw.id > 0 && !byId(raw.id) ? raw.id : null });
        if (id != null && isRecord(raw.opts)) {
          for (const k of Object.keys(raw.opts)) api.setOpt(id, k, raw.opts[k]);
        }
      }
      for (const raw of (Array.isArray(saved.links) ? saved.links : [])) {
        if (isRecord(raw)) api.connect(raw.from, raw.to);
      }
      dirty();
    },

    // A working patch for a first visit, or for RESET.
    reset() {
      api.load({ nodes: STARTER, links: STARTER_LINKS });
    },

    clear() {
      for (const n of nodes.slice()) api.remove(n.id);
      nodes = []; links = []; nextId = 1;
      dirty();
    },
  };
  return api;
})();
