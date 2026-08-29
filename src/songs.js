// Play-along note charts: the bundled public-domain melodies (embedded as a
// module so they work offline with no extra fetches), plus whatever the
// player has imported from their own MIDI files (kept in localStorage, so
// they survive reload but never leave the machine).
//
// Format: { id, name, bpm, beatsPerBar, root, scale, notes: [{ b, m, d }] }
//   b = beat offset from song start, m = MIDI note, d = duration in beats.
// Charts stay within C3–C6 so they sit comfortably on the C2–C7 keyboard
// and within a hand-height mapping's usable range.

import { lsGet, lsSet } from './storage.js';
import { isRecord, isString } from './is.js';

export const SONGS = [
  {
    id: 'ode-to-joy', name: 'Ode to Joy', bpm: 110, beatsPerBar: 4,
    root: 'C', scale: 'major (ionian)',
    notes: [
      { b: 0, m: 64, d: 1 }, { b: 1, m: 64, d: 1 }, { b: 2, m: 65, d: 1 }, { b: 3, m: 67, d: 1 },
      { b: 4, m: 67, d: 1 }, { b: 5, m: 65, d: 1 }, { b: 6, m: 64, d: 1 }, { b: 7, m: 62, d: 1 },
      { b: 8, m: 60, d: 1 }, { b: 9, m: 60, d: 1 }, { b: 10, m: 62, d: 1 }, { b: 11, m: 64, d: 1 },
      { b: 12, m: 64, d: 1.5 }, { b: 13.5, m: 62, d: 0.5 }, { b: 14, m: 62, d: 2 },
      { b: 16, m: 64, d: 1 }, { b: 17, m: 64, d: 1 }, { b: 18, m: 65, d: 1 }, { b: 19, m: 67, d: 1 },
      { b: 20, m: 67, d: 1 }, { b: 21, m: 65, d: 1 }, { b: 22, m: 64, d: 1 }, { b: 23, m: 62, d: 1 },
      { b: 24, m: 60, d: 1 }, { b: 25, m: 60, d: 1 }, { b: 26, m: 62, d: 1 }, { b: 27, m: 64, d: 1 },
      { b: 28, m: 62, d: 1.5 }, { b: 29.5, m: 60, d: 0.5 }, { b: 30, m: 60, d: 2 },
    ],
  },
  {
    id: 'twinkle', name: 'Twinkle Twinkle', bpm: 100, beatsPerBar: 4,
    root: 'C', scale: 'major (ionian)',
    notes: [
      { b: 0, m: 60, d: 1 }, { b: 1, m: 60, d: 1 }, { b: 2, m: 67, d: 1 }, { b: 3, m: 67, d: 1 },
      { b: 4, m: 69, d: 1 }, { b: 5, m: 69, d: 1 }, { b: 6, m: 67, d: 2 },
      { b: 8, m: 65, d: 1 }, { b: 9, m: 65, d: 1 }, { b: 10, m: 64, d: 1 }, { b: 11, m: 64, d: 1 },
      { b: 12, m: 62, d: 1 }, { b: 13, m: 62, d: 1 }, { b: 14, m: 60, d: 2 },
      { b: 16, m: 67, d: 1 }, { b: 17, m: 67, d: 1 }, { b: 18, m: 65, d: 1 }, { b: 19, m: 65, d: 1 },
      { b: 20, m: 64, d: 1 }, { b: 21, m: 64, d: 1 }, { b: 22, m: 62, d: 2 },
      { b: 24, m: 67, d: 1 }, { b: 25, m: 67, d: 1 }, { b: 26, m: 65, d: 1 }, { b: 27, m: 65, d: 1 },
      { b: 28, m: 64, d: 1 }, { b: 29, m: 64, d: 1 }, { b: 30, m: 62, d: 2 },
      { b: 32, m: 60, d: 1 }, { b: 33, m: 60, d: 1 }, { b: 34, m: 67, d: 1 }, { b: 35, m: 67, d: 1 },
      { b: 36, m: 69, d: 1 }, { b: 37, m: 69, d: 1 }, { b: 38, m: 67, d: 2 },
      { b: 40, m: 65, d: 1 }, { b: 41, m: 65, d: 1 }, { b: 42, m: 64, d: 1 }, { b: 43, m: 64, d: 1 },
      { b: 44, m: 62, d: 1 }, { b: 45, m: 62, d: 1 }, { b: 46, m: 60, d: 2 },
    ],
  },
  {
    id: 'saints', name: 'When the Saints', bpm: 120, beatsPerBar: 4,
    root: 'C', scale: 'major (ionian)',
    notes: [
      { b: 0, m: 60, d: 1 }, { b: 1, m: 64, d: 1 }, { b: 2, m: 65, d: 1 }, { b: 3, m: 67, d: 2.5 },
      { b: 8, m: 60, d: 1 }, { b: 9, m: 64, d: 1 }, { b: 10, m: 65, d: 1 }, { b: 11, m: 67, d: 2.5 },
      { b: 16, m: 60, d: 1 }, { b: 17, m: 64, d: 1 }, { b: 18, m: 65, d: 1 }, { b: 19, m: 67, d: 1.5 },
      { b: 20.5, m: 64, d: 1.5 }, { b: 22, m: 60, d: 1.5 }, { b: 23.5, m: 64, d: 1.5 }, { b: 25, m: 62, d: 3 },
      { b: 32, m: 64, d: 1 }, { b: 33, m: 64, d: 1 }, { b: 34, m: 62, d: 1 }, { b: 35, m: 60, d: 1.5 },
      { b: 36.5, m: 60, d: 0.5 }, { b: 37, m: 64, d: 1 }, { b: 38, m: 67, d: 1.5 }, { b: 39.5, m: 67, d: 1 },
      { b: 40.5, m: 65, d: 1.5 }, { b: 42, m: 64, d: 1 }, { b: 43, m: 65, d: 1 }, { b: 44, m: 67, d: 1.5 },
      { b: 45.5, m: 64, d: 1.5 }, { b: 47, m: 60, d: 1.5 }, { b: 48.5, m: 62, d: 1.5 }, { b: 50, m: 60, d: 3 },
    ],
  },
  {
    id: 'scarborough', name: 'Scarborough Fair', bpm: 90, beatsPerBar: 3,
    root: 'D', scale: 'dorian',
    notes: [
      { b: 0, m: 62, d: 2 }, { b: 2, m: 62, d: 1 }, { b: 3, m: 69, d: 2 }, { b: 5, m: 69, d: 1 },
      { b: 6, m: 64, d: 1 }, { b: 7, m: 65, d: 1 }, { b: 8, m: 64, d: 1 }, { b: 9, m: 62, d: 3 },
      { b: 12, m: 69, d: 1 }, { b: 13, m: 69, d: 1 }, { b: 14, m: 72, d: 1 }, { b: 15, m: 74, d: 2 },
      { b: 17, m: 72, d: 1 }, { b: 18, m: 71, d: 1 }, { b: 19, m: 67, d: 1 }, { b: 20, m: 69, d: 3 },
      { b: 24, m: 74, d: 2 }, { b: 26, m: 74, d: 1 }, { b: 27, m: 74, d: 1 }, { b: 28, m: 72, d: 1 },
      { b: 29, m: 69, d: 1 }, { b: 30, m: 71, d: 1 }, { b: 31, m: 67, d: 1 }, { b: 32, m: 65, d: 1 },
      { b: 33, m: 64, d: 2 }, { b: 36, m: 69, d: 2 }, { b: 38, m: 67, d: 1 }, { b: 39, m: 65, d: 2 },
      { b: 41, m: 64, d: 1 }, { b: 42, m: 62, d: 3 },
    ],
  },
];

// ── Imported songs ────────────────────────────────────────────────────────

const USER_KEY = 'motionmuse-user-songs';
// localStorage is ~5 MB and shared with everything else the app remembers; a
// dozen full charts is well under half a megabyte, and the picker stops being
// a picker long before the storage runs out.
export const MAX_USER_SONGS = 24;

export function userSongs() {
  try {
    const raw = JSON.parse(lsGet(USER_KEY));
    return Array.isArray(raw) ? raw.filter(s => isRecord(s) && isString(s.id) && Array.isArray(s.notes)) : [];
  } catch { return []; }
}

export function addUserSong(song) {
  const id = `user-${Date.now().toString(36)}`;
  const list = userSongs();
  list.push({ ...song, id });
  while (list.length > MAX_USER_SONGS) list.shift();   // oldest out first
  lsSet(USER_KEY, JSON.stringify(list));
  return id;
}

export function removeUserSong(id) {
  lsSet(USER_KEY, JSON.stringify(userSongs().filter(s => s.id !== id)));
}

export const isUserSong = id => isString(id) && id.startsWith('user-');

// Every pickable chart, bundled first. Generated charts are not in this list:
// they are made fresh at start(), not stored.
export const allSongs = () => [...SONGS, ...userSongs()];
export const songById = id => allSongs().find(s => s.id === id) ?? null;
