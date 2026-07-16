import { cvSource }                        from './cv.js';
import { depthSource }                      from './depth.js';
import { engine }                           from './engine.js';
import { mapper }                           from './mapper.js';
import { setStatus, toast }                 from './ui/status.js';
import { buildSigPanel, updateSigPanel }    from './ui/signals.js';
import { renderMapper, updateMapperBars }   from './ui/mapper-ui.js';
import { renderAudioPanel, updateAudioSliders } from './ui/audio-ui.js';
import { drawViz }                          from './ui/viz.js';
import * as preset                          from './preset.js';

// ── Main RAF loop ────────────────────────────────────────────────────────
function loop() {
  mapper.tick();
  updateSigPanel();
  updateMapperBars();
  if (engine.started) updateAudioSliders();
  drawViz();
  requestAnimationFrame(loop);
}

// ── Camera button ────────────────────────────────────────────────────────
document.getElementById('cv-btn').addEventListener('click', async () => {
  const btn = document.getElementById('cv-btn');
  if (cvSource.running) {
    cvSource.running = false;
    setStatus('', 'STOPPED');
    btn.textContent = 'START CAMERA';
    btn.classList.remove('on');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'LOADING…';
  try {
    await cvSource.init();
    await cvSource.startCamera();
    setStatus('active', 'CV ACTIVE');
    btn.textContent = 'STOP CAMERA';
    btn.disabled = false;
    btn.classList.add('on');
    buildSigPanel();
    renderMapper();
  } catch (err) {
    setStatus('error', 'ERROR: ' + err.message.slice(0, 30));
    btn.textContent = 'RETRY';
    btn.disabled = false;
    console.error(err);
  }
});

// ── Tracking model toggle (classic ↔ experimental v2) ───────────────────
const trackBtn = document.getElementById('track-btn');
trackBtn.classList.toggle('on', cvSource.conditioning);
trackBtn.addEventListener('click', () => {
  const on = !cvSource.conditioning;
  cvSource.setConditioning(on);
  trackBtn.classList.toggle('on', on);
  toast(on ? 'Experimental tracking v2 ON (smoothing + plausibility gates)'
           : 'Classic tracking (v2 off)');
});

// ── LiDAR / optical depth toggle ─────────────────────────────────────────
const depthBtn = document.getElementById('depth-btn');
depthSource.lidarSupported().then(ok => {
  if (!ok) {
    depthBtn.classList.add('unsupported');
    depthBtn.title = 'WebXR optical depth sensing not available on this browser/device';
  }
});
depthBtn.addEventListener('click', async () => {
  depthBtn.disabled = true;
  await depthSource.toggleLidar();
  depthBtn.classList.toggle('on', depthSource.lidarActive);
  depthBtn.textContent = depthSource.lidarActive ? '◈ LiDAR ON' : '◈ LiDAR';
  depthBtn.disabled = false;
});

// ── Audio button ─────────────────────────────────────────────────────────
document.getElementById('audio-btn').addEventListener('click', async () => {
  const btn = document.getElementById('audio-btn');
  if (engine.started) {
    engine.stop();
    btn.textContent = 'AUDIO OFF';
    btn.classList.remove('on');
    document.getElementById('audio-panel').innerHTML = `
      <div style="padding:16px 10px;color:var(--border2);font-size:10px;text-align:center;">
        Enable audio to begin
      </div>`;
  } else {
    await engine.start();
    btn.textContent = 'AUDIO ON';
    btn.classList.add('on');
    renderAudioPanel();
  }
});

// ── Mapper buttons ───────────────────────────────────────────────────────
document.getElementById('add-map-btn').addEventListener('click', () => {
  mapper.add(Object.keys(engine.PARAMS)[0]);
  renderMapper();
});

document.getElementById('preset-btn').addEventListener('click', () => {
  mapper.applyPreset();
  renderMapper();
  toast('Preset loaded — start camera + audio to play!');
});

// ── Save / load settings + mappings ──────────────────────────────────────
// Reflect a freshly loaded state everywhere: mapper rows always, and the audio
// panel (waveforms, sliders, tuning + keyboard) only while it exists.
function refreshFromState() {
  renderMapper();
  if (engine.started) renderAudioPanel();
}

document.getElementById('save-btn').addEventListener('click', () => {
  preset.downloadFile();
  preset.saveLocal();
  toast('Settings saved');
});

const loadFile = document.getElementById('load-file');
document.getElementById('load-btn').addEventListener('click', () => loadFile.click());
loadFile.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await preset.loadFromFile(file);
    refreshFromState();
    preset.saveLocal();
    toast('Settings loaded');
  } catch (err) {
    toast('Could not load: ' + err.message);
  }
  loadFile.value = '';   // allow re-loading the same file
});

// Persist the session so it survives a reload / PWA relaunch.
const persist = () => preset.saveLocal();
window.addEventListener('beforeunload', persist);
window.addEventListener('visibilitychange', () => { if (document.hidden) persist(); });

// ── Init ─────────────────────────────────────────────────────────────────
depthSource.init();       // register depth signals so they appear in the panel
preset.restoreLocal();    // bring back the last session's mappings + settings
renderMapper();
loop();
