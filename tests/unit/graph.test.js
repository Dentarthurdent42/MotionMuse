// The patchbay's function nodes — the shader-graph move.
//
// A node is both ends of the existing machinery at once: its inputs register
// as engine parameters (so any cable can drive them), its output as a bus
// signal (so any cable can read it onward). These tests pin that contract,
// the evaluation order, and each node's math.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { graph, NODE_TYPES, sigKeyOf, paramKeyOf } = await import('../../src/graph.js');
const { engine } = await import('../../src/engine.js');
const { bus }    = await import('../../src/bus.js');
const { mapper } = await import('../../src/mapper.js');

const out = id => bus.signals.get(sigKeyOf(id))?.value;
const setIn = (id, name, v) => engine.set(paramKeyOf(id, name), v);

test('a node is both ends of the machinery: params in, signal out', () => {
  const id = graph.add('math');
  assert.ok(engine.PARAMS[paramKeyOf(id, 'a')], 'input A is an engine parameter');
  assert.ok(engine.PARAMS[paramKeyOf(id, 'b')], 'input B is an engine parameter');
  assert.ok(bus.signals.has(sigKeyOf(id)), 'the output is a bus signal');
  graph.remove(id);
  assert.equal(engine.PARAMS[paramKeyOf(id, 'a')], undefined, 'removal unregisters the params');
  assert.equal(bus.signals.has(sigKeyOf(id)), false, 'and the signal');
});

test('node inputs survive an oscillator bank resize', () => {
  // rebuildParams() starts from a clean slate; a node input dropped by a bank
  // change would leave a cable driving nothing, silently.
  const id = graph.add('mix');
  const before = engine.getOscCount();
  engine.setOscCount(before === 8 ? 1 : 8);
  assert.ok(engine.PARAMS[paramKeyOf(id, 'mix')], 'still registered after the resize');
  engine.setOscCount(before);
  graph.remove(id);
});

test('math does what its op says, clamped into the signal range', () => {
  const id = graph.add('math');
  setIn(id, 'a', 0.5); setIn(id, 'b', 0.25);
  const expect = { add: 0.75, sub: 0.25, mul: 0.125, min: 0.25, max: 0.5, avg: 0.375 };
  for (const [op, want] of Object.entries(expect)) {
    graph.setOpt(id, 'op', op);
    graph.tick(1);
    assert.ok(Math.abs(out(id) - want) < 1e-9, `${op}: ${out(id)} ≠ ${want}`);
  }
  setIn(id, 'a', 0.9); setIn(id, 'b', 0.9);
  graph.setOpt(id, 'op', 'add');
  graph.tick(2);
  assert.equal(out(id), 1, 'a sum past the range clamps — the bus is 0..1');
  graph.remove(id);
});

test('const is a knob; quantize snaps onto N levels', () => {
  const c = graph.add('const');
  graph.setOpt(c, 'value', 0.8);
  graph.tick(1);
  assert.equal(out(c), 0.8);
  const q = graph.add('quant');
  graph.setOpt(q, 'steps', 3);         // levels at 0, 0.5, 1
  setIn(q, 'in', 0.6);
  graph.tick(2);
  assert.equal(out(q), 0.5);
  graph.remove(c); graph.remove(q);
});

test('sample & hold samples on the rising edge and holds through everything else', () => {
  const id = graph.add('hold');
  setIn(id, 'in', 0.7); setIn(id, 'gate', 0);
  graph.tick(1);
  assert.equal(out(id), 0, 'no edge yet — the resting value stands');
  setIn(id, 'gate', 1);                // rising edge
  graph.tick(2);
  assert.equal(out(id), 0.7, 'the edge samples the input');
  setIn(id, 'in', 0.2);                // input moves, gate stays high
  graph.tick(3);
  assert.equal(out(id), 0.7, 'held — a high gate is not a new edge');
  setIn(id, 'gate', 0);
  graph.tick(4);
  setIn(id, 'gate', 1); setIn(id, 'in', 0.4);
  graph.tick(5);
  assert.equal(out(id), 0.4, 'the next edge samples again');
  graph.remove(id);
});

test('a chain settles in dependency order within one graph pass', () => {
  // const → (cable) → math.a; the cable is real mapper machinery, and the
  // math node must evaluate AFTER the const each pass.
  const c = graph.add('const');
  const m = graph.add('math');
  graph.setOpt(c, 'value', 0.6);
  graph.setOpt(m, 'op', 'add');
  const cable = mapper.add(paramKeyOf(m, 'a'), sigKeyOf(c), 0, 1, 'linear');
  graph.tick(1);      // publishes const
  mapper.tick();      // strings the cable value into math.a
  graph.tick(2);      // math reads it — const re-evaluated first is the point
  assert.ok(Math.abs(out(m) - 0.6) < 1e-9, `chain output ${out(m)}`);
  // Removing the upstream node drops the cable rather than leaving a wire to
  // a ghost.
  graph.remove(c);
  assert.equal(mapper.mappings.some(x => x.id === cable), false, 'cable went with the node');
  graph.remove(m);
});

test('the LFO is deterministic against an explicit clock', () => {
  const id = graph.add('lfo');
  graph.setOpt(id, 'wave', 'saw');
  setIn(id, 'rate', 0);                // 0 → 0.05 Hz: 20 s per cycle
  setIn(id, 'depth', 1);
  // Stepped like real frames: a single 5 s jump would hit the dt clamp that
  // protects a backgrounded tab from a catch-up burst.
  for (let i = 0; i <= 100; i++) graph.tick(10 + i * 0.05);
  assert.ok(Math.abs(out(id) - 0.25) < 0.02, `saw quarter-cycle ${out(id)}`);
  graph.remove(id);
});

test('smooth converges toward its input without ever overshooting', () => {
  const id = graph.add('smooth');
  setIn(id, 'in', 1); setIn(id, 'amount', 0.5);
  let prev = 0;
  for (let t = 0; t < 3; t += 1 / 30) {
    graph.tick(100 + t);
    const v = out(id);
    assert.ok(v >= prev - 1e-9 && v <= 1, `monotone ${v}`);
    prev = v;
  }
  assert.ok(prev > 0.9, `converged to ${prev}`);
  graph.remove(id);
});

test('nodes round-trip through serialize/load, ids and cables intact', () => {
  graph.load([]);                       // a clean slate, whatever ran before
  const c = graph.add('const');
  const q = graph.add('quant');
  graph.setOpt(c, 'value', 0.3);
  graph.setOpt(q, 'steps', 5);
  mapper.add(paramKeyOf(q, 'in'), sigKeyOf(c), 0, 1, 'linear');
  const snapG = graph.serialize();
  const snapM = mapper.serialize();
  graph.load([]);                       // clear
  assert.equal(graph.nodes().length, 0);
  graph.load(snapG);
  mapper.load(snapM);
  const nodes = graph.nodes();
  assert.equal(nodes.length, 2);
  assert.equal(nodes.find(n => n.type === 'const').opts.value, 0.3);
  assert.equal(nodes.find(n => n.type === 'quant').opts.steps, 5);
  graph.tick(1); mapper.tick(); graph.tick(2);
  const qq = nodes.find(n => n.type === 'quant');
  assert.equal(out(qq.id), 0.25, 'the reloaded chain still computes (0.3 → nearest of 5 levels)');
  mapper.load([]);
  graph.load([]);
});

test('junk in a loaded snapshot falls back instead of wedging', () => {
  graph.load([{ type: 'teleport', opts: {} }, { type: 'math', id: 'seven', opts: { op: 'yell' } }, null]);
  const nodes = graph.nodes();
  assert.equal(nodes.length, 1, 'the unknown type and the null are dropped');
  assert.equal(nodes[0].type, 'math');
  assert.equal(nodes[0].opts.op, 'add', 'a junk option falls back to its default');
  graph.load([]);
});

test('every node type declares what the strip needs to render it', () => {
  for (const [key, t] of Object.entries(NODE_TYPES)) {
    assert.ok(t.name, `${key} has a name`);
    assert.ok(Array.isArray(t.ins), `${key} declares its inputs`);
    assert.ok(t.make instanceof Function, `${key} builds an evaluator`);
  }
});
