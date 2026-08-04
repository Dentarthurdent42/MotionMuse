import { cvSource }                        from './cv.js';
import { depthSource }                      from './depth.js';
import { faceSource }                       from './face.js';
import { engine }                           from './engine.js';
import { mapper }                           from './mapper.js';
import { setStatus, toast }                 from './ui/status.js';
import { buildSigPanel, updateSigPanel }    from './ui/signals.js';
import { renderMapper, updateMapperBars }   from './ui/mapper-ui.js';
import { renderAudioPanel, updateAudioSliders } from './ui/audio-ui.js';
import { drawViz }                          from './ui/viz.js';
import { initResize }                       from './ui/resize.js';
import { initFullscreen, updateFsOverlay }  from './ui/fullscreen.js';
import { playalong }                        from './playalong.js';
import { initPlayalongUI, updateGamePanel } from './ui/playalong-ui.js';
import { gesture }                          from './gesture.js';
import { chordmode }                        from './chordmode.js';
import { devmode }                          from './devmode.js';
import { shader }                           from './shader.js';
import * as preset                          from './preset.js';

// ── Main RAF loop ────────────────────────────────────────────────────────
function loop() {
  mapper.tick();
  gesture.tick();        // recognize hand gestures → gesture_<id> bus signals
  chordmode.tick();      // cheap no-op unless chord mode is enabled
  playalong.tick();      // cheap no-op unless a song is running
  updateSigPanel();
  updateMapperBars();
  if (engine.started) updateAudioSliders();
  drawViz();
  shader.render();       // cheap no-op unless the shader panel is active
  updateFsOverlay();     // cheap no-op unless fullscreen is active
  updateGamePanel();     // cheap no-op unless a song is running
  requestAnimationFrame(loop);
}

// ── Camera button ────────────────────────────────────────────────────────
document.getElementById('cv-btn').addEventListener('click', async () => {
  const btn = document.getElementById('cv-btn');
  if (cvSource.running) {
    cvSource.stopCamera();               // releases the camera hardware
    faceSource.setFace(false);           // face/gaze read the same stream
    faceSource.setGaze(false);
    ['face-btn', 'gaze-btn'].forEach(id => {
      const b = document.getElementById(id);
      b.disabled = true; b.classList.remove('on');
    });
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
    // Face & gaze tracking are opt-in once the camera is running.
    document.getElementById('face-btn').disabled = false;
    document.getElementById('gaze-btn').disabled = false;
  } catch (err) {
    setStatus('error', 'ERROR: ' + err.message.slice(0, 30));
    btn.textContent = 'RETRY';
    btn.disabled = false;
    console.error(err);
  }
});

// ── Face / gaze tracking toggles (opt-in, camera must be running) ────────
const faceToggle = (btnId, key, setter, label) => {
  const btn = document.getElementById(btnId);
  btn.addEventListener('click', async () => {
    const on = !faceSource[key];
    btn.disabled = true;
    try {
      await setter(on);
      btn.classList.toggle('on', on);
      toast(on ? `${label} tracking ON` : `${label} tracking off`);
    } catch (err) {
      toast(`Could not start ${label.toLowerCase()} tracking: ` + err.message);
    }
    btn.disabled = false;
  });
};
faceToggle('face-btn', 'faceOn', on => faceSource.setFace(on), 'Face');
faceToggle('gaze-btn', 'gazeOn', on => faceSource.setGaze(on), 'Gaze');

// ── Developer mode toggle (reveals under-construction features) ──────────
const devBtn = document.getElementById('dev-btn');
devmode.onChange(on => {
  devBtn.classList.toggle('on', on);
  devBtn.setAttribute('aria-pressed', String(on));
});
devBtn.addEventListener('click', () => devmode.toggle());

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
  document.getElementById('depth-btn-lbl').textContent =
    depthSource.lidarActive ? '◈ LiDAR ON' : '◈ LiDAR';
  depthBtn.disabled = false;
});
// LiDAR is under construction: turning dev mode off ends a live depth session
// (a hidden, running XR session with no visible control would be confusing).
devmode.onChange(on => { if (!on && depthSource.lidarActive) depthSource.stopLidar(); });

// ── Audio button ─────────────────────────────────────────────────────────
document.getElementById('audio-btn').addEventListener('click', async () => {
  const btn = document.getElementById('audio-btn');
  if (engine.started) {
    playalong.stop();          // a running game can't outlive its audio clock
    shader.setActive(false);   // panel (and its canvas) is about to be torn down
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
  if (cvSource.running) buildSigPanel();   // restored gesture signals appear
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
devmode.init();           // apply persisted dev-mode state to <body>
depthSource.init();       // register depth signals so they appear in the panel
faceSource.registerSignals();  // face/gaze signals are mappable up front
gesture.registerSignals();     // gesture_<id> signals are mappable up front
initResize();             // draggable panel splitters (desktop)
initFullscreen();         // fullscreen camera view + keyboard overlay
initPlayalongUI();        // registers the fullscreen game renderer
preset.restoreLocal();    // bring back the last session's mappings + settings
renderMapper();
loop();
