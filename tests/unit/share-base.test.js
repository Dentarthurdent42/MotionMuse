// The 'b' and 'c' packings: a setup as its difference from a frozen baseline
// — the Hands patch for 'b', whichever starting patch is closest for 'c'.
//
// Two things can silently break every such link and every setup tag ever made:
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

const { BASE_B, BASES_C } = await import('../../src/sharebase.js');
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

test('the c baselines are the ones every c-link was made against, in their order', () => {
  // The index is the format: edit one or reorder them and every 'c' link and
  // tag decodes to a different patch. A new baseline goes on the end.
  assert.equal(shareFingerprint(JSON.stringify(BASES_C)), '144krlw');
  assert.equal(BASES_C[0], BASE_B, 'the first is the b baseline itself');
  assert.ok(Object.isFrozen(BASES_C));
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

test('every starting patch round-trips through a c-link and through tag bytes', async () => {
  for (const p of PRESETS) {
    mapper.applyPreset(p.id);
    const s = { ...shareableSnapshot(snapshot()), label: p.name };
    const link = await encodeState(s);
    assert.equal(link[0], 'c');
    assert.deepEqual(await decodeState(link), JSON.parse(JSON.stringify(s)), `${p.id} via link`);
    assert.deepEqual(await decodeStateBytes(await encodeStateBytes(s)), JSON.parse(JSON.stringify(s)), `${p.id} via bytes`);
  }
});

test('every starting patch packs to a few bytes — the c packing picks its own baseline', async () => {
  for (const p of PRESETS) {
    mapper.applyPreset(p.id);
    const bytes = await encodeStateBytes(shareableSnapshot(snapshot()));
    assert.ok(bytes.length < 16, `${p.id}: ${bytes.length} bytes`);
  }
});

test('an old b-link still opens', async () => {
  // Made before 'c': the Hands baseline alone.
  mapper.applyPreset('pose');
  const s = shareableSnapshot(snapshot());
  const bytes = await new Response(new Blob([JSON.stringify(diffFrom(BASE_B, s))]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  const link = 'b' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.deepEqual(await decodeState(link), JSON.parse(JSON.stringify(s)));
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
  const cells = Uint8Array.from(fx.cells, ch => parseInt(ch, 13));
  const img = rasterize({ order: fx.order, cells }, 11);
  const data = await decodeStateBytes(readTag(img));
  assert.ok(applyAll(data).ok);
  assert.equal(data.label, 'fixture: right hand opens the filter');
  const now = snapshot();
  assert.equal(now.audio.params.filter_freq, 1234);
  assert.equal(now.audio.params.reverb_mix, 0.4);
  assert.ok(now.mappings.some(m => m.audioParam === 'lfo_depth' && m.invert === true));
});
