// Save / load of the full instrument state — mappings, audio parameters,
// pitch-quantise tuning and waveform/filter selections — as one JSON blob.
//
// Two persistence paths share the same snapshot:
//   • downloadFile / loadFromFile — a portable .json the user keeps or shares.
//   • saveLocal / restoreLocal    — localStorage, so a session survives reload.
//
// `apply()` only mutates state; the caller refreshes the UI afterwards so this
// module stays free of UI imports (and of the circular deps that would bring).

import { engine } from './engine.js';
import { mapper } from './mapper.js';
import { currentKit, setCurrentLabel } from './soundkit.js';
import { gesture } from './gesture.js';
import { chordmode } from './chordmode.js';
import { shader } from './shader.js';
import { lsGet, lsSet } from './storage.js';
import { isString, isRecord } from './is.js';

const LS_KEY = 'motionmuse-session-v1';
const TAG    = 'motionmuse-sound';
// Preset files saved before the rename carry the old tag. They're the same
// format, so keep loading them rather than telling people their file is
// invalid.
const LEGACY_TAGS = ['biosignal-sound'];

// Everything that is "how the app is set up" but lives outside the audio graph
// and the patch: which theme, how the panels and sections are sized, which
// trackers are on, dev mode. It is all already persisted individually in
// localStorage; collecting it here is what makes a saved file the WHOLE state
// rather than most of it — so a setup can be moved between machines, or
// restored after clearing site data, and actually look the same.
//
// Read straight from localStorage rather than from each module: these are the
// values those modules already treat as the source of truth, and going through
// the store means a module that is not loaded yet cannot cost us a key.
const UI_KEYS = {
  theme:       'motionmuse-theme',
  sections:    'motionmuse-sections',
  secOrder:    'motionmuse-sec-order',
  secFolded:   'motionmuse-sec-folded',
  secHome:     'motionmuse-sec-home',
  panelWidths: 'motionmuse-panel-widths',
  camHeight:   'motionmuse-cam-height',
  tracking:    'motionmuse-tracking',
  face:        'motionmuse-face',
  models:      'motionmuse-posemodel',
  hotkeys:     'motionmuse-hotkeys',
  dev:         'motionmuse-dev',
  uicontrol:   'motionmuse-uicontrol',
};

function uiSnapshot() {
  const out = {};
  for (const [name, key] of Object.entries(UI_KEYS)) {
    const v = lsGet(key);
    if (v !== null && v !== '') out[name] = v;    // stored verbatim, as strings
  }
  return out;
}

// Written back to the same keys, then the page reloads: every one of these is
// read at startup by the module that owns it, and re-applying them live would
// mean re-implementing each module's init in here — a second code path that
// would drift. A reload is honest and total.
function uiApply(ui) {
  if (!isRecord(ui)) return false;
  let any = false;
  for (const [name, key] of Object.entries(UI_KEYS)) {
    if (isString(ui[name])) { lsSet(key, ui[name]); any = true; }
  }
  return any;
}

export function snapshot() {
  return {
    app: TAG, v: 2,
    kit: currentKit(),
    mappings: mapper.serialize(),
    audio: engine.snapshot(),
    gestures: gesture.serialize(),   // custom gestures + hidden built-ins
    chord: chordmode.serialize(),
    shader: shader.serialize(),
    ui: uiSnapshot(),
  };
}

export function apply(data) {
  if (!data || (data.app !== TAG && !LEGACY_TAGS.includes(data.app))) return false;
  if (data.audio) engine.restore(data.audio);
  if (Array.isArray(data.mappings)) mapper.load(data.mappings);
  if (data.gestures) gesture.load(data.gestures);
  if (data.chord) chordmode.load(data.chord);
  if (data.shader) shader.load(data.shader);
  // Restore the kit *selection label* only — the exact parameter values came
  // from the snapshot above, so re-applying the kit would stomp them.
  setCurrentLabel(data.kit ?? 'custom');
  return true;
}

// Full restore including layout/theme/tracking. Separate from apply() because
// apply() runs on every session restore, and rewriting the UI keys on each
// startup with values that came from that same startup is pointless churn —
// this is for an explicit LOAD of a saved file.
export function applyAll(data) {
  const ok = apply(data);
  const uiChanged = ok && uiApply(data.ui);
  return { ok, uiChanged };
}

export function saveLocal() {
  lsSet(LS_KEY, JSON.stringify(snapshot()));
}

export function restoreLocal() {
  try {
    const raw = lsGet(LS_KEY);
    return raw ? apply(JSON.parse(raw)) : false;
  } catch { return false; }
}

export function downloadFile(name = 'motionmuse-preset.json') {
  const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Resolves true on success; throws on unreadable / malformed JSON so the
// caller can surface a clear message.
export async function loadFromFile(file) {
  const data = JSON.parse(await file.text());
  const { ok, uiChanged } = applyAll(data);
  if (!ok) throw new Error('Not a MotionMuse preset');
  return { uiChanged };
}
