// Sound kits change tone, and nothing else.
//
// A kit used to resize the oscillator bank and set every level, so picking
// "Strings" switched on an oscillator you had deliberately removed and
// overwrote the balance you had dialled in. How many voices you play and how
// loud each is, is your arrangement; a kit describes the timbre.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { engine } = await import('../../src/engine.js');
const { applyKit, KITS, KIT_PARAM_KEYS } = await import('../../src/soundkit.js');

const vols = () => Array.from({ length: engine.getOscCount() },
  (_, i) => engine.PARAMS[`osc${i + 1}_volume`].val);

test('a kit never changes how many oscillators there are', () => {
  for (const n of [0, 1, 2, 5]) {
    engine.setOscCount(n);
    for (const id of Object.keys(KITS)) {
      applyKit(id);
      assert.equal(engine.getOscCount(), n, `${id} resized the bank from ${n}`);
    }
  }
});

test('a kit never changes the balance between oscillators', () => {
  engine.setOscCount(3);
  engine.set('osc1_volume', 0.7);
  engine.set('osc2_volume', 0.25);
  engine.set('osc3_volume', 0.4);
  const before = vols();
  for (const id of Object.keys(KITS)) applyKit(id);
  assert.deepEqual(vols(), before, 'a kit overwrote the levels');
});

test('a kit does change the tone', () => {
  engine.setOscCount(1);
  applyKit('synth');
  const plain = engine.getOscType(0);
  applyKit('trumpet');
  assert.notEqual(engine.getOscType(0), plain, 'the waveform should follow the kit');
  assert.equal(engine.getOscType(0), 'custom:trumpet');
  assert.equal(Math.round(engine.PARAMS.filter_freq.val), 1800, 'and so should the filter');
});

test('waveforms cycle when the bank is bigger than the kit', () => {
  // Slots 3 and 4 repeat 1 and 2 rather than falling back to a default that
  // belongs to no instrument.
  engine.setOscCount(4);
  applyKit('piano');
  const t = engine.getOscTypes();
  assert.equal(t[0], t[2]);
  assert.equal(t[1], t[3]);
  assert.notEqual(t[0], t[1], 'the kit really does name two different waves');
});

test('one oscillator gets the kit\'s lead wave', () => {
  engine.setOscCount(1);
  for (const [id, kit] of Object.entries(KITS)) {
    applyKit(id);
    assert.equal(engine.getOscType(0), kit.oscs[0].wave, `${id} lead wave`);
  }
});

test('an empty bank still tones the chord voices', () => {
  // Chords take their timbre from slot 1's waveform, so a chord-only setup must
  // still respond to a kit — that is the only thing a kit can reach there.
  engine.setOscCount(0);
  applyKit('organ');
  assert.equal(engine.getOscType(0), 'custom:organ');
  assert.equal(engine.getOscCount(), 0, 'and without conjuring an oscillator');
});

test('kits may only write timbre parameters', () => {
  for (const [id, kit] of Object.entries(KITS)) {
    for (const k of Object.keys(kit.params)) {
      assert.ok(KIT_PARAM_KEYS.has(k), `${id} sets ${k}, which is not a timbre key`);
    }
  }
  // The keys a kit must never touch: pitch is the player's, level is the
  // arrangement's.
  for (const k of ['volume', 'osc_volume', 'chord_volume', 'osc1_freq']) {
    assert.equal(KIT_PARAM_KEYS.has(k), false, `${k} must not be kit-writable`);
  }
});

test('an unknown kit changes nothing and says so', () => {
  engine.setOscCount(2);
  applyKit('synth');
  const before = [engine.getOscTypes(), vols()];
  assert.equal(applyKit('nosuchkit'), false);
  assert.deepEqual([engine.getOscTypes(), vols()], before);
});
