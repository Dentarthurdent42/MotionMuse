// Chord mode: key handling, degree assignments, and the migration path off
// the old absolute-root format.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chordmode, degreeFromRoot, DEFAULT_KEY } from '../../src/chordmode.js';
import { engine } from '../../src/engine.js';

const reset = () => {
  engine.setTuning({ enabled: false, root: 'C', scale: 'chromatic' });
  // `{}` merges over the defaults, i.e. restores them — see load().
  chordmode.load({ enabled: false, key: { ...DEFAULT_KEY }, assignments: {} });
  chordmode.setKey({ ...DEFAULT_KEY });
};

test('default assignments spell chords in the default key', () => {
  reset();
  assert.equal(chordmode.chordFor('fist').numeral, 'I');
  // IV lives on asl4, not palm: palm is the default release gesture and a
  // shape cannot both sound a chord and stop one.
  assert.equal(chordmode.chordFor('asl4').numeral, 'IV');
  assert.equal(chordmode.chordFor('palm'), null, 'the release gesture holds no chord by default');
  assert.equal(chordmode.chordFor('peace').numeral, 'V7');
  assert.equal(chordmode.chordFor('peace').rootName, 'G');
});

test('changing the key transposes every assignment at once', () => {
  reset();
  const before = Object.keys(chordmode.assignments())
    .map(id => chordmode.chordFor(id).midi[0]);
  chordmode.setKey({ root: 'E' });
  const after = Object.keys(chordmode.assignments())
    .map(id => chordmode.chordFor(id).midi[0]);
  after.forEach((m, i) => assert.equal(m - before[i], 4, 'up a major third'));
});

test('the 7th belongs to the chord, not the handshape that plays it', () => {
  reset();
  const triad = chordmode.chordFor('fist');
  chordmode.setSeventh(0, true);
  const sev = chordmode.chordFor('fist');
  assert.equal(triad.midi.length, 3);
  assert.equal(sev.midi.length, 4);
  assert.equal(sev.midi[0], triad.midi[0]);
  assert.equal(sev.numeral, 'Imaj7');
  // Take the shape away and the chord keeps its 7th — it is a property of I,
  // not of the fist.
  chordmode.setDegreeGesture(0, null);
  assert.equal(chordmode.chordAt(0).numeral, 'Imaj7');
  chordmode.setSeventh(0, false);
});

test('a nonsense degree clamps instead of producing NaN pitches', () => {
  reset();
  chordmode.setDegreeGesture(99, 'fist');
  assert.equal(chordmode.assignments().fist, 6);
  chordmode.setDegreeGesture(-3, 'fist');
  assert.equal(chordmode.assignments().fist, 0);
  chordmode.setDegreeGesture('nope', 'fist');
  assert.ok(Number.isFinite(chordmode.chordFor('fist').freqs[0]));
});

// ── One handshape, one job ──
// The reported bug: Open Palm was both the RELEASE shape and the chord on I,
// so the panel offered a configuration the tick loop then had to break by
// fiat. The mapping is a bijection now and every writer enforces it.
test('a handshape is never on two chords at once', () => {
  reset();
  assert.equal(chordmode.assignments().fist, 0, 'fist starts on I');
  chordmode.setDegreeGesture(3, 'fist');          // move it to IV
  assert.equal(chordmode.assignments().fist, 3, 'and only IV');
  // asl4 held IV, so it swaps into the chord fist left rather than going free.
  assert.equal(chordmode.gestureFor(0), 'asl4');
  const ids = Object.keys(chordmode.assignments());
  assert.equal(new Set(ids).size, ids.length);
});

test('moving a handshape onto another chord swaps them', () => {
  reset();
  assert.equal(chordmode.gestureFor(0), 'fist');
  assert.equal(chordmode.gestureFor(4), 'peace');
  chordmode.setDegreeGesture(4, 'fist');
  assert.equal(chordmode.gestureFor(4), 'fist');
  // Not dropped: peace takes the chord fist just left, so rearranging two
  // shapes costs neither of them their assignment.
  assert.equal(chordmode.gestureFor(0), 'peace', 'peace should have taken I');
  const degrees = Object.values(chordmode.assignments());
  assert.equal(new Set(degrees).size, degrees.length, 'still a bijection');
});

test('a handshape with no chord to swap back leaves the other one free', () => {
  reset();
  // vii° is unmanned by default, so nothing comes back the other way.
  assert.equal(chordmode.gestureFor(6), null);
  chordmode.setDegreeGesture(6, 'fist');
  assert.equal(chordmode.gestureFor(6), 'fist');
  assert.equal(chordmode.gestureFor(0), null, 'I is now unmanned');

  // …and an unassigned newcomer displaces without giving anything back.
  reset();
  chordmode.setDegreeGesture(4, 'asl6');
  assert.equal(chordmode.gestureFor(4), 'asl6');
  assert.equal(chordmode.assignments().peace, undefined);
});

test('a chord cannot be assigned to the release shape', () => {
  reset();
  chordmode.setReleaseGesture('palm');
  chordmode.setDegreeGesture(2, 'palm');
  assert.equal(chordmode.getReleaseGesture(), null, 'it stopped being the release');
  assert.equal(chordmode.chordFor('palm').numeral.startsWith('iii'), true);
});

test('taking a shape for the release takes its chord away', () => {
  reset();
  assert.equal(chordmode.chordFor('fist').numeral, 'I');
  chordmode.setReleaseGesture('fist');
  assert.equal(chordmode.chordFor('fist'), null, 'it cannot also sound a chord');
  assert.equal(chordmode.gestureFor(0), null);
  chordmode.setReleaseGesture('palm');
});

test('loaded data that breaks the bijection is repaired on the way in', () => {
  reset();
  chordmode.load({
    enabled: false,
    releaseGesture: 'palm',
    // Exactly the state the old panel could produce: palm is the release AND
    // holds I, and two shapes share iii.
    assignments: { palm: 0, fist: 2, horns: 2, peace: 4 },
  });
  const a = chordmode.assignments();
  assert.equal(a.palm, undefined, 'the release shape gave up its chord');
  assert.equal(chordmode.chordFor('palm'), null);
  const onIii = Object.entries(a).filter(([, d]) => d === 2).map(([id]) => id);
  assert.equal(onIii.length, 1, `two shapes still share iii: ${onIii}`);
  // Every remaining shape drives exactly one chord, and every chord at most
  // one shape.
  const degrees = Object.values(a);
  assert.equal(new Set(degrees).size, degrees.length, 'a degree is claimed twice');
});

// ── Follow Pitch Quantize ──
test('follow takes the key from Pitch Quantize when it is diatonic', () => {
  reset();
  chordmode.setKey({ follow: true });
  engine.setTuning({ enabled: true, root: 'A', scale: 'natural minor' });
  const eff = chordmode.effectiveKey();
  assert.equal(eff.root, 'A');
  assert.equal(eff.mode, 'natural minor');
  assert.equal(chordmode.chordFor('fist').numeral, 'i');   // A minor, not A major
  assert.equal(chordmode.isFollowing(), true);
});

test('follow ignores non-diatonic scales rather than spelling nonsense', () => {
  reset();
  chordmode.setKey({ follow: true, mode: 'dorian' });
  engine.setTuning({ enabled: true, root: 'F', scale: 'blues' });
  const eff = chordmode.effectiveKey();
  assert.equal(eff.root, 'F');          // root still follows
  assert.equal(eff.mode, 'dorian');     // mode falls back to the panel's own
});

test('follow is inert while quantise is off', () => {
  reset();
  chordmode.setKey({ follow: true, root: 'D' });
  engine.setTuning({ enabled: false, root: 'A', scale: 'natural minor' });
  assert.equal(chordmode.isFollowing(), false);
  assert.equal(chordmode.effectiveKey().root, 'D');
});

// ── Persistence ──
test('load merges over defaults so new gestures still get a chord', () => {
  reset();
  chordmode.load({ enabled: false, assignments: { fist: { degree: 4, seventh: true } } });
  const a = chordmode.assignments();
  assert.equal(a.fist, 4);
  assert.equal(a.asl4, 3, 'defaults for untouched gestures survive');
  // fist displaced peace off V, since a chord takes one shape.
  assert.equal(chordmode.gestureFor(4), 'fist');
  // The old per-handshape 7th moves onto the chord it played.
  assert.equal(chordmode.sevenths()[4], true);
});

test('old absolute-root assignments migrate to the nearest degree', () => {
  reset();
  chordmode.load({
    enabled: false,
    key: { root: 'C', mode: 'major (ionian)', octave: 4, follow: false },
    assignments: {
      fist:  { root: 'C', octave: 4, quality: 'major' },
      peace: { root: 'G', octave: 4, quality: 'dom7'  },
      point: { root: 'A', octave: 3, quality: 'minor' },
    },
  });
  const a = chordmode.assignments();
  assert.equal(a.fist,  0);   // C  → I
  assert.equal(a.peace, 4);   // G7 → V7
  assert.equal(a.point, 5);   // Am → vi
  assert.equal(chordmode.sevenths()[4], true, 'the dominant 7th survived the move');
});

test('degreeFromRoot snaps an out-of-key root to the closest degree', () => {
  // Eb is not in C major; the nearest scale tones are D (ii) and E (iii).
  const d = degreeFromRoot('D#', 'C', 'major (ionian)', 'minor').degree;
  assert.ok(d === 1 || d === 2, `expected ii or iii, got ${d}`);
});

test('serialize round-trips key, assignments and sevenths', () => {
  reset();
  chordmode.setKey({ root: 'F', mode: 'dorian', octave: 3, follow: false });
  chordmode.setDegreeGesture(6, 'horns');
  chordmode.setSeventh(6, true);
  const s = JSON.parse(JSON.stringify(chordmode.serialize()));
  reset();
  chordmode.load(s);
  assert.deepEqual(chordmode.key(), { root: 'F', mode: 'dorian', octave: 3, follow: false });
  assert.equal(chordmode.assignments().horns, 6);
  assert.equal(chordmode.sevenths()[6], true);
  assert.equal(chordmode.gestureFor(6), 'horns');
});

// ── Chord ADSR + release gesture ─────────────────────────────────────────
// The release gesture is the one place where two features want the same
// input, so the resolution is pinned rather than left to whoever reads the
// code next.

test('chord envelope clamps to a musical range instead of any float', () => {
  const before = engine.getChordEnv();
  assert.deepEqual(engine.setChordEnv({ attack: 99 }).attack, 2, 'attack capped');
  assert.equal(engine.setChordEnv({ sustain: -5 }).sustain, 0, 'sustain is a 0-1 level');
  assert.equal(engine.setChordEnv({ sustain: 9 }).sustain, 1);
  assert.ok(engine.setChordEnv({ release: 0 }).release > 0,
    'a zero release would click rather than stop');
  assert.equal(engine.setChordEnv({ attack: 'nonsense' }).attack, 2,
    'garbage leaves the previous value alone');
  engine.setChordEnv(before);
});

test('the release gesture defaults to open palm, and palm holds no chord', () => {
  assert.equal(chordmode.getReleaseGesture(), 'palm');
  // The two must not collide out of the box: a shape cannot both start and
  // stop a chord, so IV was moved off palm rather than the default being left
  // dead on arrival.
  assert.equal(chordmode.chordFor('palm'), null);
  assert.equal(chordmode.chordFor('asl4').numeral, 'IV', 'IV is still reachable');
});

test('the release gesture round-trips through save/load', () => {
  chordmode.setReleaseGesture('horns');
  const s = JSON.parse(JSON.stringify(chordmode.serialize()));
  chordmode.setReleaseGesture('fist');
  chordmode.load(s);
  assert.equal(chordmode.getReleaseGesture(), 'horns');
  chordmode.setReleaseGesture('palm');
});

test('clearing the release gesture is allowed', () => {
  chordmode.setReleaseGesture(null);
  assert.equal(chordmode.getReleaseGesture(), null);
  chordmode.setReleaseGesture('palm');
});
