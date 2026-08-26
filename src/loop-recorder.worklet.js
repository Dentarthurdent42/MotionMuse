// The looper's capture end, on the audio thread.
//
// A worklet rather than a ScriptProcessorNode because this runs in the render
// quantum: it is handed the exact samples the graph produced, with no resampling
// and no main-thread scheduling between them and the buffer. The whole job is to
// copy and forward — anything cleverer belongs on the main thread, where it can
// be reasoned about and tested.
//
// The copy is not optional. `inputs` points at buffers the engine REUSES on the
// next quantum, so posting them directly would hand the main thread views onto
// memory that is about to be overwritten with the next 128 samples — a loop that
// records a smear of whatever came later.
class LoopRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = e => { this.on = !!e.data?.on; };
  }

  process(inputs, outputs) {
    if (this.on) {
      const chans = inputs[0];
      if (chans?.length) this.port.postMessage(chans.map(c => new Float32Array(c)));
    }
    // The output exists only so the graph can reach this node from the
    // destination and therefore pull it — a node nothing pulls never runs, and
    // a recorder that never runs records silence. It stays silent: the main
    // thread connects it through a zero gain, and leaving the buffer untouched
    // is already zeroes.
    void outputs;
    // Always true: a recorder that returned false while idle would be collected,
    // and arming it again would find nothing on the other end of the port.
    return true;
  }
}

registerProcessor('loop-recorder', LoopRecorder);
