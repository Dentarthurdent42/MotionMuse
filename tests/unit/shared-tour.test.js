// Which tour a setup that arrived by link should get.
//
// Following a link is not opening the app for the first time. The link already
// chose the way of playing and brought a patch with it, so the welcome that
// asks which mode you want is answering a question nobody asked, and panels
// this particular setup never touches are noise in front of the thing you were
// handed. This pins that narrowing, because getting it wrong is invisible —
// the tour still opens, it just wastes the one moment someone is paying
// attention to a patch that is not theirs.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { body: { classList: { toggle() {}, add() {}, remove() {} } } };

import { TOUR_STEPS, stepsForMode, stepsForSharedSetup } from '../../src/ui/tutorial.js';
import { chordmode, DEFAULT_KEY } from '../../src/chordmode.js';
import { mapper } from '../../src/mapper.js';

const ids = steps => steps.map(s => s.id);

test('the welcome is dropped — the link already chose the mode', () => {
  assert.ok(ids(TOUR_STEPS).includes('welcome'), 'the full tour still opens with it');
  assert.ok(!ids(stepsForSharedSetup()).includes('welcome'));
});

test('a shared setup never gets more than its mode would', () => {
  const shared = new Set(ids(stepsForSharedSetup()));
  const mode = new Set(ids(stepsForMode(chordmode.enabled ? 'chords' : 'osc')));
  for (const id of shared) assert.ok(mode.has(id), `${id} is not even in the mode's tour`);
  assert.ok(shared.size < TOUR_STEPS.length, 'and it is genuinely narrower than the full tour');
});

test('a chord-mode link gets the chord steps, not the patchbay tour', () => {
  chordmode.load({ enabled: true, key: { ...DEFAULT_KEY }, assignments: {} });
  mapper.load([]);                       // a chord setup wires no cables
  const shown = ids(stepsForSharedSetup());
  assert.ok(shown.some(id => id.startsWith('chords-')), 'the chords steps are there');
  assert.ok(!shown.includes('patchbay'), 'the patchbay tour is not');
  assert.ok(!shown.includes('cable-editor'));
});

test('a patch with cables keeps the patchbay steps', () => {
  chordmode.load({ enabled: false, key: { ...DEFAULT_KEY }, assignments: {} });
  mapper.load([['hand_R_y', 'osc1_freq', 110, 880, 'linear']]);
  const shown = ids(stepsForSharedSetup());
  assert.ok(shown.includes('patchbay'), 'a wired patch is worth explaining');
  assert.ok(!shown.some(id => id.startsWith('chords-')), 'chord steps stay out of a tone patch');
});

test('every step it returns is a real step', () => {
  const known = new Set(ids(TOUR_STEPS));
  for (const s of stepsForSharedSetup()) {
    assert.ok(known.has(s.id), `${s.id} is not in TOUR_STEPS`);
    assert.ok(s.title && s.body, `${s.id} has nothing to say`);
  }
});
