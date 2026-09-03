// Fullscreen camera view. Native Fullscreen API where available (desktop,
// iPad); CSS "fake fullscreen" fallback on iPhone Safari, which has no
// Element.requestFullscreen. Both paths hang styling off #video-wrap.fs-active.
// Also owns the fullscreen keyboard overlay (#fs-kbd): a live pitch-quantise
// keyboard strip, replaced by the play-along game renderer while a song runs.

import { engine } from '../engine.js';
import { makeKbdView, midiOf } from './keyboard.js';
import { chordmode } from '../chordmode.js';
import { arpvoice }  from '../arpvoice.js';

let wrap, fsBtn, kbdBtn, kbdCanvas;
let lastKbdH = null;      // last published --fs-kbd-h, so it is written on change only
let kbdShown = false;
let fsGameRenderer = null;   // injected by playalong-ui to avoid circular imports
const changeCbs = [];

const nativeSupported = () =>
  !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);

const nativeActive = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

export const fullscreen = {
  get active() { return wrap?.classList.contains('fs-active') ?? false; },
  toggle() {
    if (this.active) exit(); else enter();
  },
  // Open it without a click. The native Fullscreen API requires a user
  // gesture and rejects anything else, so a setup arriving by link — which
  // lands after a reload, with no gesture anywhere near it — takes the CSS
  // takeover instead. Same view, same exit (Esc, or the button), no promise
  // to be refused.
  open() {
    if (this.active) return;
    fakeEnter();
  },
  onChange(cb) { changeCbs.push(cb); },
};

// The actions strip (mute, SHARE, source, ♥) lives in the header, which
// fullscreen hides — so it rides the picture while fullscreen is on.
function placeActions(active) {
  const bar = document.querySelector('.cam-actions');
  if (!bar) return;
  const home = active ? wrap : document.getElementById('header');
  if (bar.parentElement !== home) home.appendChild(bar);
}

function syncState(active) {
  wrap.classList.toggle('fs-active', active);
  placeActions(active);
  fsBtn.textContent = active ? '✕ EXIT' : '⛶ FULL';
  fsBtn.classList.toggle('on', active);
  // The overlay is sized as a share of the frame, and the frame just changed
  // size — so the reserved space is stale until the next redraw measures it.
  lastKbdH = null;
  // Refit overlay canvases immediately (the ResizeObserver also fires, but
  // some Safari versions deliver it a frame late).
  ['overlay', 'face-overlay'].forEach(id => {
    const c = document.getElementById(id);
    if (c) { c.width = wrap.offsetWidth; c.height = wrap.offsetHeight; }
  });
  changeCbs.forEach(cb => cb(active));
}

function enter() {
  if (nativeSupported() && wrap.requestFullscreen) {
    wrap.requestFullscreen().catch(() => fakeEnter());
  } else if (nativeSupported() && wrap.webkitRequestFullscreen) {
    wrap.webkitRequestFullscreen();
  } else {
    fakeEnter();
  }
}

function exit() {
  if (nativeActive()) (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
  else fakeExit();
}

// The picture lives inside the workspace, which is a transformed element —
// and `position: fixed` resolves against the nearest transformed ancestor,
// so a fixed, inset: 0 frame would fill the camera NODE rather than the
// screen. For the CSS takeover the picture is lifted out to <body> for the
// duration; a placeholder marks its way back into the node. Native
// fullscreen needs none of this: the browser promotes the element itself.
let placeholder = null;

function fakeEnter() {
  if (!placeholder) {
    placeholder = document.createComment('video-wrap');
    wrap.replaceWith(placeholder);
    document.body.appendChild(wrap);
  }
  wrap.classList.add('fake-fullscreen');
  document.body.classList.add('no-scroll');
  syncState(true);
}

function fakeExit() {
  wrap.classList.remove('fake-fullscreen');
  document.body.classList.remove('no-scroll');
  if (placeholder) { placeholder.replaceWith(wrap); placeholder = null; }
  syncState(false);
}

export function initFullscreen() {
  wrap      = document.getElementById('video-wrap');
  fsBtn     = document.getElementById('fs-btn');
  kbdBtn    = document.getElementById('fskbd-btn');
  kbdCanvas = document.getElementById('fs-kbd');

  fsBtn.addEventListener('click', () => fullscreen.toggle());

  // Native transitions (including Esc) drive state through the change events.
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev =>
    document.addEventListener(ev, () => syncState(nativeActive() || wrap.classList.contains('fake-fullscreen'))));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && wrap.classList.contains('fake-fullscreen')) fakeExit();
  });

  kbdBtn.addEventListener('click', () => {
    kbdShown = !kbdShown;
    kbdCanvas.classList.toggle('shown', kbdShown);
    kbdBtn.classList.toggle('on', kbdShown);
    // The class is already correct by the time the RAF path looks, so its
    // early-out skips the publish and the space stays reserved for a keyboard
    // that is no longer there. Say it here, where the truth is.
    publishKbdHeight();
    fsKbd.invalidate();
  });
}

// Injected by playalong-ui so the game takes over the overlay while running.
export function setFsGameRenderer(fn) { fsGameRenderer = fn; }

const fsKbd = makeKbdView('fs-kbd', {
  height: () => Math.max(40, Math.round((wrap?.clientHeight ?? 480) * 0.14)),
});

// How much of the bottom of the frame the keyboard overlay is occupying, as a
// custom property the stylesheet can do arithmetic with. The controls that
// hug the bottom edge — the actions bar and the ♥ popover it opens — ride
// above it rather than sitting on the keys, which are themselves something
// you play with your thumbs.
//
// Published rather than duplicated: the height is `makeKbdView`'s to decide
// (14% of the frame, floored at 40px), and a second copy of that expression
// in CSS would be a copy that goes stale.
// offsetHeight, not a client rect: the picture lives on a zoomed canvas,
// and a length written into its stylesheet is read in layout pixels.
function publishKbdHeight() {
  const h = kbdCanvas?.classList.contains('shown')
    ? Math.round(kbdCanvas.offsetHeight) : 0;
  if (h === lastKbdH) return;
  lastKbdH = h;
  wrap?.style.setProperty('--fs-kbd-h', `${h}px`);
}

// What the keyboard should be showing. A block chord really does hold every
// note down, so all of them are drawn at full strength — but an ARPEGGIO does
// not, and drawing the whole chord while a run picks through it one note at a
// time was the keyboard describing a way of playing nobody had chosen. Under
// the arp the display follows the schedule instead: each note struck, held for
// its gate, falling through its tail, gone.
function soundingNotes() {
  if (!chordmode.enabled) return [];
  if (arpvoice.enabled) {
    return arpvoice.voices().map(v => ({ m: midiOf(v.freq), level: v.level }));
  }
  const c = chordmode.currentChord();
  return c ? c.freqs.map(midiOf) : [];
}

// Called every RAF from main.js — cheap no-op unless the keyboard overlay is
// up. It is no longer fullscreen-only: the keys show which notes the
// instrument is quantised to, which is as worth seeing while you are wiring
// something as while you are playing it.
export function updateFsOverlay() {
  if (!kbdCanvas) return;

  // A running game owns the overlay (and forces the canvas visible).
  if (fsGameRenderer && fsGameRenderer(kbdCanvas)) {
    kbdCanvas.classList.add('shown');
    publishKbdHeight();
    fsKbd.invalidate();          // force a clean keyboard redraw afterwards
    return;
  }
  if (!kbdShown) {
    if (!kbdCanvas.classList.contains('shown')) return;
    kbdCanvas.classList.remove('shown');
    publishKbdHeight();
    return;
  }
  kbdCanvas.classList.add('shown');
  publishKbdHeight();
  const t = engine.getTuning();
  // Chord tones go on the same keyboard as the oscillator markers, because in
  // gesture mode the keyboard is otherwise inert — the markers track oscillators,
  // and gesture mode typically runs with none. Fullscreen is exactly where you
  // cannot see the panel, so this is the only place the harmony is visible
  // while you are playing it.
  fsKbd.draw({
    root: t.root,
    scale: t.enabled ? t.scale : null,   // untinted keys when quantise is off
    markers: Array.from({ length: engine.getOscCount() },
      (_, i) => midiOf(engine.PARAMS[`osc${i + 1}_freq`].val)),
    chord: soundingNotes(),
  });
}
