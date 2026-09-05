// Draggable panel splitters (desktop). The two side-column widths live in
// CSS variables on #main; dragging a splitter updates them, double-click
// resets, and the result persists in localStorage.
import { isDesktop } from './viewport.js';
import { lsGet, lsSet } from '../storage.js';

const KEY = 'motionmuse-panel-widths';
const NARROW_DEF  = { l: 320, r: 280 };
const DESKTOP_DEF = { l: 380, r: 340 };   // wide windows start with more breathing room
const MIN = 200;       // narrowest a side column may go
const MID_MIN = 320;   // the mapper column keeps at least this much
const HANDLES = 12;    // two 6px splitter columns

export function initResize() {
  const main = document.getElementById('main');
  const DEF = isDesktop() ? DESKTOP_DEF : NARROW_DEF;

  let w;
  try { w = { ...DEF, ...JSON.parse(lsGet(KEY) || '{}') }; }
  catch { w = { ...DEF }; }

  // Clamp for *display* without touching the stored widths. Squeezing the
  // window used to overwrite them, so narrowing to phone width and widening
  // again left both side panels stuck at MIN with no way back short of a
  // double-click — the layout could shrink but never recover.
  const clamped = () => {
    const avail = main.clientWidth - HANDLES - MID_MIN;
    if (avail < 2 * MIN) return { ...w };     // window too small — CSS mobile layout applies anyway
    const l = Math.min(Math.max(w.l, MIN), avail - MIN);
    return { l, r: Math.min(Math.max(w.r, MIN), avail - l) };
  };
  const apply = () => {
    const c = clamped();
    main.style.setProperty('--col-l', c.l + 'px');
    main.style.setProperty('--col-r', c.r + 'px');
  };
  const save = () => lsSet(KEY, JSON.stringify(w));

  apply();

  [['split-l', 'l', 1], ['split-r', 'r', -1]].forEach(([id, key, dir]) => {
    const el = document.getElementById(id);
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const startX = e.clientX, startW = w[key];
      document.body.classList.add('resizing');
      // A drag *is* an explicit request, so the clamped result is what gets
      // stored — unlike a window resize, which must leave the intent alone.
      const move = ev => { w[key] = startW + dir * (ev.clientX - startX); w = clamped(); apply(); };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing');
        save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => { w = { ...DEF }; apply(); save(); });
  });

  // Keep the camera overlay canvases matched to their container as the left
  // panel is resized (they are otherwise sized once at camera start).
  const wrap = document.getElementById('video-wrap');
  const fit = () => ['overlay', 'face-overlay'].forEach(id => {
    const c = document.getElementById(id);
    if (!c) return;
    if (c.width !== wrap.offsetWidth)  c.width  = wrap.offsetWidth;
    if (c.height !== wrap.offsetHeight) c.height = wrap.offsetHeight;
  });
  new ResizeObserver(fit).observe(wrap);

  window.addEventListener('resize', apply);
  initCamHandle();
  measureTabs();
}

// The portrait sticky offset has to equal the camera's header height, and that
// changes with the font-size breakpoints — a hardcoded number would leave a
// sliver of the label on screen at one size and clip the video at another.
function measureTabs() {
  const tabs = document.querySelector('.panel-cam > .cam-label');
  const cam  = document.querySelector('.panel-cam');
  if (!tabs || !cam) return;
  const apply = () => {
    const h = tabs.getBoundingClientRect().height;
    if (h > 0) cam.style.setProperty('--cam-label-h', `${Math.round(h)}px`);
  };
  apply();
  new ResizeObserver(apply).observe(tabs);
}

// Camera height handle (portrait dev mode). The bar drags vertically because
// that is what the user is changing — height — but it writes a *width*, since
// #video-wrap derives its height from a 4:3 aspect-ratio. Driving the height
// directly would either break the ratio or crop the frame, and a cropped frame
// puts the landmark overlay out of register with the video.
const CAM_KEY = 'motionmuse-cam-height';
const CAM_MIN_H = 90;

function initCamHandle() {
  const handle = document.getElementById('cam-handle');
  const cam    = document.querySelector('.panel-cam');
  const wrap   = document.getElementById('video-wrap');
  if (!handle || !cam || !wrap) return;

  const maxH = () => Math.max(CAM_MIN_H, Math.min(cam.clientWidth * 0.75, window.innerHeight * 0.6));
  const setH = h => {
    const clamped = Math.max(CAM_MIN_H, Math.min(h, maxH()));
    cam.style.setProperty('--cam-w', `${clamped * 4 / 3}px`);
    return clamped;
  };

  let stored = Number(lsGet(CAM_KEY));
  if (Number.isFinite(stored) && stored > 0) setH(stored);

  let startY = 0, startH = 0;
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    startY = e.clientY;
    startH = wrap.getBoundingClientRect().height;
    document.body.classList.add('resizing-cam');
    const move = ev => setH(startH + (ev.clientY - startY));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing-cam');
      lsSet(CAM_KEY, String(Math.round(wrap.getBoundingClientRect().height)));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    cam.style.removeProperty('--cam-w');
    lsSet(CAM_KEY, '');
  });
}
