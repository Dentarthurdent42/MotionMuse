// Facial landmark + gaze tracking (opt-in). Runs MediaPipe FaceLandmarker
// with blendshapes on its own RAF loop and overlay canvas, fully decoupled
// from the hand/pose pipeline in cv.js. Two independent toggles:
//   FACE → eyebrow / lips / tongue / cheek / ear signals
//   GAZE → pupil-orientation signals (gaze_x / gaze_y)
// Either toggle loads the (shared) face model on first use.

import { bus } from './bus.js';

// Face-oval landmarks nearest the ears (tragus region) in the 468-pt mesh.
const EAR_R = 234, EAR_L = 454;   // subject's right / left
// Iris centres (indices 468..477 are the 10 iris points).
const IRIS_R = 468, IRIS_L = 473;

export const faceSource = {
  faceOn: false,
  gazeOn: false,
  _model: null,
  _loading: null,
  video: null,
  canvas: null,
  ctx: null,
  _lastT: -1,
  _running: false,

  registerSignals() {
    const gf = 'face';
    bus.register('brow_raise',     { label: 'Brow Raise',      group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('brow_furrow',    { label: 'Brow Furrow',     group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('brow_L',         { label: 'L Brow Up',       group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('brow_R',         { label: 'R Brow Up',       group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('mouth_open',     { label: 'Mouth Open',      group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('smile',          { label: 'Smile',           group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('pucker',         { label: 'Lip Pucker',      group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('lips_funnel',    { label: 'Lip Funnel',      group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('tongue_out',     { label: 'Tongue Out',      group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('cheek_puff',     { label: 'Cheek Puff',      group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('cheek_squint_L', { label: 'L Cheek Squint',  group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('cheek_squint_R', { label: 'R Cheek Squint',  group: gf, min: 0,  max: 1, source: 'face' });
    // Ears don't articulate — their tracked positions give head orientation.
    bus.register('ear_L_x',        { label: 'L Ear X',         group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('ear_L_y',        { label: 'L Ear Y',         group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('ear_R_x',        { label: 'R Ear X',         group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('ear_R_y',        { label: 'R Ear Y',         group: gf, min: 0,  max: 1, source: 'face' });
    bus.register('head_yaw',       { label: 'Head Yaw (ears)', group: gf, min: -1, max: 1, source: 'face' });
    bus.register('head_roll',      { label: 'Head Roll (ears)',group: gf, min: -1, max: 1, source: 'face' });

    const gg = 'gaze';
    bus.register('gaze_x',         { label: 'Gaze X',          group: gg, min: -1, max: 1, source: 'face' });
    bus.register('gaze_y',         { label: 'Gaze Y',          group: gg, min: -1, max: 1, source: 'face' });
  },

  async _load() {
    if (this._model) return;
    if (!this._loading) this._loading = (async () => {
      const { FilesetResolver, FaceLandmarker } = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
      );
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      this._model = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
    })();
    await this._loading;
  },

  // Toggle helpers — the loop runs while either mode is on.
  async setFace(on)  { this.faceOn = on;  return this._sync(); },
  async setGaze(on)  { this.gazeOn = on;  return this._sync(); },

  async _sync() {
    if (this.faceOn || this.gazeOn) {
      await this._load();
      if (!this._running) {
        this.video  = document.getElementById('video');
        this.canvas = document.getElementById('face-overlay');
        this.ctx    = this.canvas.getContext('2d');
        const wrap  = this.video.parentElement;
        this.canvas.width  = wrap.offsetWidth;
        this.canvas.height = wrap.offsetHeight;
        this._running = true;
        this._loop();
      }
    } else if (this._running) {
      this._running = false;                       // loop exits on next frame
      this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._decayAll();
    }
  },

  _decayAll() {
    ['brow_raise','brow_furrow','brow_L','brow_R','mouth_open','smile','pucker','lips_funnel',
     'tongue_out','cheek_puff','cheek_squint_L','cheek_squint_R'].forEach(k => bus.decay(k));
    ['gaze_x','gaze_y','head_yaw','head_roll'].forEach(k => bus.decay(k, 0.8));
  },

  _loop() {
    if (!this._running) return;
    if (this.video.currentTime !== this._lastT && this.video.readyState >= 2) {
      this._lastT = this.video.currentTime;
      try {
        const res = this._model.detectForVideo(this.video, performance.now());
        this._process(res);
        this._draw(res);
      } catch (e) { console.error('Face frame error:', e); }
    }
    requestAnimationFrame(() => this._loop());
  },

  _process(res) {
    const lm = res.faceLandmarks?.[0];
    const cats = res.faceBlendshapes?.[0]?.categories;
    if (!lm || !cats) { this._decayAll(); return; }
    const bs = {};
    cats.forEach(c => { bs[c.categoryName] = c.score; });

    if (this.faceOn) {
      bus.update('brow_raise',     bs.browInnerUp ?? 0);
      bus.update('brow_furrow',    ((bs.browDownLeft ?? 0) + (bs.browDownRight ?? 0)) / 2);
      bus.update('brow_L',         bs.browOuterUpLeft ?? 0);
      bus.update('brow_R',         bs.browOuterUpRight ?? 0);
      bus.update('mouth_open',     bs.jawOpen ?? 0);
      bus.update('smile',          ((bs.mouthSmileLeft ?? 0) + (bs.mouthSmileRight ?? 0)) / 2);
      bus.update('pucker',         bs.mouthPucker ?? 0);
      bus.update('lips_funnel',    bs.mouthFunnel ?? 0);
      bus.update('tongue_out',     bs.tongueOut ?? 0);
      bus.update('cheek_puff',     bs.cheekPuff ?? 0);
      bus.update('cheek_squint_L', bs.cheekSquintLeft ?? 0);
      bus.update('cheek_squint_R', bs.cheekSquintRight ?? 0);

      const eL = lm[EAR_L], eR = lm[EAR_R];
      bus.update('ear_L_x', eL.x); bus.update('ear_L_y', 1 - eL.y);
      bus.update('ear_R_x', eR.x); bus.update('ear_R_y', 1 - eR.y);
      // Yaw from the ears' relative depth; roll from the ear-to-ear slope.
      bus.update('head_yaw',  Math.max(-1, Math.min(1, (eR.z - eL.z) * 6)));
      bus.update('head_roll', Math.max(-1, Math.min(1,
        Math.atan2(eL.y - eR.y, eL.x - eR.x) / (Math.PI / 4))));
    }

    if (this.gazeOn) {
      // Pupil orientation from the eye-look blendshapes, subject's frame:
      // +x = subject looks to their right, +y = up.
      const right = ((bs.eyeLookOutRight ?? 0) + (bs.eyeLookInLeft  ?? 0)) / 2;
      const left  = ((bs.eyeLookOutLeft  ?? 0) + (bs.eyeLookInRight ?? 0)) / 2;
      const up    = ((bs.eyeLookUpLeft   ?? 0) + (bs.eyeLookUpRight ?? 0)) / 2;
      const down  = ((bs.eyeLookDownLeft ?? 0) + (bs.eyeLookDownRight ?? 0)) / 2;
      bus.update('gaze_x', right - left);
      bus.update('gaze_y', up - down);
    }
  },

  _draw(res) {
    const { ctx, canvas: c } = this;
    ctx.clearRect(0, 0, c.width, c.height);
    const lm = res.faceLandmarks?.[0];
    if (!lm) return;

    // Same cover-fit mapping as the hand/pose overlay.
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const scale = Math.max(c.width / vw, c.height / vh);
    const ox = (c.width - vw * scale) / 2, oy = (c.height - vh * scale) / 2;
    const lx = x => ox + x * vw * scale, ly = y => oy + y * vh * scale;

    if (this.faceOn) {
      ctx.fillStyle = '#f0a50055';
      for (let i = 0; i < 468; i += 3) {          // sparse mesh dots
        ctx.fillRect(lx(lm[i].x) - 0.5, ly(lm[i].y) - 0.5, 1.5, 1.5);
      }
      ctx.fillStyle = '#f0a500';
      [EAR_L, EAR_R].forEach(i => {
        ctx.beginPath(); ctx.arc(lx(lm[i].x), ly(lm[i].y), 3, 0, Math.PI * 2); ctx.fill();
      });
    }

    if (this.gazeOn && lm[IRIS_L] && lm[IRIS_R]) {
      const gx = bus.signals.get('gaze_x')?.value ?? 0;
      const gy = bus.signals.get('gaze_y')?.value ?? 0;
      ctx.strokeStyle = '#00e5cc'; ctx.fillStyle = '#00e5cc'; ctx.lineWidth = 1.5;
      [IRIS_L, IRIS_R].forEach(i => {
        const x = lx(lm[i].x), y = ly(lm[i].y);
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
        // gaze vector (screen-x flipped: the canvas is mirrored like the video)
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - gx * 18, y - gy * 18); ctx.stroke();
      });
    }
  },
};
