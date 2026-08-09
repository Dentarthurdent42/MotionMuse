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
      el.setPointerCapture(e.pointerId);
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
}
