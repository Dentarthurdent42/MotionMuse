// The order handshapes are listed in.
//
// Where a handshape IS an ASL handshape it already has a name in the language
// — its gloss — and that gloss orders it. Numerals count and letters spell:
// a plain string sort would be lexicographic and would put "10" between "1"
// and "2", which is right for strings and wrong for a person counting on
// their hand. What is pinned here is that 10 lands after 9, that the letters
// follow the numbers rather than interleaving, and that the gloss leads the
// label it is sorted by.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gesture, gestureLabel, orderByGloss } from '../../src/gesture.js';

const glosses = list => list.filter(g => g.asl).map(g => g.asl);

test('ASL handshapes are listed in gloss order', () => {
  assert.deepEqual(glosses(gesture.list()),
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'ILY', 'L', 'S']);
});

test('the numerals count — 10 lands after 9, not after 1', () => {
  const g = glosses(gesture.list());
  assert.equal(g.indexOf('10'), g.indexOf('9') + 1);
  // The failure this guards against is a plain string sort, which is
  // lexicographic and would seat "10" between "1" and "2".
  assert.ok(g.indexOf('10') > g.indexOf('2'));
});

test('lettered glosses follow the numerals, and spell among themselves', () => {
  const g = glosses(gesture.list());
  assert.ok(g.indexOf('ILY') > g.indexOf('10'), 'letters come after every number');
  assert.ok(g.indexOf('ILY') < g.indexOf('L'));
  assert.ok(g.indexOf('L') < g.indexOf('S'));
});

test('the gloss leads the label it is sorted by', () => {
  const point = gesture.list().find(g => g.id === 'point');
  assert.equal(gestureLabel(point), 'ASL 1 · Point');
  assert.equal(gestureLabel(gesture.list().find(g => g.id === 'horns')), 'Rock Horns',
    'a shape with no gloss is just its name');
});

test('handshapes with no gloss are not ASL, so they are not reordered', () => {
  // They follow the glossed ones, in the order they are declared.
  const tail = gesture.list().filter(g => !g.asl && !g.sem && g.builtin).map(g => g.id);
  assert.deepEqual(tail, ['horns', 'thumbsdown', 'sem_rest']);
  const ids = gesture.list().map(g => g.id);
  assert.ok(ids.indexOf('horns') > ids.indexOf('fist'),
    'the unglossed ones sit after every glossed one');
});

test('semaphore is its own gloss, in the order the circle is signed', () => {
  // A letter is a gloss too, just not an ASL one — so the poses are a block
  // of their own rather than being sorted in among the numerals (where 'A'
  // would land between 'ILY' and 'L') or dropped in with the unglossed.
  const ids = gesture.list().filter(g => g.sem).map(g => g.id);
  assert.deepEqual(ids, ['sem_a', 'sem_b', 'sem_c', 'sem_d', 'sem_e', 'sem_f', 'sem_g']);
  const all = gesture.list().map(g => g.id);
  assert.ok(all.indexOf('sem_a') > all.indexOf('gun'),
    'the ASL glosses come first');
});

test('ordering keeps every handshape, exactly once', () => {
  const before = [{ id: 'z', asl: 'S' }, { id: 'y' }, { id: 'x', asl: '10' },
                  { id: 'w', asl: '2' }];
  const after = orderByGloss(before);
  assert.equal(after.length, before.length);
  assert.deepEqual([...after].map(g => g.id).sort(), ['w', 'x', 'y', 'z']);
  assert.deepEqual(after.map(g => g.id), ['w', 'x', 'z', 'y']);
});

test('recorded handshapes are the user’s own, and stay last in the order made', () => {
  gesture.load({ custom: [
    { id: 'custom1', name: 'Zed', f: [], hand: 'any' },
    { id: 'custom2', name: 'Alpha', f: [], hand: 'any' },
  ] });
  const ids = gesture.list().map(g => g.id);
  assert.deepEqual(ids.slice(-2), ['custom1', 'custom2']);
  gesture.load({ custom: [] });
});
