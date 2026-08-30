// The order handshapes are listed in.
//
// Where a handshape IS an ASL handshape it already has a name in the language
// — its gloss — and that gloss orders it, lexicographically. The point of
// pinning it here is the awkward part: it is a STRING sort, so "10" lands
// between "1" and "2", and a well-meant "fix" to a numeric sort would look
// right for the numerals and have nowhere to put "L", "S" or "ILY".
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gesture, orderByGloss } from '../../src/gesture.js';

const glosses = list => list.filter(g => g.asl).map(g => g.asl);

test('ASL handshapes are listed in lexicographic gloss order', () => {
  assert.deepEqual(glosses(gesture.list()),
    ['0', '1', '10', '2', '3', '4', '5', '6', '7', '8', '9', 'ILY', 'L', 'S']);
});

test('"10" sits between "1" and "2" — lexicographic, not numeric', () => {
  const g = glosses(gesture.list());
  assert.equal(g.indexOf('10'), g.indexOf('1') + 1);
  assert.equal(g.indexOf('2'), g.indexOf('10') + 1);
});

test('lettered glosses follow the numerals, and each other', () => {
  const g = glosses(gesture.list());
  assert.ok(g.indexOf('ILY') > g.indexOf('9'), 'letters come after digits');
  assert.ok(g.indexOf('ILY') < g.indexOf('L'));
  assert.ok(g.indexOf('L') < g.indexOf('S'));
});

test('handshapes with no gloss are not ASL, so they are not reordered', () => {
  // They follow the glossed ones, in the order they are declared.
  const tail = gesture.list().filter(g => !g.asl && g.builtin).map(g => g.id);
  assert.deepEqual(tail, ['horns', 'thumbsdown']);
  const ids = gesture.list().map(g => g.id);
  assert.ok(ids.indexOf('horns') > ids.indexOf('fist'),
    'the unglossed ones sit after every glossed one');
});

test('ordering keeps every handshape, exactly once', () => {
  const before = [{ id: 'z', asl: 'S' }, { id: 'y' }, { id: 'x', asl: '1' }];
  const after = orderByGloss(before);
  assert.equal(after.length, before.length);
  assert.deepEqual([...after].map(g => g.id).sort(), ['x', 'y', 'z']);
  assert.deepEqual(after.map(g => g.id), ['x', 'z', 'y']);
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
