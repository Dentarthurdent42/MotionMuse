// Renaming a saved setup, and remembering which one is loaded.
//
// A name is chosen in a hurry — usually while sharing — and the setup
// outlives the moment it was typed. What is pinned here: renaming keeps the
// snapshot and does not leave the old row behind, renaming onto an existing
// name is refused rather than merged (it would destroy a setup nobody asked
// to touch), and the "currently playing" marker follows a rename rather than
// pointing at a name that is gone.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage ??= {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const { saveConfig, renameConfig, findConfig, savedConfigs, deleteConfig,
        currentConfig, setCurrentConfig } = await import('../../src/saved.js');

const snap = n => ({ app: 'motionmuse-sound', v: 2, mappings: [], tag: n });
const reset = () => { store.clear(); };

test('renaming keeps the snapshot and leaves no duplicate behind', () => {
  reset();
  saveConfig('asdf', snap('one'));
  const out = renameConfig('asdf', 'Ambient pads');
  assert.equal(out.name, 'Ambient pads');
  assert.equal(out.snap.tag, 'one', 'the setup itself is untouched');
  assert.equal(findConfig('asdf'), null, 'the old name is gone');
  assert.equal(findConfig('Ambient pads').snap.tag, 'one');
  assert.equal(savedConfigs().length, 1, 'renaming is not saving a second copy');
});

test('renaming onto an existing name is refused — neither setup is lost', () => {
  reset();
  saveConfig('keep', snap('keeper'));
  saveConfig('other', snap('mine'));
  assert.equal(renameConfig('other', 'keep'), null);
  assert.equal(savedConfigs().length, 2, 'both survive');
  assert.equal(findConfig('keep').snap.tag, 'keeper', 'the one not being renamed is untouched');
  assert.equal(findConfig('other').snap.tag, 'mine', 'and so is the one that was');
});

test('renaming nothing, or to nothing, changes nothing', () => {
  reset();
  saveConfig('real', snap('x'));
  assert.equal(renameConfig('missing', 'new'), null);
  assert.equal(renameConfig('real', '   '), null);
  assert.equal(renameConfig('real', 'real').name, 'real', 'a no-op rename is not an error');
  assert.equal(savedConfigs().length, 1);
});

test('the loaded setup is remembered, and follows a rename', () => {
  reset();
  saveConfig('Live set', snap('x'));
  setCurrentConfig('Live set');
  assert.equal(currentConfig(), 'Live set');
  renameConfig('Live set', 'Live set v2');
  assert.equal(currentConfig(), 'Live set v2', 'the marker moved with the name');
});

test('a marker pointing at a forgotten setup reads as no setup', () => {
  reset();
  saveConfig('Temp', snap('x'));
  setCurrentConfig('Temp');
  deleteConfig('Temp');
  assert.equal(currentConfig(), '', 'a name whose setup is gone is not a name');
});
