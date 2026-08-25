// Keyboard shortcuts. Currently one — mute — but built as a binding table
// because "defaulting to spacebar" implies the default can be changed, and
// because a second shortcut shouldn't need a second listener.
//
// Space is a loaded choice: browsers use it to activate whatever has focus, so
// after clicking any button the same key would both re-press that button and
// toggle mute. The rule below resolves that by claiming Space (and any other
// bound key) for the app EXCEPT where a keystroke means something irreplaceable
// — typing into a field, or picking from an open select. Buttons lose their
// Space activation and keep Enter, which is the trade that makes the shortcut
// predictable instead of dependent on invisible focus state.

import { lsGet, lsSet } from '../storage.js';
import { isRecord } from '../is.js';

const LS_KEY = 'motionmuse-hotkeys';

// KeyboardEvent.code values: layout-independent, so the shortcut sits on the
// same physical key whatever the keyboard layout.
export const DEFAULT_BINDINGS = { mute: 'Space', cursor: 'KeyC' };

// Fields where a keystroke is content, not a command.
const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;

// Human-readable name for a KeyboardEvent.code, for the button that shows the
// current binding. Falls back to the raw code, which is ugly but never wrong.
export function keyLabel(code) {
  if (!code) return '—';
  if (code === 'Space') return 'SPACE';
  let m;
  if ((m = /^Key([A-Z])$/.exec(code)))    return m[1];
  if ((m = /^Digit(\d)$/.exec(code)))     return m[1];
  if ((m = /^Numpad(\d)$/.exec(code)))    return `NUM ${m[1]}`;
  if ((m = /^Arrow(\w+)$/.exec(code)))    return m[1].toUpperCase();
  if ((m = /^(F\d{1,2})$/.exec(code)))    return m[1];
  return code.toUpperCase();
}

// Should this event fire the action bound to `code`? Pure, so the rules are
// testable without a DOM: takes the fields it needs, not a live event.
//
// `repeat` is excluded so holding the key doesn't strobe the output, and any
// modifier defers to the browser — Ctrl/Cmd+Space belongs to the OS and the
// input method, not to us.
export function shouldFire(e, code) {
  if (!code || e.code !== code) return false;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  const t = e.target;
  if (!t) return true;
  if (TYPING.test(t.tagName)) return false;
  if (t.isContentEditable) return false;
  return true;
}

function load() {
  try {
    const raw = JSON.parse(lsGet(LS_KEY) || '{}');
    if (!isRecord(raw)) return { ...DEFAULT_BINDINGS };
    // Merge over the defaults rather than replacing them, so a binding added
    // in a later release still reaches someone with a saved file.
    return { ...DEFAULT_BINDINGS, ...raw };
  } catch { return { ...DEFAULT_BINDINGS }; }
}

let bindings = load();
let capture = null;      // pending rebind: fn(code) called with the next key
const watchers = [];     // notified on rebind, so every label showing the key updates

export const getBinding = action => bindings[action] ?? null;

// The bound key is printed in several places (button tooltip, the banner over
// the visualiser, the rebind control). They subscribe rather than poll, so
// there's no way to rebind and leave one of them telling the old story.
export const onBindingChange = fn => { watchers.push(fn); return fn; };
const announce = () => watchers.forEach(fn => { try { fn(bindings); } catch { /* a bad watcher isn't fatal */ } });

function persist() { lsSet(LS_KEY, JSON.stringify(bindings)); announce(); }

export function setBinding(action, code) {
  bindings = { ...bindings, [action]: code };
  persist();
  return bindings[action];
}

export const resetBindings = () => {
  bindings = { ...DEFAULT_BINDINGS };
  persist();
  return bindings;
};

// Grab the next keypress as a new binding. `onDone` gets the code, or null if
// the user pressed Escape to cancel.
export function captureNextKey(onDone) { capture = onDone; }
export const capturing = () => capture !== null;

export function initHotkeys(actions = {}) {
  document.addEventListener('keydown', e => {
    if (capture) {
      // Rebinding: swallow everything so the key being *assigned* can't also
      // trigger whatever it is currently bound to.
      e.preventDefault();
      const done = capture; capture = null;
      done(e.code === 'Escape' ? null : e.code);
      return;
    }
    for (const [action, fn] of Object.entries(actions)) {
      if (!shouldFire(e, bindings[action])) continue;
      e.preventDefault();   // stop Space from also re-pressing a focused button
      fn(e);
      return;
    }
  });
}
