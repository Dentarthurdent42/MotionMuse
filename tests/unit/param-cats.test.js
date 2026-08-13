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
const { PARAM_CATS } = await import('../../src/ui/mapper-ui.js');

test('every engine param appears in exactly one picker category', () => {
  const inCats = PARAM_CATS.flatMap(([, keys]) => keys);
  const dupes = inCats.filter((k, i) => inCats.indexOf(k) !== i);
  assert.deepEqual(dupes, [], `listed twice: ${dupes}`);
  const missing = Object.keys(engine.PARAMS).filter(k => !inCats.includes(k));
  assert.deepEqual(missing, [],
    `unreachable from the patchbay picker: ${missing}`);
});

test('the picker lists no params the engine does not have', () => {
  const ghosts = PARAM_CATS.flatMap(([, keys]) => keys)
    .filter(k => !engine.PARAMS[k]);
  assert.deepEqual(ghosts, [], `picker offers nonexistent params: ${ghosts}`);
});
