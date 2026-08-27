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
