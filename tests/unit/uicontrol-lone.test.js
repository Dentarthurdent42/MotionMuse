// Arming with only one hand available.
//
// The clap needs two hands. Deciding whether a second hand EXISTS from the
// tracking toggles rather than from the camera made arming impossible in the
// most ordinary setup there is: a tablet held in one hand, both toggles on,
// the holding hand permanently out of frame. No clap was possible, the
// one-hand fallback never engaged because the toggles claimed two hands, and
// the cursor could never be armed at all — while its idle ring followed the
// free hand and made the whole thing look live.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uicontrol, UIC } from '../../src/uicontrol.js';

// A raised, open hand: wrist high in frame, fingertips well clear of the palm.
const P = (x, y) => ({ x, y, z: 0 });
const raisedOpen = () => {
  const l = Array.from({ length: 21 }, () => P(0.5, 0.3));
  l[0]  = P(0.50, 0.32);                                   // wrist (yUp = 0.68)
  l[5]  = P(0.45, 0.22); l[9] = P(0.50, 0.21);
  l[13] = P(0.55, 0.22); l[17] = P(0.60, 0.24);
  l[4]  = P(0.36, 0.26); l[8] = P(0.45, 0.06);
  l[12] = P(0.50, 0.04); l[16] = P(0.55, 0.06); l[20] = P(0.60, 0.10);
  return l;
};
const world = () => Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));

test('one hand in frame can arm itself by holding up, with both trackers on', () => {
  const dwell = UIC.SINGLE_DWELL, cool = UIC.SINGLE_COOLDOWN;
  UIC.SINGLE_DWELL = 1;            // still wall-clock — the stepped shim below feeds it
  // Long, deliberately: the dwell is a TOGGLE, and with the shim feeding a
  // full frame per tick a short cooldown lets it re-fire every iteration —
  // eight toggles ends exactly where it started. One arm is the test.
  UIC.SINGLE_COOLDOWN = 1e9;
  // The dwell accumulates real time BETWEEN ticks, and a fast machine runs
  // all eight iterations in under a millisecond — so the test failed exactly
  // when nothing was wrong. Step the clock like real frames instead.
  const realNow = performance.now.bind(performance);
  let skew = 0;
  performance.now = () => realNow() + skew;
  try {
    uicontrol.disarmAll();
    uicontrol.setEnabled(true);
    assert.equal(uicontrol.armedOn('L'), false);
    // Only the LEFT hand is ever seen — the right is holding the tablet.
    // Nothing tells uicontrol that a tracker was switched off, because none was.
    for (let i = 0; i < 8; i++) {
      skew += 33;
      uicontrol.feedHands({ L: raisedOpen(), R: null },
                          { L: world(), R: null }, performance.now());
      uicontrol.tick();
    }
    assert.equal(uicontrol.armedOn('L'), true, 'the lone hand armed itself');
    assert.equal(uicontrol.armedOn('R'), false, 'the absent hand did not');
  } finally {
    performance.now = realNow;
    UIC.SINGLE_DWELL = dwell;
    UIC.SINGLE_COOLDOWN = cool;
    uicontrol.disarmAll();
    uicontrol.setEnabled(false);
  }
});

test('with BOTH hands in frame the lone-hand path stays shut (clap territory)', () => {
  const dwell = UIC.SINGLE_DWELL;
  UIC.SINGLE_DWELL = 1;
  try {
    uicontrol.disarmAll();
    uicontrol.setEnabled(true);
    for (let i = 0; i < 8; i++) {
      uicontrol.feedHands({ L: raisedOpen(), R: raisedOpen() },
                          { L: world(), R: world() }, performance.now());
      uicontrol.tick();
    }
    assert.equal(uicontrol.armedOn('L'), false,
      'two raised hands must not silently arm — that is what the clap is for');
    assert.equal(uicontrol.armedOn('R'), false);
  } finally {
    UIC.SINGLE_DWELL = dwell;
    uicontrol.disarmAll();
    uicontrol.setEnabled(false);
  }
});
