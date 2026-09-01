// Flag semaphore as a body gesture: seven arm positions for the seven degrees
// of a key, in a notation where A…G already MEAN 1…7.
//
// What is pinned here is the part that is easy to get wrong and impossible to
// see in a diff. First the geometry — the letters have to sit on the actual
// semaphore positions, in the signaller's own frame, and published charts are
// drawn mirrored, so a template built by copying one would put every letter on
// the wrong arm. Second the recognition — an arm is a noisier instrument than
// a finger and there are only eight templates in this space, so "is A still A
// when the arm is 10° off?" and "does standing still sound a chord?" are both
// real questions with numeric answers.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gesture, gestureLabel, matchGesture, templateSeparation,
         kindOf, KINDS, MATCH_THRESHOLD, SEPARATION_FLOOR } from '../../src/gesture.js';

const SEM = () => gesture.list().filter(g => kindOf(g) === 'body' && g.f);
const byId = id => SEM().find(g => g.id === id);
const CH = KINDS.body.features;
const at = (g, name) => g.f[CH.indexOf(name)];

// Deterministic PRNG so failures reproduce exactly.
let seed = 7;
const reset = s => { seed = s; };
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0, seed / 2 ** 32);
const clamp = v => Math.max(0, Math.min(1, v));

// ── The geometry ─────────────────────────────────────────────────────────

test('the first circle sweeps one position at a time, right arm to left', () => {
  // A → D lift the RIGHT arm through low, out, high, up; E → G bring the LEFT
  // arm back down through high, out, low. That is the circle the name refers
  // to, and each step is one 45° position: 0.25 of `arm_raise`.
  const rise = ['sem_a', 'sem_b', 'sem_c', 'sem_d'].map(id => at(byId(id), 'arm_raise_R'));
  assert.deepEqual(rise, [0.25, 0.50, 0.75, 1.00]);
  const fall = ['sem_e', 'sem_f', 'sem_g'].map(id => at(byId(id), 'arm_raise_L'));
  assert.deepEqual(fall, [0.75, 0.50, 0.25]);
  // …and the arm that is not signalling hangs, in every one of them.
  for (const id of ['sem_a', 'sem_b', 'sem_c', 'sem_d'])
    assert.equal(at(byId(id), 'arm_raise_L'), 0, `${id} raises the wrong arm`);
  for (const id of ['sem_e', 'sem_f', 'sem_g'])
    assert.equal(at(byId(id), 'arm_raise_R'), 0, `${id} raises the wrong arm`);
  assert.deepEqual([at(byId('sem_rest'), 'arm_raise_L'), at(byId('sem_rest'), 'arm_raise_R')],
    [0, 0], 'rest is both arms down');
});

// The mirror is the trap: semaphore charts are drawn in receive mode, so the
// arm on the left of the picture is the signaller's right. Copying a chart
// straight across puts every letter on the wrong arm — and the whole set would
// still be self-consistent and still pass a separation test, which is why this
// asserts the handedness directly.
test('the letters are on the signaller\'s own arms, not the chart\'s', () => {
  assert.ok(at(byId('sem_a'), 'arm_raise_R') > at(byId('sem_a'), 'arm_raise_L'),
    'A is the RIGHT arm low');
  assert.ok(at(byId('sem_g'), 'arm_raise_L') > at(byId('sem_g'), 'arm_raise_R'),
    'G is the LEFT arm low');
});

test('a letter reads as a letter, and the label says which', () => {
  assert.equal(gestureLabel(byId('sem_a')), 'Semaphore A · Right Low');
  assert.equal(gestureLabel(byId('sem_e')), 'Semaphore E · Left High');
  assert.equal(gestureLabel(byId('sem_rest')), 'Semaphore Rest');
  // A…G double as the digits 1…7, which is the whole reason there are seven
  // of them: one per degree of a key.
  assert.deepEqual(SEM().filter(g => g.sem).map(g => g.sem),
    ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
});

test('the metric asks only how high each arm is', () => {
  const kept = new Set(['arm_raise_L', 'arm_raise_R', 'shoulder_elev_L', 'shoulder_elev_R']);
  for (const g of SEM()) {
    assert.equal(g.f.length, CH.length, `${g.id} wrong length`);
    CH.forEach((name, i) => {
      assert.equal(!!g.m[i], kept.has(name),
        `${g.id} ${kept.has(name) ? 'ignores' : 'demands'} ${name}`);
    });
  }
});

// ── The recognition ──────────────────────────────────────────────────────

// An arm is not a finger: it lands within a few degrees of where you meant it,
// the pose model's joint estimate wobbles, and you do not stand square to the
// camera. ±10° of aim plus a couple of degrees of frame noise, on both arms.
const AIM = 10 / 180, NOISE = 2.5 / 180;
const degrade = f => f.map((v, i) => {
  const name = CH[i];
  if (!/^(arm_raise|shoulder_elev)_/.test(name)) return v;
  return clamp(v + (rnd() - 0.5) * 2 * AIM + (rnd() - 0.5) * 2 * NOISE);
});

test('every letter survives an arm that is ten degrees off', () => {
  reset(11);
  const T = SEM();
  for (const g of T) {
    let hit = 0;
    for (let k = 0; k < 400; k++) {
      if (matchGesture(degrade(g.f), T, MATCH_THRESHOLD, null, 'body')?.id === g.id) hit++;
    }
    assert.ok(hit / 400 >= 0.95,
      `${g.id}: only ${(hit / 400 * 100).toFixed(1)}% recognized`);
  }
});

// The reason REST is a template at all. Standing normally is 0.177 from both A
// and G — inside the 0.20 match threshold — so without a pose of its own,
// simply standing there would name a degree and sound a chord that nothing
// asked for.
test('standing still is Rest, and Rest is not a letter', () => {
  reset(23);
  const T = SEM();
  const standing = () => degrade(byId('sem_rest').f);
  let asLetter = 0;
  for (let k = 0; k < 400; k++) {
    const m = matchGesture(standing(), T, MATCH_THRESHOLD, null, 'body');
    if (m && m.id !== 'sem_rest') asLetter++;
  }
  assert.equal(asLetter, 0, `${asLetter}/400 idle frames named a letter`);
  // And with no Rest template it WOULD, which is what makes shipping one the
  // fix rather than a nicety.
  reset(23);
  const noRest = T.filter(g => g.id !== 'sem_rest');
  let caught = 0;
  for (let k = 0; k < 400; k++) {
    if (matchGesture(standing(), noRest, MATCH_THRESHOLD, null, 'body')) caught++;
  }
  assert.ok(caught > 200, `only ${caught}/400 — rest may no longer need a template`);
});

test('the eight poses are as far apart as any shipped shape has to be', () => {
  const T = SEM();
  let worst = { d: Infinity };
  for (let i = 0; i < T.length; i++)
    for (let j = i + 1; j < T.length; j++) {
      const d = templateSeparation(T[i], T[j]);
      if (d < worst.d) worst = { d, a: T[i].id, b: T[j].id };
    }
  assert.ok(worst.d >= SEPARATION_FLOOR,
    `${worst.a} ~ ${worst.b} = ${worst.d.toFixed(3)} < floor ${SEPARATION_FLOOR}`);
});

// A pose is only ever matched inside its own kind, so an arm position can
// never be answered with a handshape however close the numbers look.
test('an arm pose is never answered with a handshape', () => {
  const all = gesture.list().filter(g => g.f);
  for (const g of SEM()) {
    const m = matchGesture(g.f, all, MATCH_THRESHOLD, null, 'body');
    assert.equal(m?.id, g.id, `${g.id} matched ${m?.id}`);
    assert.equal(kindOf(all.find(t => t.id === m.id)), 'body');
  }
});
