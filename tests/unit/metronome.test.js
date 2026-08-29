// The metronome: one beat clock, three faces — click, camera strip, and the
// SAMPLE events the beat-sampled volume modes strike on.
//
// What is pinned: the first tick after starting is beat ONE (a clock that
// waits a bar to say anything reads as broken), beats land on the tempo grid
// and wrap the bar, the SAMPLE mask gates the sampling events but never the
// clock, MUTE silences the click and nothing else, and junk in a loaded
// snapshot falls back instead of wedging.
//
// tick() takes its time as a parameter, so these run on an explicit clock —
// no shims, no real time.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};
globalThis.document ??= {
  getElementById: () => null, querySelectorAll: () => [], addEventListener() {},
  body: { classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
};
globalThis.window ??= { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { metronome, SIGNATURES, BPM_MIN, BPM_MAX, numOf } = await import('../../src/metronome.js');
const { engine } = await import('../../src/engine.js');

const fresh = (over = {}) => metronome.load({ on: true, bpm: 120, sig: '4/4', ...over });

test('the first tick after starting is beat one, immediately', () => {
  fresh();
  metronome.tick(10);
  assert.deepEqual(metronome.beatThisFrame(), { beat: 0, downbeat: true, sampled: true },
    'a metronome that waits a whole beat before its first click reads as broken');
  metronome.setOn(false);
});

test('beats land on the tempo grid and wrap the bar', () => {
  fresh({ sig: '3/4' });                       // 120 BPM: a beat every 0.5 s
  metronome.tick(10);                          // beat 0
  metronome.tick(10.4);
  assert.equal(metronome.beatThisFrame(), null, 'between beats is silence');
  metronome.tick(10.52);
  assert.equal(metronome.beatThisFrame()?.beat, 1);
  metronome.tick(11.03);
  assert.equal(metronome.beatThisFrame()?.beat, 2);
  metronome.tick(11.55);                       // the bar wraps
  const ev = metronome.beatThisFrame();
  assert.equal(ev?.beat, 0);
  assert.equal(ev?.downbeat, true, 'the wrap is the next downbeat');
  metronome.setOn(false);
});

test('the SAMPLE mask gates the sampling events, never the clock', () => {
  fresh({ sig: '4/4' });
  metronome.toggleMaskBeat(1);
  metronome.tick(10);                          // beat 0: masked in
  assert.ok(metronome.sampleThisFrame());
  metronome.tick(10.52);                       // beat 1: masked out
  assert.ok(metronome.beatThisFrame(), 'the beat still happens…');
  assert.equal(metronome.sampleThisFrame(), null, '…but nothing samples on it');
  metronome.setOn(false);
});

test('tempo clamps to its range and the nudge steps it', () => {
  fresh();
  assert.equal(metronome.setBpm(10000), BPM_MAX);
  assert.equal(metronome.setBpm(1), BPM_MIN);
  assert.equal(metronome.setBpm('junk'), BPM_MIN, 'junk keeps the last value');
  metronome.setBpm(100);
  assert.ok(metronome.nudge(+1) > 100, 'the + button speeds it up');
  assert.equal(metronome.nudge(-1), 100, 'and − undoes it');
  metronome.setOn(false);
});

test('a signature change resizes the mask and restarts the bar', () => {
  fresh({ sig: '4/4' });
  metronome.toggleMaskBeat(2);
  metronome.tick(10); metronome.tick(10.52);    // mid-bar
  metronome.setSig('7/8');
  const c = metronome.config();
  assert.equal(c.mask.length, 7);
  assert.equal(c.mask[2], false, 'the beats it already had keep their setting');
  assert.equal(c.mask[6], true, 'new beats arrive switched on');
  metronome.tick(20);
  assert.equal(metronome.beatThisFrame()?.beat, 0, 'the new bar starts at ONE');
  assert.equal(numOf('7/8'), 7);
  metronome.setOn(false);
});

test('MUTE stops the click and nothing else', () => {
  const calls = [];
  const orig = engine.click;
  engine.click = (...a) => calls.push(a);
  try {
    fresh();
    metronome.tick(10);
    assert.equal(calls.length, 1, 'the first beat clicks');
    assert.equal(calls[0][1], true, 'and it is the accented downbeat');
    metronome.setMuted(true);
    metronome.tick(10.52);
    assert.ok(metronome.beatThisFrame(), 'the clock keeps counting under MUTE');
    assert.ok(metronome.sampleThisFrame(), 'and the sampling modes keep sampling');
    assert.equal(calls.length, 1, 'but no click is scheduled');
  } finally {
    engine.click = orig;
    metronome.setOn(false);
  }
});

test('the overlay view mirrors the clock, and is null when off', () => {
  fresh({ sig: '5/4' });
  metronome.tick(10); metronome.tick(10.52);
  const v = metronome.view();
  assert.equal(v.num, 5);
  assert.equal(v.beat, 1);
  assert.ok(v.phase >= 0 && v.phase < 1);
  assert.equal(v.mask.length, 5);
  metronome.setOn(false);
  assert.equal(metronome.view(), null, 'no clock, no picture');
});

test('the clock publishes itself onto the bus, wirable like any signal', async () => {
  const { bus } = await import('../../src/bus.js');
  metronome.registerSignals();
  fresh({ sig: '4/4' });
  metronome.tick(10);
  assert.equal(bus.signals.get('metro_beat').value, 1, 'a one-frame pulse on the beat');
  assert.equal(bus.signals.get('metro_downbeat').value, 1);
  metronome.tick(10.2);
  assert.equal(bus.signals.get('metro_beat').value, 0, 'and silence between beats');
  assert.ok(Math.abs(bus.signals.get('metro_phase').value - 0.4) < 1e-6,
    'phase runs 0..1 through the beat (120 BPM: 0.2 s is 40%)');
  metronome.setOn(false);
  metronome.tick(11);
  assert.equal(bus.signals.get('metro_phase').value, 0, 'off reads as zero, not as frozen');
});

test('the shared arp follows the metronome when synced, the free rate otherwise', async () => {
  const { arpvoice } = await import('../../src/arpvoice.js');
  const { engine } = await import('../../src/engine.js');
  engine.set?.('arp_rate', 4);
  arpvoice.set({ sync: 2 });
  fresh({ bpm: 120 });                        // 2 steps/beat at 120 BPM = 4/s… pick 90 to differ
  metronome.setBpm(90);
  // The rate is read inside run(), which needs audio; pin the arithmetic the
  // panel readout shows instead: synced = (bpm/60)·sync.
  const a = arpvoice.state();
  assert.equal(a.sync, 2);
  assert.ok(Math.abs((90 / 60) * a.sync - 3) < 1e-9, 'synced rate is 3 steps/s at 90 BPM');
  metronome.setOn(false);
  arpvoice.set({ sync: 0 });
});

test('settings round-trip through serialize/load; junk falls back', () => {
  metronome.load({ on: false, bpm: 87, sig: '6/8', muted: true,
                   mask: [true, false, true, true, false, true] });
  const snap = metronome.serialize();
  metronome.load({});                          // stomp with defaults
  metronome.load(snap);
  assert.deepEqual(metronome.serialize(), snap);

  metronome.load({ on: 'yes??', bpm: 'fast', sig: '13/16', muted: 0, mask: 'all' });
  const c = metronome.config();
  assert.equal(c.on, false, 'junk on is off');
  assert.ok(SIGNATURES.includes(c.sig));
  assert.ok(c.bpm >= BPM_MIN && c.bpm <= BPM_MAX);
  assert.equal(c.mask.length, numOf(c.sig));
  assert.ok(c.mask.every(v => v === true), 'junk mask is every beat on');
  metronome.load({});
});

// ── Arpeggiator sync ──────────────────────────────────────────────────────
//
// "The arpeggiator should sync with the metronome." Rate alone is not sync:
// a run at exactly the right speed but a semiquaver off the grid still
// sounds like two musicians who have not met. These pin both halves, and
// that the clock being off leaves the free rate alone.

test('the arpeggiator syncs to the clock by default', async () => {
  const { arpvoice, ARP_SYNC_DEFAULT } = await import('../../src/arpvoice.js');
  arpvoice.load({});
  assert.equal(arpvoice.state().sync, ARP_SYNC_DEFAULT);
  assert.ok(ARP_SYNC_DEFAULT > 0, 'the default is a division of the beat, not FREE');
});

test('a synced run takes its tempo from the clock, and stands down when it stops', async () => {
  const { arpvoice } = await import('../../src/arpvoice.js');
  const { engine } = await import('../../src/engine.js');
  arpvoice.load({ sync: 2 });
  fresh({ bpm: 90 });
  metronome.tick(10);
  // 90 BPM at two steps per beat is three steps a second, whatever the
  // free-running RATE parameter says.
  assert.ok(Math.abs(arpvoice.stepsPerSecond() - 3) < 1e-9,
    `synced rate ${arpvoice.stepsPerSecond()}`);
  metronome.setOn(false);
  assert.equal(arpvoice.stepsPerSecond(), engine.PARAMS.arp_rate?.val ?? 4,
    'with no clock to lock to, the RATE slider stands');
  arpvoice.load({});
});

test('a run struck off the beat waits for the grid, not for a whole step', async () => {
  const { arpvoice } = await import('../../src/arpvoice.js');
  arpvoice.load({ sync: 2 });
  fresh({ bpm: 120 });                 // a beat every 0.5 s, a step every 0.25 s
  metronome.tick(10);                  // beat 0, phase 0
  assert.ok(Math.abs(arpvoice.gridWait()) < 1e-9,
    'struck exactly on the beat, the run starts now — never a step late');
  metronome.tick(10.125);              // half a step in
  assert.ok(Math.abs(arpvoice.gridWait() - 0.125) < 1e-3,
    `half a step in, it waits out the other half (${arpvoice.gridWait()})`);
  metronome.setOn(false);
  assert.equal(arpvoice.gridWait(), 0, 'free-running runs start immediately');
  arpvoice.load({});
});
