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
import { renderMapper, updateMapperBars, initMapperUI } from './ui/mapper-ui.js';
import { registerControls, syncControls, onControlChange, defineControls } from './controls.js';
import { renderAudioPanel, updateAudioSliders } from './ui/audio-ui.js';
import { drawViz }                          from './ui/viz.js';
import { initFullscreen, updateFsOverlay, fullscreen } from './ui/fullscreen.js';
import { initCamBadge, updateCamBadge }     from './ui/cam-badge.js';
import { playalong }                        from './playalong.js';
import { initPlayalongUI, updateGamePanel } from './ui/playalong-ui.js';
import { gesture }                          from './gesture.js';
import { chordmode }                        from './chordmode.js';
import { radial }                           from './radial.js';
import { metronome }                        from './metronome.js';
import { graph }                            from './graph.js';
import { watchRanges, syncNumbers }         from './ui/numeric.js';
import { devmode }                          from './devmode.js';
import { shader }                           from './shader.js';
import { audioSession }                     from './audiosession.js';
import { initDonate }                       from './ui/donate.js';
import { initModelPanel }                   from './ui/model-ui.js';
import { initPresetMenu }                   from './ui/preset-menu.js';
import { findConfig, setCurrentConfig,
         clearCurrentConfig }               from './saved.js';
import { initHeaderHelp }                    from './ui/docpop.js';
import { initCamDiag, diag }                from './ui/camdiag.js';
import { changed as docsChanged }           from './ui/nodedocs.js';
import { initHotkeys, keyLabel, getBinding, onBindingChange } from './ui/hotkeys.js';
import { initWorkspace, relayout, adoptSections, openAddMenu } from './ui/workspace.js';
import { initGroupVolume, syncGroupGains }  from './ui/group-volume.js';
import { shaderSectionHTML, wireShaderSection, setShaderAddHandler } from './ui/shader-ui.js';
import { initTheme }                        from './ui/theme.js';
import { initSettings }                     from './ui/settings.js';
import { initCamSticky }                    from './ui/cam-sticky.js';
import { initChordCables }                  from './chordcables.js';
import { initShare, consumeSharedLink, announceSharedLink, isConsumingShare } from './ui/share.js';
import { shouldOfferStart, openStartPicker } from './ui/firstrun.js';
import { uicontrol }                        from './uicontrol.js';
import { initUidriver }                     from './ui/uidriver.js';
import { initUicontrol, updateUicOverlay }  from './ui/uicontrol-ui.js';
import { initStage, updateStage }           from './ui/stage-ui.js';
import { tickLooperUI, pedalPressed }       from './ui/looper-ui.js';
import { looper }                           from './looper.js';
import * as preset                          from './preset.js';
import { NEWER_SETUP }                      from './presetformat.js';

// Before anything else runs, so an early failure is on the log too (?debug).
initCamDiag({ buildInfo, buildLabel });

// ── A shared setup, if this page was opened from a QR code / link ────────
// First thing: it applies the state, persists it and reloads without the
// fragment, so the sooner it runs the less of the old setup flashes past.
consumeSharedLink();

// Switches and choices (filter type, key, tempo…) are input sockets too.
// Registered before the audio panel first renders and before any saved
// state is replayed, so both find the parameters they refer to.
registerControls();

// ── Main RAF loop ────────────────────────────────────────────────────────
//
// The whole body runs inside a try/catch, and requestAnimationFrame is
// scheduled unconditionally at the end — in `finally`, not after the last
// line. Before this, one uncaught exception anywhere in the frame (a bad
// preset, a malformed cable, any bug in any tick) meant this function threw
// before ever reaching its own reschedule call, which silently ended the
// loop for good: no more audio parameter updates, no more visualiser, no
// more per-frame UI sync — the instrument going dead while every ordinary
// click handler (mute, a gesture picker's <select>) kept firing, which reads
// as "the whole UI stopped responding" precisely because the one thing that
// actually stopped was invisible. A frame that fails now logs the error and
// is simply a frame that did less; the next one still arrives.
function loop() {
  try {
    mapper.tick();
    // Function nodes, after the cables have written their inputs: a chain of
    // nodes settles inside the frame; only the hop through a cable is a frame
    // behind, which at 60 fps sits under the One-Euro smoothing every camera
    // signal already carries.
    graph.tick();
    micSource.tick();      // cheap no-op unless the mic is on
    gesture.tick();        // recognize hand gestures → gesture_<id> bus signals
    // Hand cursor — cheap no-op unless enabled. Sits between gesture and
    // chordmode so a claim made this frame is respected this frame. DEV-gated
    // while under construction, and gated HERE rather than inside uicontrol:
    // hiding the button does not switch the feature off, and the setting
    // persists, so without this a clap would arm an invisible cursor that
    // silently claims a hand away from the instrument.
    if (devmode.enabled) uicontrol.tick();
    // The metronome BEFORE the play modes: a beat that lands this frame must be
    // visible to the beat-sampled volume modes this frame, not next.
    metronome.tick();
    chordmode.tick();      // cheap no-op unless gesture mode is enabled
    radial.tick();         // cheap no-op unless radial mode is enabled
    playalong.tick();      // cheap no-op unless a song is running
    // The pedal, after the trackers have published this frame's signals and
    // before anything draws: a nod detected now should move the transport now,
    // not one frame late — a loop point is a moment, and a frame is 33 ms of it.
    if (pedalPressed()) looper.pedal();
    tickLooperUI();
    updateSigPanel();
    // Sliders' typed twins follow their slider, whatever moved it — a drag, a
    // cable, a preset load (see ui/numeric.js).
    syncNumbers();
    // Mic meter: the one piece of feedback that tells you the browser is actually
    // hearing you, which is otherwise invisible until you have wired a cable.
    if (micSource.active) {
      const f = document.getElementById('mic-meter-fill');
      if (f) f.style.width = `${(micSource.level * 100).toFixed(1)}%`;
    }
    updateMapperBars();
    if (engine.started) updateAudioSliders();
    drawViz();
    shader.render();       // cheap no-op unless the shader panel is active; it
                           // recompiles only when the node graph's shape changed
    updateFsOverlay();     // cheap no-op unless fullscreen is active
    updateCamBadge();      // which saved setup is playing
    updateGamePanel();     // cheap no-op unless a song is running
    updateUicOverlay();    // cheap no-op unless the hand cursor is live
    updateStage();         // cheap no-op unless the gesture stage is up
  } catch (err) {
    console.error('MotionMuse: frame skipped —', err);
  } finally {
    requestAnimationFrame(loop);
  }
}

// ── Header button labels ─────────────────────────────────────────────────
// Buttons whose caption changes carry a hidden .btn-sizer holding the longest
// caption, so writing the visible .btn-text can't change the button's width.
// Writing button.textContent directly would delete the sizer.
const setLabel = (btn, text) => {
  const t = btn.querySelector('.btn-text');
  if (t) t.textContent = text; else btn.textContent = text;
};

// ── Camera: START is the blank frame, STOP is on the picture ─────────────
//
// Two elements rather than one toggle, because they are never both meaningful:
// the target to press when there is no picture is the whole empty frame, and
// once there IS a picture that target is gone — covering the view with a
// button would be covering the instrument.
function stopCamera() {
  cvSource.stopCamera();                 // releases the camera hardware
  faceSource.setFace(false);             // face/gaze read the same stream
  faceSource.setGaze(false);
  ['face-btn', 'gaze-btn'].forEach(id => {
    const b = document.getElementById(id);
    b.disabled = true; b.classList.remove('on');
  });
  setStatus('', 'STOPPED');
  setLabel(document.getElementById('cv-btn'), 'START CAMERA');
  document.body.classList.remove('cam-on');
}
document.getElementById('cv-stop').addEventListener('click', stopCamera);

// Starting it happens in two stages, and the order matters more than anything
// else in this function.
//
// The camera is asked for first, on its own, with nothing awaited in front of
// it. The models are ~15MB and used to load first, which meant the permission
// prompt — the only thing that looks to a person like the camera starting —
// arrived tens of seconds after the tap on a phone connection, if at all: the
// prompt needs transient user activation, and that is long gone by then.
// Reported as the camera simply not starting when you press the frame.
//
// So: stream, picture, THEN models. Tracking joins the live picture a few
// seconds later (cvSource.loop runs with whichever models exist), and if the
// models fail the camera stays up as a camera rather than the whole thing
// being torn down — the signals it can't fill are the only loss.
let starting = false;
async function startCamera() {
  const btn = document.getElementById('cv-btn');
  diag(`startCamera() — running=${cvSource.running} starting=${starting}`);
  if (cvSource.running || starting) return;   // the picture hides this button anyway
  starting = true;
  btn.disabled = true;
  setLabel(btn, 'ALLOW CAMERA…');
  setStatus('loading', 'ASKING FOR CAMERA…');
  // A permission request the browser never answers is the one failure with
  // no error to show: no prompt appears (an in-app browser, a prompt the OS
  // swallowed, one already dismissed), the promise simply never settles, and
  // the frame sits on ALLOW CAMERA… forever. Say so after a few seconds.
  const watchdog = setTimeout(() => {
    diag('getUserMedia: still no answer after 6 s');
    toast('Still waiting for the camera. If no permission prompt appeared, allow the camera for this site in your browser settings — or, in an app’s built-in browser, open the page in Safari or Chrome.', 10000);
  }, 6000);
  try {
    diag('getUserMedia: requested');
    await cvSource.startCamera();
    diag('getUserMedia: granted, picture up');
  } catch (err) {
    clearTimeout(watchdog);
    starting = false;
    diag(`getUserMedia: FAILED ${err?.name}: ${err?.message}`);
    setStatus('error', cameraError(err));
    setLabel(btn, 'RETRY');
    btn.disabled = false;
    // The header status chip carrying that message is `display: none` on
    // phones (see the max-width: 768px block in main.css) — without a toast
    // too, a failed start looks identical to a dead button: RETRY sits there
    // with no visible reason why.
    // The raw name and message go in too: they are what makes a report
    // from a phone diagnosable.
    toast(`Camera failed to start — ${cameraError(err)} (${err?.name ?? 'Error'}: ${err?.message ?? err})`, 8000);
    console.error(err);
    return;
  }
  clearTimeout(watchdog);
  starting = false;
  // The picture is live. Everything that depends on having a stream rather
  // than on having models happens now, not after the download.
  setLabel(btn, 'START CAMERA');
  btn.disabled = false;
  buildSigPanel();
  renderMapper();
  // Face & gaze tracking are opt-in once the camera is running: they load a
  // model onto the live stream, so their buttons in the TRACKING row wake
  // up here.
  document.body.classList.add('cam-on');
  document.getElementById('face-btn').disabled = false;
  document.getElementById('gaze-btn').disabled = false;
  // A preset chosen while the camera was off asked for face or gaze; now
  // there is a stream to run them on.
  applyFaceIntent();

  try {
    diag('models: loading');
    await cvSource.init();               // sets its own LOADING MODELS… status
    diag('models: loaded');
    if (cvSource.running) setStatus('active', 'CV ACTIVE');
  } catch (err) {
    diag(`models: FAILED ${err?.message}`);
    // Not fatal: you can see yourself, you just can't be tracked.
    if (cvSource.running) {
      setStatus('error', 'NO TRACKING: ' + err.message.slice(0, 22));
      // The status chip is hidden on phones; without this the picture would
      // be up and simply never track, with nothing saying why.
      toast(`Camera is on, but tracking failed to load (${err?.message ?? err})`, 8000);
    }
    console.error(err);
  }
}

// getUserMedia's failures are the ones a person can actually act on, and
// `NotAllowedError` on its own tells them nothing. Named rather than raw.
function cameraError(err) {
  const map = {
    NotAllowedError:    'CAMERA BLOCKED — ALLOW IT',
    NotFoundError:      'NO CAMERA FOUND',
    NotReadableError:   'CAMERA IN USE ELSEWHERE',
    OverconstrainedError: 'CAMERA UNSUPPORTED',
    SecurityError:      'CAMERA NEEDS HTTPS',
    NoMediaDevices:     'THIS BROWSER GIVES PAGES NO CAMERA — OPEN IN SAFARI OR CHROME',
  };
  return map[err?.name] ?? 'ERROR: ' + String(err?.message ?? err).slice(0, 30);
}
document.getElementById('cv-btn').addEventListener('click', startCamera);
// The whole blank frame starts it, decided by WHERE the finger lifted rather
// than by which element Safari says was touched.
//
// Reported on an iPhone: pressing START CAMERA changed nothing at all — not
// even the caption, which the start sets before anything else. So the tap
// never reached the button. On a phone the picture is lifted into a strip
// in a zero-height sticky dock at the top of the scrolling column
// (ui/cam-sticky.js), and WebKit's touch hit-testing is known to misplace
// content that overflows a composited, zero-size box like that: the touch is
// delivered to whatever lies underneath, or nowhere useful. Chromium routes
// it correctly, which is why no desktop or headless test ever saw it.
//
// So element targeting is not trusted here. A touch that ends (or a click
// that lands) inside the frame's on-screen rectangle, while there is no
// picture, starts the camera — whatever element the browser attributed it
// to. touchend counts as a user gesture in Safari, so the permission prompt
// is still allowed; `starting` makes the touchend and the click that follows
// it one start, not two. Controls drawn over the frame (FULL, KEYS…) keep
// their own taps.
const frameRect = () => {
  for (const id of ['cv-btn', 'cam-hold']) {
    const el = document.getElementById(id);
    if (el?.getClientRects().length) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return r;
    }
  }
  return null;
};
const inFrame = (x, y) => {
  const r = frameRect();
  return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};
const onFrameControl = t => !!t?.closest?.('button:not(#cv-btn), a, select, input, label, .cam-bar, .cam-toggles');
let touchFrom = null;
document.addEventListener('touchstart', e => {
  const t = e.changedTouches[0];
  touchFrom = t ? { x: t.clientX, y: t.clientY } : null;
}, { capture: true, passive: true });
document.addEventListener('touchend', e => {
  const t = e.changedTouches[0];
  if (!t || !touchFrom || cvSource.running || starting) return;
  const moved = Math.hypot(t.clientX - touchFrom.x, t.clientY - touchFrom.y) > 12;   // a scroll, not a tap
  if (moved || onFrameControl(e.target) || !inFrame(t.clientX, t.clientY)) return;
  diag(`touchend in frame at ${Math.round(t.clientX)},${Math.round(t.clientY)} → startCamera`);
  startCamera();
}, { capture: true, passive: true });
document.addEventListener('click', e => {
  if (cvSource.running || starting || e.target.closest?.('#cv-btn') || onFrameControl(e.target)) return;
  if (!inFrame(e.clientX, e.clientY) && !e.target.closest?.('#video-wrap, #cam-hold')) return;
  diag('click in frame → startCamera');
  startCamera();
}, true);

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
// A cable into the microphone's switch (src/controls.js) reports here once
// the mic has actually started or stopped; the button and the signal list
// follow the real state.
onControlChange(key => {
  if (key !== 'mic_on' || !micBtn) return;
  const on = micSource.active;
  micBtn.textContent = on ? 'ON' : 'OFF';
  micBtn.classList.toggle('on', on);
  micBtn.setAttribute('aria-pressed', String(on));
  buildSigPanel();
});
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
      syncControls();
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

// The camera and its trackers as inputs (their state is here). A tracker
// switch follows its cable; face and gaze need a running camera, so a cable
// into them while it is off is honoured when it starts. The camera itself
// remembers what the cable last asked, since a refused start never catches
// up with it.
const trackCtl = (label, get, set) => ({
  label, min: 0, max: 1, toggle: true,
  read: () => (get() ? 1 : 0),
  apply: v => { const on = Math.round(v) >= 1; if (on === !!get()) return; set(on); },
});
defineControls({
  camera_on: {
    label: 'Camera', min: 0, max: 1, toggle: true,
    read: () => (cvSource.running ? 1 : 0),
    apply: (() => {
      let last = null;
      return v => {
        const on = Math.round(v) >= 1;
        if (on === last) return;
        last = on;
        if (on && !cvSource.running) startCamera();
        else if (!on && cvSource.running) stopCamera();
      };
    })(),
  },
  track_hands_l: trackCtl('Left Hand',  () => cvSource.handsL, on => { cvSource.setTracking({ handsL: on }); syncAllTracking(); }),
  track_hands_r: trackCtl('Right Hand', () => cvSource.handsR, on => { cvSource.setTracking({ handsR: on }); syncAllTracking(); }),
  track_pose:    trackCtl('Pose',       () => cvSource.poseOn, on => { cvSource.setTracking({ pose: on }); syncAllTracking(); }),
  track_face:    trackCtl('Face', () => faceSource.faceOn, on => {
    rememberFaceIntent(on, faceSource.gazeOn);
    if (cvSource.running) faceSource.setFace(on).then(syncAllTracking).catch(() => {});
  }),
  track_gaze:    trackCtl('Gaze', () => faceSource.gazeOn, on => {
    rememberFaceIntent(faceSource.faceOn, on);
    if (cvSource.running) faceSource.setGaze(on).then(syncAllTracking).catch(() => {});
  }),
});
// The mute switch on the Output node, as a cable moves it.
onControlChange(key => { if (key === 'mute') syncMuteUI(); });
// Whatever a click or a change did to the instrument, the parameters that
// mirror its switches and choices read it back — one listener, every panel.
document.addEventListener('click',  () => syncControls(), true);
document.addEventListener('change', () => syncControls(), true);

// ── Developer mode ───────────────────────────────────────────────────────
// The toggle itself lives in the settings popover (ui/settings.js), which is
// built lazily — so the button is wired there, where it exists, rather than
// looked up here at startup where it does not.
//
// Dev mode reveals whole nodes (MODELS, Shader), and the frames around them
// are measured from what is visible — so they are re-measured here.
devmode.onChange(() => relayout());

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

// ── Audio: starts with the page, sound on ────────────────────────────────
// The engine used to wait behind a button, which meant every control in the
// audio panel was absent until you found it — you couldn't set up a patch and
// then start playing, you had to start first and configure while it ran. Now
// the graph is built at load so everything is manipulable immediately. The
// output starts unmuted; the browser keeps it silent until the first gesture.
//
// The button is therefore a mute toggle, not a power switch.
const audioBtn = document.getElementById('audio-btn');
const vizMuted = document.getElementById('viz-muted');

// One function owns every visible trace of mute state, so the button, the
// banner and the assistive-tech state can't drift apart.
function syncMuteUI() {
  const m = engine.muted;
  // An icon, not a caption: it sits on the picture now, where the shortest
  // thing that still says which state you are in is the right size.
  setLabel(audioBtn, m ? '🔇' : '🔊');
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
  const nowMuted = engine.setMuted(!engine.muted);
  // On an iPhone this click is also what decides whether the Ring/Silent
  // switch applies to us — see audiosession.js. It hangs off unmuting rather
  // than off startup because holding the session is not free: it stops
  // whatever the phone was already playing.
  if (nowMuted) audioSession.release(); else audioSession.hold();
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
// Sound is on by default, so this first gesture is also when an iPhone must
// be told this page plays media — otherwise the Ring/Silent switch silences
// it (see audiosession.js). Only if still unmuted: someone who muted before
// touching anything asked for silence.
const wakeAudio = () => {
  engine.resume();
  if (!engine.muted) audioSession.hold();
};
['pointerdown', 'keydown'].forEach(ev =>
  document.addEventListener(ev, wakeAudio, { once: true, capture: true }));

// Coming back to a backgrounded tab. The browser paused the camera's <video>
// on the way out and does not un-pause it on the way in, which is a black
// frame AND a frozen instrument — the inference loop is gated on the video's
// clock, so the signals stop moving while everything still claims to be
// running (see cvSource.restore).
//
// Three events rather than one, because they mean different things and a
// phone does not always send all of them: `visibilitychange` is the tab or
// app switch, `pageshow` is a restore from the back/forward cache, and
// `focus` catches a window that was merely behind another one. restore() is
// idempotent and cheap when there is nothing to do, so the overlap is free.
const restoreCamera = () => { if (!document.hidden) cvSource.restore(); };
document.addEventListener('visibilitychange', restoreCamera);
addEventListener('pageshow', restoreCamera);
addEventListener('focus', restoreCamera);

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
syncMuteUI();                   // mute state from the first paint, before the graph exists
startAudio();

// ── Mapper buttons ───────────────────────────────────────────────────────
// PRESET opens a menu of starting patches; each reports what it still needs
// switched on (camera / face / gaze) rather than loading silently.
initPresetMenu({
  onSave: saveSetup,
  onLoad: loadSetup,
  onApply: async (preset, missing) => {
    // A built-in patch is not one of your named setups: whatever was playing
    // has been replaced, so the name on the camera view goes with it — and so
    // do the previous patch's unwired nodes.
    clearCurrentConfig();
    renderMapper();
    // Choosing a patch from the menu is a statement about what you are about
    // to do, which is what decides whose `?` is worth pressing — so the help
    // flags are recomputed. Nothing opens; the relevant buttons just start
    // asking.
    docsChanged();
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
    // This IS what you are playing now — the camera view says so.
    setCurrentConfig(name);
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
  if (!cvSource.running) return [];
  // A pending intent is a one-shot: a preset or a starting point asking for
  // face/gaze before there was a stream to run them on. Falling back to the
  // SAVED intent is what makes tracking resume when the camera does —
  // stopping the camera switches face and gaze off (they read that stream),
  // but putting the camera down is not a decision to stop using your
  // eyebrows, which is exactly why the choice is remembered separately.
  const { face, gaze } = pendingFace ?? savedFaceIntent();
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

// The Oscillators node follows the bank: a preset voiced for two oscillators
// grows the bank as it loads, and its cables need the second row's sockets
// to end on. Deferred a tick, so a restore that sets the count and then the
// parameters is drawn once, after both.
let oscRedraw = null;
engine.onOscCountChange(() => {
  if (oscRedraw) return;
  oscRedraw = setTimeout(() => {
    oscRedraw = null;
    renderAudioPanel();
    renderMapper();
  }, 0);
});

// SAVE and LOAD sit at the foot of the PRESET menu (initPresetMenu above
// calls these). Declarations, so the menu can be set up before this point.
function saveSetup() {
  preset.downloadFile();
  preset.saveLocal();
  toast('Settings saved');
}
const loadFile = document.getElementById('load-file');
function loadSetup() { loadFile.click(); }
loadFile.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { uiChanged, newer } = await preset.loadFromFile(file);
    refreshFromState();
    preset.saveLocal();
    if (newer) {
      toast(`${NEWER_SETUP} — ${uiChanged ? 'reloading' : 'loaded'}`);
      // Longer than the usual 700ms: this is the one message worth reading
      // before the reload takes it away.
      if (uiChanged) setTimeout(() => location.reload(), 2500);
    } else if (uiChanged) {
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

// Keep the camera's overlay canvases matched to the picture as its node is
// resized (they are otherwise sized once at camera start).
function fitOverlays() {
  const wrap = document.getElementById('video-wrap');
  if (!wrap) return;
  const fit = () => ['overlay', 'face-overlay'].forEach(id => {
    const c = document.getElementById(id);
    if (!c) return;
    if (c.width !== wrap.offsetWidth)  c.width  = wrap.offsetWidth;
    if (c.height !== wrap.offsetHeight) c.height = wrap.offsetHeight;
  });
  new ResizeObserver(fit).observe(wrap);
}

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
metronome.registerSignals();   // the beat clock is wirable like any signal
// Every slider in the app gets a typed twin, including panels that rebuild
// themselves and any slider added later — see ui/numeric.js.
watchRanges();
initChordCables();        // gesture mode's shapes are cables into its degrees
initGroupVolume();        // before the canvas: group faders need to know what sounds
initWorkspace();          // the canvas: every section becomes a node on it
syncGroupGains();         // …and the engine hears the layout that was restored
initMapperUI();           // sockets and cables on that canvas
buildSigPanel();          // every signal is an output socket on its node, camera or not
fitOverlays();            // landmark canvases follow the camera node's size
initFullscreen();         // fullscreen camera view + keyboard overlay
initCamSticky();          // in the column, the picture rides the top of the screen
initCamBadge();           // the saved setup's name, captioning the frame
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
initHeaderHelp();         // the header ? — how the app works, as one short card
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
      docsChanged();               // the `?`s for the way of playing chosen
    },
  });
} else if (openedShare) {
  // A link is an invitation to PLAY, not to read a patchbay: someone pointed
  // a phone at a QR code and the next thing they should see is themselves,
  // full frame, with one thing to press. So a shared setup opens straight
  // into the fullscreen camera view.
  fullscreen.open();
  // …and the help waits for them to come back out of it. A `?` pulsing
  // behind a fullscreen camera is pulsing at nobody, and only the first time
  // that link is followed: reopening a QR pinned to a wall lands you on a
  // setup that is already yours.
  if (openedShare.first) {
    let flagged = false;
    fullscreen.onChange(active => {
      if (active || flagged) return;
      flagged = true;
      docsChanged();
    });
  }
} else {
  docsChanged();
}
renderMapper();
// Shader controls belong with the patchbay — the shader reads signals and
// mappings, so its node sits beside the wiring rather than among synth
// parameters. Rendered once, then adopted onto the canvas like any section.
const shaderHost = document.getElementById('shader-host');
if (shaderHost) {
  // Deliberately NOT seeded with a starter patch. Shader nodes are nodes on
  // the same canvas as the instrument, and cables on that canvas are what
  // gets saved and shared — so populating the shader by default would put
  // four nodes and three cables into every patch, every saved setup and
  // every share link, for people who never open the panel. The panel's
  // STARTER button is one tap away and says so.
  // + NODE on the panel opens the canvas's own add menu, so there is one
  // place where nodes come from however you reach for them.
  setShaderAddHandler((x, y) => openAddMenu(x, y));
  shaderHost.innerHTML = shaderSectionHTML();
  wireShaderSection();
  adoptSections(shaderHost);
  // A saved patch may carry shader nodes; give them their shells.
  renderMapper();
}
loop();

// Say which build this is, once, on startup. The cheapest possible answer to
// "am I running a cached version?" — and the only one available on a phone
// without opening a console, short of the line in the settings popover.
buildInfo().then(b => console.info(
  `%cMotionMuse%c build ${buildLabel(b)}${b.source === 'header' ? ' (from Last-Modified; no build.json)' : ''}`,
  'color:#00e5cc;font-weight:600', 'color:inherit'));
