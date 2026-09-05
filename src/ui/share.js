// SHARE button → a QR code of the current setup.
//
// Sits beside SAVE and LOAD because it is the same idea without the file: SAVE
// is for keeping a setup, SHARE is for handing it to the person next to you.
// They point a camera at the screen and the app opens with your patch.

import { snapshot, applyAll, saveLocal } from '../preset.js';
import { shareableSnapshot, encodeState, decodeState, shareUrl, readShareUrl,
         cleanShareLabel, SHARE_LABEL_MAX, shareFingerprint,
         QR_COMFORTABLE_VERSION } from '../share.js';
import { encodeQR, drawQR } from '../qr.js';
import { saveConfig, setCurrentConfig } from '../saved.js';
import { toast } from './status.js';
import { lsGet, lsSet } from '../storage.js';

let pop = null;

function build() {
  const el = document.createElement('div');
  el.id = 'share-pop';
  el.setAttribute('role', 'dialog');
  el.innerHTML = `
    <div class="donate-title">SHARE THIS SETUP</div>
    <canvas id="share-qr" class="share-qr"></canvas>
    <div id="share-note" class="share-note"></div>
    <input id="share-label" class="share-label" type="text"
           maxlength="${SHARE_LABEL_MAX}" autocomplete="off"
           aria-label="Name this setup — kept in PRESET and sent with the link"
           placeholder="Name it — e.g. ambient pads, left hand opens the filter">
    <div class="share-kept" id="share-kept"></div>
    <div class="wave-btns">
      <button class="wave-btn" id="share-copy" type="button">COPY LINK</button>
      <button class="wave-btn" id="share-close" type="button">CLOSE</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#share-close').addEventListener('click', () => setOpen(false));
  // Every character changes the payload, so the code has to be redrawn — but
  // not per keystroke: encoding compresses the whole state and then lays out a
  // QR, which is far more work than a keypress is worth. A short idle is
  // imperceptible while typing and coalesces a sentence into one redraw.
  const input = el.querySelector('#share-label');
  input.value = label;
  let typing = null;
  input.addEventListener('input', () => {
    label = input.value;
    clearTimeout(typing);
    typing = setTimeout(render, 250);
  });
  // Keeping it is committed on `change` — blur, or Enter — rather than on the
  // same debounce that redraws the code. Typing "ambient" on the way to
  // "ambient pads" is not two configurations, and a store that recorded every
  // prefix someone typed would be a menu of half-names.
  input.addEventListener('change', () => keep());
  input.addEventListener('keydown', e => { if (e.key === 'Enter') keep(); });
  return el;
}

let currentUrl = '';
// Kept for the session rather than persisted: it names the setup you are
// sharing now, and reopening SHARE after a tweak should not make you retype
// it — the stored copy lives in the saved-configuration list, under this name.
let label = '';
// The name this popover has already stored, so committing twice — blur, then
// COPY LINK, then close — does not re-announce it three times.
let kept = '';

// Naming a setup keeps it: it shows up in PRESET under that name, and stays
// there after the link is gone. Called from every point where the name is
// finished rather than still being typed.
function keep() {
  const name = cleanShareLabel(label);
  if (!name) return null;
  // The snapshot is taken NOW, not when the popover opened: the point of a
  // named configuration is the instrument as it stands at the moment you named
  // it, and this is the same state the link is being built from.
  const entry = saveConfig(name, shareableSnapshot(snapshot()));
  // Naming it is keeping it, and what you just named is what you are playing.
  if (entry) setCurrentConfig(entry.name);
  if (entry && name !== kept) {
    kept = name;
    toast(`Kept as “${name}” — it is in PRESET`);
  }
  const note = pop?.querySelector('#share-kept');
  if (note) note.textContent = name ? `Kept in PRESET as “${name}”` : '';
  return entry;
}

// Nothing has to be told: the PRESET menu re-reads the store every time it
// opens, so a setup named here is in the list the next time anyone looks.

async function render() {
  const canvas = pop.querySelector('#share-qr');
  const note = pop.querySelector('#share-note');
  try {
    const described = cleanShareLabel(label);
    const state = shareableSnapshot(snapshot());
    if (described) state.label = described;
    const payload = await encodeState(state);
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
      ? `Dense code (v${qr.version}) — hold steady, shorten the name, or use COPY LINK`
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

// Keep the popover inside the part of the screen that is actually visible.
//
// A phone's keyboard does not shrink the layout viewport, so a dialog centred
// in it sits half behind the keyboard the moment the description field takes
// focus — and the QR code is what ends up covered, which is the one thing that
// has to stay on screen for someone to point a camera at. visualViewport is
// the only thing that reports the area the keyboard has left, so the popover
// is centred in THAT and capped to its height.
function fitToViewport() {
  const vv = globalThis.visualViewport;
  if (!pop || !vv) return;
  pop.style.top = `${vv.offsetTop + vv.height / 2}px`;
  pop.style.maxHeight = `${Math.max(0, vv.height - 16)}px`;
}

function setOpen(open) {
  pop ??= build();
  pop.classList.toggle('open', open);
  document.getElementById('share-btn')?.setAttribute('aria-expanded', String(open));
  const vv = globalThis.visualViewport;
  if (open) {
    render();
    fitToViewport();
    vv?.addEventListener('resize', fitToViewport);
    vv?.addEventListener('scroll', fitToViewport);
  } else {
    keep();
    vv?.removeEventListener('resize', fitToViewport);
    vv?.removeEventListener('scroll', fitToViewport);
    // Hand the position back to the stylesheet, so a resize while closed
    // cannot leave it pinned where a keyboard once was.
    pop.style.top = '';
    pop.style.maxHeight = '';
  }
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
    keep();
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

// The last shared link this browser opened, by fingerprint.
const SEEN_KEY = 'motionmuse-shared-seen';

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
    // A named link is a named configuration. Whoever sent it already said what
    // this is, and without keeping it the setup is yours only until you touch a
    // slider — there would be no way back to what arrived short of finding the
    // QR code again. Stored before the reload below, because localStorage is
    // what survives it.
    const kept = saveConfig(data.label, shareableSnapshot(data));
    if (kept) setCurrentConfig(kept.name);
    // Is this the first time this particular link has been followed? Only a
    // first open is worth a tour: reopening a pinned QR, or reloading, lands
    // you on a setup that is already yours.
    const fp = shareFingerprint(payload);
    const first = lsGet(SEEN_KEY) !== fp;
    lsSet(SEEN_KEY, fp);
    // Carried across the reload below, because the toast that announces the
    // setup happens on the far side of it. Re-cleaned rather than trusted:
    // this string came out of somebody else's URL.
    sessionStorage.setItem('motionmuse-shared',
      JSON.stringify({ label: cleanShareLabel(data.label), first }));
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
// Returns what just arrived, or null — main.js uses it to decide whether the
// setup is new enough to be worth a tour.
export function announceSharedLink() {
  const mark = sessionStorage.getItem('motionmuse-shared');
  if (!mark) return null;
  sessionStorage.removeItem('motionmuse-shared');
  let opened;
  try { opened = JSON.parse(mark); } catch { opened = { label: '', first: true }; }
  const label = cleanShareLabel(opened?.label);
  toast(label ? `Opened: ${label}` : 'Opened a shared setup');
  return { label, first: opened?.first !== false };
}
