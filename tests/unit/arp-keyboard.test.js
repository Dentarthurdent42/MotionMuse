// What the keyboard shows while the arpeggiator is running.
//
// Reported from playing: "keep the keyboard display honest when the
// arpeggiator is running — currently it just displays all notes in the
// arpeggio being held, rather than showing what gets pressed, held, released,
// and faded."
//
// It was true of a block chord and a lie about an arpeggio. A run sounds ONE
// note at a time, and the overlay claimed all four were down for as long as
// the gesture was held — describing a way of playing nobody had chosen.
//
// The fix is that the display reads the SAME numbers the engine scheduled the
// gain from (noteSpans/noteLevelAt in arp.js), so it cannot be a second
// opinion about the sound. These tests pin that shape and the schedule
// reading built on it.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { noteSpans, noteLevelAt, ARP_ATTACK, noteEnvelope } =
  await import('../../src/arp.js');
const { arpvoice } = await import('../../src/arpvoice.js');
const { engine } = await import('../../src/engine.js');

let now = 0;
engine.now = () => now;
engine.arpNote = () => {};
engine.silenceChordVoices = () => {};
engine.releaseChordVoices = () => {};
engine.getChordEnv = () => ({ attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.4 });
Object.defineProperty(engine, 'started', { get: () => true, configurable: true });

const CHORD = [220, 275, 330];
const reset = () => {
  arpvoice.load({ enabled: true, pattern: 'up', octaves: 1, sync: 0 });
  arpvoice.stop();
  now = 0;
  engine.set('arp_rate', 4);        // a step every 0.25 s
};

// ── The shape itself ──

test('a note is silent before it starts and after it has faded', () => {
  const sp = noteSpans(0.2, 0.1);
  assert.equal(noteLevelAt(-0.01, sp), 0);
  assert.equal(noteLevelAt(0, sp), 0);
  assert.equal(noteLevelAt(sp.hold + sp.rel + 0.001, sp), 0);
});

test('it rises over the attack, holds, then falls — pressed, held, released, faded', () => {
  const sp = noteSpans(0.3, 0.2);
  assert.ok(noteLevelAt(ARP_ATTACK / 2, sp) > 0.4 && noteLevelAt(ARP_ATTACK / 2, sp) < 0.6,
    'halfway up the attack');
  assert.equal(noteLevelAt(sp.hold / 2, sp), 1, 'held at full while the gate is open');
  assert.equal(noteLevelAt(sp.hold, sp), 1, 'still full at the moment the fall begins');
  const mid = noteLevelAt(sp.hold + sp.rel / 2, sp);
  assert.ok(Math.abs(mid - 0.5) < 1e-9, 'halfway down the release');
  assert.equal(noteLevelAt(sp.hold + sp.rel, sp), 0, 'gone at the end of it');
});

test('the level never leaves 0..1, at any age', () => {
  const sp = noteSpans(0.25, 0.12);
  for (let a = -0.05; a < 1.5; a += 0.005) {
    const v = noteLevelAt(a, sp);
    assert.ok(v >= 0 && v <= 1, `level ${v} at age ${a}`);
  }
});

test('with no tail the fall happens INSIDE the gate, so the note ends when the gate says', () => {
  // This is the rule engine.arpNote has always followed; the display now
  // depends on it too, which is exactly why it is stated once.
  const sp = noteSpans(0.4, 0);
  assert.ok(sp.rel > 0, 'there is still a fade — a cut would click');
  assert.ok(Math.abs((sp.hold + sp.rel) - 0.4) < 1e-9,
    'and the whole note fits the gate');
});

test('with a tail the gate is held in full and the ring is added after it', () => {
  const sp = noteSpans(0.4, 0.5);
  assert.ok(Math.abs(sp.hold - 0.4) < 1e-9, 'the gate is not shortened');
  assert.ok(Math.abs(sp.rel - 0.5) < 1e-9, 'and the tail is the ring asked for');
});

// ── Reading the schedule ──

test('a run shows one note at a time, not the whole chord', () => {
  reset();
  arpvoice.run(CHORD);
  now = 0.01;                       // just past the first onset
  const v = arpvoice.voices();
  assert.equal(v.length, 1, 'an arpeggio is not a chord');
  assert.equal(v[0].freq, CHORD[0]);
  assert.ok(v[0].level > 0);
});

test('a note not yet struck is not shown — the scheduler runs ahead of the sound', () => {
  reset();
  arpvoice.run(CHORD);              // queues the horizon, ~0.12 s of it
  now = 0;
  const shown = arpvoice.voices().map(x => x.freq);
  assert.ok(!shown.includes(CHORD[1]), 'the next step has not happened yet');
});

test('with a tail, the note before is still falling as the next is struck', () => {
  reset();
  engine.set('arp_gate', 0.9);
  engine.set('arp_sustain', 1);     // a full step of ring
  for (let t = 0; t <= 0.3; t += 0.02) { now = t; arpvoice.run(CHORD); }
  now = 0.26;                       // just after the second onset at 0.25
  const v = arpvoice.voices();
  assert.ok(v.length >= 2, `two notes audible, got ${JSON.stringify(v)}`);
  const first = v.find(x => x.freq === CHORD[0]);
  const second = v.find(x => x.freq === CHORD[1]);
  assert.ok(first && second, 'the struck note and the one still ringing');
  assert.ok(second.level > first.level,
    `the new note is louder than the one falling (${second.level} vs ${first.level})`);
});

test('a fully staccato run leaves nothing ringing between steps', () => {
  reset();
  engine.set('arp_gate', 0.2);      // 0.05 s of a 0.25 s step
  engine.set('arp_sustain', 0);
  for (let t = 0; t <= 0.3; t += 0.02) { now = t; arpvoice.run(CHORD); }
  now = 0.20;                       // well after the first note is over…
  assert.equal(arpvoice.voices().length, 0, 'silence between notes is shown as silence');
  now = 0.2501;                     // …and the next one has just landed
  assert.equal(arpvoice.voices().length, 1);
});

test('letting the chord go keeps the last notes falling instead of blanking', () => {
  reset();
  engine.set('arp_gate', 0.9);
  engine.set('arp_sustain', 1);
  for (let t = 0; t <= 0.3; t += 0.02) { now = t; arpvoice.run(CHORD); }
  now = 0.26;
  const before = arpvoice.voices();
  assert.ok(before.length > 0);

  arpvoice.release();
  const rel = engine.getChordEnv().release;
  const at = arpvoice.voices();
  assert.equal(at.length, before.length, 'the same notes carry on');
  now = 0.26 + rel / 2;
  const half = arpvoice.voices();
  assert.ok(half.every((v, i) => v.level < at[i].level), 'and they are falling');
  now = 0.26 + rel + 0.01;
  assert.equal(arpvoice.voices().length, 0, 'until the release has run out');
});

test('a hard stop shows nothing — the voices were cut, not released', () => {
  reset();
  for (let t = 0; t <= 0.3; t += 0.02) { now = t; arpvoice.run(CHORD); }
  now = 0.26;
  assert.ok(arpvoice.voices().length > 0);
  arpvoice.stop();
  assert.equal(arpvoice.voices().length, 0);
});

test('with the arp off the display is not its business', () => {
  reset();
  arpvoice.run(CHORD);
  now = 0.01;
  arpvoice.set({ enabled: false });
  assert.deepEqual(arpvoice.voices(), []);
});

test('each note is drawn with the envelope it was PLAYED under, not the current one', () => {
  // gate, sustain and rate are live patchbay outputs, so the setting in force
  // now is not necessarily the one a still-ringing note was struck with.
  reset();
  engine.set('arp_gate', 0.9);
  engine.set('arp_sustain', 1);
  arpvoice.run(CHORD);
  const longSpans = noteSpans(...(() => {
    const e = noteEnvelope(0.25, 0.9, 1);
    return [e.hold, e.tail];
  })());
  engine.set('arp_gate', 0.1);      // yank the gate down under the ringing note
  engine.set('arp_sustain', 0);
  now = 0.2;
  const v = arpvoice.voices();
  assert.equal(v.length, 1);
  assert.ok(Math.abs(v[0].level - noteLevelAt(0.2, longSpans)) < 1e-9,
    'the note still follows the envelope it was struck with');
});
