// Arbitration between MediaPipe's canned gesture classifier and this app's
// template matcher.
//
// The hand model is now GestureRecognizer, which is the same hand landmarker
// with a trained classifier head bundled beside it. That classifier is better
// than hand-measured templates at the seven shapes it knows — and knows nothing
// about the ASL number handshapes, rock horns, or anything the user recorded.
// resolveGesture decides who wins, and this pins that policy, because the
// failure it prevents is silent: a confident "Open_Palm" stealing every ASL 4.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gesture, resolveGesture, matchGesture, CANNED_TO_ID, CANNED_MIN_SCORE,
  FEATURES,
} from '../../src/gesture.js';

const T = gesture.list();
const feat = id => T.find(g => g.id === id).f;
const canned = (name, score = 0.95) => ({ name, score });

// A vector that is nothing in particular: mid-range everywhere, so the
// template matcher rejects it.
const NOTHING = [0.4, 0.5, 0.5, 0.5, 0.5, 0.6, 0.3, 0.3, 0, 0, 0, 0];

test('the canned map only names gestures this app actually has', () => {
  const ids = new Set(T.map(g => g.id));
  for (const [cat, id] of Object.entries(CANNED_TO_ID))
    assert.ok(ids.has(id), `${cat} maps to ${id}, which is not a gesture`);
});

test('every canned category is a real MediaPipe label', () => {
  // Verified against the model bundle's own labels.txt, not from memory:
  // gesture_recognizer.task contains labels.txt =
  // None, Closed_Fist, Open_Palm, Pointing_Up, Thumb_Down, Thumb_Up, Victory,
  // ILoveYou.
  const LABELS = new Set(['Closed_Fist', 'Open_Palm', 'Pointing_Up',
    'Thumb_Down', 'Thumb_Up', 'Victory', 'ILoveYou']);
  for (const cat of Object.keys(CANNED_TO_ID))
    assert.ok(LABELS.has(cat), `${cat} is not a category the model emits`);
});

test('the two classifier-only gestures ship without a template', () => {
  for (const id of ['thumbsdown', 'iloveyou']) {
    const g = T.find(x => x.id === id);
    assert.ok(g, `${id} missing`);
    assert.equal(g.f, undefined, `${id} must not ship an invented vector`);
    assert.ok(g.canned, `${id} needs a canned category to be reachable at all`);
  }
  // …and the matcher must skip them rather than treating a missing vector as
  // neutral, which would make them match anything mid-range.
  assert.equal(matchGesture(NOTHING, T, 99)?.id === 'thumbsdown', false);
});

test('with no classifier the result is exactly the template match', () => {
  for (const id of ['fist', 'palm', 'asl6', 'horns']) {
    assert.equal(resolveGesture(feat(id), T, null)?.id, id);
  }
  assert.equal(resolveGesture(NOTHING, T, null), null);
});

test('a confident classifier wins a shape it can name', () => {
  // Fist-shaped hand, classifier says palm: trust the trained model over the
  // hand-measured template — that is the entire reason for adopting it.
  const r = resolveGesture(feat('fist'), T, canned('Open_Palm'));
  assert.equal(r.id, 'palm');
  assert.equal(r.src, 'canned');
});

test('a template the classifier CANNOT name is not overruled by it', () => {
  // The point of the whole exercise. ASL 4 is four fingers with the thumb
  // folded across the palm; the classifier has no such category, so its nearest
  // answer is Open_Palm. That is it naming the closest thing it knows, not
  // evidence the hand is open — so the template must survive.
  for (const id of ['asl3', 'asl4', 'asl6', 'asl7', 'asl8', 'asl9', 'asl0', 'horns']) {
    const r = resolveGesture(feat(id), T, canned('Open_Palm'));
    assert.equal(r?.id, id, `${id} was stolen by the classifier`);
  }
});

test('a low-confidence classification is ignored', () => {
  const weak = canned('Open_Palm', CANNED_MIN_SCORE - 0.01);
  assert.equal(resolveGesture(feat('fist'), T, weak)?.id, 'fist', 'template kept');
  assert.equal(resolveGesture(NOTHING, T, weak), null, 'and creates no match');
  // …and just above the line it does count.
  assert.equal(resolveGesture(NOTHING, T, canned('Open_Palm', CANNED_MIN_SCORE))?.id,
    'palm');
});

test('the classifier can name a gesture no template would have matched', () => {
  // Thumbs Down has no template at all, so this is the only way to reach it.
  const r = resolveGesture(NOTHING, T, canned('Thumb_Down'));
  assert.equal(r.id, 'thumbsdown');
  assert.equal(r.src, 'canned');
});

test('no hand means no gesture, whatever the classifier last said', () => {
  // The stale-classification ghost: the hand leaves frame, the last answer is
  // still sitting there, and the release debounce would happily hold it.
  assert.equal(resolveGesture(null, T, canned('Open_Palm')), null);
});

test('a hidden gesture cannot be resurrected by the classifier', () => {
  const without = T.filter(g => g.id !== 'palm');
  const r = resolveGesture(feat('asl4'), without, canned('Open_Palm'));
  assert.notEqual(r?.id, 'palm', 'a removed gesture must stay removed');
});

test('an unknown category name is ignored rather than throwing', () => {
  assert.equal(resolveGesture(feat('fist'), T, canned('Rock_On'))?.id, 'fist');
  assert.equal(resolveGesture(feat('fist'), T, canned('None'))?.id, 'fist');
});

test('feature vector length is unchanged — this is a classifier, not new inputs', () => {
  assert.equal(FEATURES.length, 12);
});
