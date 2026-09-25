// Camera diagnostics: an on-screen log for the one bug that only happens on a
// device we cannot run.
//
// "Pressing the camera does nothing, and no message" is three different bugs
// that look identical from the outside: the tap never reaches the button,
// the button runs and the browser never answers the permission request, or
// the answer comes and the picture never plays. Only the device can say
// which. Open the app with ?debug (or #debug) and a small panel logs every
// step — where each tap actually landed, each stage of the start, and what
// the browser supports — with a COPY button, so the log can be pasted into a
// report instead of described.
//
// Off unless asked for: no panel, no listeners, diag() does nothing.

const ON = /[?&#]debug\b/.test(location.search + location.hash);
let box = null, list = null;
const lines = [];

const stamp = () => {
  const t = performance.now() / 1000;
  return t.toFixed(1).padStart(6, ' ');
};

export function diag(msg) {
  if (!ON) return;
  const line = `${stamp()}s  ${msg}`;
  lines.push(line);
  if (list) {
    const li = document.createElement('div');
    li.textContent = line;
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
  }
}

const describe = el => {
  if (!el || el === document) return '(nothing)';
  if (el.nodeType !== 1) return describe(el.parentElement);
  const id = el.id ? `#${el.id}` : '';
  const cls = el.classList?.length ? '.' + [...el.classList].slice(0, 2).join('.') : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
};

export function initCamDiag({ buildInfo, buildLabel } = {}) {
  if (!ON) return;
  box = document.createElement('div');
  box.id = 'cam-diag';
  box.innerHTML = `
    <div class="cam-diag-head">
      <b>CAMERA DEBUG</b>
      <button type="button" class="cam-diag-copy">COPY</button>
      <button type="button" class="cam-diag-hide">×</button>
    </div>
    <div class="cam-diag-list"></div>`;
  document.body.appendChild(box);
  list = box.querySelector('.cam-diag-list');
  for (const l of lines) { const d = document.createElement('div'); d.textContent = l; list.appendChild(d); }
  box.querySelector('.cam-diag-copy').addEventListener('click', async e => {
    e.stopPropagation();
    const text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); e.target.textContent = 'COPIED'; }
    catch {
      // Clipboard refused (older iOS, no gesture): select the text instead so
      // a long-press can copy it.
      const r = document.createRange(); r.selectNodeContents(list);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      e.target.textContent = 'SELECTED';
    }
  });
  box.querySelector('.cam-diag-hide').addEventListener('click', e => { e.stopPropagation(); box.remove(); });

  addEventListener('error', e => diag(`page error: ${e.message}`));
  addEventListener('unhandledrejection', e => diag(`unhandled rejection: ${e.reason?.message ?? e.reason}`));

  // What this browser can do.
  const md = navigator.mediaDevices;
  diag(`ua: ${navigator.userAgent}`);
  diag(`secure context: ${window.isSecureContext}  · mediaDevices: ${!!md}  · getUserMedia: ${md?.getUserMedia instanceof Function}`);
  diag(`service worker controlling: ${!!navigator.serviceWorker?.controller}  · standalone: ${matchMedia('(display-mode: standalone)').matches}`);
  diag(`viewport: ${innerWidth}×${innerHeight} @${devicePixelRatio}`);
  navigator.permissions?.query?.({ name: 'camera' })
    .then(p => diag(`camera permission: ${p.state}`))
    .catch(() => diag('camera permission: (not queryable here)'));
  buildInfo?.().then(b => diag(`build: ${buildLabel(b)}`)).catch(() => {});

  // Where every tap lands — the question the whole panel exists to answer.
  document.addEventListener('pointerdown', e => {
    if (box.contains(e.target)) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const btn = document.getElementById('cv-btn');
    const onBtn = !!btn && (hit === btn || btn.contains(hit));
    diag(`tap ${Math.round(e.clientX)},${Math.round(e.clientY)} (${e.pointerType}) → ${describe(e.target)}`
      + (hit !== e.target ? ` · topmost ${describe(hit)}` : '')
      + (btn ? ` · start button ${onBtn ? 'HIT' : 'missed'}` : ''));
  }, true);
  document.addEventListener('click', e => {
    if (box.contains(e.target)) return;
    diag(`click → ${describe(e.target)}`);
  }, true);
}
