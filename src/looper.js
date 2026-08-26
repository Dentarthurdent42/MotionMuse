// A loop pedal.
//
// Play a phrase, drop it, and it repeats under you while you play the next one
// over the top. What is recorded is the AUDIO — the master bus, exactly as you
// heard it — rather than your motion, so a loop sounds the same in every mode
// the app has and layering is simply mixing. (Recording the motion instead
// would let a loop follow a key change, which is tempting; it also means two
// layers both driving `hand_L_y` fight over one oscillator, which is not a
// loop pedal, it is a race.)
//
// ── The transport ────────────────────────────────────────────────────────
//
//   empty  ──pedal──▶  recording  ──pedal──▶  playing  ──pedal──▶ overdubbing
//                                                ▲                     │
//                                                └────────pedal────────┘
//
// One control does the whole cycle, because a pedal has one switch. STOP and
// CLEAR are on the panel: they end things, and ending something by the same
// motion that starts it is how you lose a take.
//
// ── Why layers stay separate ─────────────────────────────────────────────
//
// Each pass is kept as its own buffer and mixed on demand. Bouncing straight
// into one buffer would halve the bookkeeping and make UNDO impossible, and a
// looper you cannot undo is one where the fourth pass costs you the first
// three.

import { engine } from './engine.js';

export const LOOP_STATES = ['empty', 'recording', 'playing', 'overdubbing', 'stopped'];

// A ceiling on both, because this is uncompressed float audio in memory:
// 30 s of stereo at 48 kHz is ~11 MB per layer, so eight layers is ~90 MB and
// that is already more than a phone will thank you for.
export const MAX_LOOP_SECONDS = 30;
export const MAX_LAYERS = 8;

// Below this there is no phrase, only a click — and a loop that short would
// spin fast enough to sound like a tone rather than a repeat.
export const MIN_LOOP_SECONDS = 0.25;

// Mix `layers` (each exactly `frames` long) down to one buffer for playback.
// Exported for its own test: the wrap arithmetic below is the part of this
// module that is easy to get subtly, unlistenably wrong.
export function mixLayers(ctx, layers, frames, channels) {
  if (!frames) return null;
  const out = ctx.createBuffer(channels, frames, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const dst = out.getChannelData(c);
    for (const buf of layers) {
      const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
      for (let i = 0; i < frames; i++) dst[i] += src[i];
    }
  }
  return out;
}

// Write a captured pass into a loop-length buffer at the phase it was played
// at, wrapping past the end.
//
// This is what makes an overdub land where you played it. Recording starts the
// instant the pedal goes down, which is somewhere in the middle of the loop —
// so the samples belong at THAT offset, and anything past the loop point
// belongs back at the start. Dropped straight in at zero, every overdub would
// slide to the top of the bar and the layers would drift apart.
export function wrapIntoLoop(ctx, chunks, frames, channels, offsetFrames) {
  // Zero frames is not a buffer the Web Audio API will make, so a pass that
  // captured nothing has to be caught here rather than allocated and then
  // checked.
  if (!frames) return null;
  const out = ctx.createBuffer(channels, frames, ctx.sampleRate);
  const start = ((offsetFrames % frames) + frames) % frames;
  for (let c = 0; c < channels; c++) {
    const dst = out.getChannelData(c);
    let w = start;
    for (const chunk of chunks) {
      const src = chunk[Math.min(c, chunk.length - 1)];
      if (!src) continue;
      for (let i = 0; i < src.length; i++) {
        dst[w] += src[i];
        if (++w >= frames) w = 0;
      }
    }
  }
  return out;
}

export const looper = (() => {
  let state = 'empty';
  let node = null;          // AudioWorkletNode | ScriptProcessorNode
  let sink = null;          // silent pump for the ScriptProcessor fallback
  let chunks = [];          // Float32Array[][] captured since the pedal went down
  let capturedFrames = 0;
  let channels = 2;

  let layers = [];          // one AudioBuffer per pass, all `frames` long
  let frames = 0;           // the loop's length, in samples
  let source = null;        // the single looping BufferSource
  let loopStartedAt = 0;    // ctx time the current playback pass began
  let recStartedAt = 0;     // ctx time the pedal went down for this pass
  let unsupported = '';     // why capture is unavailable, if it is

  const listeners = new Set();
  const emit = () => listeners.forEach(fn => fn(snapshot()));

  const io = () => engine.loopIO();
  const secs = () => (frames && io() ? frames / io().ctx.sampleRate : 0);

  function snapshot() {
    return {
      state, layers: layers.length, seconds: secs(),
      full: layers.length >= MAX_LAYERS, unsupported,
      // Where the playhead is, 0–1, for a progress ring. Meaningless when
      // stopped, so it reads 0 rather than wherever it happened to freeze.
      get position() {
        const c = io();
        if (!c || !frames || (state !== 'playing' && state !== 'overdubbing')) return 0;
        return ((c.ctx.currentTime - loopStartedAt) % secs()) / secs();
      },
    };
  }

  // ── Capture ────────────────────────────────────────────────────────────
  async function ensureNode() {
    const c = io();
    if (!c || node) return !!node;
    try {
      if (c.ctx.audioWorklet) {
        // The URL is resolved against THIS module rather than the page, so the
        // worklet is found whether the app is served from / or a project
        // subpath — the same reason the service worker derives its base from
        // its own scope.
        await c.ctx.audioWorklet.addModule(new URL('./loop-recorder.worklet.js', import.meta.url));
        node = new AudioWorkletNode(c.ctx, 'loop-recorder',
          { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = e => take(e.data);
      } else {
        // Older Safari. Deprecated and it runs on the main thread, but a
        // looper that simply does not exist there is worse than one that
        // occasionally glitches under load.
        node = c.ctx.createScriptProcessor(4096, 2, 2);
        node.onaudioprocess = e => {
          if (state !== 'recording' && state !== 'overdubbing') return;
          const b = e.inputBuffer;
          take(Array.from({ length: b.numberOfChannels }, (_, i) => new Float32Array(b.getChannelData(i))));
        };
        // A ScriptProcessorNode with nothing downstream is not pulled at all in
        // several browsers, so it gets a silent path to the destination.
      }
      // Both capture nodes need a path to the destination, and this is not
      // optional or defensive: a node the graph cannot reach from the output is
      // never pulled, so `process()` is never called and the loop records
      // silence. The gain is zero, so the path costs nothing audible — it
      // exists purely to make the node live.
      sink = c.ctx.createGain(); sink.gain.value = 0;
      node.connect(sink); sink.connect(c.ctx.destination);
      c.tap.connect(node);
      return true;
    } catch (err) {
      unsupported = err?.message || 'audio capture unavailable';
      node = null;
      emit();
      return false;
    }
  }

  function take(chanArrays) {
    if (!chanArrays?.length) return;
    // A pass longer than the ceiling stops growing rather than being thrown
    // away: what you played up to the limit is still a loop.
    const c = io();
    if (!c || capturedFrames >= MAX_LOOP_SECONDS * c.ctx.sampleRate) return;
    channels = Math.max(1, Math.min(2, chanArrays.length));
    chunks.push(chanArrays);
    capturedFrames += chanArrays[0].length;
  }

  // Arming clears; disarming does NOT. Clearing on the way down would throw
  // away the pass at exactly the moment it is finished and about to be read —
  // which is what it did, silently, and the loop came out empty every time.
  const arm = on => {
    if (on) { chunks = []; capturedFrames = 0; }
    node?.port?.postMessage({ on });
  };

  // ── Playback ───────────────────────────────────────────────────────────
  //
  // One source for the whole mix, restarted whenever the layer list changes.
  // Restarting is what keeps every layer in phase: they are all exactly one
  // loop long and they all begin at the same instant, so there is no drift to
  // accumulate in the first place.
  function play(atPhase = 0) {
    const c = io();
    stopSource();
    if (!c || !layers.length || !frames) return;
    const buf = mixLayers(c.ctx, layers, frames, channels);
    if (!buf) return;
    source = c.ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;
    source.connect(c.sum);
    const offset = atPhase * secs();
    source.start(c.ctx.currentTime, offset);
    loopStartedAt = c.ctx.currentTime - offset;
  }

  function stopSource() {
    try { source?.stop(); } catch { /* already stopped */ }
    source?.disconnect();
    source = null;
  }

  // Fold the pass just captured into a layer, phase-aligned to the loop.
  function commitPass() {
    const c = io();
    if (!c || !frames || !chunks.length || layers.length >= MAX_LAYERS) { arm(false); return; }
    const offset = Math.round((recStartedAt - loopStartedAt) * c.ctx.sampleRate);
    const layer = wrapIntoLoop(c.ctx, chunks, frames, channels, offset);
    if (layer) layers.push(layer);
    arm(false);
  }

  return {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },
    snapshot,

    // One motion, the whole cycle. Async because the first press is what builds
    // the capture node — nothing is loaded until somebody actually loops.
    async pedal() {
      const c = io();
      if (!c) return state;                      // no audio yet; nothing to record
      if (!(await ensureNode())) return state;

      unsupported = '';
      if (state === 'empty' || state === 'stopped') {
        if (state === 'stopped' && layers.length) {   // resume rather than re-record
          state = 'playing';
          play(0);
          emit();
          return state;
        }
        recStartedAt = c.ctx.currentTime;
        state = 'recording';
        arm(true);
      } else if (state === 'recording') {
        const len = c.ctx.currentTime - recStartedAt;
        arm(false);
        if (len < MIN_LOOP_SECONDS) {            // a stab, not a phrase
          state = 'empty';
          emit();
          return state;
        }
        // The wall clock says how long the pedal was down; the capture says how
        // much audio actually arrived. Trust the shorter — a loop longer than
        // its own audio ends in a gap that was never played.
        frames = Math.min(Math.round(len * c.ctx.sampleRate), capturedFrames);
        const first = frames ? wrapIntoLoop(c.ctx, chunks, frames, channels, 0) : null;
        chunks = [];
        if (!first) {
          // Nothing was captured — no audio engine output, or the capture node
          // never came alive. Fail back to empty rather than into a state whose
          // only exit is CLEAR.
          frames = 0;
          state = 'empty';
          unsupported = 'nothing was captured — is the audio running?';
          emit();
          return state;
        }
        // The first pass defines the loop, so it starts at phase zero and the
        // clock starts with it.
        loopStartedAt = c.ctx.currentTime;
        layers.push(first);
        state = 'playing';
        play(0);
      } else if (state === 'playing') {
        if (layers.length >= MAX_LAYERS) return state;
        recStartedAt = c.ctx.currentTime;
        state = 'overdubbing';
        arm(true);
      } else if (state === 'overdubbing') {
        // Keep the phase across the restart: a loop that jumped back to its
        // top every time you closed an overdub would stutter on every pass.
        const phase = snapshot().position;
        commitPass();
        state = 'playing';
        play(phase);
      }
      emit();
      return state;
    },

    stop() {
      if (state === 'overdubbing') commitPass();
      arm(false);
      stopSource();
      state = layers.length ? 'stopped' : 'empty';
      emit();
      return state;
    },

    clear() {
      arm(false);
      stopSource();
      layers = [];
      frames = 0;
      chunks = [];
      capturedFrames = 0;
      state = 'empty';
      emit();
      return state;
    },

    // Drop the last pass. The loop keeps playing minus that layer, at the phase
    // it had reached — undoing a wrong note should not also restart the bar.
    undo() {
      if (!layers.length) return state;
      const phase = snapshot().position;
      if (state === 'overdubbing') { arm(false); state = 'playing'; }
      layers.pop();
      if (!layers.length) { stopSource(); frames = 0; state = 'empty'; }
      else if (state === 'playing') play(phase);
      emit();
      return state;
    },
  };
})();
