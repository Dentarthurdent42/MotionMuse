// Fullscreen camera view. Native Fullscreen API where available (desktop,
// iPad); CSS "fake fullscreen" fallback on iPhone Safari, which has no
// Element.requestFullscreen. Both paths hang styling off #video-wrap.fs-active.
// Also owns the fullscreen keyboard overlay (#fs-kbd): a live pitch-quantise
// keyboard strip, replaced by the play-along game renderer while a song runs.

import { engine } from '../engine.js';
import { makeKbdView, midiOf } from './keyboard.js';
import { chordmode } from '../chordmode.js';

let wrap, fsBtn, kbdBtn, kbdCanvas;
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

function syncState(active) {
  wrap.classList.toggle('fs-active', active);
  fsBtn.textContent = active ? '✕ EXIT' : '⛶ FULL';
  fsBtn.classList.toggle('on', active);
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

function fakeEnter() {
  wrap.classList.add('fake-fullscreen');
  document.body.classList.add('no-scroll');
  syncState(true);
}

function fakeExit() {
  wrap.classList.remove('fake-fullscreen');
  document.body.classList.remove('no-scroll');
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
    fsKbd.invalidate();
  });
}

// Injected by playalong-ui so the game takes over the overlay while running.
export function setFsGameRenderer(fn) { fsGameRenderer = fn; }

const fsKbd = makeKbdView('fs-kbd', {
  height: () => Math.max(40, Math.round((wrap?.clientHeight ?? 480) * 0.14)),
});

// Called every RAF from main.js — cheap no-op unless fullscreen is active.
export function updateFsOverlay() {
  if (!fullscreen.active) return;

  // A running game owns the overlay (and forces the canvas visible).
  if (fsGameRenderer && fsGameRenderer(kbdCanvas)) {
    kbdCanvas.classList.add('shown');
    fsKbd.invalidate();          // force a clean keyboard redraw afterwards
    return;
  }
  if (!kbdShown) {
    if (!kbdCanvas.classList.contains('shown')) return;
    kbdCanvas.classList.remove('shown');
    return;
  }
  kbdCanvas.classList.add('shown');
  const t = engine.getTuning();
  // Chord tones go on the same keyboard as the oscillator markers, because in
  // gesture mode the keyboard is otherwise inert — the markers track oscillators,
  // and gesture mode typically runs with none. Fullscreen is exactly where you
  // cannot see the panel, so this is the only place the harmony is visible
  // while you are playing it.
  const c = chordmode.enabled ? chordmode.currentChord() : null;
  fsKbd.draw({
    root: t.root,
    scale: t.enabled ? t.scale : null,   // untinted keys when quantise is off
    markers: Array.from({ length: engine.getOscCount() },
      (_, i) => midiOf(engine.PARAMS[`osc${i + 1}_freq`].val)),
    chord: c ? c.freqs.map(midiOf) : [],
  });
}
