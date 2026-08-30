// What the camera view says about the setup you are playing.
//
// Two captions, both in the corners so the middle of the frame — where you
// are — stays clear:
//
//   • the NAME of the saved setup, when the thing playing is one of yours.
//     A patchbay full of cables does not tell you which of your setups this
//     is, and in fullscreen the patchbay is not even on screen.
//   • in DEV mode, the setup itself as a QR code, at the smallest size that
//     survives a screenshot — so a setup can be handed over by photographing
//     the picture, with no dialog in the way.
//
// ── How small the QR can be ───────────────────────────────────────────────
//
// Measured rather than guessed (the method is in the README): render at N
// device pixels per module, screenshot, and decode with an independent
// reader. ONE pixel per module decodes reliably; the floor is not the module
// size but the requirement that modules land on WHOLE pixels, so the canvas
// is drawn at exactly 1 px per module and never scaled. The quiet zone still
// earns its keep and is drawn into the canvas at the spec's 4 modules, so a
// screenshot cropped to the canvas is a complete, readable code.

import { shareableSnapshot, encodeState, shareUrl } from '../share.js';
import { encodeQR, drawQR } from '../qr.js';
import { currentConfig } from '../saved.js';
import { devmode } from '../devmode.js';

let nameEl, qrWrap, qrCanvas;
let lastName = null;
let lastPayload = null;      // what the drawn code encodes
let encoding = false;
let nextEncodeAt = 0;

// Re-encoding is a compress + Reed-Solomon pass over a kilobyte, so it is
// rate-limited rather than run per frame. Two seconds is faster than anyone
// can change a setup and photograph it, and slow enough to be free.
const ENCODE_EVERY_MS = 2000;

export function initCamBadge() {
  nameEl   = document.getElementById('cam-name');
  qrWrap   = document.getElementById('cam-qr');
  qrCanvas = document.getElementById('cam-qr-canvas');
  // Turning dev mode on should show the code now, not up to a rate-limit
  // later; turning it off drops the memo so the next re-entry redraws.
  devmode.onChange(() => { nextEncodeAt = 0; lastPayload = null; });
}

// Per frame, from the main loop. Cheap: a string compare, and a clock check.
export function updateCamBadge() {
  if (!nameEl) return;

  const name = currentConfig();
  if (name !== lastName) {
    lastName = name;
    nameEl.textContent = name;
    nameEl.hidden = !name;
    nameEl.title = name ? `Playing your saved setup “${name}”` : '';
  }

  if (!qrWrap) return;
  if (!devmode.enabled) { qrWrap.hidden = true; return; }
  const now = performance.now();
  if (encoding || now < nextEncodeAt) return;
  nextEncodeAt = now + ENCODE_EVERY_MS;
  encoding = true;
  // Fire and forget: the code is a picture of the state a moment ago, which
  // is what a photograph of a screen is anyway.
  buildQR().finally(() => { encoding = false; });
}

async function buildQR() {
  try {
    const payload = await encodeState(shareableSnapshot());
    if (payload === lastPayload) { qrWrap.hidden = false; return; }
    const url = shareUrl(payload);
    // ECC L, for the same reason the SHARE dialog uses it: the tolerance the
    // higher levels buy is for a code that is torn, dirty or badly lit, and
    // none of that happens to a screenshot taken seconds ago. L is the most
    // payload per module, which here means the fewest modules — 121 rather
    // than M's 137 for a typical setup, so 129px square instead of 145.
    const qr = encodeQR(url, { ecc: 'L' });
    // Exactly one pixel per module, quiet zone included: `target` equals the
    // full width the code needs, so the scale works out to 1, and `min: 1`
    // lets it — drawQR's usual floor of 2 is there for the SHARE dialog,
    // where a phone reads a screen across a room. Here the reader is a
    // screenshot of these same pixels, with nothing optical in the path.
    drawQR(qrCanvas, qr, { quiet: 4, min: 1, target: qr.size + 8 });
    qrCanvas.style.width = `${qrCanvas.width}px`;
    qrCanvas.style.height = `${qrCanvas.height}px`;
    qrWrap.hidden = false;
    // An aria-label rather than a title: the wrapper is pointer-events:none,
    // so a tooltip would never appear, but a screen reader still reaches it.
    qrWrap.setAttribute('aria-label',
      `This setup as a QR code, ${qr.size}×${qr.size} modules — screenshot it to share`);
    lastPayload = payload;
  } catch {
    // A setup too big for any version, or a browser without compression:
    // no code rather than a broken one.
    qrWrap.hidden = true;
  }
}
