// Unit tests for the hotkey decision rules.
//
// `shouldFire` is where the awkwardness of binding Space lives — the browser
// already uses it to activate whatever has focus — so it is a pure function
// taking event-shaped plain objects, and the rules are pinned here rather than
// discovered by clicking around.

import test from 'node:test';
import assert from 'node:assert/strict';

// storage.js touches localStorage at import time only through functions, but
// hotkeys.js calls lsGet() at module scope, so give it somewhere to look.
globalThis.localStorage ??= {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

const { shouldFire, keyLabel, DEFAULT_BINDINGS } = await import('../../src/ui/hotkeys.js');

const ev = (over = {}) => ({ code: 'Space', repeat: false, ctrlKey: false,
                             metaKey: false, altKey: false,
                             target: { tagName: 'BODY', isContentEditable: false }, ...over });

test('the default mute binding is the spacebar', () => {
  assert.equal(DEFAULT_BINDINGS.mute, 'Space');
});

test('a bare press of the bound key fires', () => {
  assert.equal(shouldFire(ev(), 'Space'), true);
});

test('a different key does not fire', () => {
  assert.equal(shouldFire(ev({ code: 'KeyM' }), 'Space'), false);
  assert.equal(shouldFire(ev({ code: 'Space' }), 'KeyM'), false);
});

test('an unbound action never fires', () => {
  for (const binding of [null, undefined, '']) assert.equal(shouldFire(ev(), binding), false);
});

test('typing is never hijacked', () => {
  // The whole reason Space is risky: it is also a character.
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT'])
    assert.equal(shouldFire(ev({ target: { tagName, isContentEditable: false } }), 'Space'), false, tagName);
  assert.equal(
    shouldFire(ev({ target: { tagName: 'DIV', isContentEditable: true } }), 'Space'), false,
    'contenteditable');
});

test('a focused button does not stop the shortcut', () => {
  // Deliberate: the alternative is a shortcut whose behaviour depends on
  // invisible focus state — dead after you click anything. Buttons keep Enter.
  assert.equal(shouldFire(ev({ target: { tagName: 'BUTTON', isContentEditable: false } }), 'Space'), true);
});

test('modified presses belong to the browser and the OS', () => {
  for (const mod of ['ctrlKey', 'metaKey', 'altKey'])
    assert.equal(shouldFire(ev({ [mod]: true }), 'Space'), false, mod);
});

test('holding the key does not strobe the output', () => {
  assert.equal(shouldFire(ev({ repeat: true }), 'Space'), false);
});

test('a missing target is treated as the document, not as typing', () => {
  assert.equal(shouldFire(ev({ target: null }), 'Space'), true);
});

test('key labels are readable, and never blank', () => {
  assert.equal(keyLabel('Space'), 'SPACE');
  assert.equal(keyLabel('KeyM'), 'M');
  assert.equal(keyLabel('Digit4'), '4');
  assert.equal(keyLabel('Numpad7'), 'NUM 7');
  assert.equal(keyLabel('ArrowLeft'), 'LEFT');
  assert.equal(keyLabel('F8'), 'F8');
  assert.equal(keyLabel('Backquote'), 'BACKQUOTE');   // ugly, but never wrong
  assert.equal(keyLabel(null), '—');
  assert.equal(keyLabel(''), '—');
});
