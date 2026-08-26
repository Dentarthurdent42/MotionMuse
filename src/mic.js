// Microphone input — the first non-camera signal source.
//
// Everything else on the bus comes from vision, which means MotionMuse has one
// sense. That is a real limit: sound is the fastest thing a body produces, it
// works in the dark, it works with the camera off, and it works for someone who
// cannot hold a pose in front of a lens. The mic is also the only input here
// with no latency budget spent on inference — an FFT is microseconds.
//
// Four signals, chosen because each answers a different musical question and
// none of them is "the waveform":
//
//   mic_level   how loud you are          → dynamics, gating, swells
//   mic_pitch   what note you are on      → melody by voice, harmoniser
//   mic_clarity is it a pitch or a noise  → the gate for mic_pitch
//   mic_bright  timbre, dark → bright     → filter, morphing
//
// Its own AudioContext, deliberately: analysis has to work before the synth is
// started and while it is muted, and coupling to engine's context would make
// "can I hear my voice drive the filter" depend on whether the synth happens to
// be running.
//
// The stream is never connected to any output. It is analysed and discarded —
// nothing is recorded, nothing is uploaded, and routing it to the speakers
// would feed back into itself.

import { bus } from './bus.js';

// The pitch range worth tracking: MIDI 36..96 is the same C2..C7 the keyboard
// draws, so mic_pitch normalises onto exactly what the UI can show.
const PITCH_LO = 36, PITCH_HI = 96;
const midiOfHz = hz => 69 + 12 * Math.log2(hz / 440);

// Pitch via the normalised square difference function (McLeod). Plain
// autocorrelation does not work here and the failure is instructive: r(lag)
// falls off with lag simply because fewer samples overlap, so normalising by
// the overlap over-corrects and the global maximum lands on a SUBHARMONIC —
// the first version of this returned 88Hz for a 440Hz tone, a fifth of the
// real pitch, and 73Hz for 220Hz. Both are "a peak", just the wrong one.
//
// NSDF is bounded to [-1, 1] regardless of lag, so peaks are comparable, and
// the fundamental is then the FIRST peak within 90% of the best rather than the
// tallest — which is what stops a strong 2nd harmonic from pulling the answer
// up an octave. Both cases are covered in tests/unit/mic-pitch.test.js.
//
// Cost is O(lags x window) ≈ 1.4M multiply-adds per frame, ~1-2ms, and only
// while the mic is on. An FFT-based version would be faster and is the obvious
// move if this ever shows up in a frame budget.
//
// Returns { hz, clarity }: clarity is the peak height, which is what separates
// a sung note from a consonant or a room. Below ~0.5 there is no pitch there
// and the caller must not pretend otherwise.
export function detectPitch(buf, sampleRate) {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.008) return { hz: 0, clarity: 0 };      // silence: nothing to find

  const loLag = Math.max(2, Math.floor(sampleRate / 2093));   // ~C7
  const hiLag = Math.min(Math.floor(sampleRate / 65), n - 2); // ~C2
  if (hiLag <= loLag) return { hz: 0, clarity: 0 };

  const nsdf = new Float32Array(hiLag + 2);
  let peak = 0;
  for (let lag = loLag; lag <= hiLag; lag++) {
    let ac = 0, m = 0;
    for (let i = 0; i < n - lag; i++) {
      ac += buf[i] * buf[i + lag];
      m  += buf[i] * buf[i] + buf[i + lag] * buf[i + lag];
    }
    nsdf[lag] = m > 0 ? (2 * ac) / m : 0;
    if (nsdf[lag] > peak) peak = nsdf[lag];
  }
  if (peak <= 0) return { hz: 0, clarity: 0 };

  // First peak within 90% of the best — see the note above.
  const thresh = 0.9 * peak;
  let bestLag = -1;
  for (let lag = loLag + 1; lag < hiLag; lag++) {
    if (nsdf[lag] > nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1] && nsdf[lag] >= thresh) {
      bestLag = lag; break;
    }
  }
  if (bestLag < 0) return { hz: 0, clarity: 0 };

  // Parabolic interpolation: without it the tracker quantises to whole samples,
  // which near the top of the range is most of a semitone.
  const y0 = nsdf[bestLag - 1], y1 = nsdf[bestLag], y2 = nsdf[bestLag + 1];
  const denom = 2 * (2 * y1 - y0 - y2);
  const shift = denom !== 0 ? (y2 - y0) / denom : 0;
  const lag = bestLag + Math.max(-1, Math.min(1, shift));

  return { hz: sampleRate / lag, clarity: Math.max(0, Math.min(1, y1)) };
}

export const micSource = (() => {
  let ctx = null, analyser = null, stream = null, node = null;
  let timeBuf = null, freqBuf = null;
  let active = false, registered = false, lastLevel = 0;

  const G = 'Microphone';
  function registerSignals() {
    if (registered) return;
    registered = true;
    // `adapt` on level and brightness: a phone mic in a quiet room and a laptop
    // mic in a loud one occupy completely different parts of the range, and a
    // fixed mapping would make one of them unusable. Pitch is NOT adaptive —
    // its scale is musical, not relative, and a self-calibrating pitch axis
    // would mean the same note moved as you sang.
    // Rates of change here are the attack of a note, the speed of a slide and
    // the sweep of a timbre — all things a player shapes deliberately. Clarity
    // is left alone: it reports how much to trust the pitch, and how fast that
    // trust is changing is a diagnostic, not something to play.
    bus.register('mic_level',   { velocity: true, label: 'Mic Level',      group: G, min: 0, max: 1, source: 'mic', smooth: true, adapt: true });
    bus.register('mic_pitch',   { velocity: true, label: 'Mic Pitch',      group: G, min: 0, max: 1, source: 'mic', smooth: { minCutoff: 2.0, beta: 0.3 } });
    bus.register('mic_clarity', { label: 'Mic Clarity',    group: G, min: 0, max: 1, source: 'mic', smooth: true });
    bus.register('mic_bright',  { velocity: true, label: 'Mic Brightness', group: G, min: 0, max: 1, source: 'mic', smooth: true, adapt: true });
  }

  return {
    get active() { return active; },
    get supported() { return !!navigator.mediaDevices?.getUserMedia; },

    async start() {
      if (active) return true;
      registerSignals();
      // The processing defaults are all wrong for an instrument: AGC fights
      // exactly the dynamics mic_level exists to capture, and noise suppression
      // is tuned to remove everything that is not speech — which includes
      // whistling, humming and any instrument you play at it.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.15;
      node = ctx.createMediaStreamSource(stream);
      node.connect(analyser);        // and nowhere else — never to destination
      timeBuf = new Float32Array(analyser.fftSize);
      freqBuf = new Uint8Array(analyser.frequencyBinCount);
      active = true;
      return true;
    },

    stop() {
      active = false;
      try { node?.disconnect(); } catch { /* already gone */ }
      stream?.getTracks().forEach(t => t.stop());
      ctx?.close().catch(() => {});
      ctx = analyser = stream = node = null;
      // Leave the signals registered and resting at zero: a cable wired to
      // mic_level should still be there when the mic comes back, and dropping
      // the signal would silently delete the user's mapping.
      for (const k of ['mic_level', 'mic_pitch', 'mic_clarity', 'mic_bright']) bus.update(k, 0);
    },

    async toggle() { return active ? (this.stop(), false) : this.start().then(() => true); },

    // Called every frame from main.js. Cheap no-op when the mic is off.
    tick(tMs) {
      if (!active || !analyser) return;
      analyser.getFloatTimeDomainData(timeBuf);
      analyser.getByteFrequencyData(freqBuf);

      // Level: RMS in dB, mapped from a -60 dB floor. Linear RMS spends most of
      // its range on the loudest tenth and reads as an on/off switch.
      let sum = 0;
      for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
      const rms = Math.sqrt(sum / timeBuf.length);
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      lastLevel = Math.max(0, Math.min(1, (db + 60) / 60));
      bus.update('mic_level', lastLevel, tMs);

      // Spectral centroid → brightness.
      let num = 0, den = 0;
      for (let i = 0; i < freqBuf.length; i++) { num += i * freqBuf[i]; den += freqBuf[i]; }
      const centroid = den > 0 ? num / den / freqBuf.length : 0;
      bus.update('mic_bright', Math.min(1, centroid * 3), tMs);

      const { hz, clarity } = detectPitch(timeBuf, ctx.sampleRate);
      bus.update('mic_clarity', clarity, tMs);
      // Hold the last pitch through unvoiced moments rather than snapping to
      // zero: consonants and bow changes would otherwise drop a melody line to
      // the bottom of the range several times a second.
      if (hz > 0 && clarity > 0.5) {
        const m = midiOfHz(hz);
        bus.update('mic_pitch',
          Math.max(0, Math.min(1, (m - PITCH_LO) / (PITCH_HI - PITCH_LO))), tMs);
      }
    },

    // For the panel readout.
    get level() { return lastLevel; },
  };
})();
