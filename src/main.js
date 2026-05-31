import { cvSource }                        from './cv.js';
import { engine }                           from './engine.js';
import { mapper }                           from './mapper.js';
import { setStatus, toast }                 from './ui/status.js';
import { buildSigPanel, updateSigPanel }    from './ui/signals.js';
import { renderMapper, updateMapperBars }   from './ui/mapper-ui.js';
import { renderAudioPanel, updateAudioSliders } from './ui/audio-ui.js';
import { drawViz }                          from './ui/viz.js';

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

// ── Init ─────────────────────────────────────────────────────────────────
renderMapper();
loop();
