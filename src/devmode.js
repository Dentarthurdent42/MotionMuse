// Developer mode. Off by default; when on, reveals the under-construction
// features that aren't ready for everyday use: EEG/EMG source tabs, the pose
// model comparison, the shader, inference timings, LiDAR, the hand cursor and
// the gesture stage. Toggling flips a `dev` class on <body> — CSS hides
// `.uc-feature` elements unless that class is present — and notifies
// subscribers, which is how the features that RUN (LiDAR, the hand cursor, the
// stage) know to stop rather than carry on with their controls hidden.
//
// Chord mode used to be in that list and is not any more: it is a way of
// playing the instrument, not an experiment.

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
