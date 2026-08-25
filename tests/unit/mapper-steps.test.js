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

// ── Per-connection invert ──
import { PRESETS, DEFAULT_PRESET, trackersFor } from '../../src/mapper.js';
import { missingFor } from '../../src/ui/preset-menu.js';

const driveInv = (v, opts) => {
  mapper.load([{ audioParam: 'filter_freq', signal: 'test_sig',
                 outMin: 100, outMax: 1100, curve: 'linear', steps: 0, ...opts }]);
  bus.update('test_sig', v);
  mapper.tick();
  return engine.PARAMS.filter_freq.val;
};

test('invert reverses the connection end to end', () => {
  bus.register('test_sig', { min: 0, max: 1 });
  assert.equal(driveInv(0, { invert: false }), 100);
  assert.equal(driveInv(1, { invert: false }), 1100);
  assert.equal(driveInv(0, { invert: true }), 1100, 'low input → high output');
  assert.equal(driveInv(1, { invert: true }), 100,  'high input → low output');
  assert.equal(driveInv(0.5, { invert: true }), driveInv(0.5, { invert: false }),
    'the midpoint is the pivot');
});

test('invert composes with a curve rather than reshaping it', () => {
  bus.register('test_sig', { min: 0, max: 1 });
  // quad then flip: output should mirror the un-inverted quad response.
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const plain = driveInv(v, { curve: 'quad' });
    const flipped = driveInv(v, { curve: 'quad', invert: true });
    assert.ok(Math.abs((plain - 100) + (flipped - 100) - 1000) < 1e-9,
      `at ${v} the two should sum to the full span`);
  }
});

test('invert composes with steps and stays on the rungs', () => {
  bus.register('test_sig', { min: 0, max: 1 });
  const rungs = new Set();
  for (let v = 0; v <= 1.0001; v += 0.01) rungs.add(+driveInv(v, { steps: 5, invert: true }).toFixed(6));
  for (const r of rungs) {
    const t = (r - 100) / 1000;
    assert.ok(Math.abs(t * 4 - Math.round(t * 4)) < 1e-6, `${r} is not on a 5-step rung`);
  }
  assert.ok(rungs.size >= 4, `expected the rungs to be reachable, saw ${rungs.size}`);
});

test('invert survives serialize → load, and defaults to false', () => {
  mapper.load([{ audioParam: 'volume', signal: 'x', outMin: 0, outMax: 1, curve: 'linear', steps: 0, invert: true }]);
  assert.equal(mapper.serialize()[0].invert, true);
  mapper.load(mapper.serialize());
  assert.equal(mapper.serialize()[0].invert, true);
  // A pre-invert preset file has no such field and must load as un-inverted.
  mapper.load([{ audioParam: 'volume', signal: 'x', outMin: 0, outMax: 1, curve: 'linear' }]);
  assert.equal(mapper.serialize()[0].invert, false);
});

// ── Preset library ──
test('every preset references real params and real signals', async () => {
  // Every source that can back a preset signal, registered the way main.js
  // does at startup — depth included, since hand_R_z lives there.
  const { cvSource } = await import('../../src/cv.js');
  const { faceSource } = await import('../../src/face.js');
  const { depthSource } = await import('../../src/depth.js');
  cvSource.registerSignals();
  faceSource.registerSignals();
  depthSource.init();
  for (const p of PRESETS) {
    assert.ok(p.id && p.name && p.hint, `${p.id} missing metadata`);
    assert.ok(p.mappings.length > 0, `${p.id} has no mappings`);
    // A preset may name oscillator slots the bank does not currently have —
    // most are voiced for two and the default bank is one — so APPLYING it has
    // to make them real. That is the guarantee worth pinning: a preset whose
    // params don't exist afterwards is a patch with dead cables in it.
    engine.setOscCount(1);
    mapper.applyPreset(p.id);
    for (const [param, sig, lo, hi] of p.mappings) {
      assert.ok(engine.PARAMS[param],
        `${p.id}: ${param} still missing after the preset was applied`);
      assert.ok(bus.signals.has(sig), `${p.id}: unknown signal ${sig}`);
      assert.ok(Number.isFinite(lo) && Number.isFinite(hi), `${p.id}: bad range on ${param}`);
      const P = engine.PARAMS[param];
      assert.ok(Math.min(lo, hi) >= P.min && Math.max(lo, hi) <= P.max,
        `${p.id}: ${param} range ${lo}..${hi} escapes ${P.min}..${P.max}`);
    }
  }
});

test('a preset voiced for more oscillators grows the bank to fit', () => {
  engine.setOscCount(1);
  const p = PRESETS.find(x => x.mappings.some(m => m[0].startsWith('osc2_')));
  assert.ok(p, 'no preset uses a second oscillator — this test has gone stale');
  mapper.applyPreset(p.id);
  assert.ok(engine.getOscCount() >= 2, `bank stayed at ${engine.getOscCount()}`);
  // …and never the other way: a one-oscillator patch must not delete slots the
  // player added.
  engine.setOscCount(4);
  mapper.applyPreset('face-brow-mouth');
  assert.equal(engine.getOscCount(), 4, 'a smaller patch shrank the bank');
  engine.setOscCount(1);
});

test('a preset asks for exactly the trackers its cables use', () => {
  // Derived from the signals the preset wires, not from a list beside it, so
  // this checks the derivation against the requested behaviour: choosing
  // "Face · Brow & Mouth" must switch face ON and hands, pose and gaze OFF.
  const want = id => trackersFor(PRESETS.find(p => p.id === id));
  assert.deepEqual(want('face-brow-mouth'),
    { handsL: false, handsR: false, pose: false, face: true, gaze: false });
  assert.deepEqual(want('gaze'),
    { handsL: false, handsR: false, pose: false, face: true, gaze: true });
  assert.deepEqual(want('pose'),
    { handsL: false, handsR: false, pose: true, face: false, gaze: false });
  // The hands patch uses both hands, and reaches for pose too (elbow angle,
  // and hand_R_z comes off the depth pipeline).
  assert.deepEqual(want('hands'),
    { handsL: true, handsR: true, pose: true, face: false, gaze: false });

  // Every preset must ask for something, or applying it silences the app.
  for (const p of PRESETS) {
    const t = trackersFor(p);
    assert.ok(Object.values(t).some(Boolean), `${p.id} needs no tracker at all`);
  }
});

test('an unknown or empty preset asks for nothing rather than throwing', () => {
  assert.deepEqual(trackersFor(undefined),
    { handsL: false, handsR: false, pose: false, face: false, gaze: false });
  assert.deepEqual(trackersFor({ mappings: [['volume', 'nosuchsignal', 0, 1]] }),
    { handsL: false, handsR: false, pose: false, face: false, gaze: false });
});

test('preset ids are unique and the default exists', () => {
  const ids = PRESETS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(DEFAULT_PRESET));
  assert.equal(mapper.applyPreset().id, DEFAULT_PRESET, 'no argument = the default patch');
  assert.equal(mapper.applyPreset('nonexistent').id, DEFAULT_PRESET, 'unknown id falls back');
});

test('there is a face preset and a gaze preset, and they declare what they need', () => {
  const face = PRESETS.filter(p => p.needs.includes('face') && !p.needs.includes('gaze'));
  const gaze = PRESETS.filter(p => p.needs.includes('gaze'));
  assert.ok(face.length >= 1, 'no face preset');
  assert.ok(gaze.length >= 1, 'no gaze preset');
  // Gaze needs face landmarks too — the picker must say so.
  for (const p of gaze) assert.ok(p.needs.includes('face'), `${p.id} should also require face`);
  for (const p of PRESETS) assert.ok(p.needs.includes('camera'), `${p.id} should require the camera`);
});

test('the requested face patch is brow → pitch, mouth → volume', () => {
  const p = PRESETS.find(x => x.id === 'face-brow-mouth');
  const byParam = Object.fromEntries(p.mappings.map(m => [m[0], m[1]]));
  assert.equal(byParam.osc1_freq, 'brow_raise');
  assert.equal(byParam.volume, 'mouth_open');
  assert.equal(p.mappings.length, 2, 'kept to exactly the two requested controls');
});

test('missingFor reports only what the user still has to do', () => {
  // Face and gaze used to be listed here. Applying a preset now switches every
  // model to what the patch uses, so the only prerequisite left is the camera —
  // the one thing the app will not turn on for you.
  const gazePreset = PRESETS.find(p => p.id === 'gaze');
  assert.deepEqual(missingFor(gazePreset, { camera: false, face: false, gaze: false }),
                   ['camera']);
  assert.deepEqual(missingFor(gazePreset, { camera: true, face: false, gaze: false }), []);
  assert.deepEqual(missingFor(gazePreset, { camera: true, face: true, gaze: true }), []);
  assert.deepEqual(missingFor(PRESETS.find(p => p.id === 'hands'), { camera: true }), []);
});
