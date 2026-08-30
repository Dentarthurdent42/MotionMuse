// What the camera view says about the setup you are playing.
//
// The NAME of the saved setup, when the thing playing is one of yours, in the
// top-left corner so the middle of the frame — where you are — stays clear. A
// patchbay full of cables does not tell you which of your setups this is, and
// in fullscreen the patchbay is not even on screen.
//
// This used to carry a second passenger: the whole setup as a QR code, in DEV,
// so it could be handed over by screenshotting the picture. The measurement
// that feature was built on holds — one pixel per module really does decode
// from a screenshot, which is the smallest a code can honestly be — but the
// answer it produced was still too big. A typical setup is 121 modules, and
// 129px square is a quarter of the width of a phone's camera panel: a corner
// ornament in name only. A code that size has to be somewhere it can be the
// whole point, which is the SHARE sheet, and SHARE now takes the screen.

import { currentConfig } from '../saved.js';

let nameEl;
let lastName = null;

export function initCamBadge() {
  nameEl = document.getElementById('cam-name');
}

// Per frame, from the main loop. Cheap: one string compare.
export function updateCamBadge() {
  if (!nameEl) return;
  const name = currentConfig();
  if (name === lastName) return;
  lastName = name;
  nameEl.textContent = name;
  nameEl.hidden = !name;
  nameEl.title = name ? `Playing your saved setup “${name}”` : '';
}
