// Brand-prefixed localStorage with a read-through migration from the keys used
// before the MotionMuse rename. Renaming a key is normally silent data loss —
// the app would just find nothing and hand the user factory defaults, wiping
// their dev-mode preference, panel widths, saved session and play-along high
// scores. Instead the first read of a new key adopts the legacy value and
// retires the old one.
//
// Every access is wrapped: localStorage throws in private mode and on quota,
// and none of this is important enough to break the app over.

const LEGACY_KEYS = {
  'motionmuse-dev':          'motionmuse-dev',
  'motionmuse-posemodel':    'motionmuse-posemodel',
  'motionmuse-scores':       'motionmuse-scores',
  'motionmuse-session-v1':   'biosignal-session-v1',
  'motionmuse-panel-widths': 'biosignal-panel-widths',
};

export function lsGet(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
    const legacyKey = LEGACY_KEYS[key];
    if (!legacyKey) return null;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy === null) return null;
    localStorage.setItem(key, legacy);      // adopt it under the new name…
    localStorage.removeItem(legacyKey);     // …and don't migrate twice
    return legacy;
  } catch { return null; }
}

export function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
}
