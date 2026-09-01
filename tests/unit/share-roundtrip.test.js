// What a shared link actually carries.
//
// Reported from playing: "a bunch of configs aren't saved when following the
// link: chord-gesture selections, Shepard tone being on, and gesture
// calibration."
//
// Three separate holes, and they were not all in the same place:
//
//  - SHEPARD was simply never in engine.snapshot(). Not a share bug at all —
//    a saved file and a session restore lost it too. It is a different SOUND
//    (the voices are rebuilt as octave stacks), so it was the one part of the
//    patch no snapshot could describe.
//  - A CHORD-GESTURE SELECTION survived unless you had CLEARED one. The saved
//    form is gestureId → degree, in which an emptied degree simply has no
//    entry — indistinguishable, on the way back in, from a save that predates
//    that degree — and the merge-over-defaults then handed the default back.
//  - The PEDAL — which gesture drives the looper, and the sensitivity you tune
//    it to — lived in three loose localStorage keys that nothing collected.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

const { chordmode, DEGREES } = await import('../../src/chordmode.js');

// A blob with an EMPTY assignments map is how you ask for the shipped
// defaults: load() merges over them, and merging over nothing leaves exactly
// them. (`{}` alone carries no assignments at all, and load correctly leaves
// the current ones standing.)
const DEFAULTS = { assignments: {} };
const { engine } = await import('../../src/engine.js');
const { shareableSnapshot } = await import('../../src/share.js');

// ── Chord-gesture selections ──

test('an emptied degree is stated as empty, not left to be inferred', () => {
  chordmode.load(DEFAULTS);                       // defaults
  const filled = chordmode.gestureFor(2);
  assert.ok(filled, 'degree 2 starts with a default gesture');

  chordmode.setDegreeGesture(2, null);
  const s = chordmode.serialize();
  assert.ok(Array.isArray(s.degrees), 'the panel view is serialized');
  assert.equal(s.degrees.length, DEGREES);
  assert.equal(s.degrees[2], null, 'and it says degree 2 is empty');
  // The old form cannot say it, which is the whole reason for the new one.
  assert.equal(s.assignments[filled], undefined);
});

test('a cleared degree comes back cleared', () => {
  chordmode.load(DEFAULTS);
  chordmode.setDegreeGesture(2, null);
  const saved = chordmode.serialize();

  chordmode.load(DEFAULTS);                        // somebody else's defaults
  assert.ok(chordmode.gestureFor(2), 'defaults fill it');
  chordmode.load(saved);
  assert.equal(chordmode.gestureFor(2), null,
    'following the link must not hand the default back');
});

test('every other degree survives alongside it', () => {
  chordmode.load(DEFAULTS);
  chordmode.setDegreeGesture(2, null);
  chordmode.setDegreeGesture(3, 'asl0');
  const want = Array.from({ length: DEGREES }, (_, i) => chordmode.gestureFor(i));
  const saved = chordmode.serialize();
  chordmode.load(DEFAULTS);
  chordmode.load(saved);
  const got = Array.from({ length: DEGREES }, (_, i) => chordmode.gestureFor(i));
  assert.deepEqual(got, want);
});

test('a save from before this existed still merges the defaults in', () => {
  // The old behaviour has to stay: `assignments` alone cannot distinguish
  // "emptied" from "saved before this degree existed", and filling it in is
  // the better guess for an old file.
  chordmode.load(DEFAULTS);
  const dflt = chordmode.gestureFor(2);
  chordmode.load({ assignments: { point: 0 } });     // no `degrees` key
  assert.equal(chordmode.gestureFor(2), dflt, 'defaults still arrive');
  assert.equal(chordmode.gestureFor(0), 'point', 'and the save still wins where it speaks');
});

test('degrees outrank assignments when a save carries both', () => {
  chordmode.load(DEFAULTS);
  chordmode.setDegreeGesture(2, null);
  const s = chordmode.serialize();
  assert.ok(s.assignments && s.degrees, 'both are written, for older readers');
  chordmode.load(s);
  assert.equal(chordmode.gestureFor(2), null);
});

// ── Shepard ──

test('Shepard is part of the snapshot, because it is part of the sound', () => {
  engine.setShepard({ lead: false, chord: false });
  const off = engine.snapshot();
  assert.deepEqual(off.shepard, { lead: false, chord: false });

  engine.setShepard({ lead: true, chord: true });
  const on = engine.snapshot();
  assert.deepEqual(on.shepard, { lead: true, chord: true });

  engine.restore(off);
  assert.deepEqual(engine.getShepard(), { lead: false, chord: false });
  engine.restore(on);
  assert.deepEqual(engine.getShepard(), { lead: true, chord: true },
    'and it comes back, which is what a shared link needs');
});

test('each Shepard bank is remembered on its own', () => {
  engine.setShepard({ lead: true, chord: false });
  const s = engine.snapshot();
  engine.setShepard({ lead: false, chord: true });
  engine.restore(s);
  assert.deepEqual(engine.getShepard(), { lead: true, chord: false });
});

test('a snapshot from before this existed leaves Shepard alone', () => {
  engine.setShepard({ lead: true, chord: true });
  engine.restore({ params: {} });          // no `shepard` key
  assert.deepEqual(engine.getShepard(), { lead: true, chord: true },
    'absent is not the same as off');
});

// ── What travels in a link ──

test('the pedal travels: a nod at the wrong sensitivity is not the same instrument', () => {
  const snap = {
    app: 'motionmuse-sound',
    ui: { theme: 'midnight', panelWidths: '{"a":1}', secOrder: 'x',
          pedalSrc: 'brow', pedalSens: '0.77', pedalOn: '1',
          hotkeys: '{"z":"mute"}', uicontrol: '{"enabled":true}' },
  };
  const ui = shareableSnapshot(snap).ui;
  for (const k of ['pedalSrc', 'pedalSens', 'pedalOn', 'hotkeys', 'uicontrol', 'theme']) {
    assert.equal(ui[k], snap.ui[k], `${k} travels`);
  }
});

test('and the window does not: geometry describes a screen, not a setup', () => {
  const snap = {
    app: 'motionmuse-sound',
    ui: { panelWidths: '{"a":1}', secOrder: 'x', camHeight: '300',
          sections: 's', secFolded: 'f', secHome: 'h', models: 'movenet-thunder' },
  };
  const ui = shareableSnapshot(snap).ui;
  for (const k of Object.keys(snap.ui)) {
    assert.equal(ui[k], undefined, `${k} stays behind`);
  }
});
