// Named configurations — the setups you kept.
//
// SHARE already asks for a line describing the setup, because a QR code is
// opaque and a screen showing three of them is three identical squares. That
// line is a NAME, and naming a thing is how people mean to keep it: someone who
// types "ambient pads, left hand opens the filter" has told the app what this
// setup is, and then had to watch it evaporate the moment they changed a
// slider. The same is true from the other end — following a named link handed
// you somebody's instrument and no way back to it once you touched anything.
//
// So a name saves it. Named configurations sit in the PRESET menu beside the
// built-in starting patches, and are restored the same way a loaded file is.
//
// A configuration is a WHOLE snapshot — the same object `preset.snapshot()`
// produces and `preset.applyAll()` consumes — not a patch. A built-in preset is
// a set of cables; this is the instrument, including the audio graph, the
// gestures, gesture mode and which trackers were running. Storing less would make
// "the setup I named" mean something different from "the setup I shared", and
// those are the same act.

import { lsGet, lsSet } from './storage.js';
import { isRecord, isString } from './is.js';
import { cleanShareLabel } from './share.js';

const KEY = 'motionmuse-saved-v1';

// The name IS the identity: saving under a name you already used replaces that
// configuration rather than growing a second one with the same label. Two rows
// reading "ambient pads" would be a menu that cannot be used.
export const configName = cleanShareLabel;

// A ceiling, because these live in localStorage alongside the session, the
// layout and the gestures, and a menu nobody can scroll is not a feature. The
// oldest go first — a name you have not saved under in months is the one you
// have stopped using.
export const SAVED_MAX = 24;

function read() {
  try {
    const raw = JSON.parse(lsGet(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    // Written by us, but read back after a browser update, a hand-edited
    // localStorage or a version of this app that stored something else. An
    // entry that is not a named snapshot is dropped rather than handed on to
    // the menu, which would render `undefined` and apply nothing.
    return raw.filter(e => isRecord(e) && isString(e.name) && e.name && isRecord(e.snap));
  } catch { return []; }
}

const write = list => lsSet(KEY, JSON.stringify(list.slice(0, SAVED_MAX)));

// Newest first: the thing you just named is the thing you are most likely to
// want back.
export const savedConfigs = () => read();

export const findConfig = name => {
  const n = configName(name);
  return read().find(e => e.name === n) ?? null;
};

// Returns the stored entry, or null when there is no name to store it under.
// Silent on the empty name rather than throwing: every caller reaches here from
// a text field that is allowed to be blank, and "shared without naming it" is
// an ordinary thing to do, not an error.
export function saveConfig(name, snap, at) {
  const n = configName(name);
  if (!n || !isRecord(snap)) return null;
  const entry = { name: n, snap, saved: at ?? new Date().toISOString() };
  write([entry, ...read().filter(e => e.name !== n)]);
  return entry;
}

export function deleteConfig(name) {
  const n = configName(name);
  const list = read();
  const kept = list.filter(e => e.name !== n);
  if (kept.length === list.length) return false;
  write(kept);
  return true;
}

// ── Renaming ──────────────────────────────────────────────────────────────
//
// A name is a label you chose in a hurry, usually while sharing — "test",
// "asdf", "ambient 2" — and the setup outlives the moment you typed it.
// Renaming keeps the snapshot and changes only what it is called; saving
// under a new name instead would leave the old one behind, so the menu grows
// a duplicate every time somebody corrects a typo.
//
// Returns the stored entry, or null when there is nothing to rename, the new
// name is empty, or the new name already belongs to a DIFFERENT setup.
//
// That last one is where renaming parts company with saving. Saving under a
// used name replaces it because you just built the thing you are storing —
// the name is the identity, and you said which identity. Renaming onto a used
// name would destroy a setup you did not touch in this action, to make room
// for one you only meant to relabel. Refused here rather than only in the
// menu, so no future caller can lose a patch by being careless.
export function renameConfig(from, to) {
  const a = configName(from), b = configName(to);
  if (!a || !b) return null;
  const list = read();
  const entry = list.find(e => e.name === a);
  if (!entry) return null;
  if (a === b) return entry;
  if (list.some(e => e.name === b)) return null;
  // Read the marker BEFORE the write: currentConfig() only reports a name
  // whose setup still exists, and after the write the old name does not.
  const wasCurrent = currentConfig() === a;
  const renamed = { ...entry, name: b };
  // In place, not moved to the front: renaming is not saving. A row that
  // jumped to the top of the menu because its label was corrected would be
  // the list reordering itself for no reason the user can see.
  write(list.map(e => (e.name === a ? renamed : e)));
  if (wasCurrent) setCurrentConfig(b);
  return renamed;
}

// ── Which setup is loaded ─────────────────────────────────────────────────
//
// The instrument shows its name on the camera view, so it has to know which
// named setup it is currently playing. Kept beside the setups rather than in
// the session snapshot: it is a fact about THIS browser's state ("you are
// playing the one called X"), not part of the setup itself — a shared link
// carrying "currently loaded: X" would be meaningless to whoever opened it.
//
// Cleared, not preserved, the moment the instrument stops being that setup:
// a built-in preset applied over the top, or a blank start. Editing a slider
// does NOT clear it — you are still playing your setup, just changed, and a
// name that vanished on the first knob turn would be a name nobody trusts.
const CURRENT_KEY = 'motionmuse-current-config';

export const currentConfig = () => {
  const n = configName(lsGet(CURRENT_KEY) ?? '');
  // A name whose setup has been forgotten is not a name any more.
  return n && findConfig(n) ? n : '';
};

export function setCurrentConfig(name) {
  const n = configName(name ?? '');
  lsSet(CURRENT_KEY, n);
  return n;
}

export const clearCurrentConfig = () => setCurrentConfig('');
