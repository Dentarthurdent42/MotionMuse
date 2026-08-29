import { engine }                    from '../engine.js';
import { mapper }                    from '../mapper.js';
import { renderMapper, PARAM_CATS }  from './mapper-ui.js';
import { SCALES, TUNINGS, NOTE_NAMES } from '../scale.js';
import { makeKbdView, midiOf, OSC_COLS } from './keyboard.js';
import { isDesktop } from './viewport.js';
import { STEP_OPTS, FLOOR_OPTS, EDGE_KEYS, GATE_AT_OPTS, GATE_AT_DEFAULT,
         makeDynamics } from '../dynamics.js';
import { enhanceSections } from './sections.js';
import { KITS, KIT_PARAM_KEYS, applyKit, currentKit, markCustom } from '../soundkit.js';
import { playalong } from '../playalong.js';
import { SONGS }     from '../songs.js';
import { gestureModeSection, wireGestureSections, updateGesturePanel } from './gesture-ui.js';
import { radialMenuSection, wireRadialSection, updateRadialPanel } from './radial-ui.js';
import { metronomeSection, wireMetronomeSection, updateMetronomePanel } from './metronome-ui.js';
import { looperSectionHTML, wireLooperSection } from './looper-ui.js';

const opts = (arr, sel) =>
  arr.map(v => `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`).join('');

// Gate threshold options, labelled with the value the player actually reads off
// a cable ("silent below 18%") rather than the internal rung position. The
// percentage is obtained by asking the real quantiser, not by re-deriving the
// ladder here, so a label can never drift from the behaviour it describes — and
// it has to be rebuilt whenever steps or floor change, since both move it.
const gateAtOpts = vq => GATE_AT_OPTS.map(p => {
  const pct = makeDynamics({ ...vq, gateAt: p }).gateGain * 100;
  return `<option value="${p}"${p === vq.gateAt ? ' selected' : ''}>`
       + `&lt; ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
       + `${p === GATE_AT_DEFAULT ? ' ·auto' : ''}</option>`;
}).join('');

// The panel's pitch-quantise keyboard (canvas #quant-kbd, recreated with the
// panel; the view looks it up by id on every draw).
const panelKbd = makeKbdView('quant-kbd', { height: () => isDesktop() ? 60 : 46 });
const sliderRefs = new Map();   // param key → {slider, valEl}, rebuilt per render

// Saved best score for the currently selected song+difficulty (idle display).
const bestLine = () => {
  const song = document.getElementById('song-select')?.value ?? playalong.lastSong;
  const diff = document.getElementById('diff-select')?.value ?? playalong.lastDiff;
  const b = playalong.bestFor(song, diff);
  return b ? `BEST ${b.score} · ${b.grade} · ${Math.round(b.acc * 100)}%` : '—';
};
// One marker per live oscillator, so the picker keeps telling the truth as the
// bank is resized rather than showing a fixed pair of dots.
const oscMidis = () => Array.from({ length: engine.getOscCount() },
  (_, i) => midiOf(engine.PARAMS[`osc${i + 1}_freq`].val));
const kbdOpts = () => {
  const t = engine.getTuning();
  return { root: t.root, scale: t.scale, markers: oscMidis() };
};

// Tick marks at the snap values, drawn on the track as background gradients
// (native <datalist> ticks are suppressed by our -webkit-appearance:none).
// Module scope because the volume ladder changes at runtime, so handlers have
// to repaint an existing slider's notches without a full re-render.
const tickCss = p => !p.snaps?.length ? '' : p.snaps.map(s => {
  const f = ((s - p.min) / (p.max - p.min) * 100).toFixed(2);
  return `linear-gradient(90deg,transparent calc(${f}% - 1.5px),var(--dim) calc(${f}% - 1.5px),var(--dim) calc(${f}% + 1.5px),transparent calc(${f}% + 1.5px))`;
}).join(',');

export function renderAudioPanel() {
  const panel = document.getElementById('audio-panel');
  const nOsc = engine.getOscCount();

  const tickBg = p => tickCss(p) ? ` style="background-image:${tickCss(p)}"` : '';

  const rangeRow = (key, p) => `
    <div class="ctrl-row">
      <span class="ctrl-lbl">${p.label}</span>
      <input type="range" class="apr" data-key="${key}"
        min="${p.min}" max="${p.max}" value="${p.val}"
        step="${((p.max - p.min) / 300).toPrecision(3)}"${tickBg(p)}>
      <span class="ctrl-val" id="av-${key}">${p.val.toFixed(p.unit === 'Hz' ? 0 : 2)}</span>
    </div>`;

  const waveBtn = (type, label, osc) =>
    `<button type="button" class="wave-btn" data-type="${type}" data-osc="${osc}">${label}</button>`;

  const vq = engine.getVolStep();
  const vqStepOpts = STEP_OPTS.map(s =>
    `<option value="${s}"${s === vq.steps ? ' selected' : ''}>${s} steps</option>`).join('');
  const vqFloorOpts = FLOOR_OPTS.map(f =>
    `<option value="${f}"${f === vq.floorDb ? ' selected' : ''}>${f} dB</option>`).join('');
  const vqEdgeOpts = EDGE_KEYS.map(k =>
    `<option value="${k}"${k === vq.edge ? ' selected' : ''}>${k.toUpperCase()}</option>`).join('');

  const t = engine.getTuning();

  const kitId = currentKit();
  const kitOpts = Object.entries(KITS)
    .map(([id, k]) => `<option value="${id}"${id === kitId ? ' selected' : ''}>${k.label}</option>`)
    .join('') + (kitId === 'custom' ? '<option value="custom" selected>Custom</option>' : '');

  const le = engine.getLeadEnv();
  const shep = engine.getShepard();
  const gv = playalong.view;
  const gameActive = gv.state === 'countdown' || gv.state === 'playing';

  // Gesture Mode leads the panel: it is a way of playing rather than a
  // setting, so someone who came to play by handshape should not have to
  // scroll past the timbre picker and the note game to reach it. A section
  // the user has dragged keeps the position they gave it — sections.js only
  // falls back to this markup order for hosts nobody has rearranged.
  panel.innerHTML = `
    ${gestureModeSection()}
    ${radialMenuSection()}
    ${metronomeSection()}
    <div class="audio-section">
      <div class="audio-section-label">Sound Kit</div>
      <select id="kit-select" title="Instrument timbre preset (synthesized)">${kitOpts}</select>
    </div>
    <div class="audio-section">
      <div class="audio-section-label">Play Along</div>
      <div class="scale-grid" style="grid-template-columns:1.6fr 1fr;">
        <select id="song-select" title="Song"${gameActive ? ' disabled' : ''}>
          ${SONGS.map(s => `<option value="${s.id}"${s.id === playalong.lastSong ? ' selected' : ''}>${s.name}</option>`).join('')}
        </select>
        <select id="diff-select" title="Difficulty"${gameActive ? ' disabled' : ''}>
          ${['easy', 'medium', 'hard'].map(d => `<option value="${d}"${d === playalong.lastDiff ? ' selected' : ''}>${d}</option>`).join('')}
        </select>
      </div>
      <div class="wave-btns" style="margin-top:4px;">
        <button type="button" class="wave-btn${gameActive ? ' on' : ''}" id="game-btn">${gameActive ? 'STOP' : 'PLAY'}</button>
        <button type="button" class="wave-btn${playalong.guide ? ' on' : ''}" id="guide-btn" title="Play a quiet guide melody">GUIDE</button>
      </div>
      <canvas id="game-canvas" class="game-canvas" style="display:${gv.state !== 'idle' ? 'block' : 'none'}"></canvas>
      <div id="game-score" class="quant-notes">${gv.state === 'idle' ? bestLine() : '—'}</div>
    </div>
    ${looperSectionHTML()}
    <div class="audio-section">
      <div class="audio-section-label">
        Pitch Quantize
        <button type="button" class="wave-btn${t.enabled ? ' on' : ''}" id="quant-toggle"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${t.enabled ? 'ON' : 'OFF'}</button>
      </div>
      <div class="scale-grid">
        <select id="scale-root"   title="Root note">${opts(NOTE_NAMES, t.root)}</select>
        <select id="scale-name"   title="Scale">${opts(Object.keys(SCALES), t.scale)}</select>
        <select id="scale-tuning" title="Tuning system">${opts(Object.keys(TUNINGS), t.system)}</select>
      </div>
      <canvas id="quant-kbd" class="quant-kbd" style="display:${t.enabled ? 'block' : 'none'}"></canvas>
      <div id="quant-notes" class="quant-notes">${t.enabled ? '' : '—'}</div>
    </div>
    <div class="audio-section">
      <div class="audio-section-label">
        Volume Quantize
        <button type="button" class="wave-btn${vq.enabled ? ' on' : ''}" id="vq-toggle"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${vq.enabled ? 'ON' : 'OFF'}</button>
      </div>
      <div class="scale-grid" style="grid-template-columns:1fr 1fr 1fr;">
        <select id="vq-steps" title="Loudness levels, silence included">${vqStepOpts}</select>
        <select id="vq-floor" title="Bottom of the ladder — the silence anchor when GATE is on">${vqFloorOpts}</select>
        <select id="vq-edge"  title="Attack / release speed at a level change">${vqEdgeOpts}</select>
      </div>
      <div class="wave-btns" style="margin-top:4px;">
        <button type="button" class="wave-btn${vq.gate ? ' on' : ''}" id="vq-gate"
             title="Make the bottom level true silence, so notes can be separated and re-attacked">GATE</button>
        <select id="vq-gate-at" style="flex:1 1 auto;min-width:0;"
                ${vq.gate ? '' : 'disabled'}
                title="Where the gate switches off, as a share of full volume. The ladder's own midpoint (·auto) is not always where you want the switch: with 2 steps it lands at 18%, so an on/off control flips very early. Raise it to move the switch later in the gesture.">${gateAtOpts(vq)}</select>
      </div>
      <div id="vq-level" class="quant-notes">${vq.enabled ? '' : '—'}</div>
      <!-- ADSR lives here rather than in its own section because this is where
           its trigger is: crossing up out of silence is the note-on and
           dropping to the bottom rung is the note-off. It REPLACES the edge
           preset above when on, which is why the select dims. -->
      <div class="audio-section-label" style="margin-top:8px;">
        Envelope
        <button type="button" class="wave-btn${le.enabled ? ' on' : ''}" id="lead-env-toggle"
             aria-pressed="${le.enabled}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;"
             title="Use a full ADSR instead of the fixed attack/release of the edge preset. Triggered by the volume gate: out of silence is a note-on, back to silence a note-off.">${le.enabled ? 'ADSR' : 'EDGE'}</button>
      </div>
      <div class="scale-grid" style="grid-template-columns:1fr 1fr 1fr 1fr;"
           ${le.enabled ? '' : 'aria-hidden="true"'}>
        ${['attack', 'decay', 'sustain', 'release'].map(k => `
          <label class="ctrl-lbl" style="display:flex;flex-direction:column;gap:2px;">
            ${k.slice(0, 3).toUpperCase()}
            <input type="range" class="lead-env" data-env="${k}"
              min="${engine.LEAD_ENV_RANGE[k][0]}" max="${engine.LEAD_ENV_RANGE[k][1]}"
              step="0.005" value="${le[k]}" ${le.enabled ? '' : 'disabled'}>
            <span class="ctrl-val" id="le-env-${k}">${k === 'sustain'
              ? Math.round(le[k] * 100) + '%' : le[k].toFixed(2) + 's'}</span>
          </label>`).join('')}
      </div>
    </div>
    <div class="audio-section" data-sec="oscillators">
      <div class="audio-section-label">Oscillators
        <div class="num-step" style="margin-left:auto;">
          <button class="wave-btn" id="osc-minus" type="button" aria-label="Remove an oscillator"
                  title="Remove the last oscillator"${nOsc <= 0 ? ' disabled' : ''}>−</button>
          <input type="number" id="osc-count" min="0" max="${engine.MAX_OSCS}" step="1"
                 value="${nOsc}" inputmode="numeric" aria-label="Number of oscillators"
                 title="How many oscillators the lead voice runs. Each gets its own pitch, detune, waveform and level. Zero leaves gesture mode playing on its own.">
          <button class="wave-btn" id="osc-plus" type="button" aria-label="Add an oscillator"
                  title="Add an oscillator"${nOsc >= engine.MAX_OSCS ? ' disabled' : ''}>+</button>
        </div>
      </div>
      ${Array.from({ length: nOsc }, (_, i) => `
        <div class="osc-row">
          <span class="osc-row-n" style="color:${OSC_COLS[i % OSC_COLS.length]}">${i + 1}</span>
          <div class="wave-btns" data-osc="${i}">
            ${waveBtn('sine','SIN',i)}${waveBtn('triangle','TRI',i)}
            ${waveBtn('sawtooth','SAW',i)}${waveBtn('square','SQR',i)}
          </div>
        </div>`).join('')}
      <div class="wave-btns" style="margin-top:4px;">
        <button type="button" class="wave-btn${shep.lead ? ' on' : ''}" id="shep-lead"
             aria-pressed="${shep.lead}"
             title="Shepard tones: each oscillator becomes a stack of octaves under a fixed loudness curve, so pitch rises or falls endlessly without ever leaving its register.">SHEPARD</button>
      </div>
      <div class="osc-hint">${nOsc
        ? (shep.lead
            ? 'Shepard: sweep pitch and it climbs forever — an octave returns you to the start'
            : 'Each has its own level: Osc1 Vol… under Parameters')
        : 'No lead oscillators — gesture mode plays on its own'}</div>
    </div>
    <div class="audio-section">
      <div class="audio-section-label">Filter Type</div>
      <div class="wave-btns" id="filt-types">
        ${['lowpass','highpass','bandpass','notch'].map(t =>
          `<button type="button" class="wave-btn" data-ftype="${t}">${t.slice(0, 3).toUpperCase()}</button>`
        ).join('')}
      </div>
    </div>
    <div class="audio-section">
      <div class="audio-section-label">Chord Filter Type</div>
      <div class="wave-btns" id="cfilt-types">
        ${['lowpass','highpass','bandpass','notch'].map(t =>
          `<button type="button" class="wave-btn" data-ftype="${t}">${t.slice(0, 3).toUpperCase()}</button>`
        ).join('')}
      </div>
    </div>
    <div class="audio-section" data-sec="sliders" style="border-bottom:none;">
      <div class="audio-section-label">Parameters</div>
      ${(() => {
        // Grouped by the SAME table the patchbay's add-output picker uses, so a
        // parameter is in the same place whichever way you go looking for it.
        // Sharing the table also means the two cannot drift: a new param has to
        // be categorised once, and tests/unit/param-cats.test.js already fails
        // the build if it is missing from that table.
        const listed = new Set();
        const groups = PARAM_CATS().map(([cat, keys]) => {
          const rows = keys.filter(k => engine.PARAMS[k]);
          rows.forEach(k => listed.add(k));
          return !rows.length ? '' : `
            <div class="param-group">
              <div class="param-group-name">${cat}</div>
              ${rows.map(k => rangeRow(k, engine.PARAMS[k])).join('')}
            </div>`;
        }).join('');
        // A param the table forgot still gets a slider — being uncategorised
        // should cost it a heading, not its control.
        const orphans = Object.entries(engine.PARAMS).filter(([k]) => !listed.has(k));
        return groups + (!orphans.length ? '' : `
          <div class="param-group">
            <div class="param-group-name">Other</div>
            ${orphans.map(([k, p]) => rangeRow(k, p)).join('')}
          </div>`);
      })()}
    </div>`;

  // Re-wrap: innerHTML above discarded the section containers, grips and
  // stored heights. Runs before the wiring below, so every handler attaches to
  // nodes that are already in their final place.
  enhanceSections(panel);

  const activateWave = (group, type) =>
    group.querySelectorAll('.wave-btn').forEach(b =>
      b.classList.toggle('on', (b.dataset.type ?? b.dataset.ftype) === type));

  // Selecting a kit applies it and refreshes the panel to reflect it.
  document.getElementById('kit-select').addEventListener('change', e => {
    if (applyKit(e.target.value)) renderAudioPanel();
  });

  // Play-along controls.
  document.getElementById('game-btn').addEventListener('click', () => {
    const st = playalong.view.state;
    if (st === 'countdown' || st === 'playing') { playalong.stop(); renderAudioPanel(); return; }
    if (st === 'finished') playalong.stop();     // clear results, then restart
    const ok = playalong.start(
      document.getElementById('song-select').value,
      document.getElementById('diff-select').value,
    );
    if (ok) renderAudioPanel();
  });
  document.getElementById('guide-btn').addEventListener('click', e => {
    playalong.setGuide(!playalong.guide);
    e.target.classList.toggle('on', playalong.guide);
  });
  // Show the saved best for the selected song+difficulty while idle.
  ['song-select', 'diff-select'].forEach(id =>
    document.getElementById(id).addEventListener('change', () => {
      if (playalong.view.state !== 'idle') return;
      const el = document.getElementById('game-score');
      if (el) el.textContent = bestLine();
    }));
  // Manual timbre tweaks flip the kit selection to "Custom" in place
  // (no full re-render — that would kill a slider mid-drag).
  const syncKitToCustom = () => {
    markCustom();
    const sel = document.getElementById('kit-select');
    if (!sel) return;
    if (!sel.querySelector('option[value="custom"]')) {
      sel.insertAdjacentHTML('beforeend', '<option value="custom">Custom</option>');
    }
    sel.value = 'custom';
  };

  // One handler for every slot's waveform buttons — the row count is a runtime
  // value, so the group's own data-osc says which oscillator it drives.
  document.querySelectorAll('.wave-btns[data-osc]').forEach(group => {
    group.querySelectorAll('.wave-btn').forEach(b => {
      b.addEventListener('click', () => {
        engine.setOscType(+group.dataset.osc, b.dataset.type);
        activateWave(group, b.dataset.type);
        syncKitToCustom();
      });
    });
  });

  // Bank size. Shrinking orphans any cable wired to a slot that no longer
  // exists — engine.set() ignores an unknown key, so it would go quiet rather
  // than break, but the patchbay would keep drawing a node for a parameter that
  // is gone. Prune those cables instead of leaving them to confuse.
  const setCount = n => {
    const before = engine.getOscCount();
    const after = engine.setOscCount(n);
    if (after === before) return;
    if (after < before) {
      mapper.mappings
        .filter(m => !engine.PARAMS[m.audioParam])
        .map(m => m.id)
        .forEach(id => mapper.remove(id));
      renderMapper();     // the pruned cables' nodes have to leave the canvas too
    }
    syncKitToCustom();
    renderAudioPanel();
  };
  // ── Shepard (lead) ─────────────────────────────────────────────────────
  // Re-renders because the hint line under the oscillator list changes with it,
  // and because engine.setShepard rebuilds the bank — the panel should reflect
  // the instrument it now actually is.
  document.getElementById('shep-lead')?.addEventListener('click', () => {
    engine.setShepard({ lead: !engine.getShepard().lead });
    renderAudioPanel();
  });

  // ── Lead ADSR ──────────────────────────────────────────────────────────
  document.getElementById('lead-env-toggle')?.addEventListener('click', () => {
    engine.setLeadEnv({ enabled: !engine.getLeadEnv().enabled });
    renderAudioPanel();          // the sliders enable/disable with it
  });
  document.querySelectorAll('.lead-env').forEach(el => {
    el.addEventListener('input', e => {
      const k = e.target.dataset.env;
      const v = engine.setLeadEnv({ [k]: +e.target.value })[k];
      const out = document.getElementById(`le-env-${k}`);
      if (out) out.textContent = k === 'sustain'
        ? `${Math.round(v * 100)}%` : `${v.toFixed(2)}s`;
    });
  });

  document.getElementById('osc-minus').addEventListener('click', () => setCount(engine.getOscCount() - 1));
  document.getElementById('osc-plus') .addEventListener('click', () => setCount(engine.getOscCount() + 1));
  const oscCountInput = document.getElementById('osc-count');
  // `change`, not `input`: typing "12" passes through "1", and re-rendering the
  // panel on every keystroke would tear the field out from under the caret.
  oscCountInput.addEventListener('change', e => setCount(e.target.value));
  document.getElementById('filt-types').querySelectorAll('.wave-btn').forEach(b => {
    b.addEventListener('click', () => {
      engine.setFilterType(b.dataset.ftype);
      activateWave(b.parentElement, b.dataset.ftype);
      syncKitToCustom();
    });
  });
  // Chord filter type — deliberately NOT part of kit matching: kits describe
  // the lead voice, and repainting the kit select because the chord bed went
  // bandpass would be noise.
  document.getElementById('cfilt-types').querySelectorAll('.wave-btn').forEach(b => {
    b.addEventListener('click', () => {
      engine.setChordFilterType(b.dataset.ftype);
      activateWave(b.parentElement, b.dataset.ftype);
    });
  });

  // Magnetic detent: dragging within ~1.5% of the range of a snap value locks
  // onto it. Applies only to user drags — mapped writeback never snaps.
  const snapTo = (p, v) => {
    if (!p.snaps) return v;
    const tol = 0.015 * (p.max - p.min);
    for (const s of p.snaps) if (Math.abs(v - s) <= tol) return s;
    return v;
  };
  // Scoped to the document, not the panel: enhanceSections() above may have
  // relocated a section to another column, so the sliders this render just
  // created are no longer guaranteed to be inside `panel`.
  document.querySelectorAll('.apr').forEach(el => {
    el.addEventListener('input', e => {
      const key = e.target.dataset.key;
      const p   = engine.PARAMS[key];
      let val = parseFloat(e.target.value);
      const s = snapTo(p, val);
      if (s !== val) { val = s; e.target.value = s; }   // detent the thumb too
      engine.set(key, val);
      const dispEl = document.getElementById(`av-${key}`);
      if (dispEl) dispEl.textContent = val.toFixed(p.unit === 'Hz' ? 0 : 2);
      if (KIT_PARAM_KEYS.has(key)) syncKitToCustom();
    });
  });

  // Pitch quantisation controls
  const quantToggle = document.getElementById('quant-toggle');
  const kbd = document.getElementById('quant-kbd');
  const redrawKbd = () => { panelKbd.invalidate(); panelKbd.draw(kbdOpts()); };
  quantToggle.addEventListener('click', () => {
    const on = !engine.getTuning().enabled;
    engine.setTuning({ enabled: on });
    quantToggle.classList.toggle('on', on);
    quantToggle.textContent = on ? 'ON' : 'OFF';
    kbd.style.display = on ? 'block' : 'none';
    if (on) redrawKbd();
    else document.getElementById('quant-notes').textContent = '—';
  });
  document.getElementById('scale-root')
    .addEventListener('change', e => { engine.setTuning({ root: e.target.value }); redrawKbd(); });
  document.getElementById('scale-name')
    .addEventListener('change', e => { engine.setTuning({ scale: e.target.value }); redrawKbd(); });
  document.getElementById('scale-tuning')
    .addEventListener('change', e => { engine.setTuning({ system: e.target.value }); redrawKbd(); });

  // Volume quantisation (stepped dynamics). Mutates in place like the pitch
  // handlers — a full re-render would kill an in-flight slider drag. The
  // volume slider's notches are baked into an inline style at render time, so
  // every change here has to repaint them or they'd silently lie.
  const vqToggle = document.getElementById('vq-toggle');
  const vqGate   = document.getElementById('vq-gate');
  const refreshVolTicks = () => {
    const r = sliderRefs.get('volume');
    if (r) r.slider.style.backgroundImage = tickCss(engine.PARAMS.volume) || 'none';
  };
  vqToggle.addEventListener('click', () => {
    const on = !engine.getVolStep().enabled;
    engine.setVolStep({ enabled: on });
    vqToggle.classList.toggle('on', on);
    vqToggle.textContent = on ? 'ON' : 'OFF';
    refreshVolTicks();
    if (!on) document.getElementById('vq-level').textContent = '—';
  });
  // The gate threshold's labels are percentages of full volume, so changing the
  // step count or the floor moves every one of them. Rebuilding the options
  // (rather than only the selection) keeps the numbers true; without this the
  // menu would keep advertising the thresholds of the previous ladder.
  const vqGateAt = document.getElementById('vq-gate-at');
  const refreshGateAt = () => { vqGateAt.innerHTML = gateAtOpts(engine.getVolStep()); };
  vqGate.addEventListener('click', () => {
    const on = !engine.getVolStep().gate;
    engine.setVolStep({ gate: on });
    vqGate.classList.toggle('on', on);
    vqGateAt.disabled = !on;      // nothing to place when there's no silence rung
    refreshVolTicks();
  });
  document.getElementById('vq-steps')
    .addEventListener('change', e => {
      engine.setVolStep({ steps: +e.target.value }); refreshVolTicks(); refreshGateAt();
    });
  document.getElementById('vq-floor')
    .addEventListener('change', e => {
      engine.setVolStep({ floorDb: +e.target.value }); refreshVolTicks(); refreshGateAt();
    });
  vqGateAt.addEventListener('change', e => { engine.setVolStep({ gateAt: +e.target.value }); });

  document.getElementById('vq-edge')
    .addEventListener('change', e => { engine.setVolStep({ edge: e.target.value }); });

  // Reflect the engine's actual waveform / filter selections (they may have
  // just been restored from a saved preset, not the factory defaults).
  // A kit's custom harmonic table ('custom:piano') matches none of the four
  // buttons, so a row can legitimately show nothing selected.
  document.querySelectorAll('.wave-btns[data-osc]').forEach(group =>
    group.querySelector(`[data-type="${engine.getOscType(+group.dataset.osc)}"]`)?.classList.add('on'));
  document.getElementById('filt-types').querySelector(`[data-ftype="${engine.getFilterType()}"]`)?.classList.add('on');
  document.getElementById('cfilt-types').querySelector(`[data-ftype="${engine.getChordFilterType()}"]`)?.classList.add('on');

  if (t.enabled) redrawKbd();

  wireGestureSections(renderAudioPanel);
  wireRadialSection(renderAudioPanel);
  wireMetronomeSection(renderAudioPanel);
  wireLooperSection();

  // Cache slider/readout refs — updateAudioSliders runs every frame and
  // shouldn't pay for per-mapping querySelector calls.
  sliderRefs.clear();
  document.querySelectorAll('.apr').forEach(el =>
    sliderRefs.set(el.dataset.key, { slider: el, valEl: document.getElementById(`av-${el.dataset.key}`) }));
}

export function updateAudioSliders() {
  mapper.mappings.forEach(m => {
    if (!m.signal) return;
    const p = engine.PARAMS[m.audioParam];
    const r = sliderRefs.get(m.audioParam);
    if (!p || !r) return;
    r.slider.value = p.val;
    if (r.valEl) r.valEl.textContent = p.val.toFixed(p.unit === 'Hz' ? 0 : 2);
  });

  // Live readout of the notes the oscillators are currently snapped to, plus
  // the keyboard markers. Colour the two note tokens to match their markers.
  if (engine.getTuning().enabled) {
    const notesEl = document.getElementById('quant-notes');
    if (notesEl) {
      const html = Array.from({ length: engine.getOscCount() }, (_, i) =>
        `OSC${i + 1} <b style="color:${OSC_COLS[i % OSC_COLS.length]}">`
        + `${engine.noteFor(`osc${i + 1}_freq`)}</b>`).join('  ·  ') || '—';
      if (notesEl.innerHTML !== html) notesEl.innerHTML = html;
    }
    panelKbd.draw(kbdOpts());
  }

  // Live volume rung — a level meter you can read at a glance while playing,
  // so you can see the gate close rather than only hear it.
  const lv = engine.volLevel();
  const vqEl = document.getElementById('vq-level');
  if (vqEl) {
    const txt = !lv ? '—'
      : Array.from({ length: lv.count }, (_, i) => (i > 0 && i <= lv.idx) ? '█' : '▁').join('')
        + `  ${lv.idx + 1}/${lv.count} · ${lv.gain === 0 ? 'SILENT' : `${lv.db.toFixed(0)} dB`}`;
    if (vqEl.textContent !== txt) vqEl.textContent = txt;
  }

  updateGesturePanel();
  updateRadialPanel();
  updateMetronomePanel();
}
