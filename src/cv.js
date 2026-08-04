import { bus }                                             from './bus.js';
import { push30, dist3, angleBetween, handOpenness, fingerExt } from './math.js';
import { setStatus }                                        from './ui/status.js';
import { depthSource }                                      from './depth.js';

// Pinch distance normalised against this max (metres); beyond → 1.0
const PINCH_MAX = 0.10;

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
  pose:     null,
  video:    null,
  canvas:   null,
  ctx:      null,
  running:  false,
  lastTime: -1,
  _lat:     null,

  // ── Register all CV signals into the bus ────────────────────────────
  registerSignals() {
    ['L', 'R'].forEach(s => {
      const lbl = s === 'L' ? 'Left' : 'Right';
      const g   = `hand ${s.toLowerCase()}`;
      bus.register(`hand_${s}_x`,      { label: `${lbl} Wrist X`,  group: g, min: 0, max: 1,   source: 'cv', smooth: true });
      bus.register(`hand_${s}_y`,      { label: `${lbl} Wrist Y`,  group: g, min: 0, max: 1,   source: 'cv', smooth: true });
      bus.register(`hand_${s}_open`,   { label: `${lbl} Openness`, group: g, min: 0, max: 1,   source: 'cv', smooth: true });
      bus.register(`hand_${s}_spread`, { label: `${lbl} Spread`,   group: g, min: 0, max: 1,   source: 'cv', smooth: true });
      bus.register(`pinch_${s}`,       { label: `${lbl} Pinch`,    group: g, min: 0, max: 1,   source: 'cv', smooth: true });
      ['Thumb','Index','Middle','Ring','Pinky'].forEach((fn, fi) =>
        bus.register(`finger_${s}_${fn.toLowerCase()}`, {
          label: `${lbl} ${fn}`, group: g, min: 0, max: 1, source: 'cv', smooth: true,
        })
      );
    });

    const g2 = 'pose';
    // Elbows self-calibrate: nobody's elbow closes to 0° or opens to a flat
    // 180°, and the usable range differs per user. `adapt` maps the observed
    // range onto the full control range once ≥25° of motion has been seen.
    bus.register('elbow_L',        { label: 'L Elbow Angle',     group: g2, min: 0,  max: 180, source: 'cv', smooth: true, adapt: true, adaptSpan: 40 });
    bus.register('elbow_R',        { label: 'R Elbow Angle',     group: g2, min: 0,  max: 180, source: 'cv', smooth: true, adapt: true, adaptSpan: 40 });
    bus.register('shoulder_y_L',   { label: 'L Shoulder Height', group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('shoulder_y_R',   { label: 'R Shoulder Height', group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('shoulder_width', { label: 'Shoulder Width',    group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('arm_raise_L',    { label: 'L Arm Raise',       group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('arm_raise_R',    { label: 'R Arm Raise',       group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('torso_tilt',     { label: 'Torso Tilt',        group: g2, min: -1, max: 1,   source: 'cv', smooth: true });
    bus.register('head_x',         { label: 'Head X',            group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('head_y',         { label: 'Head Y',            group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
    bus.register('nose_y',         { label: 'Nose Dip',          group: g2, min: 0,  max: 1,   source: 'cv', smooth: true });
  },

  // ── Load MediaPipe models ────────────────────────────────────────────
  async init() {
    if (this.hand && this.pose) return;   // already loaded (camera restart)
    this.registerSignals();
    setStatus('loading', 'LOADING MODELS…');

    const { FilesetResolver, HandLandmarker, PoseLandmarker } = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
    );

    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );

    this.hand = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU',
      },
      numHands: 2,
      runningMode: 'VIDEO',
    });

    this.pose = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
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

    this.running = true;
    this.loop();
  },

  // ── Camera shutdown ──────────────────────────────────────────────────
  // Actually releases the camera: stops every MediaStream track (turning the
  // hardware indicator off), detaches the stream, and resets the view.
  stopCamera() {
    this.running = false;
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
        if ((lat.frame & 1) === 0) {
          this._hr = this.hand.detectForVideo(this.video, now);
          push30(lat.hand, performance.now() - t0);
          this.processHands(this._hr);
        } else {
          this._pr = this.pose.detectForVideo(this.video, now);
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

  // ── Signal extraction: hands ─────────────────────────────────────────
  processHands(r) {
    const found      = { L: null, R: null };
    const foundWorld = { L: null, R: null };
    if (r.handednesses && r.landmarks) {
      r.handednesses.forEach((h, i) => {
        // MediaPipe Tasks API reports handedness from the subject's perspective
        const side = h[0].categoryName === 'Left' ? 'L' : 'R';
        found[side]      = r.landmarks[i];
        foundWorld[side] = r.worldLandmarks?.[i] ?? null;
      });
    }

    ['L', 'R'].forEach(s => {
      const lm = found[s];
      if (lm) {
        bus.update(`hand_${s}_x`,      lm[0].x);
        bus.update(`hand_${s}_y`,      1 - lm[0].y); // flip: up = 1
        bus.update(`hand_${s}_open`,   handOpenness(lm));
        bus.update(`hand_${s}_spread`, Math.min(1, dist3(lm[4], lm[20]) / (dist3(lm[0], lm[9]) * 2.5)));
        ['thumb','index','middle','ring','pinky'].forEach((n, fi) =>
          bus.update(`finger_${s}_${n}`, fingerExt(lm, fi))
        );
        const wlm = foundWorld[s];
        if (wlm) {
          bus.update(`pinch_${s}`, Math.min(1, dist3(wlm[4], wlm[8]) / PINCH_MAX));
        }
      } else {
        [`hand_${s}_x`, `hand_${s}_y`, `hand_${s}_open`, `hand_${s}_spread`, `pinch_${s}`]
          .forEach(k => bus.decay(k));
        ['thumb','index','middle','ring','pinky'].forEach(n => bus.decay(`finger_${s}_${n}`));
      }
    });

    // Distance-from-camera (LiDAR if active, else monocular size estimate).
    depthSource.feedHands(found);
  },

  // ── Signal extraction: pose ──────────────────────────────────────────
  processPose(r) {
    if (!r.landmarks?.length) {
      // Decay pose signals like the hand path does — otherwise they freeze at
      // their last value when the subject leaves the frame.
      ['elbow_L','elbow_R','shoulder_y_L','shoulder_y_R','shoulder_width',
       'arm_raise_L','arm_raise_R','torso_tilt','head_x','head_y','nose_y']
        .forEach(k => bus.decay(k));
      depthSource.feedPose(null);
      return;
    }
    const lm = r.landmarks[0];
    // Indices: 0=nose, 11=Lshoulder, 12=Rshoulder, 13=Lelbow,
    //          14=Relbow, 15=Lwrist, 16=Rwrist, 23=Lhip, 24=Rhip
    const [ls, rs, le, re, lw, rw, lh, rh, nose] = [11,12,13,14,15,16,23,24,0].map(i => lm[i]);

    if (ls && le && lw) {
      bus.update('elbow_L',     angleBetween(ls, le, lw));
      bus.update('arm_raise_L', Math.max(0, 1 - ls.y));
    }
    if (rs && re && rw) {
      bus.update('elbow_R',     angleBetween(rs, re, rw));
      bus.update('arm_raise_R', Math.max(0, 1 - rs.y));
    }
    if (ls && rs) {
      bus.update('shoulder_y_L',   1 - ls.y);
      bus.update('shoulder_y_R',   1 - rs.y);
      bus.update('shoulder_width', Math.abs(ls.x - rs.x));
    }
    if (ls && rs && lh && rh) {
      const smx = (ls.x + rs.x) / 2, hmx = (lh.x + rh.x) / 2;
      bus.update('torso_tilt', Math.max(-1, Math.min(1, (smx - hmx) * 5)));
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
