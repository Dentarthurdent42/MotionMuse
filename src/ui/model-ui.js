// Dev-mode Models panel: pick the pose backend (MediaPipe lite/full/heavy or
// TF.js MoveNet) and watch live inference stats, so variants can be A/B'd on
// the actual device. Selection persists in localStorage via cvSource.

import { cvSource }      from '../cv.js';
import { POSE_BACKENDS } from '../posebackends.js';
import { toast }         from './status.js';
import { lsSet }         from '../storage.js';

const p95 = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] : null;
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const ms  = v => v == null ? '—' : v.toFixed(1) + 'ms';

export function initModelPanel() {
  const poseSel = document.getElementById('model-pose');
  const delSel  = document.getElementById('model-delegate');
  const stats   = document.getElementById('model-stats');
  if (!poseSel) return;

  poseSel.innerHTML = POSE_BACKENDS
    .map(b => `<option value="${b.id}">${b.label}</option>`).join('');

  const saved = cvSource._savedModel();
  poseSel.value = saved.backend;
  delSel.value  = saved.delegate;
  const syncDelegate = () => {
    // MoveNet runs on tfjs's own backend; the delegate choice is MediaPipe-only.
    delSel.disabled = poseSel.value.startsWith('movenet');
  };
  syncDelegate();

  const apply = async () => {
    poseSel.disabled = delSel.disabled = true;
    const prev = cvSource.poseBackend?.id;
    try {
      if (cvSource.hand) {           // models are loaded — swap live
        // The delegate is a property of BOTH models. It only ever reached the
        // pose backend, so switching to CPU (or back) left hand inference —
        // the more expensive of the two — untouched, and the panel's own
        // latency readout made that look like the switch had done nothing.
        // Delegate only — hand count belongs to the header L/R toggles.
        await cvSource.setHandOptions({ delegate: delSel.value });
        await cvSource.setPoseBackend(poseSel.value, delSel.value);
        toast(`Pose ${poseSel.value} · ${delSel.value}`);
      } else {                       // camera not started yet — just persist
        lsSet('motionmuse-posemodel', JSON.stringify(
          { ...cvSource._savedModel(), backend: poseSel.value, delegate: delSel.value }));
      }
    } catch (e) {
      // The full text matters here: the previous 40-character truncation cut
      // "SyntaxError: Importing binding name 'PoseDetector' is not found" down
      // to "Syntax Error: Importing binding name 'Pos", which named neither
      // the binding nor the module and made the cause unguessable.
      console.error('[models] switch failed', e);
      toast(`Model switch failed — ${String(e?.message || e).slice(0, 110)}`);
      if (prev) poseSel.value = prev;
    } finally {
      poseSel.disabled = false;
      syncDelegate();
    }
  };
  poseSel.addEventListener('change', apply);
  delSel.addEventListener('change', apply);

  // Live stats at 2Hz — cheap, and only meaningful while the camera runs.
  setInterval(() => {
    const lat = cvSource._lat;
    if (!cvSource.running || !lat) return;
    const fps = avg(lat.interval) ? (1000 / avg(lat.interval)).toFixed(0) : '—';
    stats.textContent =
      `DET ${fps}fps · hand ${ms(avg(lat.hand))} (p95 ${ms(p95(lat.hand))})` +
      ` · pose ${ms(avg(lat.pose))} (p95 ${ms(p95(lat.pose))})`;
  }, 500);
}
