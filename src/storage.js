// Brand-prefixed localStorage with a read-through migration from the prefixes
// used before each rename. Renaming a key is normally silent data loss — the
// app would just find nothing and hand the user factory defaults, wiping their
// dev-mode preference, panel widths, saved session, rearranged layout and
// play-along high scores. Instead the first read of a new key adopts the
// legacy value and retires the old one.
//
// This is prefix-based rather than a hand-listed map of every key, because the
// map was the bug waiting to happen: it named five keys while the app stored
// nineteen, so a rename silently dropped the other fourteen — the section
// layout, the tour progress, the theme, the hotkeys, the saved preset. A
// prefix rule cannot fall behind a key that is added later.
//
// Ordered oldest-last: whichever prefix still holds a value wins, and the app
// has been renamed twice (biosignal → motionmuse → motionmuse → motionmuse), so
// a user who skipped a release can still be carrying either of the older two.
//
// Every access is wrapped: localStorage throws in private mode and on quota,
// and none of this is important enough to break the app over.

const PREFIX = 'motionmuse-';
const LEGACY_PREFIXES = ['motionmuse-', 'biosignal-'];

// The candidates for `key`, oldest last. A key that does not carry the current
// prefix has no legacy form — it is not ours to migrate.
function legacyNames(key) {
  if (!key.startsWith(PREFIX)) return [];
  const bare = key.slice(PREFIX.length);
  return LEGACY_PREFIXES.map(p => p + bare);
}

export function lsGet(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
    for (const legacyKey of legacyNames(key)) {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy === null) continue;
      localStorage.setItem(key, legacy);      // adopt it under the new name…
      localStorage.removeItem(legacyKey);     // …and don't migrate twice
      return legacy;
    }
    return null;
  } catch { return null; }
}

export function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
}

// Forget a key, under the current name and any legacy one — otherwise lsGet
// would helpfully adopt the legacy copy on the very next read and undo the
// removal.
export function lsDel(key) {
  try {
    localStorage.removeItem(key);
    for (const legacyKey of legacyNames(key)) localStorage.removeItem(legacyKey);
  } catch { /* private mode */ }
}
