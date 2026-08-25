import { bus }            from './bus.js';
import { dist3 }          from './math.js';
import { setStatus, toast } from './ui/status.js';

// ── Optical depth layer ──────────────────────────────────────────────────
//
// A pluggable "Z axis" for the signal bus. Distance-from-camera is published
// as first-class, mappable signals so gestures *toward* and *away* from the
// lens can drive audio — not just motion in the image plane.
//
// Two interchangeable backends feed the same signals:
//
//   • 'estimate' — a monocular cue derived from MediaPipe landmarks (apparent
//     hand size / shoulder width). Needs no extra hardware; works with the
//     existing webcam, but it is relative and scale-ambiguous.
//
//   • 'lidar'    — the WebXR Depth Sensing API, which surfaces the per-pixel
//     depth map produced by an optical depth sensor (Apple LiDAR on iOS AR,
//     ARCore ToF on Android). This gives *true metric* depth in metres and is
//     far more accurate, especially in low texture / low light.
//
// When the LiDAR backend is live, per-landmark depth is sampled straight from
// the depth map and transparently replaces the monocular estimate behind the
// same signal keys, so existing mappings keep working — just better.

// Metric normalisation window (metres): NEAR → 1.0 (closest), FAR → 0.0.
const NEAR_M = 0.30;
const FAR_M  = 3.00;

// Monocular estimate windows (normalised image units). A hand spanning more of
// the frame is nearer; likewise a wider shoulder span means a closer torso.
const HAND_SIZE_FAR  = 0.05;
const HAND_SIZE_NEAR = 0.22;
const BODY_SPAN_FAR  = 0.12;
const BODY_SPAN_NEAR = 0.45;

const clamp01 = v => Math.max(0, Math.min(1, v));
const metricCloseness = m =>
  (m == null || m <= 0) ? null : clamp01((FAR_M - m) / (FAR_M - NEAR_M));

export const depthSource = {
  backend:     'estimate',   // 'estimate' | 'lidar'
  lidarActive: false,

  _session:  null,
  _refSpace: null,
  _gl:       null,
  _depth:    null,           // latest XRCPUDepthInformation
  _z:        { L: null, R: null },

  // ── Register the depth signals into the bus ─────────────────────────────
  registerSignals() {
    const g = 'depth';
    bus.register('hand_L_z',     { label: 'L Hand Depth',  group: g, min: 0,  max: 1, source: 'depth' });
    bus.register('hand_R_z',     { label: 'R Hand Depth',  group: g, min: 0,  max: 1, source: 'depth' });
    bus.register('hand_dz',      { label: 'Hand Push Δ',   group: g, min: -1, max: 1, source: 'depth' });
    bus.register('body_z',       { label: 'Body Depth',    group: g, min: 0,  max: 1, source: 'depth' });
    bus.register('depth_near',   { label: 'Nearest (m)',   group: g, min: 0,  max: 4, source: 'depth' });
    bus.register('depth_center', { label: 'Center (m)',    group: g, min: 0,  max: 4, source: 'depth' });
  },

  init() {
    this.registerSignals();
  },

  // ── Capability detection ────────────────────────────────────────────────
  async lidarSupported() {
    if (!('xr' in navigator) || !navigator.xr?.isSessionSupported) return false;
    try { return await navigator.xr.isSessionSupported('immersive-ar'); }
    catch { return false; }
  },

  // ── CV feed: hands ──────────────────────────────────────────────────────
  // `found` = { L: imageLandmarks|null, R: imageLandmarks|null }
  // `frozen` names hands the UI cursor has borrowed. Their depth holds its
  // last value rather than decaying, for the same reason their other signals
  // do: the hand is in use elsewhere, not missing.
  feedHands(found, frozen = {}) {
    ['L', 'R'].forEach(s => {
      if (frozen[s]) return;
      const lm = found[s];
      if (!lm) {
        bus.decay(`hand_${s}_z`);
        this._z[s] = null;
        return;
      }
      // Prefer true metric depth at the wrist; fall back to apparent size.
      let z = this.lidarActive ? this.metricAt(lm[0].x, lm[0].y) : null;
      if (z == null) z = this._handCloseness(lm);
      bus.update(`hand_${s}_z`, z);
      this._z[s] = z;
    });

    if (this._z.L != null && this._z.R != null) {
      bus.update('hand_dz', this._z.R - this._z.L);
    } else {
      bus.decay('hand_dz');
    }
  },

  // ── CV feed: pose ───────────────────────────────────────────────────────
  feedPose(lm) {
    if (!lm) { bus.decay('body_z'); return; }

    let z = null;
    const nose = lm[0];
    if (this.lidarActive && nose) z = this.metricAt(nose.x, nose.y);

    if (z == null) {
      const ls = lm[11], rs = lm[12];
      if (ls && rs) {
        const span = Math.abs(ls.x - rs.x);
        z = clamp01((span - BODY_SPAN_FAR) / (BODY_SPAN_NEAR - BODY_SPAN_FAR));
      }
    }
    if (z != null) bus.update('body_z', z); else bus.decay('body_z');
  },

  // Apparent-size closeness from the wrist→middle-MCP span in image units.
  _handCloseness(lm) {
    const size = dist3({ x: lm[0].x, y: lm[0].y }, { x: lm[9].x, y: lm[9].y });
    return clamp01((size - HAND_SIZE_FAR) / (HAND_SIZE_NEAR - HAND_SIZE_FAR));
  },

  // ── LiDAR / WebXR Depth Sensing backend ─────────────────────────────────
  async toggleLidar() {
    return this.lidarActive ? this.stopLidar() : this.startLidar();
  },

  async startLidar() {
    if (!(await this.lidarSupported())) {
      toast('Optical depth sensing not available on this device');
      return false;
    }

    let session;
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['depth-sensing'],
        depthSensing: {
          usagePreference:      ['cpu-optimized'],
          dataFormatPreference: ['luminance-alpha', 'float32'],
        },
      });
    } catch (e) {
      toast('Depth sensor unsupported: ' + (e.message || '').slice(0, 40));
      return false;
    }

    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl', { xrCompatible: true });
      await gl.makeXRCompatible();
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
      this._gl       = gl;
      this._session  = session;
      this._refSpace = await session.requestReferenceSpace('viewer');
    } catch {
      try { await session.end(); } catch {}
      toast('Depth session init failed');
      return false;
    }

    this.backend     = 'lidar';
    this.lidarActive = true;
    session.addEventListener('end', () => this._onSessionEnd());
    session.requestAnimationFrame((t, f) => this._xrFrame(t, f));
    setStatus('active', 'LIDAR DEPTH ON');
    this._toggleHud(true);
    return true;
  },

  async stopLidar() {
    try { await this._session?.end(); } catch {}
    return false;
  },

  _onSessionEnd() {
    this._session = this._refSpace = this._gl = this._depth = null;
    this.backend     = 'estimate';
    this.lidarActive = false;
    ['depth_near', 'depth_center'].forEach(k => bus.update(k, 0));
    this._toggleHud(false);
    const btn = document.getElementById('depth-btn');
    if (btn) {
      btn.classList.remove('on');
      const lbl = document.getElementById('depth-btn-lbl');
      if (lbl) lbl.textContent = '◈ LiDAR';
    }
    setStatus('active', 'CV ACTIVE');
  },

  // Per-frame: pull the depth map and publish scene-level metric signals.
  _xrFrame(t, frame) {
    const session = this._session;
    if (!session) return;

    const pose = frame.getViewerPose(this._refSpace);
    if (pose) {
      for (const view of pose.views) {
        const info = frame.getDepthInformation?.(view);
        if (info) {
          this._depth = info;
          this._publishScene(info);
          break;
        }
      }
    }
    session.requestAnimationFrame((tt, ff) => this._xrFrame(tt, ff));
  },

  _publishScene(info) {
    const center = this._rawMeters(info, 0.5, 0.5);
    if (center != null) bus.update('depth_center', center);

    // Coarse grid scan for the nearest surface in view.
    let near = Infinity;
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const m = this._rawMeters(info, i / 8, j / 8);
        if (m != null && m > 0.05 && m < near) near = m;
      }
    }
    if (isFinite(near)) bus.update('depth_near', near);

    const hud = document.getElementById('lat-depth');
    if (hud && center != null) hud.textContent = center.toFixed(2) + 'm';
  },

  // Closeness 0..1 (near = 1) at a normalised view coordinate, or null.
  metricAt(u, v) {
    return metricCloseness(this._rawMeters(this._depth, u, v));
  },

  // Raw metres at a normalised view coordinate (u,v in 0..1), or null.
  _rawMeters(info, u, v) {
    if (!info || u < 0 || u > 1 || v < 0 || v > 1) return null;
    try {
      // Map normalised view coords into the depth buffer's own frame.
      const m = info.normDepthBufferFromNormView?.matrix;
      let du = u, dv = v;
      if (m) {
        du = m[0] * u + m[4] * v + m[12];
        dv = m[1] * u + m[5] * v + m[13];
      }
      if (du < 0 || du > 1 || dv < 0 || dv > 1) return null;
      const meters = info.getDepthInMeters(du, dv);
      return (Number.isFinite(meters) && meters > 0) ? meters : null;
    } catch {
      return null;
    }
  },

  _toggleHud(on) {
    const wrap = document.getElementById('lat-depth-wrap');
    if (wrap) wrap.style.display = on ? '' : 'none';
  },
};
