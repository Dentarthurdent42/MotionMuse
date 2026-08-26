// The description a sharer attaches to a setup.
//
// A QR code is opaque: a photo of one says nothing about the patch behind it,
// so a screen showing three of them is three identical squares. The sharer
// gets a line to say what this one is, and it travels inside the link so the
// person who opens it is told what they just loaded.
//
// What is worth pinning is the boundary behaviour on both sides. The text is
// typed by one person and read out of a URL by another, so it is cleaned going
// in AND coming out — and it is capped, because every character is more
// payload, and payload is QR modules.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanShareLabel, SHARE_LABEL_MAX, shareFingerprint,
         encodeState, decodeState } from '../../src/share.js';

test('a description is collapsed to one line and trimmed', () => {
  // The payload is JSON in a URL fragment; a newline in the middle of it buys
  // nothing a space does not.
  assert.equal(cleanShareLabel('  ambient   pads \n left hand opens it '),
    'ambient pads left hand opens it');
  assert.equal(cleanShareLabel('   '), '');
});

test('a description cannot grow the payload without bound', () => {
  assert.equal(cleanShareLabel('x'.repeat(500)).length, SHARE_LABEL_MAX);
  assert.ok(SHARE_LABEL_MAX <= 120, 'a cap that lets the QR densify is not a cap');
});

test('nothing typed means nothing added to the link', () => {
  // The empty string is what tells the UI to leave `label` off the state
  // entirely, so an undescribed setup costs exactly what it used to.
  assert.equal(cleanShareLabel(''), '');
  assert.equal(cleanShareLabel(undefined), '');
  assert.equal(cleanShareLabel(null), '');
});

test('a description that is not a string does not throw', () => {
  // On the receiving side this comes out of someone else's URL, so it is
  // re-cleaned rather than trusted — including when it is not text at all.
  assert.doesNotThrow(() => cleanShareLabel({}));
  assert.doesNotThrow(() => cleanShareLabel(42));
  assert.equal(cleanShareLabel(42), '42');
});

test('a described setup round-trips through the link', async () => {
  const back = await decodeState(await encodeState({ app: 'MOTIONMUSE', v: 2, label: 'ambient pads' }));
  assert.equal(back.label, 'ambient pads');
});

test('a link written before descriptions existed still opens', async () => {
  const back = await decodeState(await encodeState({ app: 'MOTIONMUSE', v: 2 }));
  assert.equal(back.label, undefined);
  assert.equal(cleanShareLabel(back.label), '', 'and reads as no description');
});

// ── Have we followed this link before? ───────────────────────────────────
//
// A link is worth explaining the first time and not after: reopen a QR pinned
// to a wall, or just reload, and the setup is already yours. The fingerprint
// is what tells those apart, so it has to be stable for one payload and
// different for another.

test('the same link fingerprints the same way every time', () => {
  const p = 'dSomeCompressedPayloadAAA';
  assert.equal(shareFingerprint(p), shareFingerprint(p));
});

test('different links fingerprint differently', () => {
  // Including a one-character difference, which is what two setups that differ
  // by a single parameter will actually look like.
  assert.notEqual(shareFingerprint('dPayloadAAA'), shareFingerprint('dPayloadAAB'));
  assert.notEqual(shareFingerprint('dPayloadAAA'), shareFingerprint('jPayloadAAA'));
});

test('a fingerprint is short enough to keep and never throws', () => {
  assert.ok(shareFingerprint('x'.repeat(5000)).length <= 8);
  assert.doesNotThrow(() => shareFingerprint(undefined));
  assert.doesNotThrow(() => shareFingerprint(null));
  assert.equal(shareFingerprint(''), shareFingerprint(''));
});
