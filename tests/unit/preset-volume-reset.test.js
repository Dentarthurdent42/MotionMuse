// Choosing a preset puts every level slider back at its default.
// Run: npm run test:unit  (plain `node --test`, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapper } from '../../src/mapper.js';
import { engine } from '../../src/engine.js';

const LEVELS = ['volume', 'osc_volume', 'chord_volume', 'loop_volume'];

test('applyPreset resets the level sliders to their defaults', () => {
  engine.setOscCount(2);
  // Each default as the slider itself lands on it: with Volume Quantize on,
  // Main Vol snaps to the nearest rung of its ladder rather than to 0.55.
  const defaults = Object.fromEntries(
    [...LEVELS, 'osc1_volume', 'osc2_volume'].map(k => {
      engine.set(k, engine.PARAMS[k].val);
      return [k, engine.PARAMS[k].val];
    }));
  for (const k of Object.keys(defaults)) engine.set(k, 0);
  engine.set('filter_freq', 500);

  mapper.applyPreset('face-brow-mouth');

  for (const [k, v] of Object.entries(defaults)) assert.equal(engine.PARAMS[k].val, v, k);
  // Only the levels: other sliders keep what you dialled in.
  assert.equal(engine.PARAMS.filter_freq.val, 500);
});
