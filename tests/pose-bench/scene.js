// Synthetic pose scene: a procedural articulated mannequin (three.js) driven
// through a scripted pose timeline. Every frame has KNOWN joint world
// transforms, projected to normalized image coordinates as ground truth —
// which is what lets the benchmark measure each model's *error*, not just
// its speed.
//
// All articulation is in the frontal (camera) plane so projected ground
// truth is unambiguous. The figure is deliberately human-proportioned with
// skin/clothing tones: pose models are trained on people, and detection
// rate on a synthetic figure is itself one of the reported metrics.

import * as THREE from 'three';

export const W = 640, H = 480;
export const FRAMES = 300;          // ~10s at 30fps synthetic timeline
export const STATIC_START = 240;    // frames 240..299 hold a static T-pose (jitter segment)
const SEG = 30;                     // frames per keyframe segment

const SKIN = 0xc68863, SHIRT = 0x2b3a5c, PANTS = 0x23262e;

let renderer, scene, camera;
const J = {};   // joint name → Object3D (the ground-truth transform sources)

function capsule(r, len, color) {
  const g = new THREE.CapsuleGeometry(r, len, 4, 12);
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  return new THREE.Mesh(g, m);
}

// A limb segment hanging along local -Y from its joint pivot.
function segment(parent, name, x, y, r, len, color) {
  const joint = new THREE.Object3D();
  joint.position.set(x, y, 0);
  parent.add(joint);
  const mesh = capsule(r, len, color);
  mesh.position.y = -(len / 2 + r);
  joint.add(mesh);
  J[name] = joint;
  const end = new THREE.Object3D();          // distal end (next pivot / GT point)
  end.position.y = -(len + 2 * r);
  joint.add(end);
  return { joint, end };
}

export function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(W, H, false);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb8bcc4);

  camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 10);
  camera.position.set(0, 1.0, 2.4);
  camera.lookAt(0, 1.0, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x668866, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1, 2, 3);
  scene.add(key);

  // Root = hip center at 1m. The subject FACES the camera, so the subject's
  // LEFT side sits at world +X (which projects to image right — matching how
  // pose models assign left/right on a non-mirrored image).
  const root = new THREE.Object3D();
  root.position.set(0, 1.0, 0);
  scene.add(root);
  J.root = root;

  // Torso + head.
  const torso = capsule(0.15, 0.34, SHIRT);
  torso.position.y = 0.26;
  root.add(torso);
  const neck = new THREE.Object3D();
  neck.position.set(0, 0.52, 0);
  root.add(neck);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 16, 12),
    new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.7 }));
  head.position.y = 0.14;
  neck.add(head);
  J.head = head;

  // Arms: shoulder → elbow → wrist. Subject-left = +X.
  const upL = segment(root, 'l_shoulder', +0.22, 0.45, 0.05, 0.20, SKIN);
  const foL = segment(upL.joint, 'l_elbow', 0, -0.30, 0.045, 0.18, SKIN);
  J.l_wrist = foL.end;
  const upR = segment(root, 'r_shoulder', -0.22, 0.45, 0.05, 0.20, SKIN);
  const foR = segment(upR.joint, 'r_elbow', 0, -0.30, 0.045, 0.18, SKIN);
  J.r_wrist = foR.end;

  // Legs (static — they anchor the silhouette).
  const thL = segment(root, 'l_hip', +0.10, 0, 0.065, 0.32, PANTS);
  segment(thL.joint, 'l_knee', 0, -0.45, 0.055, 0.30, PANTS);
  const thR = segment(root, 'r_hip', -0.10, 0, 0.065, 0.32, PANTS);
  segment(thR.joint, 'r_knee', 0, -0.45, 0.055, 0.30, PANTS);
}

// Keyframed poses: z-rotations (degrees) applied to the named joints, plus a
// whole-body lean. Subject-left arm raises with POSITIVE z (θ maps the
// hanging -Y limb toward +X = subject's left).
const KEYS = [
  { name: 'rest',        l_shoulder:  10, r_shoulder: -10 },
  { name: 't-pose',      l_shoulder:  90, r_shoulder: -90 },
  { name: 'arms-up',     l_shoulder: 170, r_shoulder: -170 },
  { name: 'wave-left',   l_shoulder: 150, l_elbow: 40, r_shoulder: -20 },
  { name: 'elbow-r-90',  l_shoulder:  20, r_shoulder: -90, r_elbow: -70 },
  { name: 'both-elbows', l_shoulder:  90, r_shoulder: -90, l_elbow: 55, r_elbow: -55 },
  { name: 'lean-left',   l_shoulder:  45, r_shoulder: -45, lean: 10 },
  { name: 'lean-right',  l_shoulder:  45, r_shoulder: -45, lean: -10 },
  { name: 'hands-mid',   l_shoulder:  70, r_shoulder: -70, l_elbow: 30, r_elbow: -30 },
  { name: 't-pose-hold', l_shoulder:  90, r_shoulder: -90 },   // static jitter segment
];
const ROT_JOINTS = ['l_shoulder', 'r_shoulder', 'l_elbow', 'r_elbow'];
const rad = d => (d * Math.PI) / 180;

function poseAt(frame) {
  // Segments 0..8 interpolate KEYS[i]→KEYS[i+1] over SEG frames; the tail
  // (>= STATIC_START) holds the final key perfectly still.
  if (frame >= STATIC_START) return KEYS[KEYS.length - 1];
  const seg = Math.min(KEYS.length - 2, Math.floor(frame / SEG));
  const t = (frame - seg * SEG) / SEG;
  const a = KEYS[seg], b = KEYS[seg + 1];
  const out = {};
  for (const j of [...ROT_JOINTS, 'lean'])
    out[j] = (a[j] ?? 0) + ((b[j] ?? 0) - (a[j] ?? 0)) * t;
  return out;
}

export function renderFrame(frame) {
  const p = poseAt(frame);
  for (const j of ROT_JOINTS) J[j].rotation.z = rad(p[j] ?? 0);
  J.root.rotation.z = rad(p.lean ?? 0);
  renderer.render(scene, camera);
}

// Ground truth: joint world positions projected to normalized image coords
// (0..1, y down) — directly comparable to landmark output.
const GT_JOINTS = ['head', 'l_shoulder', 'r_shoulder', 'l_elbow', 'r_elbow', 'l_wrist', 'r_wrist', 'l_hip', 'r_hip'];
const _v = new THREE.Vector3();
export function gtJoints() {
  const out = {};
  for (const name of GT_JOINTS) {
    J[name].getWorldPosition(_v).project(camera);
    out[name] = { x: (_v.x + 1) / 2, y: (1 - _v.y) / 2 };
  }
  return out;
}
