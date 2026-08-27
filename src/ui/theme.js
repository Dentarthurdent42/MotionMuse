// Theme switching. Themes are pure CSS: each is a `[data-theme]` block in
// main.css overriding the same set of colour tokens, and nothing else in the
// stylesheet knows a theme exists. This module only decides which one is on.
//
// Every theme is contrast-checked in CI (tests/contrast/index.js) against both
// grounds, so adding one here without adding its palette — or adding a palette
// that fails AA — turns the build red rather than shipping unreadable text.

import { lsGet, lsSet } from '../storage.js';

const KEY = 'motionmuse-theme';

// Canvas painters can't use a CSS variable — they need a colour string — so
// they read tokens through here. Cached rather than read per frame:
// getComputedStyle forces a style flush, and at 60 fps across the camera
// overlay, the face mesh and the scope that is a real cost for values that
// change only when the theme does. setTheme() empties the cache, so the next
// frame after a switch refills it.
const tokenCache = new Map();
export function themeToken(name, fallback) {
  let val = tokenCache.get(name);
  if (val === undefined) {
    val = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    tokenCache.set(name, val);
  }
  return val;
}

export const THEMES = [
  { id: 'midnight', label: 'Midnight',  dark: true  },
  { id: 'contrast', label: 'High Contrast', dark: true },
  { id: 'ember',    label: 'Ember',     dark: true  },
  { id: 'paper',    label: 'Paper',     dark: false },
  { id: 'sepia',    label: 'Sepia',     dark: false },
];
export const DEFAULT_THEME = 'midnight';

export const isTheme = id => THEMES.some(t => t.id === id);

export function getTheme() {
  const saved = lsGet(KEY);
  return isTheme(saved) ? saved : DEFAULT_THEME;
}

export function setTheme(id, { persist = true } = {}) {
  const theme = isTheme(id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  tokenCache.clear();
  // The address-bar / status-bar colour is part of the theme on mobile; a dark
  // chrome above a light page looks like a rendering fault.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = getComputedStyle(document.documentElement)
      .getPropertyValue('--surface').trim() || '#00e5cc';
  }
  if (persist) lsSet(KEY, theme);
  watchers.forEach(fn => { try { fn(theme); } catch { /* one bad watcher isn't fatal */ } });
  return theme;
}

const watchers = [];
export const onThemeChange = fn => { watchers.push(fn); return fn; };

// Applied before first paint by main.js so the page never flashes the default
// palette on the way to the chosen one.
export const initTheme = () => setTheme(getTheme(), { persist: false });
