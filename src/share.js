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
import { mapper } from './mapper.js';
import { isString, isRecord } from './is.js';
import { BASE_B } from './sharebase.js';

export const SHARE_PARAM = 's';

// UI keys that travel. Everything else in `ui` is geometry — see above.
//
// `tracking` and `face` are which MODELS are running — hands (per side), pose,
// face and gaze. They belong in a shared setup because a patch wired to
// `brow_raise` is silent without the face model: handing someone the mapping
// without the tracker that feeds it hands them an instrument that does
// nothing. The pose MODEL choice stays out, for the reason at the top of this
// file — that is a judgement about one machine's GPU, not about the music.
// `hotkeys`, `uicontrol` and the three `pedal*` keys are here for the same
// reason `tracking` is: they are how the setup is PLAYED, not what screen it
// was arranged on. A patch whose looper is driven by a nod at a tuned
// sensitivity, or whose author expects you to drive the panel with your hands,
// arrives unplayable without them — which is the same failure as handing
// someone a mapping without the tracker that feeds it.
const SHARE_UI_KEYS = ['theme', 'tracking', 'face', 'dev', 'hotkeys', 'uicontrol',
                       'pedalSrc', 'pedalSens', 'pedalOn'];

export function shareableSnapshot(snap = snapshot()) {
  const ui = {};
  for (const k of SHARE_UI_KEYS) if (snap.ui?.[k] !== undefined) ui[k] = snap.ui[k];
  return { ...snap, ui };
}

// ── The sharer's own description ─────────────────────────────────────────
//
// A QR code is opaque: a photo of one says nothing about the setup behind it,
// so a screen showing three of them is three identical squares. The sharer
// gets a line to say what this one is ("ambient pads, left hand opens the
// filter"), which shows on the screen beside the code and travels inside the
// link, so whoever opens it is told what they just loaded.
//
// Capped, because every character is more payload and payload is QR modules —
// a description long enough to need scrolling is long enough to push the code
// into a denser version that is harder to scan.
export const SHARE_LABEL_MAX = 80;

// Collapsed to a single line: the payload is JSON in a URL fragment, and a
// newline in the middle of it buys nothing a space does not.
export const cleanShareLabel = text =>
  String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, SHARE_LABEL_MAX);

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
// readable if this ever gains another format:
//   'b' = deflate-raw of the DIFFERENCE from a frozen baseline (src/sharebase.js)
//   'd' = deflate-raw of the whole snapshot (every link made before 'b')
//   'j' = plain JSON bytes (the fallback where CompressionStream is missing)
// A letter, once shipped, means that packing forever — printed codes use it,
// and so does every setup tag in a posted recording. A new packing (a new
// baseline, say) takes a new letter, and a baseline can never be edited under
// the same one. What is INSIDE the JSON is versioned separately, by `v`
// (src/presetformat.js).
//
// 'b' exists because most of a snapshot is the defaults. Sending only what
// differs from the Hands patch took a typical setup from ~1 KB to ~250 bytes —
// a QR code several versions smaller, and a tag small enough to leave on the
// picture.
export async function encodeState(state) {
  const json = new TextEncoder().encode(JSON.stringify(state));
  if (!hasCompression()) return 'j' + toB64(json);
  return 'b' + toB64(await packB(state));
}

const packB = async state => pipe(new CompressionStream('deflate-raw'),
  new TextEncoder().encode(JSON.stringify(diffFrom(BASE_B, state) ?? {})));

export async function decodeState(payload) {
  if (!isString(payload) || payload.length < 2) throw new Error('empty share link');
  const kind = payload[0];
  const bytes = fromB64(payload.slice(1));
  if (kind === 'j') return JSON.parse(new TextDecoder().decode(bytes));
  if (kind !== 'd' && kind !== 'b') throw new Error('unrecognised share link');
  if (!hasCompression()) throw new Error('this browser cannot read compressed share links');
  const parsed = JSON.parse(new TextDecoder().decode(
    await pipe(new DecompressionStream('deflate-raw'), bytes)));
  return kind === 'b' ? mergeOnto(BASE_B, parsed) : parsed;
}

// The same thing as raw bytes — the letter's char code, then the packed body —
// for a carrier that is not a URL and so has no reason to pay base64's third.
// The setup tag (src/densecode.js) carries exactly these.
export async function encodeStateBytes(state) {
  const body = hasCompression() ? await packB(state)
                                : new TextEncoder().encode(JSON.stringify(state));
  const out = new Uint8Array(body.length + 1);
  out[0] = (hasCompression() ? 'b' : 'j').charCodeAt(0);
  out.set(body, 1);
  return out;
}

export const decodeStateBytes = bytes => {
  if (!bytes || bytes.length < 2) throw new Error('empty setup code');
  return decodeState(String.fromCharCode(bytes[0]) + toB64(bytes.subarray(1)));
};

// ── The difference from the baseline ─────────────────────────────────────
//
// Objects are compared key by key, recursively; anything else — numbers,
// strings, ARRAYS — is either equal or sent whole. (Arrays whole because their
// elements have no names: a mapping list that gained an entry at the front is
// not usefully "the same list, shifted".) A key the baseline has and the state
// does not is listed under DELETED, a key no snapshot can contain.
const DELETED = '\u0000';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function diffFrom(base, state) {
  if (same(base, state)) return undefined;
  if (!isRecord(base) || !isRecord(state)) return state;
  const out = {};
  for (const k of Object.keys(state)) {
    const d = diffFrom(base[k], state[k]);
    if (d !== undefined) out[k] = d;
  }
  const gone = Object.keys(base).filter(k => !(k in state));
  if (gone.length) out[DELETED] = gone;
  return out;
}

export function mergeOnto(base, diff) {
  if (!isRecord(diff)) return structuredClone(diff);
  if (!isRecord(base)) return mergeOnto({}, diff);
  const out = structuredClone(base);
  for (const k of Array.isArray(diff[DELETED]) ? diff[DELETED] : []) delete out[k];
  for (const [k, v] of Object.entries(diff)) {
    if (k !== DELETED) out[k] = mergeOnto(base[k], v);
  }
  return out;
}

// ── What the setup tag carries ────────────────────────────────────────────
//
// The setup as shared, minus the one thing that moves while you play: the
// value of every parameter a cable is driving. Those are rewritten every frame
// from the signal, so the number in the snapshot is wherever your hand
// happened to be — meaningless to whoever loads it (the cable takes the
// parameter over again at once), and fatal to a code that is meant to sit
// still on screen: it would redraw itself every second of a performance. They
// are sent as the baseline's value, which the diff then drops, or left out.
export function tagState(snap = snapshot(), label = '') {
  const state = shareableSnapshot(snap);
  const params = state.audio?.params;
  if (isRecord(params)) {
    const steady = { ...params };
    const baseParams = BASE_B.audio.params;
    for (const m of mapper.serialize()) {
      if (!(m.audioParam in steady)) continue;
      if (m.audioParam in baseParams) steady[m.audioParam] = baseParams[m.audioParam];
      else delete steady[m.audioParam];
    }
    state.audio = { ...state.audio, params: steady };
  }
  const described = cleanShareLabel(label);
  if (described) state.label = described;
  return state;
}

// ── Have we opened this one before? ──────────────────────────────────────
//
// A link is worth explaining the first time it is followed and not after. Open
// the same QR twice — because it is pinned to a wall, or because you reloaded
// — and the setup is already yours; a tour of it is something to dismiss.
//
// A fingerprint rather than the payload itself: the payload is most of a
// kilobyte and this only ever has to answer "the same one again?".
export const shareFingerprint = payload => {
  // FNV-1a, 32-bit. Not a security hash — a collision here costs one tour that
  // did not open, which is the same thing that happens on purpose.
  let h = 0x811c9dc5;
  const t = String(payload ?? '');
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
};

// ── URLs ──────────────────────────────────────────────────────────────────
//
// A QR code is a URL frozen into a picture. Once it is printed, pinned to a
// wall or photographed, nothing can update it — so the address it points at
// has to be one that will still be answering in years, not wherever the
// sharer happened to be.
//
// Building it from `location` used to mean exactly that: a code made on a
// Netlify deploy preview, on a Cloudflare mirror, or on /index.html instead of
// the bare path pointed there forever, and died with it. Every code now points
// at the one address that is kept alive. If the app ever moves, THIS is the
// URL that has to keep redirecting, fragment intact.
export const SHARE_BASE = 'https://dentarthurdent42.github.io/MotionMuse/';

// …except while developing. A link made on localhost or a LAN address (the
// phone-testing server in scripts/mobile-serve.mjs) is being made to test
// THIS build, and sending it to production would test the wrong one.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/;

function shareBase(here) {
  if (here === undefined) return SHARE_BASE;
  const u = new URL(here);
  if (u.protocol === 'file:' || LOCAL_HOST.test(u.hostname)) {
    u.hash = '';
    u.search = '';
    return u.href;
  }
  return SHARE_BASE;
}

export function shareUrl(payload, here = globalThis.location?.href) {
  return `${shareBase(here).replace(/[?#]$/, '')}#${SHARE_PARAM}=${payload}`;
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
