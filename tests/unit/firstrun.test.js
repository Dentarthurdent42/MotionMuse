// First-run starting point.
//
// A fresh install used to open as one oscillator at 220 Hz with nothing wired
// to it — unmute and you get a static sine, which is the absence of a starting
// point rather than one. These pin what each choice actually does, and when the
// question is asked at all.
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
const cls = { toggle() {}, add() {}, remove() {}, contains: () => false };
globalThis.document ??= {
  getElementById: () => null, querySelectorAll: () => [], addEventListener() {},
  body: { classList: cls },
};
globalThis.window ??= { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.location ??= { href: 'https://example.com/', pathname: '/', search: '' };

// trackersFor reads each signal's GROUP off the bus, so the sources have to be
// registered for it to know that `brow_raise` is a face signal — main.js does
// this at startup.
const { cvSource }    = await import('../../src/cv.js');
const { faceSource }  = await import('../../src/face.js');
const { depthSource } = await import('../../src/depth.js');
cvSource.registerSignals();
faceSource.registerSignals();
depthSource.init();

const { STARTERS, STARTER_GROUPS, shouldOfferStart, applyStarter } =
  await import('../../src/ui/firstrun.js');
const { mapper, PRESETS } = await import('../../src/mapper.js');
const { engine } = await import('../../src/engine.js');
const { chordmode } = await import('../../src/chordmode.js');

// The picker hands tracker changes back to main.js, which owns the header
// buttons; here it just records what was asked for.
let asked = null;
const applyTrackers = async want => { asked = want; return []; };
const pick = id => applyStarter(id, { applyTrackers });

const reset = () => {
  store.clear();
  asked = null;
  engine.setOscCount(1);
  mapper.applyPreset('hands');
  chordmode.setEnabled(false);
  chordmode.setVoicing('chord');
};

test('every mapping preset is offered, plus both handshape voicings and blank', () => {
  const ids = STARTERS.map(s => s.id);
  for (const p of PRESETS) assert.ok(ids.includes(p.id), `${p.id} is not offered`);
  assert.ok(ids.includes('chords'), 'chord mode is a way of playing, so it is a choice');
  assert.ok(ids.includes('notes'), 'so is playing those same shapes one note at a time');
  assert.ok(ids.includes('blank'));
  assert.equal(new Set(ids).size, ids.length, 'duplicate choice');
  for (const s of STARTERS) assert.ok(s.name && s.hint, `${s.id} needs a name and a hint`);
});

test('every choice sits in a group the picker actually renders', () => {
  const modes = new Set(STARTER_GROUPS.map(g => g.mode));
  for (const s of STARTERS)
    assert.ok(modes.has(s.mode), `${s.id} is in group "${s.mode}", which is not offered`);
  for (const g of STARTER_GROUPS)
    assert.ok(STARTERS.some(s => s.mode === g.mode), `group "${g.mode}" is empty`);
});

test('the question is asked once, and only on a genuinely fresh start', () => {
  reset();
  assert.equal(shouldOfferStart({ hasSession: false }), true, 'fresh install');
  assert.equal(shouldOfferStart({ hasSession: true }), false, 'a returning user is not asked');
  assert.equal(shouldOfferStart({ hasSession: false, sharePending: true }), false,
    'a shared link IS a starting point');
});

test('choosing anything stops it being asked again', async () => {
  reset();
  assert.equal(shouldOfferStart({ hasSession: false }), true);
  await pick('blank');
  assert.equal(shouldOfferStart({ hasSession: false }), false,
    'a blank start is still a choice, and must not re-prompt forever');
});

test('blank means blank — no cables, no trackers, and no oscillator', async () => {
  reset();
  await pick('blank');
  assert.equal(mapper.mappings.length, 0, 'nothing wired');
  assert.equal(engine.getOscCount(), 0, 'not even one oscillator');
  assert.equal(chordmode.enabled, false);
  assert.deepEqual(asked, { handsL: false, handsR: false, pose: false, face: false, gaze: false });
});

test('chord mode starts with the chords and nothing else making sound', async () => {
  reset();
  await pick('chords');
  assert.equal(chordmode.enabled, true);
  assert.equal(mapper.mappings.length, 0, 'chords come from handshapes, not cables');
  assert.equal(engine.getOscCount(), 0, 'a lead drone under the chords is not what was picked');
  // Handshapes are what plays it, so the hands have to be tracked.
  assert.equal(asked.handsL && asked.handsR, true);
  assert.equal(asked.pose || asked.face || asked.gaze, false);
});

test('single notes is chord mode in note voicing, not a second mode', async () => {
  reset();
  const s = await pick('notes');
  assert.equal(chordmode.enabled, true, 'the same panel plays it');
  assert.equal(chordmode.getVoicing(), 'note');
  assert.equal(s.mode, 'chords', 'so it gets the handshape tour, not the patchbay one');
  assert.equal(mapper.mappings.length, 0);
  assert.equal(engine.getOscCount(), 0);
  assert.equal(asked.handsL && asked.handsR, true);
  assert.equal(asked.pose || asked.face || asked.gaze, false);
});

test('each handshape choice states its voicing rather than inheriting the last', async () => {
  reset();
  await pick('notes');
  assert.equal(chordmode.getVoicing(), 'note');
  // Picking again — a second fresh install, or a LOAD — must not land on
  // chords-that-play-single-notes because of what someone chose before.
  store.delete('motionmuse-started');
  await pick('chords');
  assert.equal(chordmode.getVoicing(), 'chord');
});

test('a mapping preset wires its cables and asks for exactly its trackers', async () => {
  reset();
  const s = await pick('face-brow-mouth');
  assert.equal(s.name, 'Face · Brow & Mouth');
  assert.equal(mapper.mappings.length, 2);
  assert.deepEqual(asked, { handsL: false, handsR: false, pose: false, face: true, gaze: false });
});

test('an unknown id falls back to blank rather than throwing', async () => {
  reset();
  const s = await pick('nonsense');
  assert.equal(s.id, 'blank');
  assert.equal(engine.getOscCount(), 0);
});
