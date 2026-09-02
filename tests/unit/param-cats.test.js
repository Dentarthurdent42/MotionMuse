// The add-output picker is built from PARAM_CATS, not from engine.PARAMS —
// so a parameter added to the engine but not to the table is fully functional
// and completely unreachable from the patchbay. Nothing errors; the option is
// simply absent. This pins the two lists to each other in both directions.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { engine }     = await import('../../src/engine.js');
const { PARAM_CATS } = await import('../../src/params.js');

// PARAM_CATS is a function now: the oscillator bank is resizable, so which keys
// exist is a runtime value. Checked at more than one bank size, since a table
// that only agreed with the engine at the default count would be exactly the
// silent-unreachable-param bug this test exists to catch.
for (const count of [1, 2, 5, 8]) {
test(`every engine param appears in exactly one picker category (${count} osc)`, () => {
  engine.setOscCount(count);
  const inCats = PARAM_CATS().flatMap(([, keys]) => keys);
  const dupes = inCats.filter((k, i) => inCats.indexOf(k) !== i);
  assert.deepEqual(dupes, [], `listed twice: ${dupes}`);
  const missing = Object.keys(engine.PARAMS).filter(k => !inCats.includes(k));
  assert.deepEqual(missing, [],
    `unreachable from the patchbay picker: ${missing}`);
});

test(`the picker lists no params the engine does not have (${count} osc)`, () => {
  engine.setOscCount(count);
  const ghosts = PARAM_CATS().flatMap(([, keys]) => keys)
    .filter(k => !engine.PARAMS[k]);
  assert.deepEqual(ghosts, [], `picker offers nonexistent params: ${ghosts}`);
});
}

test('the bank starts at one oscillator', async () => {
  const { engine: fresh } = await import('../../src/engine.js');
  // Same module instance the tests above resized, so assert on the shape of a
  // freshly-built slot list rather than the live count.
  fresh.setOscCount(1);
  assert.equal(fresh.getOscCount(), 1);
  assert.ok(fresh.PARAMS.osc1_volume, 'oscillator 1 has its own level');
  assert.equal(fresh.PARAMS.osc2_volume, undefined, 'slot 2 is absent by default');
  assert.equal(fresh.PARAMS.osc_mix, undefined, 'the 1<->2 crossfade is gone');
  assert.equal(fresh.PARAMS.volume.label, 'Main Vol');
});

// Function-node inputs register at runtime; the GRAPH NODES category is as
// runtime-sized as the oscillators, and the same both-directions pin applies.
test('a function node\u2019s inputs appear in the picker, and leave with it', async () => {
  const { graph, paramKeyOf } = await import('../../src/graph.js');
  const id = graph.add('mix');
  const inCats = PARAM_CATS().flatMap(([, keys]) => keys);
  for (const k of ['a', 'b', 'mix']) {
    assert.ok(inCats.includes(paramKeyOf(id, k)), `${k} reachable from the picker`);
  }
  const missing = Object.keys(engine.PARAMS).filter(k => !inCats.includes(k));
  assert.deepEqual(missing, [], `unreachable: ${missing}`);
  graph.remove(id);
  assert.equal(PARAM_CATS().flatMap(([, keys]) => keys).some(k => k.startsWith(`fn_${id}_`)), false);
});
