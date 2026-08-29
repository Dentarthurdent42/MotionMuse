// The patchbay's interior — function nodes, the shader-graph move.
//
// The patchbay used to be one hop: signal → cable → parameter. A shader graph
// is what you get when the middle grows: nodes that take signals in, compute,
// and hand a signal back out. The trick that keeps this small is that a node
// is BOTH ends of the existing machinery at once:
//
//   • each INPUT socket registers as an engine parameter (`fn_<id>_<in>`,
//     under the picker's GRAPH NODES category) — so any existing cable can
//     drive it, curves, ranges, steps and all;
//   • its OUTPUT registers as a bus signal (`fn_<id>`, group `graph`) — so
//     any existing cable can read it, into an audio parameter or into
//     another node's input.
//
// No new cable type, no new picker, no new persistence path: the graph IS
// the patchbay, just allowed to bend back on itself. Values are normalized
// 0..1 on both sides — the cable's own out-range does the scaling into real
// units, exactly as it always has.
//
// Evaluation is control-rate, once per frame, in dependency order (Kahn):
// a chain of nodes settles within the frame. Only the hop THROUGH a cable
// carries one frame of latency (the mapper ran before us), which at 60 fps
// is under the One-Euro smoothing already sitting on every camera signal.
// A cycle — legitimate, feedback is a synthesis tool — evaluates with last
// frame's value at the loop seam instead of deadlocking.

import { bus }      from './bus.js';
import { engine }   from './engine.js';
import { mapper }   from './mapper.js';
import { isRecord } from './is.js';

// What each node computes. `ins` name the input sockets in picker order;
// `dflt` is a socket's resting value when nothing is wired to it; `opts`
// declare the node's own discrete choices (rendered by the patchbay's node
// strip, not wired). Every eval takes and returns 0..1.
export const NODE_TYPES = {
  const: {
    name: 'Const', ins: [],
    opts: { value: { kind: 'slider', dflt: 0.5 } },
    make: () => (node) => node.opts.value,
  },
  math: {
    name: 'Math', ins: ['a', 'b'], dflt: { a: 0, b: 0 },
    opts: { op: { kind: 'choice', of: ['add', 'sub', 'mul', 'min', 'max', 'avg'], dflt: 'add' } },
    make: () => (node, [a, b]) => {
      switch (node.opts.op) {
        case 'sub': return a - b;
        case 'mul': return a * b;
        case 'min': return Math.min(a, b);
        case 'max': return Math.max(a, b);
        case 'avg': return (a + b) / 2;
        default:    return a + b;
      }
    },
  },
  mix: {
    name: 'Mix', ins: ['a', 'b', 'mix'], dflt: { mix: 0.5 },
    make: () => (node, [a, b, m]) => a * (1 - m) + b * m,
  },
  smooth: {
    name: 'Smooth', ins: ['in', 'amount'], dflt: { amount: 0.5 },
    // A one-pole lag with a time constant, so the feel does not change with
    // frame rate: amount 0 is a wire, amount 1 is a ~2 s glide.
    make: () => {
      let y = null;
      return (node, [x, amount], dt) => {
        const tau = 0.02 + amount * amount * 2;
        const k = 1 - Math.exp(-dt / tau);
        y = y === null ? x : y + (x - y) * k;
        return y;
      };
    },
  },
  quant: {
    name: 'Quantize', ins: ['in'],
    opts: { steps: { kind: 'int', min: 2, max: 16, dflt: 4 } },
    make: () => (node, [x]) => {
      const n = node.opts.steps;
      return Math.round(x * (n - 1)) / (n - 1);
    },
  },
  hold: {
    name: 'Sample & Hold', ins: ['in', 'gate'], dflt: { gate: 0 },
    // Samples on the gate's RISING edge and holds until the next one. Wire
    // metro_beat to the gate and any signal becomes beat-quantized.
    make: () => {
      let y = 0, wasHigh = false;
      return (node, [x, gate]) => {
        const high = gate >= 0.5;
        if (high && !wasHigh) y = x;
        wasHigh = high;
        return y;
      };
    },
  },
  lfo: {
    name: 'LFO', ins: ['rate', 'depth'], dflt: { rate: 0.3, depth: 1 },
    opts: { wave: { kind: 'choice', of: ['sine', 'triangle', 'square', 'saw'], dflt: 'sine' } },
    // rate 0..1 maps exponentially onto 0.05..12 Hz. Output swings around 0.5
    // scaled by depth, so at depth 1 it fills the range and at 0 it is a
    // steady half — a still centre, not silence.
    make: () => {
      let phase = 0;
      return (node, [rate, depth], dt) => {
        const hz = 0.05 * Math.pow(12 / 0.05, rate);
        phase = (phase + dt * hz) % 1;
        let w;
        switch (node.opts.wave) {
          case 'triangle': w = phase < 0.5 ? phase * 2 : 2 - phase * 2; break;
          case 'square':   w = phase < 0.5 ? 1 : 0; break;
          case 'saw':      w = phase; break;
          default:         w = 0.5 + Math.sin(phase * 2 * Math.PI) / 2;
        }
        return 0.5 + (w - 0.5) * depth;
      };
    },
  },
};

export const sigKeyOf   = id => `fn_${id}`;
export const paramKeyOf = (id, inName) => `fn_${id}_${inName}`;

const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

export const graph = (() => {
  let nodes = [];        // { id, type, opts, eval }  — creation order
  let nextId = 1;

  const defaultOpts = type => Object.fromEntries(
    Object.entries(NODE_TYPES[type].opts ?? {}).map(([k, o]) => [k, o.dflt]));

  const registerIO = node => {
    const t = NODE_TYPES[node.type];
    const defs = {};
    for (const inName of t.ins) {
      defs[paramKeyOf(node.id, inName)] = {
        label: `ƒ${node.id} ${t.name} · ${inName.toUpperCase()}`,
        min: 0, max: 1, val: t.dflt?.[inName] ?? 0,
      };
    }
    engine.registerParams(defs);
    bus.register(sigKeyOf(node.id), {
      label: `ƒ${node.id} ${t.name}`, min: 0, max: 1, group: 'graph', source: 'graph',
    });
  };

  const unregisterIO = node => {
    const t = NODE_TYPES[node.type];
    engine.unregisterParams(t.ins.map(n => paramKeyOf(node.id, n)));
    bus.unregister(sigKeyOf(node.id));
  };

  // Dependency order: node B depends on node A when any cable runs from A's
  // output signal into one of B's input parameters. Rebuilt from the live
  // mapping list on demand — the mapper owns the cables, and a second copy
  // of who-feeds-whom here would drift from it.
  const topoOrder = () => {
    const byId = new Map(nodes.map(n => [String(n.id), n]));
    const depsOf = new Map(nodes.map(n => [n, new Set()]));
    for (const m of mapper.mappings) {
      const src = /^fn_(\w+)$/.exec(m.signal ?? '');
      const dst = /^fn_(\w+)_/.exec(m.audioParam ?? '');
      if (!src || !dst) continue;
      const a = byId.get(src[1]), b = byId.get(dst[1]);
      if (a && b && a !== b) depsOf.get(b).add(a);
    }
    const order = [];
    const done = new Set();
    let moved = true;
    while (moved) {
      moved = false;
      for (const n of nodes) {
        if (done.has(n)) continue;
        if ([...depsOf.get(n)].every(d => done.has(d))) {
          order.push(n); done.add(n); moved = true;
        }
      }
    }
    // Whatever is left is a cycle: append in creation order — the seam reads
    // last frame's value, which is what makes feedback a delay, not a hang.
    for (const n of nodes) if (!done.has(n)) order.push(n);
    return order;
  };

  let lastT = null;

  return {
    nodes: () => nodes.map(n => ({ id: n.id, type: n.type, opts: { ...n.opts } })),
    inputKeys: () => nodes.flatMap(n => NODE_TYPES[n.type].ins.map(i => paramKeyOf(n.id, i))),

    add(type) {
      if (!NODE_TYPES[type]) return null;
      const node = { id: nextId++, type, opts: defaultOpts(type) };
      node.eval = NODE_TYPES[type].make();
      nodes.push(node);
      registerIO(node);
      return node.id;
    },

    remove(id) {
      const i = nodes.findIndex(n => n.id === id);
      if (i < 0) return;
      const node = nodes[i];
      nodes.splice(i, 1);
      unregisterIO(node);
      // Cables into or out of a removed node point at nothing; drop them
      // rather than leaving the patchbay drawing wires to a ghost.
      const sig = sigKeyOf(id);
      const pre = `fn_${id}_`;
      const doomed = mapper.mappings
        .filter(m => m.signal === sig || (m.audioParam ?? '').startsWith(pre))
        .map(m => m.id);
      doomed.forEach(mid => mapper.remove(mid));
    },

    setOpt(id, key, value) {
      const node = nodes.find(n => n.id === id);
      const decl = node && NODE_TYPES[node.type].opts?.[key];
      if (!decl) return;
      if (decl.kind === 'choice')      node.opts[key] = decl.of.includes(value) ? value : decl.dflt;
      else if (decl.kind === 'int')    node.opts[key] = Math.max(decl.min, Math.min(decl.max, Math.round(Number(value)) || decl.dflt));
      else                             node.opts[key] = clamp01(Number(value));
    },

    // Once per frame, after mapper.tick() has written this frame's cable
    // values into the input parameters.
    tick(now = performance.now() / 1000) {
      if (!nodes.length) { lastT = now; return; }
      const dt = lastT === null ? 1 / 60 : Math.max(1e-3, Math.min(0.25, now - lastT));
      lastT = now;
      for (const n of topoOrder()) {
        const t = NODE_TYPES[n.type];
        const ins = t.ins.map(name => clamp01(engine.PARAMS[paramKeyOf(n.id, name)]?.val));
        bus.update(sigKeyOf(n.id), clamp01(n.eval(n, ins, dt)));
      }
    },

    serialize: () => nodes.map(n => ({ id: n.id, type: n.type, opts: { ...n.opts } })),
    load(list) {
      while (nodes.length) this.remove(nodes[0].id);
      nextId = 1;
      if (!Array.isArray(list)) return;
      for (const raw of list) {
        if (!isRecord(raw) || !NODE_TYPES[raw.type]) continue;
        const id = this.add(raw.type);
        const node = nodes.find(n => n.id === id);
        // Keep saved ids so saved cables still point at the right sockets.
        if (Number.isInteger(raw.id) && raw.id > 0 && !nodes.some(n => n !== node && n.id === raw.id)) {
          unregisterIO(node);
          node.id = raw.id;
          registerIO(node);
        }
        if (isRecord(raw.opts)) for (const k of Object.keys(raw.opts)) this.setOpt(node.id, k, raw.opts[k]);
      }
      nextId = nodes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
    },
  };
})();
