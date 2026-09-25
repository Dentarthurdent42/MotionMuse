// The shader graph — the node catalogue, the wiring rules and the compiler.
//
// The compiler is the part worth pinning hardest: it turns a patch into GLSL
// source, and a mistake there is a black panel rather than a stack trace.
// These tests read the emitted source, so they catch a node that forgets an
// argument, a cast that goes missing, or a cycle that would hang the walk.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { shadergraph, SHADER_NODES, shxInKey, cast, TYPES, VERTEX } =
  await import('../../src/shadergraph.js');
const { engine } = await import('../../src/engine.js');

const reset = () => shadergraph.clear();

// ── The catalogue ────────────────────────────────────────────────────────

test('every node declares a legal output type and legal input types', () => {
  for (const [key, t] of Object.entries(SHADER_NODES)) {
    assert.ok(t.name, `${key} has a name`);
    assert.ok(TYPES.includes(t.out), `${key} out type ${t.out} is legal`);
    assert.ok(Array.isArray(t.ins), `${key} declares ins`);
    for (const s of t.ins) {
      assert.ok(s.name, `${key} socket has a name`);
      assert.ok(TYPES.includes(s.type), `${key}.${s.name} type ${s.type} is legal`);
    }
    assert.ok(t.glsl instanceof Function, `${key} can write itself`);
    assert.ok(t.cat, `${key} is in a category`);
  }
});

test('exactly one node is terminal, and it is the output', () => {
  const terminals = Object.entries(SHADER_NODES).filter(([, t]) => t.terminal);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0][0], 'out');
});

test('input socket names are unique within a node', () => {
  for (const [key, t] of Object.entries(SHADER_NODES)) {
    const keys = t.ins.map(s => shxInKey(1, s.name));
    assert.equal(new Set(keys).size, keys.length, `${key} has distinct socket keys`);
  }
});

// ── Casts ────────────────────────────────────────────────────────────────

test('a cast between the same type is the expression itself', () => {
  assert.equal(cast('x', 'vec3', 'vec3'), 'x');
});

test('every pair of different types has a cast', () => {
  for (const from of TYPES) for (const to of TYPES) {
    if (from === to) continue;
    const out = cast('x', from, to);
    assert.notEqual(out, 'x', `${from}→${to} converts`);
  }
});

// ── Wiring rules ─────────────────────────────────────────────────────────

test('float inputs register as engine parameters, other types do not', () => {
  reset();
  const id = shadergraph.add('circle');   // uv:vec2, radius:float, softness:float
  assert.ok(engine.PARAMS[shxInKey(id, 'radius')], 'radius is wirable from a signal');
  assert.ok(engine.PARAMS[shxInKey(id, 'softness')], 'softness is wirable');
  assert.ok(!engine.PARAMS[shxInKey(id, 'uv')], 'a coordinate takes no signal cable');
});

test('removing a node unregisters its parameters and drops its cables', () => {
  reset();
  const a = shadergraph.add('fbm');
  const b = shadergraph.add('palette');
  shadergraph.connect(a, shxInKey(b, 't'));
  assert.equal(shadergraph.links().length, 1);
  shadergraph.remove(a);
  assert.equal(shadergraph.links().length, 0, 'the cable went with it');
  assert.ok(!engine.PARAMS[shxInKey(a, 'scale')], 'its parameters are gone');
});

test('an input takes one cable — a second replaces the first', () => {
  reset();
  const a = shadergraph.add('noise');
  const b = shadergraph.add('fbm');
  const p = shadergraph.add('palette');
  shadergraph.connect(a, shxInKey(p, 't'));
  shadergraph.connect(b, shxInKey(p, 't'));
  const ls = shadergraph.links();
  assert.equal(ls.length, 1);
  assert.equal(ls[0].from, b);
});

test('a node cannot feed itself', () => {
  reset();
  const a = shadergraph.add('math');
  assert.equal(shadergraph.connect(a, shxInKey(a, 'a')), null);
});

test('the output node has no output socket to wire onward', () => {
  reset();
  const o = shadergraph.add('out');
  const p = shadergraph.add('palette');
  assert.equal(shadergraph.socketsOf(o).out, null);
  assert.equal(shadergraph.connect(o, shxInKey(p, 't')), null);
});

test('there is only ever one output node', () => {
  reset();
  const a = shadergraph.add('out');
  const b = shadergraph.add('out');
  assert.equal(a, b, 'the second add returns the one already there');
  assert.equal(shadergraph.nodes().filter(n => n.type === 'out').length, 1);
});

test('connecting to a key that is not a socket is refused', () => {
  reset();
  const a = shadergraph.add('noise');
  const b = shadergraph.add('palette');
  assert.equal(shadergraph.connect(a, shxInKey(b, 'nonesuch')), null);
  assert.equal(shadergraph.connect(a, 'filter_freq'), null);
});

// ── The compiler ─────────────────────────────────────────────────────────

test('a patch with no output compiles to nothing, and says why', () => {
  reset();
  shadergraph.add('noise');
  const r = shadergraph.compile();
  assert.equal(r.frag, null);
  assert.match(r.error, /output/);
});

test('the starter patch compiles', () => {
  shadergraph.reset();
  const r = shadergraph.compile();
  assert.equal(r.error, null);
  assert.ok(r.frag.includes('void main()'));
  assert.ok(r.frag.includes('gl_FragColor'));
});

test('a compiled shader declares every uniform it uses', () => {
  shadergraph.reset();
  const { frag, uniforms } = shadergraph.compile();
  for (const u of uniforms) {
    assert.ok(frag.includes(`uniform float ${u.name};`), `${u.name} is declared`);
    assert.ok(engine.PARAMS[u.key], `${u.key} is a real engine parameter`);
  }
  // And nothing is used that was never declared: every u_shx_… in the body
  // has a declaration line.
  for (const name of new Set(frag.match(/u_shx_\w+/g) ?? [])) {
    assert.ok(frag.includes(`uniform float ${name};`), `${name} declared before use`);
  }
});

test('only nodes the output reaches are emitted', () => {
  reset();
  const o = shadergraph.add('out');
  const p = shadergraph.add('palette');
  const orphan = shadergraph.add('voronoi');
  shadergraph.connect(p, shxInKey(o, 'colour'));
  const r = shadergraph.compile();
  assert.ok(r.order.includes(p), 'the wired node is in');
  assert.ok(!r.order.includes(orphan), 'the unplugged one costs nothing');
  assert.ok(!r.frag.includes(`v${orphan} `), 'and is not in the source');
});

test('a node is emitted once however many places read it', () => {
  reset();
  const o = shadergraph.add('out');
  const n = shadergraph.add('noise');
  const c = shadergraph.add('combine');
  shadergraph.connect(n, shxInKey(c, 'x'));
  shadergraph.connect(n, shxInKey(c, 'y'));
  shadergraph.connect(n, shxInKey(c, 'z'));
  shadergraph.connect(c, shxInKey(o, 'colour'));
  const { frag } = shadergraph.compile();
  const decls = frag.match(new RegExp(`float v${n} =`, 'g')) ?? [];
  assert.equal(decls.length, 1, 'declared once, read three times');
});

test('children are emitted before the parents that read them', () => {
  reset();
  const o = shadergraph.add('out');
  const p = shadergraph.add('palette');
  const f = shadergraph.add('fbm');
  shadergraph.connect(f, shxInKey(p, 't'));
  shadergraph.connect(p, shxInKey(o, 'colour'));
  const { frag } = shadergraph.compile();
  assert.ok(frag.indexOf(`v${f} =`) < frag.indexOf(`v${p} =`), 'fbm before palette');
});

test('a mismatched type is cast rather than refused', () => {
  reset();
  const o = shadergraph.add('out');          // colour: vec3
  const f = shadergraph.add('fbm');          // out: float
  shadergraph.connect(f, shxInKey(o, 'colour'));
  const { frag, error } = shadergraph.compile();
  assert.equal(error, null);
  assert.ok(frag.includes(`vec3(v${f})`), 'the float spread across the channels');
});

test('a cycle compiles instead of hanging, breaking at the seam', () => {
  reset();
  const o = shadergraph.add('out');
  const a = shadergraph.add('math');
  const b = shadergraph.add('math');
  shadergraph.connect(a, shxInKey(b, 'a'));
  shadergraph.connect(b, shxInKey(a, 'a'));   // a → b → a
  shadergraph.connect(b, shxInKey(o, 'colour'));
  const r = shadergraph.compile();
  assert.equal(r.error, null);
  assert.ok(r.frag.includes('void main()'));
});

test('every node type compiles when wired straight into the output', () => {
  for (const type of Object.keys(SHADER_NODES)) {
    if (SHADER_NODES[type].terminal) continue;
    reset();
    const o = shadergraph.add('out');
    const n = shadergraph.add(type);
    shadergraph.connect(n, shxInKey(o, 'colour'));
    const r = shadergraph.compile();
    assert.equal(r.error, null, `${type} compiles`);
    assert.ok(r.frag.includes(`v${n} =`), `${type} is emitted`);
    // Balanced parentheses is a cheap proxy for "this is a real expression":
    // a node that forgets to close one produces source that looks fine until
    // the driver rejects the whole program.
    const line = r.frag.split('\n').find(l => l.includes(`v${n} =`));
    const open = (line.match(/\(/g) ?? []).length, close = (line.match(/\)/g) ?? []).length;
    assert.equal(open, close, `${type} emits balanced parentheses`);
    assert.ok(line.trim().endsWith(';'), `${type} emits a statement`);
  }
});

test('every node type compiles with each of its options', () => {
  for (const [type, t] of Object.entries(SHADER_NODES)) {
    for (const [optKey, decl] of Object.entries(t.opts ?? {})) {
      if (decl.kind !== 'choice') continue;
      for (const choice of decl.of) {
        reset();
        const o = shadergraph.add('out');
        const n = shadergraph.add(type === 'out' ? 'noise' : type);
        shadergraph.setOpt(n, optKey, choice);
        shadergraph.connect(n, shxInKey(o, 'colour'));
        const r = shadergraph.compile();
        assert.equal(r.error, null, `${type} with ${optKey}=${choice} compiles`);
      }
    }
  }
});

test('the vertex shader hands the fragment stage the coordinates it reads', () => {
  shadergraph.reset();
  const { frag } = shadergraph.compile();
  for (const v of ['vUv', 'vCoord']) {
    assert.ok(VERTEX.includes(`varying vec2 ${v};`), `${v} is sent`);
    assert.ok(frag.includes(`varying vec2 ${v};`), `${v} is received`);
  }
});

test('no compiled shader calls a derivative function', () => {
  // fwidth/dFdx are an extension in WebGL 1: calling one without enabling
  // OES_standard_derivatives fails the whole program to compile, so the
  // failure would be a black panel on exactly the oldest devices.
  for (const type of Object.keys(SHADER_NODES)) {
    reset();
    const o = shadergraph.add('out');
    const n = shadergraph.add(type);
    if (n !== o) shadergraph.connect(n, shxInKey(o, 'colour'));
    const { frag } = shadergraph.compile();
    // Comments stripped first: the prelude explains in prose why it avoids
    // fwidth, and a test that reads prose as code would fail on the
    // explanation rather than on a call.
    const code = frag.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\b(fwidth|dFdx|dFdy)\s*\(/.test(code), `${type} uses no derivatives`);
  }
});

// ── Options ──────────────────────────────────────────────────────────────

test('an unknown choice falls back to the default rather than into the source', () => {
  reset();
  const n = shadergraph.add('wave');
  shadergraph.setOpt(n, 'waveform', 'definitely-not-a-wave');
  assert.equal(shadergraph.nodes().find(x => x.id === n).opts.waveform, 'sine');
});

test('changing an option bumps the revision, so the runtime recompiles', () => {
  reset();
  const n = shadergraph.add('wave');
  const before = shadergraph.revision;
  shadergraph.setOpt(n, 'waveform', 'saw');
  assert.ok(shadergraph.revision > before);
});

test('setting an option to the value it already had does not recompile', () => {
  reset();
  const n = shadergraph.add('wave');
  shadergraph.setOpt(n, 'waveform', 'saw');
  const after = shadergraph.revision;
  shadergraph.setOpt(n, 'waveform', 'saw');
  assert.equal(shadergraph.revision, after, 'no needless recompile');
});

// ── Persistence ──────────────────────────────────────────────────────────

test('a patch survives a save and load, ids and cables intact', () => {
  reset();
  const o = shadergraph.add('out');
  const p = shadergraph.add('palette');
  const f = shadergraph.add('fbm');
  shadergraph.setOpt(p, 'scheme', 'candy');
  shadergraph.connect(f, shxInKey(p, 't'));
  shadergraph.connect(p, shxInKey(o, 'colour'));
  const before = shadergraph.compile().frag;

  const saved = JSON.parse(JSON.stringify(shadergraph.serialize()));
  shadergraph.load(saved);

  assert.deepEqual(shadergraph.nodes().map(n => n.id).sort(), [o, p, f].sort());
  assert.equal(shadergraph.nodes().find(n => n.id === p).opts.scheme, 'candy');
  assert.equal(shadergraph.links().length, 2);
  assert.equal(shadergraph.compile().frag, before, 'the same picture comes back');
});

test('loading re-registers the parameters cables point at', () => {
  reset();
  const f = shadergraph.add('fbm');
  const saved = JSON.parse(JSON.stringify(shadergraph.serialize()));
  shadergraph.load(saved);
  assert.ok(engine.PARAMS[shxInKey(f, 'scale')], 'the socket a saved cable names is back');
});

test('junk in a saved patch is skipped, not thrown', () => {
  reset();
  shadergraph.load({ nodes: [{ id: 1, type: 'nonesuch' }, { id: 2, type: 'out' }, null, 7],
                     links: [{ from: 99, to: 'nope' }, null] });
  assert.equal(shadergraph.nodes().length, 1);
  assert.equal(shadergraph.nodes()[0].type, 'out');
});

test('loading nothing empties the graph rather than leaving the last one', () => {
  shadergraph.reset();
  assert.ok(shadergraph.nodes().length > 0);
  shadergraph.load(null);
  assert.equal(shadergraph.nodes().length, 0);
});

test('the starter patch draws something — output reached, uniforms bound', () => {
  shadergraph.reset();
  const r = shadergraph.compile();
  assert.equal(r.error, null);
  assert.ok(r.order.length >= 3, 'all three starter nodes are emitted');
  assert.ok(!r.frag.includes('gl_FragColor = vec4(clamp(vec3(0.0)'), 'not the empty fallback');
});
