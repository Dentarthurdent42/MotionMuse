// The 'b' packing: a setup as its difference from a frozen baseline.
//
// Two things can silently break every 'b' link and every setup tag ever made:
// an edit to the baseline (src/sharebase.js), and a diff/merge that is not an
// exact inverse. Both are pinned here. The links themselves are pinned by
// share-compat.test.js; the tags by densecode.test.js and the same fixture set.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.localStorage ??= {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

const { BASE_B } = await import('../../src/sharebase.js');
const { diffFrom, mergeOnto, encodeState, decodeState, encodeStateBytes, decodeStateBytes,
        shareableSnapshot, tagState, shareFingerprint } = await import('../../src/share.js');
const { snapshot, applyAll } = await import('../../src/preset.js');
const { mapper, PRESETS } = await import('../../src/mapper.js');
const { engine } = await import('../../src/engine.js');
const { readTag, rasterize } = await import('../../src/densecode.js');

test('the baseline is the one every b-link was made against', () => {
  // If this fails, src/sharebase.js was edited. Every 'b' link and every tag
  // in every posted recording now decodes to something else. Put it back; a
  // new baseline is a new packing letter beside this one.
  assert.equal(shareFingerprint(JSON.stringify(BASE_B)), '1bio7ev');
  assert.ok(Object.isFrozen(BASE_B));
});

test('diff then merge gives back exactly what went in', () => {
  const cases = [
    {},
    structuredClone(BASE_B),
    { ...structuredClone(BASE_B), label: 'x', extra: { deep: [1, { a: 2 }] } },
    (() => { const s = structuredClone(BASE_B); delete s.audio.params.filter_freq; delete s.chord; return s; })(),
    (() => { const s = structuredClone(BASE_B); s.audio = 7; s.mappings = {}; s.kit = null; return s; })(),
  ];
  for (const s of cases) {
    const d = diffFrom(BASE_B, s) ?? {};
    assert.deepEqual(mergeOnto(BASE_B, JSON.parse(JSON.stringify(d))), s);
  }
  assert.equal(diffFrom(BASE_B, structuredClone(BASE_B)), undefined, 'the baseline itself is no diff at all');
});

test('merging never touches the baseline', () => {
  const before = JSON.stringify(BASE_B);
  mergeOnto(BASE_B, { audio: { params: { filter_freq: 1 } }, ['\u0000']: ['chord'] });
  assert.equal(JSON.stringify(BASE_B), before);
});

test('every starting patch round-trips through a b-link and through tag bytes', async () => {
  for (const p of PRESETS) {
    mapper.applyPreset(p.id);
    const s = { ...shareableSnapshot(snapshot()), label: p.name };
    const link = await encodeState(s);
    assert.equal(link[0], 'b');
    assert.deepEqual(await decodeState(link), JSON.parse(JSON.stringify(s)), `${p.id} via link`);
    assert.deepEqual(await decodeStateBytes(await encodeStateBytes(s)), JSON.parse(JSON.stringify(s)), `${p.id} via bytes`);
  }
});

test('the b packing is several times smaller than packing the whole snapshot', async () => {
  for (const p of PRESETS) {
    mapper.applyPreset(p.id);
    const s = shareableSnapshot(snapshot());
    const bytes = await encodeStateBytes(s);
    assert.ok(bytes.length < 320, `${p.id}: ${bytes.length} bytes`);
  }
});

test('the tag ignores where the cables have pushed their parameters', () => {
  // Otherwise it would redraw every second of a performance.
  mapper.applyPreset('hands');
  const still = JSON.stringify(tagState(snapshot()));
  for (const m of mapper.serialize()) engine.set(m.audioParam, (m.outMin + m.outMax) / 3);
  assert.equal(JSON.stringify(tagState(snapshot())), still);
  // …but not a parameter nothing drives.
  assert.ok(!mapper.serialize().some(m => m.audioParam === 'filter_q'));
  engine.set('filter_q', 7.5);
  assert.notEqual(JSON.stringify(tagState(snapshot())), still);
});

test('a tag carries the name it is given', () => {
  assert.equal(tagState(snapshot(), '  evening   pads ').label, 'evening pads');
  assert.equal(tagState(snapshot(), '').label, undefined);
});

// The tag fixture carries the same setup as the share-link fixtures: opening it
// has to give the same instrument.
test('the oldest tag opens as the setup it was made from', async () => {
  const [fx] = JSON.parse(readFileSync(new URL('fixtures/setup-tags.json', import.meta.url), 'utf8'));
  const cells = Uint8Array.from(fx.cells, ch => Number(ch));
  const img = rasterize({ order: fx.order, cells }, 5);
  const data = await decodeStateBytes(readTag(img));
  assert.ok(applyAll(data).ok);
  assert.equal(data.label, 'fixture: right hand opens the filter');
  const now = snapshot();
  assert.equal(now.audio.params.filter_freq, 1234);
  assert.equal(now.audio.params.reverb_mix, 0.4);
  assert.ok(now.mappings.some(m => m.audioParam === 'lfo_depth' && m.invert === true));
});
