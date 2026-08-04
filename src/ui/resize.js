// Draggable panel splitters (desktop). The two side-column widths live in
// CSS variables on #main; dragging a splitter updates them, double-click
// resets, and the result persists in localStorage.
import { isDesktop } from './viewport.js';

const KEY = 'biosignal-panel-widths';
const NARROW_DEF  = { l: 320, r: 280 };
const DESKTOP_DEF = { l: 380, r: 340 };   // wide windows start with more breathing room
const MIN = 200;       // narrowest a side column may go
const MID_MIN = 320;   // the mapper column keeps at least this much
const HANDLES = 12;    // two 6px splitter columns

export function initResize() {
  const main = document.getElementById('main');
  const DEF = isDesktop() ? DESKTOP_DEF : NARROW_DEF;

  let w;
  try { w = { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { w = { ...DEF }; }

  const clamp = () => {
    const avail = main.clientWidth - HANDLES - MID_MIN;
    if (avail < 2 * MIN) return;              // window too small — CSS mobile layout applies anyway
    w.l = Math.min(Math.max(w.l, MIN), avail - MIN);
    w.r = Math.min(Math.max(w.r, MIN), avail - w.l);
  };
  const apply = () => {
    main.style.setProperty('--col-l', w.l + 'px');
    main.style.setProperty('--col-r', w.r + 'px');
  };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* private mode */ } };

  clamp(); apply();

  [['split-l', 'l', 1], ['split-r', 'r', -1]].forEach(([id, key, dir]) => {
    const el = document.getElementById(id);
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const startX = e.clientX, startW = w[key];
      document.body.classList.add('resizing');
      const move = ev => { w[key] = startW + dir * (ev.clientX - startX); clamp(); apply(); };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing');
        save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => { w = { ...DEF }; clamp(); apply(); save(); });
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

  window.addEventListener('resize', () => { clamp(); apply(); });
}
