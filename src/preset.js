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

const LS_KEY = 'biosignal-session-v1';
const TAG    = 'biosignal-sound';

export function snapshot() {
  return { app: TAG, v: 1, kit: currentKit(), mappings: mapper.serialize(), audio: engine.snapshot() };
}

export function apply(data) {
  if (!data || data.app !== TAG) return false;
  if (data.audio) engine.restore(data.audio);
  if (Array.isArray(data.mappings)) mapper.load(data.mappings);
  // Restore the kit *selection label* only — the exact parameter values came
  // from the snapshot above, so re-applying the kit would stomp them.
  setCurrentLabel(data.kit ?? 'custom');
  return true;
}

export function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot())); } catch { /* private mode / quota */ }
}

export function restoreLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
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
  if (!apply(data)) throw new Error('Not a MotionMuse preset');
  return true;
}
