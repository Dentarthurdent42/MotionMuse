// The loop pedal's gesture is OFF until asked for.
//
// A nod is the pedal because you can do it without interrupting a phrase —
// which is also why you do it constantly without meaning anything by it.
// Armed on a fresh install, the instrument recorded loops nobody asked for.
// This pins the default, and pins that a saved ON survives, since the same
// one-line read does both jobs and flipping it is a silent regression either
// way.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

// A real store, so the module reads what a browser would.
const store = new Map();
globalThis.localStorage ??= {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.document ??= {
  getElementById: () => null, querySelectorAll: () => [], addEventListener() {},
  body: { classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
};
globalThis.window ??= { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const KEY_ON = 'motionmuse-pedal-on';

test('a fresh install does not arm the nod', async () => {
  store.delete(KEY_ON);
  const { pedalEnabled } = await import('../../src/ui/looper-ui.js?fresh');
  assert.equal(pedalEnabled(), false,
    'nodding must not start recording until the player switches the gesture on');
});

test('and switching it on is remembered', async () => {
  store.set(KEY_ON, '1');
  const { pedalEnabled } = await import('../../src/ui/looper-ui.js?armed');
  assert.equal(pedalEnabled(), true);
});

test('any other stored value reads as off, not as on', async () => {
  // The old default was "anything but '0' is on", which is what armed every
  // fresh install; an unknown value must not resurrect that.
  store.set(KEY_ON, 'yes');
  const { pedalEnabled } = await import('../../src/ui/looper-ui.js?junk');
  assert.equal(pedalEnabled(), false);
});
