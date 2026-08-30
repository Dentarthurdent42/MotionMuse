// The iPhone Ring/Silent switch, and why it silenced the whole instrument.
//
// iOS gives every page an *audio session category*, and WebKit picks that
// category from what the page plays rather than from anything the page asks
// for. A page whose only sound is Web Audio gets **ambient** — the category
// meant for incidental noise, a game's bleeps or a video autoplaying in a
// feed — and ambient obeys the Ring/Silent switch. A page playing a media
// element with a real, unmuted audio track gets **playback**, the category
// for something a person came here to listen to, and playback ignores the
// switch.
//
// MotionMuse is Web Audio end to end and had no media element, so it landed
// in ambient: with the switch flipped the instrument was completely silent,
// with nothing on screen to explain it. Screen recordings still had sound,
// which is what made it read as a phone bug rather than ours — the recorder
// taps app audio upstream of the category.
//
// The fix is the door WebKit leaves open: while the instrument is audible,
// keep a silent, looping, UNMUTED audio element playing. That moves the page
// to playback and the switch stops applying to it. It has to be genuinely
// silent rather than muted — a muted element does not count as playing audio
// and would leave the category exactly where it started — so what loops is a
// buffer of digital silence.
//
// Held only while UNMUTED, and released on mute. A page in the playback
// category stops whatever the phone was already playing, and taking someone's
// music away the moment they open a page that is not making any sound yet
// would be a worse bug than the one this fixes.

// ── Who needs it ──────────────────────────────────────────────────────────
//
// iOS only. On Android a playing media element takes audio focus, which
// pauses the user's music for as long as it is held; on the desktop it can
// raise OS media controls for a track that does not exist. Neither platform
// has a Ring/Silent switch to work around, so neither pays for one.
//
// iPadOS reports itself as MacIntel and hides "iPad" from the agent string,
// so the platform test alone misses it. A Mac with a touchscreen does not
// exist, which is what makes maxTouchPoints the tiebreak. Arguments rather
// than direct reads of `navigator`, so the matrix is unit-testable.
export const needsPlaybackSession = (
  ua = navigator.userAgent,
  platform = navigator.platform,
  touchPoints = navigator.maxTouchPoints,
) => /iP(hone|ad|od)/.test(ua) || (platform === 'MacIntel' && touchPoints > 1);

// ── A file of silence ─────────────────────────────────────────────────────
//
// Half a second of 16-bit mono PCM at 8 kHz: 44 bytes of header and 8000
// zeroes. Built here rather than shipped as an asset or pasted in as base64
// because a reader can check these fields against the WAV spec, and cannot
// check a blob of base64 at all. It also keeps the precache list honest —
// there is no binary to forget to add to it.
//
// SIXTEEN-bit specifically: 16-bit PCM silence is 0, so an untouched buffer
// is already silent. Eight-bit PCM is unsigned with silence at 128, where an
// all-zero buffer is full-scale DC — a click on every loop, or a DC offset
// held against the speaker for as long as the page is open.
const RATE = 8000;
const SECONDS = 0.5;

export function silentWav() {
  const samples = RATE * SECONDS;
  const buf = new ArrayBuffer(44 + samples * 2);
  const w = new DataView(buf);
  const ascii = (at, s) => [...s].forEach((c, i) => w.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  w.setUint32(4, 36 + samples * 2, true);   // everything after this field
  ascii(8, 'WAVEfmt ');
  w.setUint32(16, 16, true);                // fmt chunk length
  w.setUint16(20, 1, true);                 // format: PCM
  w.setUint16(22, 1, true);                 // channels: mono
  w.setUint32(24, RATE, true);
  w.setUint32(28, RATE * 2, true);          // byte rate
  w.setUint16(32, 2, true);                 // block align
  w.setUint16(34, 16, true);                // bits per sample
  ascii(36, 'data');
  w.setUint32(40, samples * 2, true);
  return buf;                               // the samples are already zero
}

// ── The hold ──────────────────────────────────────────────────────────────
let el = null;
let held = false;

function element() {
  if (el) return el;
  el = document.createElement('audio');
  el.src = URL.createObjectURL(new Blob([silentWav()], { type: 'audio/wav' }));
  el.loop = true;
  el.preload = 'auto';
  // Full volume, playing nothing. `muted`, or volume 0, would be a different
  // thing entirely: the category follows whether an audio track is playing,
  // not how loud it is, and a muted element does not move it.
  el.volume = 1;
  el.setAttribute('playsinline', '');
  // Positioned off-screen rather than display:none — a media element a
  // browser considers hidden is one it is entitled to decline to play.
  el.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  // iOS pauses it for an interruption — a call, another app taking audio —
  // and does not start it again afterwards. Returning to the tab is the
  // reliable moment to ask, and asking when it never stopped costs nothing.
  document.addEventListener('visibilitychange', () => {
    if (held && !document.hidden) el.play().catch(() => {});
  });
  return el;
}

export const audioSession = {
  // Call from a user gesture. This is a media play() and the autoplay policy
  // applies to it exactly as it does to any other — which is why it hangs off
  // unmuting, an act the user has to perform, rather than off page load.
  hold() {
    if (!needsPlaybackSession()) return false;
    held = true;
    element().play().catch(() => { /* no gesture yet, or the tab is hidden */ });
    return true;
  },
  release() {
    held = false;
    el?.pause();
  },
  get held() { return held; },
  // For tests: whether the element exists at all, without reaching into the
  // document for an element that deliberately has no id or class.
  get element() { return el; },
};
