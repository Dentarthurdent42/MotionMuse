// Unit tests for optional per-cable step quantisation in the mapper.
// Run: npm run test:unit  (plain `node --test`, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bus } from '../../src/bus.js';
import { mapper } from '../../src/mapper.js';
import { engine } from '../../src/engine.js';

bus.register('t_step', { label: 'test', group: 'test', min: 0, max: 1 });
// Volume has its own ladder; use a param without one so we measure the mapper.
const cable = (over = {}) => mapper.load([{
  audioParam: 'filter_freq', signal: 't_step', outMin: 100, outMax: 1100,
  curve: 'linear', ...over,
}]);
const sweep = () => {
  const seen = new Set();
  for (let k = 0; k <= 200; k++) {
    bus.update('t_step', k / 200);
    mapper.tick();
    seen.add(+engine.PARAMS.filter_freq.val.toFixed(6));
  }
  return [...seen].sort((a, b) => a - b);
};

test('steps quantises a cable into N evenly spaced output levels', () => {
  cable({ steps: 5 });
  assert.deepEqual(sweep(), [100, 350, 600, 850, 1100]);
});

test('both endpoints are reachable', () => {
  cable({ steps: 4 });
  const s = sweep();
  assert.equal(s[0], 100);
  assert.equal(s[s.length - 1], 1100);
});

test('quantisation happens after the curve — same levels, different travel', () => {
  cable({ steps: 5, curve: 'quad' });
  // The reachable SET is identical to linear (quantised post-curve); only which
  // input reaches which level differs.
  assert.deepEqual(sweep(), [100, 350, 600, 850, 1100]);
});

test('steps 0 / absent / 1 mean continuous', () => {
  for (const over of [{ steps: 0 }, {}, { steps: 1 }]) {
    cable(over);
    assert.ok(sweep().length > 20, `expected continuous for ${JSON.stringify(over)}`);
  }
});

test('sticky index prevents chatter at a level boundary', () => {
  cable({ steps: 5 });
  bus.update('t_step', 0.5); mapper.tick();
  const settled = engine.PARAMS.filter_freq.val;
  let changes = 0;
  for (let i = 0; i < 200; i++) {
    bus.update('t_step', 0.5 + (i % 2 ? 0.02 : -0.02));
    mapper.tick();
    if (engine.PARAMS.filter_freq.val !== settled) changes++;
  }
  assert.equal(changes, 0, `expected no chatter, saw ${changes}`);
});

test('steps round-trips through serialize/load and leaks no internal state', () => {
  cable({ steps: 8 });
  mapper.tick();
  const s = mapper.serialize()[0];
  assert.equal(s.steps, 8);
  assert.ok(!('_stepIdx' in s), 'internal sticky index leaked into the preset');
  assert.ok(!('id' in s));
  mapper.load(mapper.serialize());
  assert.equal(mapper.mappings[0].steps, 8);
});

test('steps is coerced and clamped', () => {
  cable({ steps: 3.7 });   assert.equal(mapper.mappings[0].steps, 4);
  cable({ steps: 999 });   assert.equal(mapper.mappings[0].steps, 32);
  cable({ steps: -5 });    assert.equal(mapper.mappings[0].steps, 0);
  cable({ steps: 'abc' }); assert.equal(mapper.mappings[0].steps, 0);
});
