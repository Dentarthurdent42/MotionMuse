// The Chord Quality node: the hand that is not naming a degree says what
// QUALITY the chord on it takes — the borrowed iv, a V7 in a minor key, a sus4
// to lean on — with the root still the degree's, so the key still moves it.
//
// Pinned here: the arithmetic (root kept, intervals replaced, numeral read off
// the result), the hand rule (the OFF hand, chord voicing only, standing down
// where that hand is the volume), the defaults meaning what they say, the
// one-shape-one-quality rule, and that a setup carries its qualities.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document ??= { body: { classList: { toggle() {}, add() {}, remove() {} } } };

const { chordmode, DEFAULT_KEY, DEFAULT_QUALITY_GESTURES, DEFAULT_ACCIDENTAL_GESTURES,
        QUALITY_KEYS } = await import('../../src/chordmode.js');
const { qualityChord, diatonicChord, QUALITIES } = await import('../../src/chords.js');
const { engine } = await import('../../src/engine.js');
const { gesture } = await import('../../src/gesture.js');
const { bus } = await import('../../src/bus.js');
const { mapper } = await import('../../src/mapper.js');
const { initChordCables, QUALITY_CABLE_KEYS, CABLE_ID } = await import('../../src/chordcables.js');

// The rig chord-expression.test.js uses: a template's feature vector written
// onto one hand's bus signals, which is what the camera does.
const keysFor = side => [
  ...['thumb', 'index', 'middle', 'ring', 'pinky'].map(n => `finger_${side}_${n}`),
  `hand_${side}_open`, `hand_${side}_spread`, `thumb_out_${side}`,
  ...['index', 'middle', 'ring', 'pinky'].map(n => `contact_${side}_${n}`),
];
const feed = (side, f) => {
  bus.register(`hand_${side}_x`, { min: 0, max: 1 });
  bus.update(`hand_${side}_x`, 0.5);
  keysFor(side).forEach((k, i) => { bus.register(k, { min: -1, max: 1 }); bus.update(k, f[i]); });
};
const clearHand = side => {
  bus.register(`hand_${side}_x`, { min: 0, max: 1 });
  bus.update(`hand_${side}_x`, 0);
  keysFor(side).forEach(k => { bus.register(k, { min: -1, max: 1 }); bus.update(k, 0); });
};
const tmpl = id => gesture.list().find(g => g.id === id).f;
const settle = (n = 5) => { for (let i = 0; i < n; i++) { gesture.tick(); chordmode.tick(); } };
const soundingMidi = () => chordmode.currentChord()?.midi ?? [];

const reset = ({ voicing = 'chord' } = {}) => {
  engine.setTuning({ enabled: false, root: 'C', scale: 'chromatic' });
  chordmode.load({ enabled: true, key: { ...DEFAULT_KEY, follow: false } });
  chordmode.setVoicing(voicing);
  clearHand('L'); clearHand('R');
  gesture.tick();
};

// ── The arithmetic ───────────────────────────────────────────────────────

test('a quality keeps the degree\'s root and replaces its intervals', () => {
  // IV of C major is F major; made minor it is the borrowed iv: F A♭ C.
  const iv = qualityChord('C', 4, 'major (ionian)', 3, 'minor');
  assert.deepEqual(iv.midi, [65, 68, 72]);
  assert.equal(iv.numeral, 'iv', 'lowercase: the third is minor now');
  assert.equal(iv.rootName, 'F');
  assert.equal(iv.altered, true);
  // V made dom7 is G B D F — and names itself V7.
  const v7 = qualityChord('C', 4, 'major (ionian)', 4, 'dom7');
  assert.deepEqual(v7.midi, [67, 71, 74, 77]);
  assert.equal(v7.numeral, 'V7');
  // Asking for what the key already gives is not an alteration.
  assert.equal(qualityChord('C', 4, 'major (ionian)', 0, 'major').altered, false);
});

test('the numeral is read off the chosen intervals, sus included', () => {
  assert.equal(qualityChord('C', 4, 'major (ionian)', 6, 'dim').numeral, 'vii°');
  assert.equal(qualityChord('C', 4, 'major (ionian)', 2, 'aug').numeral, 'III+');
  assert.equal(qualityChord('C', 4, 'major (ionian)', 4, 'sus4').numeral, 'Vsus4');
  assert.equal(qualityChord('C', 4, 'major (ionian)', 1, 'sus2').numeral, 'IIsus2');
  assert.equal(qualityChord('C', 4, 'major (ionian)', 3, 'maj7').numeral, 'IVmaj7');
});

test('an unknown quality is the diatonic chord, not silence', () => {
  assert.deepEqual(qualityChord('C', 4, 'major (ionian)', 1, 'nonsense').midi,
                   diatonicChord('C', 4, 'major (ionian)', 1).midi);
  assert.deepEqual(qualityChord('C', 4, 'major (ionian)', 1, 'add9').midi,
                   diatonicChord('C', 4, 'major (ionian)', 1).midi, 'only the node\'s qualities override');
});

test('every quality the node offers is a real interval set', () => {
  for (const q of QUALITY_KEYS) assert.ok(QUALITIES[q], q);
});

// ── The defaults mean what they say ──────────────────────────────────────

test('the default shapes are the semantic ones', () => {
  assert.equal(DEFAULT_QUALITY_GESTURES.major, 'thumbs', 'up is bright');
  assert.equal(DEFAULT_QUALITY_GESTURES.minor, 'thumbsdown', 'down is dark');
  assert.equal(DEFAULT_QUALITY_GESTURES.dim, 'asl0', 'the ° is an O');
  assert.equal(DEFAULT_QUALITY_GESTURES.dom7, 'horns', 'the rock seventh');
  assert.equal(DEFAULT_QUALITY_GESTURES.maj7, 'iloveyou', 'the love-song seventh');
  // …and major/minor are the SAME shapes as ♯/♭: raise and lower, in both voicings.
  assert.equal(DEFAULT_QUALITY_GESTURES.major, DEFAULT_ACCIDENTAL_GESTURES.sharp);
  assert.equal(DEFAULT_QUALITY_GESTURES.minor, DEFAULT_ACCIDENTAL_GESTURES.flat);
});

test('no default quality shape names a degree or releases', () => {
  reset();
  const degreeGestures = new Set(Object.keys(chordmode.assignments()));
  for (const [q, id] of Object.entries(DEFAULT_QUALITY_GESTURES)) {
    if (!id) continue;
    assert.ok(!degreeGestures.has(id), `${q} → ${id} is also a degree`);
    assert.notEqual(id, chordmode.getReleaseGesture(), `${q} → ${id} is the release`);
  }
});

// ── The hand rule ────────────────────────────────────────────────────────

test('the off hand\'s quality shape changes the chord the naming hand holds', () => {
  reset();
  feed('R', tmpl('point'));                  // degree I
  settle();
  assert.deepEqual(soundingMidi(), [60, 64, 67], 'C major, the key\'s own');
  feed('L', tmpl('horns'));                  // dom7
  settle();
  assert.deepEqual(soundingMidi(), [60, 64, 67, 70], 'C7');
  assert.equal(chordmode.currentQuality(), 'dom7');
  assert.match(chordmode.currentLabel(), /I7 · C dom7/);
  clearHand('L');
  settle();
  assert.deepEqual(soundingMidi(), [60, 64, 67], 'let go, and it is the key\'s own again');
  assert.equal(chordmode.currentQuality(), null);
});

test('a quality overrides the degree\'s 7th: MAJ is a triad', () => {
  reset();
  chordmode.setSeventh(1, true);             // ii7
  feed('R', tmpl('peace'));                  // degree ii
  settle();
  assert.deepEqual(soundingMidi(), [62, 65, 69, 72]);
  feed('L', tmpl('thumbs'));                 // major
  settle();
  assert.deepEqual(soundingMidi(), [62, 66, 69], 'D major — the secondary dominant\'s triad');
  chordmode.setSeventh(1, false);
});

test('in single notes the quality shapes do nothing', () => {
  reset({ voicing: 'note' });
  feed('R', tmpl('point'));
  feed('L', tmpl('horns'));                  // a quality, not an accidental
  settle();
  assert.deepEqual(soundingMidi(), [60]);
  assert.equal(chordmode.currentQuality(), null);
});

test('with the other hand playing the volume, the quality stands down', () => {
  reset();
  chordmode.setExpression({ mode: 'hand', hand: 'L', control: 'volume' });
  feed('R', tmpl('point'));
  feed('L', tmpl('horns'));
  settle();
  assert.deepEqual(chordmode.chordFor('point').midi, [60, 64, 67]);
  assert.ok(!(chordmode.currentChord()?.midi ?? []).includes(70), 'no seventh from a hand that is the volume');
  chordmode.setExpression({ mode: 'gesture' });
});

// ── One shape, one quality ───────────────────────────────────────────────

test('a shape taken for one quality leaves the one it had', () => {
  reset();
  chordmode.setQualityGestures({ aug: 'horns' });
  const q = chordmode.qualityGestures();
  assert.equal(q.aug, 'horns');
  assert.equal(q.dom7, null);
});

// ── Saved and loaded ─────────────────────────────────────────────────────

test('a setup carries its qualities, and an older one gets the defaults', () => {
  reset();
  chordmode.setQualityGestures({ sus4: 'gun', maj7: null });
  const saved = chordmode.serialize();
  reset();
  chordmode.load(saved);
  assert.equal(chordmode.qualityGestures().sus4, 'gun');
  assert.equal(chordmode.qualityGestures().maj7, null);
  const { qualities: _, ...old } = saved;
  chordmode.load(old);
  assert.deepEqual(chordmode.qualityGestures(), DEFAULT_QUALITY_GESTURES);
});

// ── Cables ───────────────────────────────────────────────────────────────

test('each quality is a socket; the shape\'s cable is the assignment', () => {
  initChordCables();
  reset();
  const cableOn = key => mapper.mappings.find(m => m.audioParam === key)?.signal ?? null;
  assert.equal(cableOn(QUALITY_CABLE_KEYS.minor), 'gesture_thumbsdown');
  assert.equal(cableOn(QUALITY_CABLE_KEYS.aug), null);
  // Any other signal holds the quality while high — a metronome making every
  // beat's chord a seventh, say.
  mapper.add(QUALITY_CABLE_KEYS.min7, 'metro_beat', 0, 1, 'linear', 0, false);
  assert.equal(chordmode.qualityGestures().min7, CABLE_ID('q_min7'));
  chordmode.setCableHeld(CABLE_ID('q_min7'), true);
  feed('R', tmpl('point'));
  settle();
  assert.deepEqual(soundingMidi(), [60, 63, 67, 70], 'Cm7, named by the cable');
  chordmode.setCableHeld(CABLE_ID('q_min7'), false);
});

test('with gesture mode off, moving another cable keeps the shapes', () => {
  initChordCables();
  reset();
  chordmode.setEnabled(false);
  mapper.load([['filter_freq', 'hand_L_y']].map(([audioParam, signal]) => ({ audioParam, signal })));
  assert.equal(chordmode.qualityGestures().major, 'thumbs', 'radial mode still reads these');
  assert.equal(chordmode.accidentalGestures().sharp, 'thumbs');
});
