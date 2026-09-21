// Gesture mode's assignments are cables, both ways round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapper } from '../../src/mapper.js';
import { chordmode } from '../../src/chordmode.js';
import { initChordCables, DEGREE_KEYS, RELEASE_KEY, ACC_KEYS, CABLE_ID } from '../../src/chordcables.js';

const cableOn = key => mapper.mappings.find(m => m.audioParam === key)?.signal ?? null;

initChordCables();

test('the default shapes arrive as one cable per slot, from the shape\'s signal', () => {
  chordmode.setEnabled(true);
  assert.equal(cableOn(DEGREE_KEYS[0]), `gesture_${chordmode.gestureFor(0)}`);
  assert.equal(cableOn(RELEASE_KEY), `gesture_${chordmode.getReleaseGesture()}`);
  assert.equal(cableOn(ACC_KEYS.sharp), `gesture_${chordmode.accidentalGestures().sharp}`);
  const chord = mapper.mappings.filter(m => /^chord_(trig|acc)_/.test(m.audioParam));
  assert.equal(chord.length, 10);
});

test('choosing a shape for a degree re-strings the cables — a swap moves two', () => {
  const was0 = chordmode.gestureFor(0), was4 = chordmode.gestureFor(4);
  chordmode.setDegreeGesture(0, was4);
  assert.equal(cableOn(DEGREE_KEYS[0]), `gesture_${was4}`);
  assert.equal(cableOn(DEGREE_KEYS[4]), `gesture_${was0}`);
  const onFour = mapper.mappings.filter(m => m.signal === `gesture_${was4}`);
  assert.equal(onFour.length, 1, 'one shape, one cable');
});

test('a cable from a shape into a degree assigns it; unplugging clears it', () => {
  const m = mapper.mappings.find(x => x.audioParam === DEGREE_KEYS[2]);
  mapper.remove(m.id);
  assert.equal(chordmode.gestureFor(2), null);
  mapper.add(DEGREE_KEYS[2], 'gesture_palm', 0, 1, 'linear', 0, false);
  assert.equal(chordmode.gestureFor(2), 'palm');
  assert.equal(mapper.mappings.filter(x => x.signal === 'gesture_palm').length, 1, 'palm left the degree it had');
});

test('any other signal holds the degree itself while high', () => {
  const m = mapper.mappings.find(x => x.audioParam === DEGREE_KEYS[1]);
  mapper.remove(m.id);
  mapper.add(DEGREE_KEYS[1], 'metro_beat', 0, 1, 'linear', 0, false);
  assert.equal(chordmode.gestureFor(1), CABLE_ID(1));
  chordmode.setCableHeld(CABLE_ID(1), true);
  // Cable-held sources name from no side.
  const m2 = mapper.mappings.find(x => x.audioParam === DEGREE_KEYS[1]);
  mapper.remove(m2.id);
  assert.equal(chordmode.gestureFor(1), null);
});

test('a patch that replaces the cables takes the shapes; switching on brings the defaults back', () => {
  mapper.load([]);
  assert.equal(chordmode.gestureFor(0), null);
  assert.equal(chordmode.getReleaseGesture(), null);
  chordmode.setEnabled(false);
  chordmode.setEnabled(true);
  assert.equal(chordmode.gestureFor(0), 'point');
  assert.equal(mapper.mappings.filter(m => /^chord_(trig|acc)_/.test(m.audioParam)).length, 10);
});
