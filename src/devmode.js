// Developer mode. Off by default; when on, reveals under-construction
// features (EEG/EMG source tabs, chord mode) that aren't ready for everyday
// use. Toggling flips a `dev` class on <body> — CSS hides `.uc-feature`
// elements unless that class is present — and notifies subscribers.

import { lsGet, lsSet } from './storage.js';

const KEY = 'motionmuse-dev';
const cbs = [];
let enabled = lsGet(KEY) === '1';

function sync() {
  document.body.classList.toggle('dev', enabled);
  cbs.forEach(cb => cb(enabled));
}

export const devmode = {
  get enabled() { return enabled; },
  set(on) {
    enabled = !!on;
    lsSet(KEY, enabled ? '1' : '0');
    sync();
  },
  toggle() { this.set(!enabled); },
  onChange(cb) { cbs.push(cb); },
  init() { sync(); },   // apply the persisted state to <body> at startup
};
