// A chord change must not sound both chords on the same step.
//
// Reported from playing: "when the arpeggiator has the same tempo as the
// metronome, the last note of the previous chord overlaps with the first
// note of the next chord." The scheduler runs a horizon ahead, so at the
// instant the chord changes the OLD chord's next notes are already queued
// into the NEW chord's time — and when the steps line up with the beat the
// two land on the very same division, which is why syncing made it obvious.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { arpvoice } = await import('../../src/arpvoice.js');
const { engine } = await import('../../src/engine.js');

// A stub audio clock: the arp schedules against engine.now(), so driving that
// is the whole harness — no AudioContext, and the times are exact.
let now = 0, silenced = 0;
const notes = [];
engine.now = () => now;
engine.arpNote = ({ freq, when }) => notes.push({ freq, when });
engine.silenceChordVoices = () => { silenced++; };
let released = 0;
engine.releaseChordVoices = () => { released++; };
Object.defineProperty(engine, 'started', { get: () => true, configurable: true });

const A = [220, 277, 330];      // the chord being left
const B = [440, 554, 660];      // the chord arriving
const isA = f => A.includes(f);
const queuedAfter = t => notes.filter(n => n.when > t);

const reset = () => {
  arpvoice.load({ enabled: true, pattern: 'up', octaves: 1, sync: 0 });
  arpvoice.stop();
  notes.length = 0; silenced = 0; released = 0; now = 0;
};

test('a chord change re-plans the queued steps instead of doubling them', () => {
  reset();
  engine.set('arp_rate', 4);            // a step every 0.25 s
  arpvoice.run(A);                      // schedules the step at 0
  now = 0.2;
  arpvoice.run(A);                      // horizon reaches 0.32 — queues 0.25
  const stale = queuedAfter(now).filter(n => isA(n.freq));
  assert.equal(stale.length, 1, 'the old chord has a note queued in the future');

  arpvoice.run(B);                      // …and now the chord changes
  assert.equal(silenced, 1, 'the queued note is dropped, not left to sound');
  const replanned = notes.filter(n => n.when === stale[0].when && !isA(n.freq));
  assert.equal(replanned.length, 1,
    'and the step it occupied is re-issued with the new chord');
});

test('the pattern carries on in time — a swap is not a restart', () => {
  reset();
  engine.set('arp_rate', 4);
  arpvoice.run(A);                      // step 0 → pool index 0
  now = 0.2;
  arpvoice.run(A);                      // step 1 queued
  const before = notes.length;
  arpvoice.run(B);
  const after = notes.slice(before);
  assert.equal(after.length, 1, 'exactly one step is re-issued');
  assert.equal(after[0].freq, B[1],
    'and it is the pattern’s NEXT note, not the new chord’s root — a chord ' +
    'swapped under a held gate keeps its place in the run');
});

test('an unchanged chord is left alone — no silence, no re-issue', () => {
  reset();
  engine.set('arp_rate', 4);
  arpvoice.run(A);
  now = 0.2;
  arpvoice.run(A);
  const n = notes.length;
  arpvoice.run(A);                      // same chord, same frame
  assert.equal(silenced, 0, 'nothing to drop');
  assert.equal(notes.length, n, 'and nothing to re-issue');
});

test('restart drops the horizon too', () => {
  reset();
  engine.set('arp_rate', 4);
  arpvoice.run(A);
  now = 0.2;
  arpvoice.run(A);                      // a note queued at 0.25
  assert.ok(queuedAfter(now).length, 'something is in flight');
  arpvoice.restart();
  assert.equal(silenced, 1,
    'restarting the run cancels what the last chord left queued');
});

test('restart with nothing in flight stays quiet', () => {
  reset();
  arpvoice.restart();
  assert.equal(silenced, 0, 'no notes queued, no reason to touch the voices');
});


// ── Letting go of a chord is not the same as swapping one ──
//
// Reported from playing: "when releasing a chord that's being sustained, it
// should continue sustaining, rather than immediately silencing it." Every
// release path called stop(), which cuts the voices in 30 ms — right when
// another chord is taking them over, wrong when nothing is. With a sustain
// tail on every note, the cut was throwing away most of the note.
test('releasing lets the ringing note fall instead of cutting it', () => {
  reset();
  arpvoice.run(A, 1);
  assert.ok(notes.length > 0, 'the run started');
  arpvoice.release();
  assert.equal(released, 1, 'the voices are released…');
  assert.equal(silenced, 0, '…not silenced');
});

test('but it still drops what has not sounded yet', () => {
  reset();
  arpvoice.run(A, 1);
  const before = notes.length;
  arpvoice.release();
  now += 1;
  arpvoice.run(A, 1);      // the chord is gone; nothing should resume from it
  assert.ok(notes.length > before, 'a later run schedules afresh');
  // The clock was dropped, so the first note of the new run starts a pattern
  // rather than continuing the old one mid-phrase.
  assert.equal(notes[before].when >= 1, true, 'and starts from now, not the old queue');
});

test('a chord SWAP still cuts — the new chord owns those voices', () => {
  reset();
  arpvoice.run(A, 1);
  arpvoice.stop();
  assert.equal(silenced, 1, 'stop() is still the hard stop');
  assert.equal(released, 0);
});

test('releasing an arp that never ran does nothing either way', () => {
  reset();
  arpvoice.release();
  assert.equal(released, 0, 'no voices to release');
  assert.equal(silenced, 0);
});
