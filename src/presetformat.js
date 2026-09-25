// The version of a saved setup, and the one place old versions are upgraded.
//
// A snapshot outlives the code that wrote it: in a .json file someone kept, in
// localStorage, and — hardest of all — in a QR code, which is a URL frozen
// into a picture that nothing can ever update. Whatever this app becomes, a
// code printed today has to keep opening as the setup it was.
//
// So every snapshot carries `v`, and a snapshot is brought up to date HERE,
// before anything reads it, rather than by each module guessing at the shape
// of what it was handed. The contract, for whoever changes the format next:
//
//   • Anything that changes what an existing snapshot MEANS — renaming a node
//     type, a param, a signal, a gesture or a curve; changing a default an old
//     snapshot relied on by leaving the field out; changing the rules that
//     rebuild the cables `snapshot()` leaves implied — bumps PRESET_VERSION
//     and adds the step that turns the old form into the new one.
//   • Purely additive fields need no bump: an old snapshot without them gets
//     the default, which is what it had when it was saved.
//   • A step is never edited after it ships. Codes made against it exist.
//   • tests/unit/share-compat.test.js holds real links from every version.
//     Add one when you bump; never change an old one to make a test pass.
//
// Pure data in, data out — no imports — so the migrations can be tested
// without an audio engine.

export const PRESET_VERSION = 2;

// What to tell someone opening a setup from a newer app than the one they have.
export const NEWER_SETUP = 'Made with a newer MotionMuse — some of it may be missing';

// MIGRATIONS[n] takes a version-n snapshot and returns a version-(n+1) one.
// Mutating a copy is fine; migrate() hands each step its own.
//
// v1 → v2 is the identity on purpose. v1 was the same shape minus fields v2
// added (`ui`, `shader`, …), and the renames that did happen in that span are
// still handled where they were first written: the pre-rebrand app tag in
// preset.js and `osc_mix` in engine.restore(). New ones belong here.
const MIGRATIONS = {
  1: data => data,
};

// Returns the snapshot at PRESET_VERSION, plus whether it came from a NEWER
// app than this one. That is not refused: most of a newer setup usually
// applies fine, and a partial instrument is better than none. But it is
// reported, because otherwise whatever this build does not understand
// disappears without a word.
export function migrate(data) {
  // No `v` at all: the earliest saves, before it was written.
  const from = Number.isInteger(data?.v) && data.v > 0 ? data.v : 1;
  if (from > PRESET_VERSION) return { data, newer: true };
  let out = structuredClone(data);
  for (let v = from; v < PRESET_VERSION; v++) {
    out = MIGRATIONS[v](out);
    out.v = v + 1;
  }
  return { data: out, newer: false };
}
