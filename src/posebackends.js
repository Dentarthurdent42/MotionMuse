// Swappable pose-estimation backends, so dev mode can A/B model variants
// live: the three MediaPipe PoseLandmarker sizes, plus TensorFlow.js MoveNet
// as a structurally different comparator.
//
// Every backend exposes the same interface and detect() always returns a
// MediaPipe-shaped result ({ landmarks: [lm33] | [] }), so processPose,
// drawOverlay and depthSource need zero changes regardless of the engine.

export const POSE_BACKENDS = [
  { id: 'mp-lite',           label: 'MediaPipe Lite (default)', kind: 'mp',      file: 'pose_landmarker_lite'  },
  { id: 'mp-full',           label: 'MediaPipe Full',           kind: 'mp',      file: 'pose_landmarker_full'  },
  { id: 'mp-heavy',          label: 'MediaPipe Heavy',          kind: 'mp',      file: 'pose_landmarker_heavy' },
  { id: 'movenet-lightning', label: 'MoveNet Lightning',        kind: 'movenet', modelType: 'SinglePose.Lightning' },
  { id: 'movenet-thunder',   label: 'MoveNet Thunder',          kind: 'movenet', modelType: 'SinglePose.Thunder'   },
];

const MP_BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const MP_WASM   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

// MoveNet emits 17 COCO keypoints; map the ones our pose signals use onto
// their BlazePose-33 indices. Unmapped slots stay undefined — every consumer
// (processPose, drawOverlay, depthSource.feedPose) already null-guards.
const COCO_TO_BLAZE = [[0, 0], [5, 11], [6, 12], [7, 13], [8, 14], [9, 15], [10, 16], [11, 23], [12, 24]];

// UMD builds — see the note in movenetBackend.init() for why these are script
// tags rather than ES module imports.
const TFJS_UMD           = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const POSE_DETECTION_UMD = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js';

// Inject a classic script once, resolving when it has run. Cached by src so a
// second MoveNet switch doesn't refetch or re-execute.
const scripts = new Map();
function loadScript(src) {
  if (scripts.has(src)) return scripts.get(src);
  const p = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { scripts.delete(src); reject(new Error(`could not load ${src.split('/npm/')[1] ?? src}`)); };
    document.head.appendChild(el);
  });
  scripts.set(src, p);
  return p;
}

export function createPoseBackend(id, { delegate = 'GPU' } = {}) {
  const spec = POSE_BACKENDS.find(b => b.id === id) ?? POSE_BACKENDS[0];
  return spec.kind === 'mp' ? mpBackend(spec, delegate) : movenetBackend(spec);
}

function mpBackend(spec, delegate) {
  let landmarker = null;
  return {
    id: spec.id, label: spec.label, delegate,
    async init() {
      const { FilesetResolver, PoseLandmarker } = await import(MP_BUNDLE);
      const vision = await FilesetResolver.forVisionTasks(MP_WASM);
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/${spec.file}/float16/1/${spec.file}.task`,
          delegate,
        },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    },
    detect(video, tsMs) { return landmarker.detectForVideo(video, tsMs); },
    dispose() { landmarker?.close?.(); landmarker = null; },
  };
}

function movenetBackend(spec) {
  let detector = null;
  let latest   = { landmarks: [] };
  let inflight = false;
  return {
    id: spec.id, label: spec.label, delegate: 'GPU (tfjs)',
    async init() {
      // Dev-only cost: tfjs loads lazily, and only when a MoveNet backend is
      // actually selected in the Models panel.
      //
      // Loaded as classic UMD scripts, NOT as `+esm` modules. jsdelivr's
      // `+esm` transform rewrites these CommonJS packages into ESM whose
      // internal cross-package imports don't line up — pose-detection ends up
      // importing a binding from tfjs's ESM build that isn't exported there,
      // and the browser rejects the module at link time with
      // "SyntaxError: Importing binding name '…' is not found". That is a
      // packaging mismatch inside the CDN's generated bundles, so no amount
      // of ordering or awaiting fixes it — the UMD builds (the combination
      // TensorFlow actually documents for browsers) sidestep the ESM linker
      // entirely and attach to window.
      await loadScript(TFJS_UMD);
      if (!window.tf) throw new Error('tfjs failed to attach to window');
      await window.tf.ready();
      await loadScript(POSE_DETECTION_UMD);
      const pd = window.poseDetection;
      if (!pd) throw new Error('pose-detection failed to attach to window');
      detector = await pd.createDetector(pd.SupportedModels.MoveNet, {
        modelType: spec.modelType,
      });
    },
    // estimatePoses is async; the loop wants a synchronous detect. Kick off a
    // frame when idle and return the most recent completed result — one frame
    // of staleness, invisible at 15-30Hz.
    detect(video) {
      if (detector && !inflight) {
        inflight = true;
        detector.estimatePoses(video)
          .then(poses => { latest = toMpResult(poses, video); })
          .catch(() => {})
          .finally(() => { inflight = false; });
      }
      return latest;
    },
    dispose() { detector?.dispose?.(); detector = null; latest = { landmarks: [] }; },
  };
}

function toMpResult(poses, video) {
  if (!poses?.length) return { landmarks: [] };
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const lm = [];
  for (const [coco, blaze] of COCO_TO_BLAZE) {
    const kp = poses[0].keypoints[coco];
    if (kp && (kp.score ?? 1) >= 0.3) lm[blaze] = { x: kp.x / vw, y: kp.y / vh, z: 0 };
  }
  return { landmarks: [lm] };
}
