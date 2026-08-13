import { cvSource }                        from './cv.js';
import { depthSource }                      from './depth.js';
import { faceSource }                       from './face.js';
import { engine }                           from './engine.js';
import { mapper }                           from './mapper.js';
import { setStatus, toast }                 from './ui/status.js';
import { buildSigPanel, updateSigPanel, syncSigGroups } from './ui/signals.js';
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
import { initDonate }                       from './ui/donate.js';
import { initModelPanel }                   from './ui/model-ui.js';
import { initPresetMenu }                   from './ui/preset-menu.js';
import { initTutorial }                     from './ui/tutorial.js';
import { initHotkeys, keyLabel, getBinding, onBindingChange } from './ui/hotkeys.js';
import { enhanceSections, colorSections }   from './ui/sections.js';
import { shaderSectionHTML, wireShaderSection } from './ui/shader-ui.js';
import { initTheme }                        from './ui/theme.js';
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

// ── Header button labels ─────────────────────────────────────────────────
// Buttons whose caption changes carry a hidden .btn-sizer holding the longest
// caption, so writing the visible .btn-text can't change the button's width.
// Writing button.textContent directly would delete the sizer.
const setLabel = (btn, text) => {
  const t = btn.querySelector('.btn-text');
  if (t) t.textContent = text; else btn.textContent = text;
};

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
    setLabel(btn, 'START CAMERA');
    btn.classList.remove('on');
    document.body.classList.remove('cam-on');   // hides the FACE/GAZE row
    return;
  }
  btn.disabled = true;
  setLabel(btn, 'LOADING…');
  try {
    await cvSource.init();
    await cvSource.startCamera();
    setStatus('active', 'CV ACTIVE');
    setLabel(btn, 'STOP CAMERA');
    btn.disabled = false;
    btn.classList.add('on');
    buildSigPanel();
    renderMapper();
    // Face & gaze tracking are opt-in once the camera is running; their row in
    // the header only exists from this point on.
    document.body.classList.add('cam-on');
    document.getElementById('face-btn').disabled = false;
    document.getElementById('gaze-btn').disabled = false;
  } catch (err) {
    setStatus('error', 'ERROR: ' + err.message.slice(0, 30));
    setLabel(btn, 'RETRY');
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
      syncSigGroups();   // face/gaze groups expand or fold away with their tracker
      toast(on ? `${label} tracking ON` : `${label} tracking off`);
    } catch (err) {
      toast(`Could not start ${label.toLowerCase()} tracking: ` + err.message);
    }
    btn.disabled = false;
  });
};
faceToggle('face-btn', 'faceOn', on => faceSource.setFace(on), 'Face');
faceToggle('gaze-btn', 'gazeOn', on => faceSource.setGaze(on), 'Gaze');

// ── Hand / pose tracking toggles ─────────────────────────────────────────
// Unlike face and gaze these are on by default and cost nothing to switch —
// no model to load, just whether the loop runs it.
// `flag` is the cvSource property the button reflects; `key` is what
// setTracking() expects. Left and right are separate so a one-handed player
// can tell the model which hand it is, instead of letting it guess.
const trackToggle = (btnId, flag, key, label) => {
  const btn = document.getElementById(btnId);
  const sync = () => btn.classList.toggle('on', cvSource[flag]);
  btn.addEventListener('click', () => {
    cvSource.setTracking({ [key]: !cvSource[flag] });
    syncAllTracking();
    const on = cvSource[flag];
    const only = cvSource.handsL !== cvSource.handsR;
    toast(on ? `${label} ON`
             : key === 'pose' ? 'Pose off — hands now run every frame'
             : cvSource.handsOn ? `${label} off — no handedness guessing, one hand tracked`
             : 'Hands off — pose now runs every frame');
    if (on && only && key !== 'pose') toast(`${label} ON — single hand, no handedness guessing`);
  });
  return sync;
};
cvSource._loadTracking();
const syncers = [
  trackToggle('hands-l-btn', 'handsL', 'handsL', 'Left hand'),
  trackToggle('hands-r-btn', 'handsR', 'handsR', 'Right hand'),
  trackToggle('pose-btn',    'poseOn', 'pose',   'Pose'),
];
function syncAllTracking() { syncers.forEach(fn => fn()); syncSigGroups(); }
syncAllTracking();

// ── Developer mode toggle (reveals under-construction features) ──────────
const devBtn = document.getElementById('dev-btn');
devmode.onChange(on => {
  devBtn.classList.toggle('on', on);
  devBtn.setAttribute('aria-pressed', String(on));
});
devBtn.addEventListener('click', () => devmode.toggle());
// Dev mode reveals whole sections (MODELS, Gestures, Chord Mode, Shader).
// Position hues are derived from measured geometry and skip hidden elements,
// so anything revealed here has no hue until this recolours the set.
devmode.onChange(() => colorSections());

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

// ── Audio: starts with the page, muted ───────────────────────────────────
// The engine used to wait behind a button, which meant every control in the
// audio panel was absent until you found it — you couldn't set up a patch and
// then start playing, you had to start first and configure while it ran. Now
// the graph is built at load so everything is manipulable immediately, and the
// output is muted so building a patch stays silent until you ask for sound.
//
// The button is therefore a mute toggle, not a power switch.
const audioBtn = document.getElementById('audio-btn');
const vizMuted = document.getElementById('viz-muted');

// One function owns every visible trace of mute state, so the button, the
// banner and the assistive-tech state can't drift apart.
function syncMuteUI() {
  const m = engine.muted;
  setLabel(audioBtn, m ? '🔇 MUTED' : '🔊 SOUND ON');
  audioBtn.classList.toggle('muted', m);
  audioBtn.classList.toggle('on', !m);
  audioBtn.setAttribute('aria-pressed', String(m));
  audioBtn.title = m
    ? `Muted — the engine is running but silent. ${keyLabel(getBinding('mute'))} to unmute.`
    : `Sound on. ${keyLabel(getBinding('mute'))} to mute.`;
  vizMuted.hidden = !m;
  document.getElementById('mute-key-hint').textContent = keyLabel(getBinding('mute'));
}

async function toggleMute() {
  if (!engine.started) {            // auto-start failed — this click is the retry
    await startAudio();
    return;
  }
  // Unmuting is the user gesture the browser has been waiting for, so hand it
  // over — but never await it (see startAudio). Scheduling the ramp against a
  // frozen clock is safe: the AudioParam timeline is absolute, so it plays out
  // normally once the clock starts.
  engine.resume();
  engine.setMuted(!engine.muted);
  syncMuteUI();
}

async function startAudio() {
  try {
    await engine.start();
  } catch (err) {
    // Nothing else in the app depends on audio existing, so a failure here
    // degrades to "press the button" rather than taking the page down.
    console.warn('audio engine did not start', err);
    audioBtn.title = 'Audio unavailable — click to retry';
    return false;
  }
  renderAudioPanel();
  syncMuteUI();
  // Deliberately NOT awaited. `AudioContext.resume()` does not reject when the
  // browser is withholding permission — it returns a promise that simply never
  // settles until a gesture arrives. Awaiting it here left the audio panel
  // unrendered on any browser that actually enforces the autoplay policy,
  // which is every real one; the bug is invisible in headless Chromium,
  // which doesn't.
  engine.resume();
  return true;
}

audioBtn.addEventListener('click', toggleMute);
// The visualiser is the largest thing on screen already showing mute state,
// so it doubles as the target for it. The banner over it is pointer-events:
// none, so a tap anywhere in the box lands here.
document.getElementById('viz-wrap').addEventListener('click', toggleMute);

// Autoplay policy means the context starts suspended and its clock stays
// frozen until a gesture. Resume on the first one, whatever it is, so the
// instrument is already awake by the time the user unmutes.
const wakeAudio = () => { engine.resume(); };
['pointerdown', 'keydown'].forEach(ev =>
  document.addEventListener(ev, wakeAudio, { once: true, capture: true }));

initHotkeys({ mute: () => { toggleMute(); } });
onBindingChange(syncMuteUI);    // rebinding the key relabels the button and banner
syncMuteUI();                   // muted from the first paint, before the graph exists
startAudio();

// ── Mapper buttons ───────────────────────────────────────────────────────
// PRESET opens a menu of starting patches; each reports what it still needs
// switched on (camera / face / gaze) rather than loading silently.
initPresetMenu({
  onApply: () => renderMapper(),
  state: () => ({
    camera: cvSource.running,
    face:   faceSource.faceOn,
    gaze:   faceSource.gazeOn,
  }),
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
    const { uiChanged } = await preset.loadFromFile(file);
    refreshFromState();
    preset.saveLocal();
    if (uiChanged) {
      // Theme, panel sizes, section heights and tracker state are read once at
      // startup by the modules that own them, so a reload is how they take
      // effect — cheaper and more honest than a second apply path per module
      // that would drift out of step with the real one.
      toast('Full setup loaded — reloading');
      setTimeout(() => location.reload(), 700);
    } else {
      toast('Settings loaded');
    }
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
initTheme();              // before anything paints, so there is no flash of the default palette
devmode.init();           // apply persisted dev-mode state to <body>
depthSource.init();       // register depth signals so they appear in the panel
// Register every source's signals up front, before any of them are running.
// Besides making CV signals mappable before the camera starts (as face/gaze
// and gestures already were), this is what gives a restored preset real
// labels — otherwise a saved `hand_R_open` mapping had no registered signal
// to look up and the patchbay displayed the raw key.
cvSource.registerSignals();    // hand/pose signals are mappable up front
faceSource.registerSignals();  // face/gaze signals are mappable up front
gesture.registerSignals();     // gesture_<id> signals are mappable up front
initResize();             // draggable panel splitters (desktop)
initFullscreen();         // fullscreen camera view + keyboard overlay
initPlayalongUI();        // registers the fullscreen game renderer
initDonate();             // ♥ support popover in the header
initModelPanel();         // dev-mode pose model comparison panel
initTutorial();           // guided tour (? button; auto-offers on first visit)
preset.restoreLocal();    // bring back the last session's mappings + settings
renderMapper();
// Shader controls belong with the patchbay — the shader reads signals and
// mappings, so it sits beside the wiring rather than among synth parameters.
// Rendered once: renderMapper() re-runs on every rewire.
const shaderHost = document.getElementById('shader-host');
if (shaderHost) { shaderHost.innerHTML = shaderSectionHTML(); wireShaderSection(); }
enhanceSections();        // wrap every section: own container, scroller, resize grip
loop();
