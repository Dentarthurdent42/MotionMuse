// Named configurations.
//
// Naming a setup in SHARE, or following a link somebody named, puts it in the
// PRESET menu under that name. These pin what "named" means: one entry per
// name, a whole snapshot rather than a patch, and a store that survives being
// handed something that is not one.
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

const { savedConfigs, saveConfig, findConfig, deleteConfig, configName, SAVED_MAX } =
  await import('../../src/saved.js');
const { SHARE_LABEL_MAX } = await import('../../src/share.js');
const { savedWhen } = await import('../../src/ui/preset-menu.js');

const KEY = 'motionmuse-saved-v1';
const reset = () => store.clear();
const snap = n => ({ app: 'motionmuse-sound', v: 2, mappings: [], audio: { n } });

test('a named setup is kept and comes back by name', () => {
  reset();
  const e = saveConfig('ambient pads', snap(1));
  assert.equal(e.name, 'ambient pads');
  assert.deepEqual(findConfig('ambient pads').snap, snap(1));
  assert.equal(savedConfigs().length, 1);
});

test('a whole snapshot is kept, not just the cables', () => {
  reset();
  const full = { app: 'motionmuse-sound', v: 2, kit: 'strings', mappings: [['volume', 'pinch_R', 0, 1]],
                 audio: { volume: 0.4 }, gestures: { custom: [] }, chord: { enabled: true },
                 ui: { theme: 'contrast', tracking: 'L' } };
  saveConfig('everything', full);
  // A built-in preset is a set of cables; a named configuration is the
  // instrument. Storing only `mappings` would make restoring it silently drop
  // the audio graph, the gestures and the trackers.
  assert.deepEqual(findConfig('everything').snap, full);
});

test('the name is the identity — saving again replaces rather than duplicates', () => {
  reset();
  saveConfig('ambient pads', snap(1));
  saveConfig('ambient pads', snap(2));
  assert.equal(savedConfigs().length, 1, 'two rows with one name is an unusable menu');
  assert.deepEqual(findConfig('ambient pads').snap, snap(2), 'the later save wins');
});

test('names are cleaned and capped the same way the shared label is', () => {
  reset();
  assert.equal(configName('  spaced   out \n line  '), 'spaced out line');
  assert.equal(configName('x'.repeat(200)).length, SHARE_LABEL_MAX);
  // So a link naming a setup and the SHARE field naming it land on one entry
  // rather than two that look identical.
  saveConfig(' ambient  pads ', snap(1));
  assert.ok(findConfig('ambient pads'));
});

test('an unnamed setup is not kept, and is not an error', () => {
  reset();
  assert.equal(saveConfig('', snap(1)), null);
  assert.equal(saveConfig('   ', snap(1)), null);
  assert.equal(saveConfig(undefined, snap(1)), null);
  // Sharing without naming it is an ordinary thing to do.
  assert.equal(savedConfigs().length, 0);
});

test('something that is not a snapshot is not kept', () => {
  reset();
  assert.equal(saveConfig('bad', null), null);
  assert.equal(saveConfig('bad', 'a string'), null);
  assert.equal(saveConfig('bad', [1, 2]), null);
  assert.equal(savedConfigs().length, 0);
});

test('the newest is first', () => {
  reset();
  saveConfig('first', snap(1));
  saveConfig('second', snap(2));
  saveConfig('third', snap(3));
  assert.deepEqual(savedConfigs().map(c => c.name), ['third', 'second', 'first']);
});

test('the list is capped, oldest dropped', () => {
  reset();
  for (let i = 0; i < SAVED_MAX + 5; i++) saveConfig(`setup ${i}`, snap(i));
  const names = savedConfigs().map(c => c.name);
  assert.equal(names.length, SAVED_MAX);
  assert.equal(names[0], `setup ${SAVED_MAX + 4}`, 'newest survives');
  assert.ok(!names.includes('setup 0'), 'oldest is gone');
});

test('forgetting one leaves the rest', () => {
  reset();
  saveConfig('keep', snap(1));
  saveConfig('drop', snap(2));
  assert.equal(deleteConfig('drop'), true);
  assert.equal(deleteConfig('drop'), false, 'forgetting twice is not a second removal');
  assert.deepEqual(savedConfigs().map(c => c.name), ['keep']);
});

test('junk in storage yields an empty list rather than a broken menu', () => {
  reset();
  store.set(KEY, 'not json at all');
  assert.deepEqual(savedConfigs(), []);
  store.set(KEY, '{"not":"an array"}');
  assert.deepEqual(savedConfigs(), []);
  // A partly-valid list keeps the entries that are whole. Rendering the others
  // would put `undefined` in the menu and apply nothing when clicked.
  store.set(KEY, JSON.stringify([
    { name: 'good', snap: { app: 'motionmuse-sound' } },
    { name: '', snap: {} },
    { name: 'no snapshot' },
    { snap: {} },
    'nonsense',
  ]));
  assert.deepEqual(savedConfigs().map(c => c.name), ['good']);
});

test('a saved time reads as words, and a missing one reads as nothing', () => {
  const now = Date.parse('2026-08-26T12:00:00Z');
  const ago = ms => savedWhen(new Date(now - ms).toISOString(), now);
  assert.equal(ago(0), 'today');
  assert.equal(ago(26 * 3600e3), 'yesterday');
  assert.equal(ago(3 * 86400e3), '3 days ago');
  assert.equal(ago(20 * 86400e3), '2 wk ago');
  assert.equal(ago(200 * 86400e3), '6 mo ago');
  // A clock that moved backwards, and an entry written before the field
  // existed: neither is worth a broken line in the menu.
  assert.equal(savedWhen(new Date(now + 86400e3).toISOString(), now), 'just now');
  assert.equal(savedWhen(undefined), '');
  assert.equal(savedWhen('not a date'), '');
});
