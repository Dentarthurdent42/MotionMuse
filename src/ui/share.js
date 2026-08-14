// SHARE button → a QR code of the current setup.
//
// Sits beside SAVE and LOAD because it is the same idea without the file: SAVE
// is for keeping a setup, SHARE is for handing it to the person next to you.
// They point a camera at the screen and the app opens with your patch.

import { snapshot, applyAll, saveLocal } from '../preset.js';
import { shareableSnapshot, encodeState, decodeState, shareUrl, readShareUrl,
         QR_COMFORTABLE_VERSION } from '../share.js';
import { encodeQR, drawQR } from '../qr.js';
import { toast } from './status.js';

let pop = null;

function build() {
  const el = document.createElement('div');
  el.id = 'share-pop';
  el.setAttribute('role', 'dialog');
  el.innerHTML = `
    <div class="donate-title">SHARE THIS SETUP</div>
    <canvas id="share-qr" class="share-qr"></canvas>
    <div id="share-note" class="share-note"></div>
    <div class="wave-btns">
      <button class="wave-btn" id="share-copy" type="button">COPY LINK</button>
      <button class="wave-btn" id="share-close" type="button">CLOSE</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#share-close').addEventListener('click', () => setOpen(false));
  return el;
}

let currentUrl = '';

async function render() {
  const canvas = pop.querySelector('#share-qr');
  const note = pop.querySelector('#share-note');
  try {
    const payload = await encodeState(shareableSnapshot(snapshot()));
    currentUrl = shareUrl(payload);
    // Level L: the most payload per module, and the trade it gives up —
    // tolerance of a torn or dirty code — does not apply to a picture on a
    // screen being read seconds later.
    const qr = encodeQR(currentUrl, { ecc: 'L' });
    canvas.style.display = '';
    drawQR(canvas, qr, {
      dark: getComputedStyle(document.body).getPropertyValue('--text').trim() || '#000',
      light: getComputedStyle(document.body).getPropertyValue('--panel').trim() || '#fff',
    });
    note.textContent = qr.version > QR_COMFORTABLE_VERSION
      ? `Dense code (v${qr.version}) — hold steady, or use COPY LINK`
      : `${currentUrl.length} characters · point a camera at it`;
    note.classList.toggle('warn', qr.version > QR_COMFORTABLE_VERSION);
  } catch (err) {
    // Too big for any QR version, or no CompressionStream. The link still
    // works — only the picture of it does not.
    canvas.style.display = 'none';
    note.textContent = `Too much to fit in a QR code — use COPY LINK (${err.message})`;
    note.classList.add('warn');
  }
}

function setOpen(open) {
  pop ??= build();
  pop.classList.toggle('open', open);
  document.getElementById('share-btn')?.setAttribute('aria-expanded', String(open));
  if (open) render();
}

export function initShare() {
  const btn = document.getElementById('share-btn');
  if (!btn) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    setOpen(!pop?.classList.contains('open'));
  });
  document.addEventListener('click', e => {
    if (pop?.classList.contains('open') && !pop.contains(e.target) && e.target !== btn) setOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && pop?.classList.contains('open')) setOpen(false);
  });

  // Delegated so it works on the popover built lazily above.
  document.addEventListener('click', async e => {
    if (e.target?.id !== 'share-copy' || !currentUrl) return;
    try {
      await navigator.clipboard.writeText(currentUrl);
      toast('Link copied');
    } catch {
      // Clipboard access needs permission (and a secure context); selecting the
      // text is the fallback that always works.
      const ta = document.createElement('textarea');
      ta.value = currentUrl;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      toast(document.execCommand?.('copy') ? 'Link copied' : 'Copy failed — select the link manually');
      ta.remove();
    }
  });
}

// ── Opening a shared link ─────────────────────────────────────────────────
//
// Applied, persisted, then the page is reloaded without the fragment. The
// reload is not laziness: several modules read their state from localStorage at
// import time (theme, hotkeys, section layout), so applying afterwards would
// leave half the app on the old values. Restarting once with everything already
// in place is the only way it is uniformly correct.
// Set synchronously the moment a link is recognised, and read by the first-run
// picker. The fragment is stripped immediately below — before the rest of
// startup runs — so by the time anything else looks at the URL there is nothing
// there to see, and the picker would open for the half-second before the
// reload.
let consuming = false;
export const isConsumingShare = () => consuming;

export async function consumeSharedLink() {
  const payload = readShareUrl(location.href);
  if (!payload) return false;
  consuming = true;
  // Strip it first, whatever happens next: a bad link that stays in the URL
  // would fail again on every reload.
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const data = await decodeState(payload);
    if (!applyAll(data).ok) throw new Error('not a MotionMuse setup');
    saveLocal();
    sessionStorage.setItem('motionmuse-shared', '1');
    location.reload();
    return true;
  } catch (err) {
    // The link is not going to open, so nothing is arriving to replace the
    // app's state — a first-time visitor should still be asked what to play.
    consuming = false;
    toast(`Could not open that shared setup: ${err.message}`);
    return false;
  }
}

// Say so once, after the reload — otherwise the app silently looks different
// from the one the person left.
export function announceSharedLink() {
  if (sessionStorage.getItem('motionmuse-shared') !== '1') return;
  sessionStorage.removeItem('motionmuse-shared');
  toast('Opened a shared setup');
}
