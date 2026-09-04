// The workspace model: nodes on one canvas, groups that collapse, and what a
// collapsed group shows of its members' sockets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, serialize, ensure, group, ungroup, remove, setParent,
         visualOwner, exposedPorts, isShown, fitTransform, stackColumns,
         descendants, nodeId, kindOf, keyOf } from '../../src/workspace.js';

test('ids carry their kind', () => {
  assert.equal(nodeId('sig', 'hand_L_y'), 'sig:hand_L_y');
  assert.equal(kindOf('par:osc1_freq'), 'par');
  assert.equal(keyOf('fn:3'), '3');
  assert.equal(keyOf('panel:pitch-quantize'), 'pitch-quantize');
});

test('a state round-trips through serialize', () => {
  const s = createState(null);
  const a = ensure(s, 'panel:camera', { x: 10, y: 20, w: 300 });
  a.folded = true;
  const g = group(s, ['panel:camera'], 'INPUTS');
  g.collapsed = true;
  s.view = { x: 5, y: 6, k: 0.5 };
  const back = createState(JSON.parse(JSON.stringify(serialize(s))));
  const cam = back.nodes.get('panel:camera');
  assert.equal(cam.x, 10); assert.equal(cam.w, 300); assert.equal(cam.folded, true);
  assert.equal(cam.parent, g.id);
  assert.equal(back.nodes.get(g.id).collapsed, true);
  assert.equal(back.nodes.get(g.id).title, 'INPUTS');
  assert.deepEqual(back.view, { x: 5, y: 6, k: 0.5 });
});

test('garbage in storage is ignored, not fatal', () => {
  const s = createState({ nodes: { 'bogus:x': {}, 'panel:ok': { x: 'no', parent: 'group:missing' } },
                          view: { k: -1 } });
  assert.equal(s.nodes.has('bogus:x'), false);
  const ok = s.nodes.get('panel:ok');
  assert.equal(ok.x, 0);
  assert.equal(ok.parent, null, 'a parent that does not exist is no parent');
  assert.equal(s.view.k, 1);
});

test('group ids never collide with saved ones', () => {
  const s = createState({ nodes: { 'group:g7': { title: 'OLD' } }, nextGroup: 1 });
  ensure(s, 'sig:a');
  const g = group(s, ['sig:a']);
  assert.notEqual(g.id, 'group:g7');
});

test('grouping, nesting and ungrouping', () => {
  const s = createState(null);
  ensure(s, 'sig:a', { x: 40, y: 10 });
  ensure(s, 'par:b', { x: 200, y: 50 });
  const g = group(s, ['sig:a', 'par:b'], 'PAIR');
  assert.equal(s.nodes.get('sig:a').parent, g.id);
  assert.equal(g.x, 40); assert.equal(g.y, 10);
  const outer = group(s, [g.id], 'OUTER');
  assert.equal(g.parent, outer.id);
  assert.deepEqual(descendants(s, outer.id).map(n => n.id).sort(), [g.id, 'par:b', 'sig:a']);
  // A group cannot be moved into itself or its own descendant.
  assert.equal(setParent(s, outer.id, g.id), false);
  assert.equal(ungroup(s, g.id), true);
  assert.equal(s.nodes.get('sig:a').parent, outer.id, 'members go to the enclosing frame');
  remove(s, outer.id);
  assert.equal(s.nodes.get('sig:a').parent, null);
});

test('a collapsed group stands in for its members', () => {
  const s = createState(null);
  ensure(s, 'sig:a'); ensure(s, 'par:b'); ensure(s, 'par:c');
  const g = group(s, ['sig:a', 'par:b'], 'G');
  assert.equal(visualOwner(s, 'sig:a'), 'sig:a');
  g.collapsed = true;
  assert.equal(visualOwner(s, 'sig:a'), g.id);
  assert.equal(visualOwner(s, 'par:c'), 'par:c');
  assert.equal(isShown(s, 'sig:a'), false);
  assert.equal(isShown(s, g.id), true);
  const outer = group(s, [g.id], 'OUTER');
  outer.collapsed = true;
  assert.equal(visualOwner(s, 'sig:a'), outer.id, 'the outermost collapsed frame wins');
});

test('a collapsed group exposes only outward-facing sockets', () => {
  const s = createState(null);
  ['sig:a', 'sig:x', 'par:b', 'par:c', 'fn:1'].forEach(id => ensure(s, id));
  const g = group(s, ['sig:a', 'par:b', 'fn:1'], 'G');
  g.collapsed = true;
  const sockets = [
    { node: 'sig:a', side: 'out', key: 'a' },
    { node: 'sig:x', side: 'out', key: 'x' },
    { node: 'par:b', side: 'in',  key: 'b' },
    { node: 'par:c', side: 'in',  key: 'c' },
    { node: 'fn:1',  side: 'in',  key: 'fn_1_a' },
    { node: 'fn:1',  side: 'in',  key: 'fn_1_b' },
    { node: 'fn:1',  side: 'out', key: 'fn_1' },
  ];
  const links = [
    { from: { node: 'sig:a', key: 'a' },   to: { node: 'fn:1', key: 'fn_1_a' } },   // internal
    { from: { node: 'sig:x', key: 'x' },   to: { node: 'fn:1', key: 'fn_1_b' } },   // enters
    { from: { node: 'fn:1',  key: 'fn_1' }, to: { node: 'par:c', key: 'c' } },      // leaves
  ];
  const { ins, outs } = exposedPorts(s, g.id, sockets, links);
  assert.deepEqual(ins.map(p => p.key).sort(), ['fn_1_b'],
    'fn_1_b is fed from outside; fn_1_a is internal and b is unwired');
  assert.deepEqual(outs.map(p => p.key), ['fn_1'],
    'a only feeds a member, so it is hidden with the group');
});

test('fitTransform centres a box and never zooms past 1', () => {
  const t = fitTransform({ x: 100, y: 100, w: 200, h: 100 }, 1000, 500, { pad: 0 });
  assert.equal(t.k, 1);
  assert.equal(t.x + 100 * t.k, 400);     // box left edge lands at (1000-200)/2
  const t2 = fitTransform({ x: 0, y: 0, w: 4000, h: 100 }, 1000, 500, { pad: 0 });
  assert.equal(t2.k, 0.25);
});

test('stackColumns lays unplaced nodes out in columns', () => {
  const pos = stackColumns([
    { id: 'a', col: 0, order: 0, w: 100, h: 50 },
    { id: 'b', col: 0, order: 1, w: 120, h: 30 },
    { id: 'c', col: 1, order: 0, w: 200, h: 80 },
  ], { gap: 10, colGap: 20 });
  assert.deepEqual(pos.get('a'), { x: 0, y: 0 });
  assert.equal(pos.get('b').x, 0);
  assert.ok(pos.get('b').y >= 60);
  assert.ok(pos.get('c').x >= 140, 'second column starts after the widest of the first');
});
