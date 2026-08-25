// Share a setup as a link — and therefore as a QR code someone can point a
// phone at.
//
// The whole state is compressed and carried in the URL *fragment*. The fragment
// is deliberate: it is never sent to a server, so a shared setup stays between
// the two people holding the phones, and this app has no server anyway.
//
// What is shared is the instrument, not the window. Panel widths, section
// heights, section order and which column a section was dragged to describe the
// screen it was arranged on, and pushing a phone's layout onto a laptop (or the
// reverse) is not "the same settings". The pose-model choice goes the same way:
// a MoveNet variant picked for one machine's GPU is not a recommendation for
// someone else's.

import { snapshot } from './preset.js';
import { isString } from './is.js';

export const SHARE_PARAM = 's';

// UI keys that travel. Everything else in `ui` is geometry — see above.
const SHARE_UI_KEYS = ['theme', 'tracking', 'dev'];

export function shareableSnapshot(snap = snapshot()) {
  const ui = {};
  for (const k of SHARE_UI_KEYS) if (snap.ui?.[k] !== undefined) ui[k] = snap.ui[k];
  return { ...snap, ui };
}

// ── base64url ─────────────────────────────────────────────────────────────
// URL-safe and unpadded, so the payload survives a fragment without escaping —
// percent-encoding would inflate it by ~30% and cost QR versions.
const toB64 = u8 => {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = str => {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const u8 = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
  return u8;
};

const hasCompression = () => globalThis.CompressionStream !== undefined
                          && globalThis.DecompressionStream !== undefined;

async function pipe(stream, bytes) {
  const w = stream.writable.getWriter();
  w.write(bytes);
  w.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

// A one-character prefix says how the rest is packed, so an old link stays
// readable if this ever gains another format: 'd' = deflate-raw, 'j' = plain
// JSON bytes (the fallback where CompressionStream is missing).
export async function encodeState(state) {
  const json = new TextEncoder().encode(JSON.stringify(state));
  if (!hasCompression()) return 'j' + toB64(json);
  return 'd' + toB64(await pipe(new CompressionStream('deflate-raw'), json));
}

export async function decodeState(payload) {
  if (!isString(payload) || payload.length < 2) throw new Error('empty share link');
  const kind = payload[0];
  const bytes = fromB64(payload.slice(1));
  let json;
  if (kind === 'j') json = bytes;
  else if (kind === 'd') {
    if (!hasCompression()) throw new Error('this browser cannot read compressed share links');
    json = await pipe(new DecompressionStream('deflate-raw'), bytes);
  } else throw new Error('unrecognised share link');
  return JSON.parse(new TextDecoder().decode(json));
}

// ── URLs ──────────────────────────────────────────────────────────────────
export function shareUrl(payload, base) {
  const u = new URL(base ?? (globalThis.location !== undefined ? location.href : 'https://localhost/'));
  u.hash = '';
  u.search = '';
  return `${u.href.replace(/[?#]$/, '')}#${SHARE_PARAM}=${payload}`;
}

// The payload in a URL, or null. Tolerant of extra fragment content so a link
// that has been through a chat app's mangling still opens.
export function readShareUrl(href) {
  const hash = String(href ?? '').split('#').slice(1).join('#');
  if (!hash) return null;
  for (const part of hash.split('&')) {
    const [k, ...v] = part.split('=');
    if (k === SHARE_PARAM && v.length) return v.join('=');
  }
  return null;
}

// How dense the resulting QR will be, so the UI can warn before showing
// something no camera will read rather than after. Versions are 1-40; past
// about 25 a code shown on one phone screen and read by another starts to fail.
export const QR_COMFORTABLE_VERSION = 25;
