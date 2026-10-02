// The setup tag: the setup itself, always on the picture, as a code small
// enough to leave there — and the way back in, from a screenshot of it.
//
// SHARE's QR code is for the person next to you, pointing a camera at your
// screen. This is for everyone else: the people watching a recording of you
// playing. Pause the video, screenshot it, and PRESET → FROM IMAGE (or paste
// the screenshot, or drop it on the page) opens the app configured as it was
// in the recording. The format, and why it can be this small when a QR code
// could not, is src/densecode.js; the packing that makes the payload small
// enough is src/share.js's 'b'.
//
// It sits in the picture's bottom-right corner, the one corner nothing else
// uses: the name is top-left, the picture's modes top-right, and the actions
// bar takes bottom-left in fullscreen. It rides above the fullscreen keyboard
// the way that bar does. Tapping it opens SHARE, which is what it is a small
// version of. ⚙ → SETUP TAG turns it off, for a recording that is nobody
// else's business.

import { snapshot } from '../preset.js';
import { tagState, encodeStateBytes, decodeStateBytes } from '../share.js';
import { encodeTag, drawTag, readTag } from '../densecode.js';
import { currentConfig } from '../saved.js';
import { lsGet, lsSet } from '../storage.js';
import { openSharedState } from './share.js';
import { toast } from './status.js';

// Device pixels per cell. Measured, not guessed (tests/tag-recording, and the
// README): what has to survive is a cell of about two and a half pixels AFTER
// a feed has scaled the recording down. At four, a phone's recording posted at
// 720px wide and a monitor's posted at 1080 or 720 all still read, at
// compression well past a feed's default; at three, the phone's stops reading
// at 720. Device pixels, so a phone's tag is a third the CSS size of a
// laptop's — the recording sees the same thing either way.
export const TAG_CELL = 4;
const SHOWN_KEY = 'motionmuse-tag';
// How often the setup is looked at for changes. The tag is a picture of the
// setup, not of the performance (see tagState), so it changes when you
// rewire or retune — a second's lag on that is invisible.
const EVERY_MS = 1000;

let canvas = null;
let last = '';
let busy = false;

export const tagShown = () => lsGet(SHOWN_KEY) !== 'off';

export function setTagShown(on) {
  lsSet(SHOWN_KEY, on ? 'on' : 'off');
  if (canvas) canvas.hidden = !on;
  last = '';
  if (on) refresh();
}

// Shown at exactly its own device pixels — whole pixels per cell is the best
// the tag can ever look, and a recording only takes from there — wherever the
// picture is. On the canvas the picture is inside the workspace's zoom, so the
// tag's CSS size divides that zoom back out: zoomed out to half, a tag sized
// in CSS alone would be half its cells, and two-pixel cells do not survive a
// recording. Capped, though, at a share of the picture: zoomed far enough out
// the picture is a thumbnail, and a tag covering it would be the only thing
// on it. That is the one case where the tag gives way, and zooming in or
// going fullscreen gives it back.
const MAX_SHARE = 0.4;

function fitSize() {
  const wrap = canvas?.parentElement;
  if (!wrap || !canvas.width) return;
  const local = wrap.offsetWidth || 1;
  const zoom = wrap.getBoundingClientRect().width / local || 1;
  const dpr = globalThis.devicePixelRatio || 1;
  const w = Math.min(canvas.width / dpr / zoom, local * MAX_SHARE);
  const h = w * canvas.height / canvas.width;
  const ws = `${w.toFixed(2)}px`, hs = `${h.toFixed(2)}px`;
  // Only on a change: this runs every tick, and a style write that changes
  // nothing still dirties layout on some engines. Both sides, because a new
  // setup can make the tag taller without making it wider.
  if (canvas.style.width !== ws) canvas.style.width = ws;
  if (canvas.style.height !== hs) canvas.style.height = hs;
}

async function refresh() {
  if (!canvas || busy || document.hidden || !tagShown()) return;
  fitSize();
  const state = tagState(snapshot(), currentConfig());
  const json = JSON.stringify(state);
  if (json === last) return;
  busy = true;
  try {
    const tag = encodeTag(await encodeStateBytes(state));
    drawTag(canvas, tag, TAG_CELL);
    canvas.hidden = false;
    fitSize();
  } catch {
    // Too big for a tag (a setup this app would struggle to hold anyway).
    // SHARE still has the link; the corner just stays empty.
    canvas.hidden = true;
  } finally {
    last = json;
    busy = false;
  }
}

// ── Reading one back ──────────────────────────────────────────────────────

function pixelsOf(bmp) {
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

// An image file (or a pasted/dropped blob) → the setup in it, opened. Every
// failure is said out loud: an image that "did nothing" is indistinguishable
// from an app that is broken.
export async function openImage(file) {
  let bytes = null;
  try {
    const bmp = await createImageBitmap(file);
    bytes = readTag(pixelsOf(bmp));
    bmp.close?.();
  } catch {
    toast('Could not read that image');
    return false;
  }
  if (!bytes) {
    toast('No MotionMuse setup code found in that image');
    return false;
  }
  try {
    const data = await decodeStateBytes(bytes);
    // The link's own text, rebuilt, is the share's identity: a screenshot of a
    // setup you already opened from its link is the same setup.
    const payload = String.fromCharCode(bytes[0]) + linkBody(bytes);
    openSharedState(data, payload);
    return true;
  } catch (err) {
    toast(`Could not open that setup: ${err.message}`);
    return false;
  }
}

// base64url of everything after the packing letter, as a link would carry it.
const linkBody = bytes => {
  let s = '';
  for (const b of bytes.subarray(1)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

let picker = null;

// PRESET → FROM IMAGE. On a phone this is the photo library, which is where a
// screenshot already is.
export function pickImage() {
  if (!picker) {
    picker = Object.assign(document.createElement('input'),
      { type: 'file', accept: 'image/*', hidden: true, id: 'tag-file' });
    picker.addEventListener('change', () => {
      const f = picker.files?.[0];
      picker.value = '';      // the same screenshot can be picked twice
      if (f) openImage(f);
    });
    document.body.appendChild(picker);
  }
  picker.click();
}

const imageIn = list => [...(list ?? [])].find(f => f?.type?.startsWith('image/')) ?? null;

const typing = el => !!el && (el.isContentEditable
  || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export function initTag() {
  const wrap = document.getElementById('video-wrap');
  if (wrap) {
    canvas = document.createElement('canvas');
    canvas.id = 'cam-tag';
    canvas.className = 'cam-tag';
    canvas.hidden = true;
    canvas.setAttribute('role', 'button');
    canvas.setAttribute('aria-label', 'This setup as a code — tap to share it');
    canvas.title = 'This setup, as a code a screenshot can carry. Anyone with a '
      + 'screenshot of it can open it: PRESET → FROM IMAGE, or paste the image '
      + 'into the app. Tap to share. Turn it off in ⚙.';
    canvas.addEventListener('click', e => {
      // The SHARE sheet closes on any click outside it, and this click is
      // outside it on its way up — so it stops here.
      e.stopPropagation();
      document.getElementById('share-btn')?.click();
    });
    wrap.appendChild(canvas);
    refresh();
    setInterval(refresh, EVERY_MS);
    document.addEventListener('visibilitychange', refresh);
  }

  // Paste a screenshot anywhere — except into a text field, where a paste is
  // somebody typing.
  document.addEventListener('paste', e => {
    if (typing(e.target)) return;
    const f = imageIn([...(e.clipboardData?.items ?? [])]
      .filter(i => i.kind === 'file').map(i => i.getAsFile()));
    if (!f) return;
    e.preventDefault();
    openImage(f);
  });
  // …or drop it on the page.
  document.addEventListener('dragover', e => {
    if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', e => {
    const f = imageIn(e.dataTransfer?.files);
    if (!f) return;
    e.preventDefault();
    openImage(f);
  });
}

// Exported for the share sheet's saved image, which carries a tag beside its
// QR code so the app can read the picture back as well as a phone can.
export async function currentTag(label) {
  return encodeTag(await encodeStateBytes(tagState(snapshot(), label)));
}
