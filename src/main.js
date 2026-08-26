import { cvSource }                        from './cv.js';
import { depthSource }                      from './depth.js';
import { faceSource, rememberFaceIntent,
         savedFaceIntent }                  from './face.js';
import { micSource }                        from './mic.js';
import { buildInfo, buildLabel }            from './build.js';
import { engine }                           from './engine.js';
import { mapper, trackersFor }              from './mapper.js';
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
import { findConfig }                       from './saved.js';
import { initTutorial, maybeOfferTour, offerTourForMode, offerTourForSharedSetup } from './ui/tutorial.js';
import { initHotkeys, keyLabel, getBinding, onBindingChange } from './ui/hotkeys.js';
import { enhanceSections, colorSections }   from './ui/sections.js';
import { shaderSectionHTML, wireShaderSection } from './ui/shader-ui.js';
import { initTheme }                        from './ui/theme.js';
import { initSettings }                     from './ui/settings.js';
import { initShare, consumeSharedLink, announceSharedLink, isConsumingShare } from './ui/share.js';
import { shouldOfferStart, openStartPicker } from './ui/firstrun.js';
import { uicontrol }                        from './uicontrol.js';
import { initUidriver }                     from './ui/uidriver.js';
import { initUicontrol, updateUicOverlay }  from './ui/uicontrol-ui.js';
import { initStage, updateStage }           from './ui/stage-ui.js';
import * as preset                          from './preset.js';

// ── A shared setup, if this page was opened from a QR code / link ────────
// First thing: it applies the state, persists it and reloads without the
// fragment, so the sooner it runs the less of the old setup flashes past.
consumeSharedLink();

// ── Main RAF loop ────────────────────────────────────────────────────────
function loop() {
  mapper.tick();
  micSource.tick();      // cheap no-op unless the mic is on
  gesture.tick();        // recognize hand gestures → gesture_<id> bus signals
  // Hand cursor — cheap no-op unless enabled. Sits between gesture and
  // chordmode so a claim made this frame is respected this frame. DEV-gated
  // while under construction, and gated HERE rather than inside uicontrol:
  // hiding the button does not switch the feature off, and the setting
  // persists, so without this a clap would arm an invisible cursor that
  // silently claims a hand away from the instrument.
  if (devmode.enabled) uicontrol.tick();
  chordmode.tick();      // cheap no-op unless chord mode is enabled
  playalong.tick();      // cheap no-op unless a song is running
  updateSigPanel();
  // Mic meter: the one piece of feedback that tells you the browser is actually
  // hearing you, which is otherwise invisible until you have wired a cable.
  if (micSource.active) {
    const f = document.getElementById('mic-meter-fill');
    if (f) f.style.width = `${(micSource.level * 100).toFixed(1)}%`;
  }
  updateMapperBars();
  if (engine.started) updateAudioSliders();
  drawViz();
  shader.render();       // cheap no-op unless the shader panel is active
  updateFsOverlay();     // cheap no-op unless fullscreen is active
  updateGamePanel();     // cheap no-op unless a song is running
  updateUicOverlay();    // cheap no-op unless the hand cursor is live
  updateStage();         // cheap no-op unless the gesture stage is up
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
    // A preset chosen while the camera was off asked for face or gaze; now
    // there is a stream to run them on.
    applyFaceIntent();
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
      // Recorded here rather than inside setFace/setGaze: those also run when
      // the camera stops, and putting the camera down is not a decision to
      // stop using your eyebrows.
      rememberFaceIntent(faceSource.faceOn, faceSource.gazeOn);
      syncSigGroups();   // face/gaze groups expand or fold away with their tracker
      toast(on ? `${label} tracking ON` : `${label} tracking off`);
    } catch (err) {
      toast(`Could not start ${label.toLowerCase()} tracking: ` + err.message);
    }
    btn.disabled = false;
  });
};
// ── Microphone ───────────────────────────────────────────────────────────
const micBtn = document.getElementById('mic-btn');
if (micBtn) {
  if (!micSource.supported) {
    micBtn.disabled = true;
    micBtn.title = 'No microphone API in this browser';
  }
  micBtn.addEventListener('click', async () => {
    micBtn.disabled = true;
    try {
      const on = await micSource.toggle();
      micBtn.textContent = on ? 'ON' : 'OFF';
      micBtn.classList.toggle('on', on);
      micBtn.setAttribute('aria-pressed', String(on));
      // Signals only exist once the mic has been started, so the panel has to
      // be rebuilt to list them — same as the camera does when it starts.
      buildSigPanel();
      if (on) toast('Microphone on — mic_level, mic_pitch, mic_clarity, mic_bright');
    } catch (err) {
      // Denial is the common case and deserves a real explanation, not silence:
      // the browser prompt may have been dismissed minutes ago.
      toast(err?.name === 'NotAllowedError'
        ? 'Microphone permission denied — allow it in your browser’s site settings'
        : `Microphone unavailable: ${err?.message ?? err}`);
    } finally {
      micBtn.disabled = false;
    }
  });
}

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

// ── Developer mode ───────────────────────────────────────────────────────
// The toggle itself lives in the settings popover (ui/settings.js), which is
// built lazily — so the button is wired there, where it exists, rather than
// looked up here at startup where it does not.
//
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
// Same rule for the hand cursor: an armed hand is one the instrument has lost,
// and leaving that in place with the button gone is a hand that stops playing
// for no reason a player can see. Disarmed, not disabled — the HAND CURSOR
// setting is the player's, and DEV should gate reach, not overwrite choices.
devmode.onChange(on => { if (!on) uicontrol.disarmAll(); });

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

initHotkeys({
  mute:   () => { toggleMute(); },
  // The cursor key is the keyboard's version of the clap: opens the arming
  // window when nothing is armed, and is the panic key — disarm everything,
  // one press — when anything is.
  // …and inert outside DEV, for the same reason the tick is: it is the one
  // way in that does not go through a button we can hide.
  cursor: () => { if (devmode.enabled) uicontrol.hotkey(); },
});
onBindingChange(syncMuteUI);    // rebinding the key relabels the button and banner
syncMuteUI();                   // muted from the first paint, before the graph exists
startAudio();

// ── Mapper buttons ───────────────────────────────────────────────────────
// PRESET opens a menu of starting patches; each reports what it still needs
// switched on (camera / face / gaze) rather than loading silently.
initPresetMenu({
  onApply: async (preset, missing) => {
    renderMapper();
    // Choosing a patch from the menu is the same statement the first-run picker
    // makes, so it earns the same tour — offered once per mode, and silently
    // skipped for anyone who has already seen it.
    offerTourForMode('osc');
    const changed = await applyTrackers(trackersFor(preset));
    const bits = [preset.hint];
    if (changed.length) bits.push(changed.join(', '));
    if (missing.length) bits.push(`switch on ${missing.join(' + ')}`);
    toast(`${preset.name} — ${bits.join(' · ')}`);
  },
  // A saved configuration is a whole snapshot, not a patch, so it restores the
  // way a loaded file does rather than the way a preset does — same call, same
  // refresh, same reload rule. Anything less would make "the setup I named"
  // come back as only part of itself.
  onApplyConfig: name => {
    const entry = findConfig(name);
    if (!entry) { toast(`No saved setup called “${name}”`); return; }
    const { ok, uiChanged } = preset.applyAll(entry.snap);
    if (!ok) { toast(`Could not restore “${name}”`); return; }
    refreshFromState();
    preset.saveLocal();
    if (uiChanged) {
      // Theme and tracker state are read at startup by the modules that own
      // them — the same reason LOAD reloads.
      toast(`${name} — restoring`);
      setTimeout(() => location.reload(), 700);
    } else {
      toast(`${name} — restored`);
    }
  },
  state: () => ({
    camera: cvSource.running,
    face:   faceSource.faceOn,
    gaze:   faceSource.gazeOn,
  }),
});

// Switch every tracker to what a patch actually uses. Loading a face patch with
// hands and pose still running costs two models' worth of frame budget for
// cables that do not exist, and leaves the signals panel full of numbers the
// patch ignores — so this turns things OFF as well as on.
//
// The camera is deliberately not started here: that is the user's call, and
// the menu says so. Face and gaze intent is remembered until it can be applied,
// because their model needs a running stream.
// Seeded from the last choice made, so a setup arriving by shared link or
// saved file brings its trackers with it. The camera is still the user's to
// start; when they do, applyFaceIntent turns on whatever the patch asked for.
// Without this the mapping would travel and the model feeding it would not —
// a patch wired to `brow_raise` that sits there silent.
let pendingFace = savedFaceIntent();
async function applyTrackers(want) {
  const changed = [];
  const before = { handsL: cvSource.handsL, handsR: cvSource.handsR, pose: cvSource.poseOn };
  cvSource.setTracking({ handsL: want.handsL, handsR: want.handsR, pose: want.pose });
  syncAllTracking();
  const hadHands = before.handsL || before.handsR;
  const hasHands = want.handsL || want.handsR;
  if (hadHands !== hasHands) changed.push(hasHands ? 'hands on' : 'hands off');
  if (before.pose !== want.pose) changed.push(want.pose ? 'pose on' : 'pose off');

  pendingFace = { face: want.face, gaze: want.gaze };
  rememberFaceIntent(want.face, want.gaze);
  changed.push(...await applyFaceIntent());
  return changed;
}

// Face and gaze need a running camera, so a preset chosen before the camera
// starts leaves its intent here and the camera-start path applies it.
async function applyFaceIntent() {
  if (!pendingFace || !cvSource.running) return [];
  const { face, gaze } = pendingFace;
  pendingFace = null;
  const changed = [];
  try {
    if (faceSource.faceOn !== face) { await faceSource.setFace(face); changed.push(face ? 'face on' : 'face off'); }
    if (faceSource.gazeOn !== gaze) { await faceSource.setGaze(gaze); changed.push(gaze ? 'gaze on' : 'gaze off'); }
  } catch (err) {
    toast('Could not switch face tracking: ' + err.message);
  }
  document.getElementById('face-btn')?.classList.toggle('on', faceSource.faceOn);
  document.getElementById('gaze-btn')?.classList.toggle('on', faceSource.gazeOn);
  syncSigGroups();
  return changed;
}

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
initSettings();           // ⚙ theme + hotkeys: how the tool looks and is driven
initUidriver();           // hand cursor → real UI effects (adapter table)
initUicontrol();          // hand-cursor overlay, arming window, 🖐 button
// A clap needs both hands tracked; with exactly one ✋ toggle on, arming
// falls back to a long raised-open dwell of that hand. The cursor asks
// rather than imports, so cv.js stays the only module that owns the flags.
uicontrol.setSingleSide(() =>
  cvSource.handsL !== cvSource.handsR ? (cvSource.handsL ? 'L' : 'R') : null);
initStage();              // fullscreen gesture stage (DEV, under construction)
initShare();              // SHARE → a QR code of this setup
initModelPanel();         // dev-mode pose model comparison panel
initTutorial();           // guided tour (? button; auto-offers on first visit)
const hadSession = preset.restoreLocal();   // last session's mappings + settings
// …which may have just come from a scanned QR code. A setup that arrived that
// way gets the tour for what it actually is — not the full one, and only the
// first time this particular link is followed.
const openedShare = announceSharedLink();

// First visit: ask what to play rather than opening on one oscillator with
// nothing wired to it. The tour waits its turn — two modals at once is not a
// welcome. Automation skips the picker for the same reason it skips the tour:
// every headless suite starts with empty storage, and a modal over the app
// would break all of them. The dedicated check overrides navigator.webdriver
// so the real path is still exercised.
if (shouldOfferStart({ hasSession: hadSession, sharePending: isConsumingShare() })
    && !navigator.webdriver) {
  openStartPicker({
    applyTrackers,
    onDone: s => {
      refreshFromState();
      preset.saveLocal();
      toast(`${s.name} — ${s.hint}`);
      maybeOfferTour(s.mode);          // the tour for the way of playing chosen
    },
  });
} else if (openedShare) {
  // A setup that arrived by link gets the tour for what the link actually
  // brought — and only the first time that link is followed. Reopening a QR
  // pinned to a wall, or reloading, lands you on a setup that is already
  // yours; being walked through it again is something to dismiss.
  if (openedShare.first) offerTourForSharedSetup();
} else {
  maybeOfferTour();
}
renderMapper();
// Shader controls belong with the patchbay — the shader reads signals and
// mappings, so it sits beside the wiring rather than among synth parameters.
// Rendered once: renderMapper() re-runs on every rewire.
const shaderHost = document.getElementById('shader-host');
if (shaderHost) { shaderHost.innerHTML = shaderSectionHTML(); wireShaderSection(); }
enhanceSections();        // wrap every section: own container, scroller, resize grip
loop();

// Say which build this is, once, on startup. The cheapest possible answer to
// "am I running a cached version?" — and the only one available on a phone
// without opening a console, short of the line in the settings popover.
buildInfo().then(b => console.info(
  `%cMotionMuse%c build ${buildLabel(b)}${b.source === 'header' ? ' (from Last-Modified; no build.json)' : ''}`,
  'color:#00e5cc;font-weight:600', 'color:inherit'));
