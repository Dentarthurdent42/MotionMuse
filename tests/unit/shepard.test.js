// The Shepard spectrum. These assert the properties the illusion depends on —
// if any of them stops holding, what you hear is an arpeggio, not an endless
// rise.

import test from 'node:test';
import assert from 'node:assert/strict';
import { shepardPartials, SHEP_FMIN, SHEP_PARTIALS } from '../../src/shepard.js';

const sum = a => a.reduce((t, p) => t + p.gain, 0);

test('octaves of the same note give an identical spectrum', () => {
  // The property the whole illusion rests on: sweep up an octave and you are
  // back where you began, so the rise can continue forever.
  const a = shepardPartials(220);
  for (const hz of [55, 110, 440, 880, 1760]) {
    const b = shepardPartials(hz);
    assert.equal(b.length, a.length);
    for (let i = 0; i < a.length; i++) {
      assert.ok(Math.abs(a[i].hz - b[i].hz) < 1e-6, `partial ${i} moved for ${hz}Hz`);
      assert.ok(Math.abs(a[i].gain - b[i].gain) < 1e-9, `gain ${i} moved for ${hz}Hz`);
    }
  }
});

test('partials are octave-spaced and gains sum to one', () => {
  const p = shepardPartials(330);
  assert.equal(p.length, SHEP_PARTIALS);
  for (let i = 1; i < p.length; i++) {
    assert.ok(Math.abs(p[i].hz / p[i - 1].hz - 2) < 1e-9, 'partials must be an octave apart');
  }
  // Unit sum is what lets a Shepard voice replace a plain oscillator without
  // the patch suddenly getting louder or quieter.
  assert.ok(Math.abs(sum(p) - 1) < 1e-9, `gains summed to ${sum(p)}`);
});

test('the envelope is fixed in absolute frequency, not relative to the note', () => {
  // Partials near the centre are loudest and the edges are quiet, REGARDLESS of
  // which note is playing — that is what makes partials fade rather than jump.
  for (const hz of [200, 300, 450]) {
    const p = shepardPartials(hz);
    const loudest = p.indexOf(p.reduce((m, x) => (x.gain > m.gain ? x : m)));
    assert.ok(loudest > 0 && loudest < p.length - 1,
      'the loudest partial must be in the middle of the stack, not at an edge');
    assert.ok(p[0].gain < p[loudest].gain && p[p.length - 1].gain < p[loudest].gain,
      'the extremes must be quieter than the centre');
  }
});

test('partials arrive and leave silently, so the octave wrap has no seam', () => {
  // Comparing the two sides of the wrap slot-by-slot is meaningless: as theta
  // passes 1 the whole stack shifts one place, so partial i becomes partial
  // i+1. That is bookkeeping, not a sound. What must actually hold is that the
  // partial leaving the top and the one arriving at the bottom are BOTH
  // silent — then the shift is inaudible — and that everything in between is
  // unchanged.
  const at = t => shepardPartials(SHEP_FMIN * Math.pow(2, 3 + t));
  const high = at(0.999);       // just before the wrap
  const low  = at(0.001);       // just after

  assert.ok(high[high.length - 1].gain < 0.01,
    `the departing partial must have faded out, was ${high[high.length - 1].gain.toFixed(4)}`);
  assert.ok(low[0].gain < 0.01,
    `the arriving partial must fade in from nothing, was ${low[0].gain.toFixed(4)}`);

  for (let i = 0; i < SHEP_PARTIALS - 1; i++) {
    assert.ok(Math.abs(high[i].gain - low[i + 1].gain) < 0.01,
      `partial ${i} should carry over unchanged across the wrap: ` +
      `${high[i].gain.toFixed(4)} vs ${low[i + 1].gain.toFixed(4)}`);
    assert.ok(Math.abs(high[i].hz / low[i + 1].hz - 1) < 0.01,
      'and at the same frequency');
  }
});

test('nonsense input yields no partials rather than NaN frequencies', () => {
  for (const bad of [0, -100, NaN, undefined]) {
    assert.deepEqual(shepardPartials(bad), [], `${bad} should produce nothing`);
  }
});
