import { bus }                                             from './bus.js';
import { push30, dist3, angleBetween, handOpenness, fingerExt, pinchStrength,
         torsoFrame, shoulderAngles,
         thumbOut, thumbContact }                          from './math.js';
import { setStatus }                                        from './ui/status.js';
import { depthSource }                                      from './depth.js';
import { createPoseBackend }                                from './posebackends.js';
import { lsGet, lsSet }                                     from './storage.js';
import { gesture }                                          from './gesture.js';
import { uicontrol }                                        from './uicontrol.js';

// How sure the handedness guess has to be before it is allowed to REJECT a
// hand. MediaPipe reports a score per detection; below this the label is a coin
// toss and rejecting on it would cost dropouts on a correctly-shown hand.
const HANDEDNESS_SURE = 0.9;


// Hand skeleton connections (MediaPipe 21-landmark topology)
const HAND_CONNS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];

// Pose skeleton connections (subset of 33-landmark BlazePose)
const POSE_CONNS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24]];

// Placeholder for overlay drawing before a model has produced its first result.
const EMPTY_RESULT = { landmarks: [], handednesses: [] };

export const cvSource = {
  hand:     null,
  poseBackend: null,
  video:    null,
  canvas:   null,
  ctx:      null,
  running:  false,
  lastTime: -1,
  _lat:     null,

  // Which models run. Hand tracking is normally the frame-rate bottleneck —
  // it costs roughly twice what pose does — so being able to switch either
  // off outright is the bluntest and most effective control there is. Both
  // default on; the choice persists.
  //
  // Left and right are separate because handedness is a *guess*: MediaPipe
  // infers it from the hand's appearance, and a single hand at an odd angle
  // gets mislabelled, which silently swaps every signal it drives. Telling it
  // you are only using your right hand removes the guess — anything detected
  // is that hand — and, with only one side wanted, halves the landmark work.
  handsL: true,
  handsR: true,
  poseOn: true,

  // `handsOn` stays the question the render loop asks: is the hand model
  // needed at all? Derived, so there is one source of truth rather than a
  // third flag to keep in step.
  get handsOn() { return this.handsL || this.handsR; },

  setTracking({ hands, handsL, handsR, pose } = {}) {
    // `hands` sets both, so existing callers and saved state keep working.
    if (hands  !== undefined) { this.handsL = !!hands; this.handsR = !!hands; }
    if (handsL !== undefined) this.handsL = !!handsL;
    if (handsR !== undefined) this.handsR = !!handsR;
    if (pose   !== undefined) this.poseOn = !!pose;
    // Drop the cached result of anything switched off, or the overlay would
    // keep drawing the last landmarks it saw as though they were live.
    if (!this.handsOn) this._hr = null;
    if (!this.poseOn)  this._pr = null;
    // Drop the timings too, so switching a model back on reports what it is
    // doing now rather than the average it left behind.
    if (!this.handsOn) this._lat?.hand.splice(0);
    if (!this.poseOn)  this._lat?.pose.splice(0);
    this._syncLatRows();
    lsSet('motionmuse-tracking', JSON.stringify(
      { handsL: this.handsL, handsR: this.handsR, pose: this.poseOn }));
    this._applyHandCount();
    return { hands: this.handsOn, handsL: this.handsL, handsR: this.handsR, pose: this.poseOn };
  },

  // Always ask for two hands, even when only one side is enabled.
  //
  // This used to ask for one, on the reasoning that numHands caps how many
  // times the landmark stage runs. It does — but only when a second hand is
  // ACTUALLY IN FRAME. With one hand up, asking for two costs exactly the
  // same, because the palm detector finds one hand and the landmark model runs
  // once. So the saving was confined to precisely the situation the cap got
  // wrong: with two hands visible and numHands 1, the model returns whichever
  // palm scored highest — often the hand resting in your lap — and that hand
  // then drove the enabled side's signals. Enabling only the left hand did not
  // stop the right one playing.
  //
  // With two, both are landmarked and processHands picks the one whose
  // handedness matches. Paying for a second landmark pass only when there is a
  // second hand to tell apart is the right trade.
  _applyHandCount() {
    if (!this.hand || !this.handsOn) return;
    if (this._handCount === 2) return;
    this._handCount = 2;
    this.setHandOptions({ hands: 2 });
  },

  _loadTracking() {
    try {
      const s = JSON.parse(lsGet('motionmuse-tracking') || '{}');
      // Migrate the older single `hands` flag.
      const both = s.hands !== false;
      this.handsL = s.handsL ?? both;
      this.handsR = s.handsR ?? both;
      this.poseOn = s.pose !== false;
    } catch { /* defaults stand */ }
    return { hands: this.handsOn, handsL: this.handsL, handsR: this.handsR, pose: this.poseOn };
  },

  // ── Register all CV signals into the bus ────────────────────────────
  registerSignals() {
    ['L', 'R'].forEach(s => {
      const lbl = s === 'L' ? 'Left' : 'Right';
      const g   = `hand ${s.toLowerCase()}`;
      bus.register(`hand_${s}_x`,      { label: `${lbl} Wrist X`,  group: g, min: 0, max: 1,   source: 'cv', smooth: true });
      bus.register(`hand_${s}_y`,      { label: `${lbl} Wrist Y`,  group: g, min: 0, max: 1,   source: 'cv', smooth: true });
      bus.register(`hand_${s}_open`,   { label: `${lbl} Openness`, group: g, min: 0, max: 1,   source: 'cv', smooth: true });
      bus.register(`hand_${s}_spread`, { label: `${lbl} Spread`,   group: g, min: 0, max: 1,   source: 'cv', smooth: true });
      // Pinch drives volume articulation, where lag is the enemy: a note has
      // to start when the fingers open, not 100 ms later. Snappier One-Euro
      // than the default (2.5 Hz base, and beta high enough that the cutoff
      // actually opens on a fast pinch). Anti-jitter is handled downstream by
      // the volume ladder's hysteresis, so this doesn't need heavy smoothing.
      // 1 = tips together, 0 = hand open. Drives volume articulation, where lag
      // is the enemy: a note has to start when the fingers move, not 100 ms
      // later. Snappier One-Euro than the default; anti-jitter is handled
      // downstream by the volume ladder's hysteresis.
      bus.register(`pinch_${s}`,       { label: `${lbl} Pinch`,    group: g, min: 0, max: 1,   source: 'cv', smooth: { minCutoff: 2.5, beta: 0.4 } });
      ['Thumb','Index','Middle','Ring','Pinky'].forEach(fn =>
        bus.register(`finger_${s}_${fn.toLowerCase()}`, {
          label: `${lbl} ${fn}`, group: g, min: 0, max: 1, source: 'cv', smooth: true,
        })
      );
      // 0 = thumb folded across the palm, 1 = carried clear of it. The one
      // thumb measure that actually moves (see math.js) — and what separates
      // handshapes that differ only in the thumb.
      bus.register(`thumb_out_${s}`, { label: `${lbl} Thumb Out`, group: g, min: 0, max: 1, source: 'cv', smooth: true });
      // Thumb-to-fingertip contacts: 1 when the pads meet. These are what make
      // the ASL number handshapes distinguishable, and they're good triggers
      // in their own right — a thumb-to-pinky tap is an easy discrete gesture.
      ['Index','Middle','Ring','Pinky'].forEach(fn =>
        bus.register(`contact_${s}_${fn.toLowerCase()}`, {
          label: `${lbl} ${fn} Touch`, group: g, min: 0, max: 1, source: 'cv', smooth: true,
        })
      );
    });

    const g2 = 'pose';
    // Elbows self-calibrate: nobody's elbow closes to 0° or opens to a flat
    // 180°, and the usable range differs per user. `adapt` maps the observed
    // range onto the full control range once ≥40° of motion has been seen.
    bus.register('elbow_L',        { label: 'L Elbow Angle',     group: g2, min: 0,  max: 180, source: 'cv', smooth: true, adapt: true, adaptSpan: 40 });
    bus.register('elbow_R',        { label: 'R Elbow Angle',     group: g2, min: 0,  max: 180, source: 'cv', smooth: true, adapt: true, adaptSpan: 40 });
    bus.register('shoulder_y_L',   { label: 'L Shoulder Height', group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('shoulder_y_R',   { label: 'R Shoulder Height', group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('shoulder_width', { label: 'Shoulder Width',    group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    // How far the arm is raised, 0 by your side to 1 straight overhead. This
    // used to publish `1 - shoulder.y` — the SHOULDER's height in frame, which
    // is not the arm at all, and was byte-identical to shoulder_y_*. Raising
    // your arm moved it not at all; crouching moved it a lot. The Pose preset
    // maps pitch to it under the hint "arm height drives everything", so the
    // one control the preset advertises was the one thing it did not do.
    //
    // It is `shoulder_elev_*` over 180: the same measurement, scaled to the
    // 0..1 a mapping range wants. Keep both — this one for wiring straight to
    // a parameter, the degrees version when you want its self-calibration.
    bus.register('arm_raise_L',    { label: 'L Arm Raise',       group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('arm_raise_R',    { label: 'R Arm Raise',       group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    // A shoulder is a ball joint, so it takes two angles: how far the arm is
    // lifted, and where it points once that is taken out. Reaching forward and
    // lifting out to the side are the same elevation and opposite azimuths —
    // one number could not tell them apart. Elevation adapts like the elbows
    // (nobody's arm sweeps the full 180°); azimuth does not, because its zero
    // means something exact — straight out to that side.
    bus.register('shoulder_elev_L', { label: 'L Shoulder Lift',  group: g2, min: 0,    max: 180, source: 'cv', smooth: true, adapt: true, adaptSpan: 40 });
    bus.register('shoulder_elev_R', { label: 'R Shoulder Lift',  group: g2, min: 0,    max: 180, source: 'cv', smooth: true, adapt: true, adaptSpan: 40 });
    bus.register('shoulder_azim_L', { label: 'L Shoulder Swing', group: g2, min: -180, max: 180, source: 'cv', smooth: true });
    bus.register('shoulder_azim_R', { label: 'R Shoulder Swing', group: g2, min: -180, max: 180, source: 'cv', smooth: true });
    bus.register('torso_tilt',     { label: 'Torso Tilt',        group: g2, min: -1, max: 1,   source: 'cv', smooth: true });
    bus.register('head_x',         { label: 'Head X',            group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('head_y',         { label: 'Head Y',            group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('nose_y',         { label: 'Nose Dip',          group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
  },

  // ── Load models ──────────────────────────────────────────────────────
  async init() {
    if (this.hand && this.poseBackend) return;   // already loaded (camera restart)
    this.registerSignals();
    setStatus('loading', 'LOADING MODELS…');

    const { FilesetResolver, HandLandmarker, GestureRecognizer } = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
    );

    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );

    this._vision = vision;                 // kept so the hand model can be rebuilt
    this._HandLandmarker = HandLandmarker;
    this._GestureRecognizer = GestureRecognizer;
    const saved = this._savedModel();
    this.hand = await this._makeHand(saved.delegate, saved.hands);

    // Pose runs behind a swappable backend (dev Models panel).
    this.poseBackend = createPoseBackend(saved.backend, { delegate: saved.delegate });
    await this.poseBackend.init();
    this._setLatModel();
  },

  _savedModel() {
    const dflt = { backend: 'mp-lite', delegate: 'GPU' };
    let s;
    try { s = { ...dflt, ...JSON.parse(lsGet('motionmuse-posemodel') || '{}') }; }
    catch { s = { ...dflt }; }
    // Hand count is derived from which sides are wanted — one owner, so the
    // header toggles and the model can't disagree about it.
    this._loadTracking();
    s.hands = 2;
    return s;
  },

  // The hand model is the usual frame-rate bottleneck — it costs roughly twice
  // what pose does, and `numHands: 2` runs the landmark stage per detected
  // hand, so tracking one hand is close to half the work. Both that and the
  // delegate were hardcoded, which meant the Models panel's DELEGATE switch
  // silently applied to pose only while hands stayed on whatever the browser
  // gave it.
  //
  // GestureRecognizer rather than HandLandmarker. It is not a second model on
  // top: the .task bundle contains hand_landmarker.task and
  // hand_gesture_recognizer.task side by side, and its result carries the same
  // landmarks / worldLandmarks / handedness fields plus `gestures`. So the
  // extra cost is a small classifier head, and in exchange the seven shapes it
  // knows are recognized by a trained model instead of hand-measured
  // templates. Everything else — ASL numbers, rock horns, user recordings —
  // still comes from the templates (see resolveGesture in gesture.js).
  async _makeHand(delegate = 'GPU', numHands = 2) {
    const base = { numHands, runningMode: 'VIDEO' };
    try {
      return await this._GestureRecognizer.createFromOptions(this._vision, {
        ...base,
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
          delegate,
        },
      });
    } catch (e) {
      // Never lose hand tracking over the classifier. If the bundle will not
      // load — old cache, blocked host, unsupported delegate — fall back to the
      // plain landmarker and let the templates carry recognition exactly as
      // they did before. Detected per-instance at the call site, so nothing
      // downstream has to know which one it got.
      console.warn('[cv] gesture recognizer unavailable, using hand landmarker:', e);
      return this._HandLandmarker.createFromOptions(this._vision, {
        ...base,
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate,
        },
      });
    }
  },

  // Rebuild the hand model live (camera keeps running; hand frames reuse the
  // previous result until the replacement is ready).
  async setHandOptions({ delegate, hands } = {}) {
    if (this._switching || !this._vision) return false;
    this._switching = true;
    try {
      const saved = this._savedModel();
      const d = delegate ?? saved.delegate;
      const n = hands ?? saved.hands;
      const next = await this._makeHand(d, n);
      const old = this.hand;
      this.hand = next;
      old?.close?.();
      this._lat?.hand.splice(0);
      lsSet('motionmuse-posemodel', JSON.stringify({ ...saved, delegate: d, hands: n }));
      return true;
    } finally {
      this._switching = false;
    }
  },

  _setLatModel() {
    const el = document.getElementById('lat-model');
    if (el) el.textContent = this.poseBackend?.id ?? '—';
  },

  // Swap the pose backend live (camera keeps running; pose frames simply
  // reuse the previous result until the new model is ready).
  async setPoseBackend(id, delegate = 'GPU') {
    if (this._switching) return false;
    this._switching = true;
    try {
      const next = createPoseBackend(id, { delegate });
      await next.init();
      const old = this.poseBackend;
      this.poseBackend = next;
      old?.dispose?.();
      this._lat?.pose.splice(0);   // stats restart for the new model
      // Merge, don't replace: this used to drop the hand settings stored
      // alongside, so changing the pose model reset hands to the default.
      lsSet('motionmuse-posemodel',
        JSON.stringify({ ...this._savedModel(), backend: id, delegate }));
      this._setLatModel();
      return true;
    } finally {
      this._switching = false;
    }
  },

  // ── Camera startup ───────────────────────────────────────────────────
  async startCamera() {
    this.video  = document.getElementById('video');
    this.canvas = document.getElementById('overlay');
    this.ctx    = this.canvas.getContext('2d');

    const stream = await navigator.mediaDevices.getUserMedia({
      // 30fps is plenty for musical control; a 60Hz camera would double
      // the inference load for no audible benefit.
      video: { width: 640, height: 480, frameRate: { ideal: 30 }, facingMode: 'user' },
    });
    this.video.srcObject = stream;
    await new Promise(r => this.video.onloadedmetadata = r);

    const wrap = this.video.parentElement;
    this.canvas.width  = wrap.offsetWidth;
    this.canvas.height = wrap.offsetHeight;

    document.getElementById('cam-placeholder').style.display = 'none';
    this.video.classList.add('ready');

    this._lat = { hand: [], pose: [], total: [], interval: [], lastT: 0, frame: 0 };
    document.getElementById('latency-bar').style.display = 'flex';
    this._syncLatRows();

    this.running = true;
    this.loop();
  },

  // ── Camera shutdown ──────────────────────────────────────────────────
  // Actually releases the camera: stops every MediaStream track (turning the
  // hardware indicator off), detaches the stream, and resets the view.
  stopCamera() {
    this.running = false;
    // No camera means no hands to steer with — an armed cursor would be a
    // stuck claim on signals that can never move again.
    uicontrol.disarmAll();
    const stream = this.video?.srcObject;
    stream?.getTracks?.().forEach(t => t.stop());
    if (this.video) {
      this.video.srcObject = null;
      this.video.classList.remove('ready');
    }
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    document.getElementById('cam-placeholder').style.display = '';
    document.getElementById('latency-bar').style.display = 'none';
    this.lastTime = -1;
  },

  // ── Detection loop ───────────────────────────────────────────────────
  // Hand and pose alternate frames: at a 30fps camera each model still
  // updates at ≥15Hz (plenty for musical control, smoothed by the bus
  // filter), but the per-frame main-thread inference cost is halved —
  // the single biggest lever against lag. The overlay draws the latest
  // cached results outside the measured inference path.
  loop() {
    if (!this.running) return;
    const now = performance.now();
    const lat = this._lat;

    if (this.video.currentTime !== this.lastTime) {
      this.lastTime = this.video.currentTime;
      // Interval between *processed* frames → real detection rate, not RAF rate.
      if (lat.lastT) push30(lat.interval, now - lat.lastT);
      lat.lastT = now;
      try {
        const t0 = performance.now();
        // With both enabled the two models alternate. With one disabled the
        // other runs EVERY frame rather than idling on its turn: switching
        // pose off is meant to buy hand tracking the whole frame budget, and
        // keeping the alternation would have thrown half of it away.
        const both = this.handsOn && this.poseOn;
        // An armed hand cursor deserves the frame budget: tilt the
        // alternation to hands 3-of-4 (~22Hz at 30fps) while it is, and give
        // pose the remaining quarter. Plain alternation otherwise.
        const boost = both && uicontrol.wantsPriority();
        const runHand = both ? (boost ? (lat.frame & 3) !== 3 : (lat.frame & 1) === 0)
                             : this.handsOn;
        const runPose = both ? !runHand : this.poseOn;
        if (runHand) {
          this._hr = this.hand.recognizeForVideo
            ? this.hand.recognizeForVideo(this.video, now)
            : this.hand.detectForVideo(this.video, now);
          push30(lat.hand, performance.now() - t0);
          this.processHands(this._hr);
        } else if (runPose) {
          this._pr = this.poseBackend.detect(this.video, now);
          push30(lat.pose, performance.now() - t0);
          this.processPose(this._pr);
        }
        push30(lat.total, performance.now() - t0);
        this.drawOverlay(this._hr ?? EMPTY_RESULT, this._pr ?? EMPTY_RESULT);
        if (++lat.frame % 15 === 0) this._updateLatency();
      } catch (e) {
        if (!this._warned) { console.warn('[cv] frame error:', e); this._warned = true; }
      }
    }
    requestAnimationFrame(() => this.loop());
  },

  // Show a timing row only while the model behind it is running. HAND and POSE
  // used to sit there whatever was enabled, so tracking the face alone showed
  // two averages from models that had stopped — numbers indistinguishable from
  // live ones. TOTAL covers this loop's inference, so it goes when both do.
  // (FACE has its own loop and owns its own row; see face.js.)
  _syncLatRows() {
    const show = (id, on) => {
      const el = document.getElementById(id);
      if (el) el.style.display = on ? '' : 'none';
    };
    show('lat-hand-wrap',  this.handsOn);
    show('lat-pose-wrap',  this.poseOn);
    show('lat-total-wrap', this.handsOn || this.poseOn);
    // MODEL names the POSE backend, so it belongs to the pose row.
    show('lat-model-wrap', this.poseOn);
  },

  _updateLatency() {
    const { hand, pose, total, interval } = this._lat;
    const ms  = a => a.length ? (a.reduce((s, v) => s + v, 0) / a.length).toFixed(1) + 'ms' : '—';
    const fps = interval.length
      ? (1000 / (interval.reduce((s, v) => s + v, 0) / interval.length)).toFixed(0)
      : '—';
    document.getElementById('lat-fps').textContent   = fps;
    document.getElementById('lat-hand').textContent  = ms(hand);
    document.getElementById('lat-pose').textContent  = ms(pose);
    document.getElementById('lat-total').textContent = ms(total);
  },

  // Which detection to treat as `side`, or -1 for none. Exported shape kept
  // simple (indices into the result) so the choice is one place and testable.
  _pickSide(r, side) {
    let unsure = -1;
    for (let i = 0; i < r.landmarks.length; i++) {
      const h = r.handednesses[i]?.[0];
      const guess = h?.categoryName === 'Left' ? 'L' : 'R';
      const score = h?.score ?? 0;
      if (score < HANDEDNESS_SURE) { if (unsure < 0) unsure = i; continue; }
      if (guess === side) return i;            // confident, and it's the one
    }
    return unsure;                             // no confident match; take a maybe
  },

  // ── Signal extraction: hands ─────────────────────────────────────────
  processHands(r) {
    const found       = { L: null, R: null };
    const foundWorld  = { L: null, R: null };
    const foundCanned = { L: null, R: null };   // MediaPipe canned category
    // With exactly one side enabled, pick the detection whose handedness
    // matches — but only trust that guess when the model is sure of it.
    //
    // Both extremes are wrong. Trusting the guess outright is what made
    // single-hand play unreliable in the first place: one bad frame relabels
    // the hand and every signal it drives jumps to the other side's keys.
    // Ignoring it entirely — which is what shipped instead — means whatever
    // hand the model happens to return drives the enabled side, so a hand
    // resting in your lap plays the instrument.
    //
    // So: prefer a confident match; fall back to a hand the model is unsure
    // about (that is the old lenient behaviour, and it keeps a correctly-shown
    // hand from dropping out on a shaky frame); and reject a hand it is
    // confident belongs to the other side. That last case is the bug being
    // fixed, and it is the only one where a hand is thrown away.
    const onlySide = this.handsL !== this.handsR ? (this.handsL ? 'L' : 'R') : null;
    if (r.handednesses && r.landmarks) {
      if (onlySide && r.landmarks.length) {
        const i = this._pickSide(r, onlySide);
        if (i >= 0) {
          found[onlySide]       = r.landmarks[i];
          foundWorld[onlySide]  = r.worldLandmarks?.[i] ?? null;
          foundCanned[onlySide] = r.gestures?.[i]?.[0] ?? null;
        }
      } else {
        r.handednesses.forEach((h, i) => {
          // MediaPipe Tasks API reports handedness from the subject's perspective
          const side = h[0].categoryName === 'Left' ? 'L' : 'R';
          if (side === 'L' ? !this.handsL : !this.handsR) return;
          found[side]      = r.landmarks[i];
          foundWorld[side] = r.worldLandmarks?.[i] ?? null;
          // Same index, same side resolution — so the classification and the
          // landmarks can never end up describing different hands.
          foundCanned[side] = r.gestures?.[i]?.[0] ?? null;
        });
      }
    }
    // The hand cursor sees every hand BEFORE the claims gate below — an armed
    // hand is invisible to the bus precisely because the cursor owns it.
    uicontrol.feedHands(found, foundWorld, performance.now());
    // A claimed hand is BORROWED, not lost, and the difference is audible.
    // This published it as absent, which runs the fail-quiet path below —
    // signals decay and pinch is forced to 1 — and the default patch maps
    // pinch to volume inverted, so arming a cursor drove the main volume to
    // zero and silenced the whole instrument, chords included. Absence means
    // "tracking failed, make it safe"; a borrowed hand means "someone is
    // using this hand for something else". So its signals simply stop
    // updating: whatever you were playing holds while you work the UI, and
    // the gesture matcher keeps the shape it had, so a held chord sustains.
    const claimed = { L: uicontrol.claims('L'), R: uicontrol.claims('R') };

    // 'None' is the classifier saying it has no opinion, not a gesture.
    for (const side of ['L', 'R']) {
      if (claimed[side]) continue;               // frozen — keep the last answer
      const c = foundCanned[side];
      gesture.setCanned(side, c && c.categoryName !== 'None' ? c.categoryName : null,
                        c?.score ?? 0);
    }

    ['L', 'R'].forEach(s => {
      if (claimed[s]) return;                    // frozen — publish nothing
      const lm = found[s];
      if (lm) {
        bus.update(`hand_${s}_x`,      lm[0].x);
        bus.update(`hand_${s}_y`,      1 - lm[0].y); // flip: up = 1
        bus.update(`hand_${s}_open`,   handOpenness(lm));
        bus.update(`hand_${s}_spread`, Math.min(1, dist3(lm[4], lm[20]) / (dist3(lm[0], lm[9]) * 2.5)));
        ['thumb','index','middle','ring','pinky'].forEach((n, fi) =>
          bus.update(`finger_${s}_${n}`, fingerExt(lm, fi))
        );
        bus.update(`thumb_out_${s}`, thumbOut(lm));
        ['index','middle','ring','pinky'].forEach((n, i) =>
          bus.update(`contact_${s}_${n}`, thumbContact(lm, i + 1))
        );
        const wlm = foundWorld[s];
        if (wlm) {
          bus.update(`pinch_${s}`, pinchStrength(wlm[4], wlm[8]));
        }
      } else {
        [`hand_${s}_x`, `hand_${s}_y`, `hand_${s}_open`, `hand_${s}_spread`]
          .forEach(k => bus.decay(k));
        // Pinch does NOT decay toward 0: 0 now means "hand open", which a
        // volume mapping reads as full blast. Losing tracking must fail quiet,
        // so treat it as fully pinched.
        bus.update(`pinch_${s}`, 1);
        ['thumb','index','middle','ring','pinky'].forEach(n => bus.decay(`finger_${s}_${n}`));
        bus.decay(`thumb_out_${s}`);
        ['index','middle','ring','pinky'].forEach(n => bus.decay(`contact_${s}_${n}`));
      }
    });

    // Distance-from-camera (LiDAR if active, else monocular size estimate).
    // Claimed hands freeze here in step with their other signals.
    depthSource.feedHands(found, claimed);
  },

  // ── Signal extraction: pose ──────────────────────────────────────────
  processPose(r) {
    if (!r.landmarks?.length) {
      // Decay pose signals like the hand path does — otherwise they freeze at
      // their last value when the subject leaves the frame.
      ['elbow_L','elbow_R','shoulder_y_L','shoulder_y_R','shoulder_width',
       'shoulder_elev_L','shoulder_elev_R','shoulder_azim_L','shoulder_azim_R',
       'arm_raise_L','arm_raise_R','torso_tilt','head_x','head_y','nose_y']
        .forEach(k => bus.decay(k));
      depthSource.feedPose(null);
      return;
    }
    const lm = r.landmarks[0];
    // Indices: 0=nose, 11=Lshoulder, 12=Rshoulder, 13=Lelbow,
    //          14=Relbow, 15=Lwrist, 16=Rwrist, 23=Lhip, 24=Rhip
    const [ls, rs, le, re, lw, rw, lh, rh, nose] = [11,12,13,14,15,16,23,24,0].map(i => lm[i]);

    if (ls && le && lw) bus.update('elbow_L', angleBetween(ls, le, lw));
    if (rs && re && rw) bus.update('elbow_R', angleBetween(rs, re, rw));
    if (ls && rs) {
      bus.update('shoulder_y_L',   1 - ls.y);
      bus.update('shoulder_y_R',   1 - rs.y);
      bus.update('shoulder_width', Math.abs(ls.x - rs.x));
    }
    if (ls && rs && lh && rh) {
      const smx = (ls.x + rs.x) / 2, hmx = (lh.x + rh.x) / 2;
      bus.update('torso_tilt', Math.max(-1, Math.min(1, (smx - hmx) * 5)));

      // Both shoulders share one torso frame, so the two arms are described
      // against the same body rather than each against the camera.
      const frame = torsoFrame(ls, rs, lh, rh);
      if (le) {
        const a = shoulderAngles('L', ls, le, frame);
        bus.update('shoulder_elev_L', a.elevation);
        bus.update('shoulder_azim_L', a.azimuth);
        bus.update('arm_raise_L', a.elevation / 180);
      }
      if (re) {
        const a = shoulderAngles('R', rs, re, frame);
        bus.update('shoulder_elev_R', a.elevation);
        bus.update('shoulder_azim_R', a.azimuth);
        bus.update('arm_raise_R', a.elevation / 180);
      }
    }
    if (nose) {
      bus.update('head_x', nose.x);
      bus.update('head_y', 1 - nose.y);
      bus.update('nose_y', nose.y); // raw: high = head down
    }

    // Torso distance-from-camera (LiDAR if active, else shoulder-span estimate).
    depthSource.feedPose(lm);
  },

  // ── Canvas skeleton overlay ──────────────────────────────────────────
  drawOverlay(hr, pr) {
    const { ctx, canvas: c } = this;
    ctx.clearRect(0, 0, c.width, c.height);

    // Replicate object-fit:cover scale/offset so the skeleton aligns with the
    // displayed video regardless of camera resolution vs. container aspect ratio.
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const scale = Math.max(c.width / vw, c.height / vh);
    const ox = (c.width  - vw * scale) / 2;
    const oy = (c.height - vh * scale) / 2;
    const lx = x => ox + x * vw * scale;
    const ly = y => oy + y * vh * scale;

    // Batched drawing: one stroked path per hand (all 24 connections), one
    // filled path per dot colour — ~8 canvas ops instead of ~100.
    if (hr.landmarks) {
      hr.landmarks.forEach((lm, hi) => {
        const isRight = hr.handednesses[hi]?.[0]?.categoryName === 'Right';
        const col = isRight ? '#00e5cc' : '#9d5cff';
        ctx.strokeStyle = col + 'aa'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        HAND_CONNS.forEach(([a, b]) => {
          ctx.moveTo(lx(lm[a].x), ly(lm[a].y));
          ctx.lineTo(lx(lm[b].x), ly(lm[b].y));
        });
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.beginPath();
        lm.forEach((pt, i) => {
          if (i === 0) return;
          ctx.moveTo(lx(pt.x) + 2, ly(pt.y));
          ctx.arc(lx(pt.x), ly(pt.y), 2, 0, Math.PI * 2);
        });
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(lx(lm[0].x), ly(lm[0].y), 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    if (pr.landmarks?.length) {
      const lm = pr.landmarks[0];
      ctx.strokeStyle = '#f0a50066'; ctx.lineWidth = 2;
      ctx.beginPath();
      POSE_CONNS.forEach(([a, b]) => {
        if (!lm[a] || !lm[b]) return;
        ctx.moveTo(lx(lm[a].x), ly(lm[a].y));
        ctx.lineTo(lx(lm[b].x), ly(lm[b].y));
      });
      ctx.stroke();
      ctx.fillStyle = '#f0a500';
      ctx.beginPath();
      [11, 12, 13, 14, 15, 16].forEach(i => {
        if (!lm[i]) return;
        ctx.moveTo(lx(lm[i].x) + 3, ly(lm[i].y));
        ctx.arc(lx(lm[i].x), ly(lm[i].y), 3, 0, Math.PI * 2);
      });
      ctx.fill();
    }
  },
};
