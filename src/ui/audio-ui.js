import { engine }                    from '../engine.js';
import { mapper }                    from '../mapper.js';
import { inPort } from './mapper-ui.js';
import { buildSigPanel } from './signals.js';
import { syncControls, onControlChange, defineControls, FILTER_TYPES } from '../controls.js';
import { SCALES, TUNINGS, NOTE_NAMES } from '../scale.js';
import { makeKbdView, midiOf, OSC_COLS } from './keyboard.js';
import { isDesktop } from './viewport.js';
import { STEP_OPTS, FLOOR_OPTS, EDGE_KEYS, GATE_AT_OPTS, GATE_AT_DEFAULT,
         makeDynamics } from '../dynamics.js';
import { adoptSections } from './workspace.js';
import { KITS, KIT_PARAM_KEYS, applyKit, currentKit, markCustom } from '../soundkit.js';
import { playalong } from '../playalong.js';
import { toast }     from './status.js';
import { setReadout } from './numeric.js';
import { SONGS, userSongs, addUserSong, removeUserSong, isUserSong } from '../songs.js';
import { GEN_SONGS } from '../songgen.js';
import { songFromMidi } from '../midifile.js';
import { gestureModeSection, wireGestureSections, updateGesturePanel } from './gesture-ui.js';
import { radialMenuSection, wireRadialSection, updateRadialPanel } from './radial-ui.js';
import { chordVoiceSection, wireChordVoiceSection, updateChordVoicePanel } from './voice-ui.js';
import { rows, tickCss } from './rows.js';
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

export function renderAudioPanel() {
  const panel = document.getElementById('audio-panel');
  const nOsc = engine.getOscCount();

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

  // A section's sliders live IN that section, each with its input socket:
  // the oscillators' pitch, detune and level under their waveform rows, the
  // filter's cutoff and Q with its type, the master levels on the Output
  // node. There is no separate parameter list — a parameter is where the
  // thing it controls is, and that is where its socket is.
  const typeBtns = (id, key, current) => `
    <div class="ctrl-row ctrl-row-choice">
      <span class="ctrl-lbl">${inPort(key)}TYPE</span>
      <div class="wave-btns" id="${id}">
        ${FILTER_TYPES.map(t =>
          `<button type="button" class="wave-btn${t === current ? ' on' : ''}" data-ftype="${t}">${t.slice(0, 3).toUpperCase()}</button>`
        ).join('')}
      </div>
    </div>`;
  const out = document.getElementById('output-params');
  if (out) out.innerHTML = rows(['volume', 'reverb_mix', 'loop_volume']);

  panel.innerHTML = `
    ${gestureModeSection()}
    ${radialMenuSection()}
    ${chordVoiceSection()}
    ${metronomeSection()}
    <div class="audio-section">
      <div class="audio-section-label">Sound Kit <span class="head-sock">${inPort('kit')}</span></div>
      <select id="kit-select" title="Instrument timbre preset (synthesized)">${kitOpts}</select>
    </div>
    <div class="audio-section">
      <div class="audio-section-label">Play Along <span class="head-sock">${inPort('playalong_play')}</span></div>
      <div class="scale-grid" style="grid-template-columns:1.6fr 1fr;">
        <select id="song-select" title="Song — bundled charts, your imported MIDI files, and generated charts that are different every start"${gameActive ? ' disabled' : ''}>
          ${(() => {
            const opt = s => `<option value="${s.id}"${s.id === playalong.lastSong ? ' selected' : ''}>${s.name}</option>`;
            const imported = userSongs();
            return `
            <optgroup label="SONGS">${SONGS.map(opt).join('')}</optgroup>
            ${imported.length ? `<optgroup label="IMPORTED">${imported.map(opt).join('')}</optgroup>` : ''}
            <optgroup label="GENERATED · in your key, new every start">${GEN_SONGS.map(opt).join('')}</optgroup>`;
          })()}
        </select>
        <select id="diff-select" title="Difficulty"${gameActive ? ' disabled' : ''}>
          ${playalong.levels.map(l => `<option value="${l.id}"${l.id === playalong.lastDiff ? ' selected' : ''}>${l.name}</option>`).join('')}
        </select>
      </div>
      <div class="wave-btns" style="margin-top:4px;">
        <button type="button" class="wave-btn${gameActive ? ' on' : ''}" id="game-btn">${gameActive ? 'STOP' : 'PLAY'}</button>
        <button type="button" class="wave-btn" id="song-import-btn"
                title="Import a MIDI file (.mid) as a play-along chart — the busiest track becomes the melody. Stays on this machine.">IMPORT</button>
        <button type="button" class="wave-btn" id="song-delete-btn"${isUserSong(playalong.lastSong) ? '' : ' disabled'}
                title="Remove the selected imported song">✕ SONG</button>
        <input type="file" id="song-import-file" accept=".mid,.midi,audio/midi" style="display:none" aria-hidden="true">
      </div>
      <div class="met-row">
        <span class="chord-key-lbl">${inPort('playalong_guide')}GUIDE</span>
        <button type="button" class="wave-btn${playalong.guide ? ' on' : ''}" id="guide-btn" title="Play a quiet guide melody">${playalong.guide ? 'ON' : 'OFF'}</button>
      </div>
      <canvas id="game-canvas" class="game-canvas" style="display:${gv.state !== 'idle' ? 'block' : 'none'}"></canvas>
      <div id="game-score" class="quant-notes">${gv.state === 'idle' ? bestLine() : '—'}</div>
    </div>
    ${looperSectionHTML()}
    <div class="audio-section">
      <div class="audio-section-label">
        Pitch Quantize
        <span class="head-sock">${inPort('quant_on')}</span>
        <button type="button" class="wave-btn${t.enabled ? ' on' : ''}" id="quant-toggle"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${t.enabled ? 'ON' : 'OFF'}</button>
      </div>
      <!-- One input per row, each with its socket on the node's edge. -->
      <div class="met-row"><span class="chord-key-lbl">${inPort('key_root')}KEY</span>
        <select id="scale-root" title="Root note" aria-label="Key root">${opts(NOTE_NAMES, t.root)}</select></div>
      <div class="met-row"><span class="chord-key-lbl">${inPort('key_scale')}SCALE</span>
        <select id="scale-name" title="Scale" aria-label="Scale">${opts(Object.keys(SCALES), t.scale)}</select></div>
      <div class="met-row"><span class="chord-key-lbl">${inPort('tuning_system')}TUNING</span>
        <select id="scale-tuning" title="Tuning system" aria-label="Tuning system">${opts(Object.keys(TUNINGS), t.system)}</select></div>
      <canvas id="quant-kbd" class="quant-kbd" style="display:${t.enabled ? 'block' : 'none'}"></canvas>
      <div id="quant-notes" class="quant-notes">${t.enabled ? '' : '—'}</div>
    </div>
    <div class="audio-section">
      <div class="audio-section-label">
        Volume Quantize
        <span class="head-sock">${inPort('vq_on')}</span>
        <button type="button" class="wave-btn${vq.enabled ? ' on' : ''}" id="vq-toggle"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${vq.enabled ? 'ON' : 'OFF'}</button>
      </div>
      <!-- One input per row, on the node's edge. -->
      <div class="met-row"><span class="chord-key-lbl">${inPort('vq_steps')}STEPS</span>
        <select id="vq-steps" title="Loudness levels, silence included">${vqStepOpts}</select></div>
      <div class="met-row"><span class="chord-key-lbl">${inPort('vq_floor')}FLOOR</span>
        <select id="vq-floor" title="Bottom of the ladder — the silence anchor when GATE is on">${vqFloorOpts}</select></div>
      <div class="met-row"><span class="chord-key-lbl">${inPort('vq_edge')}EDGE</span>
        <select id="vq-edge"  title="Attack / release speed at a level change">${vqEdgeOpts}</select></div>
      <div class="met-row"><span class="chord-key-lbl">${inPort('vq_gate')}GATE</span>
        <button type="button" class="wave-btn${vq.gate ? ' on' : ''}" id="vq-gate"
             title="Make the bottom level true silence, so notes can be separated and re-attacked">${vq.gate ? 'ON' : 'OFF'}</button></div>
      <div class="met-row"><span class="chord-key-lbl">${inPort('vq_gate_at')}GATE AT</span>
        <select id="vq-gate-at" style="flex:1 1 auto;min-width:0;"
                ${vq.gate ? '' : 'disabled'}
                title="Where the gate switches off, as a share of full volume. The ladder's own midpoint (·auto) is not always where you want the switch: with 2 steps it lands at 18%, so an on/off control flips very early. Raise it to move the switch later in the gesture.">${gateAtOpts(vq)}</select></div>
      <div id="vq-level" class="quant-notes">${vq.enabled ? '' : '—'}</div>
      <!-- ADSR lives here rather than in its own section because this is where
           its trigger is: crossing up out of silence is the note-on and
           dropping to the bottom rung is the note-off. It REPLACES the edge
           preset above when on, which is why the select dims. -->
      <div class="audio-section-label" style="margin-top:8px;">
        <span class="head-sock">${inPort('lead_env_on')}</span>
        Envelope
        <button type="button" class="wave-btn${le.enabled ? ' on' : ''}" id="lead-env-toggle"
             aria-pressed="${le.enabled}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;"
             title="Use a full ADSR instead of the fixed attack/release of the edge preset. Triggered by the volume gate: out of silence is a note-on, back to silence a note-off.">${le.enabled ? 'ADSR' : 'EDGE'}</button>
      </div>
      ${rows(['lead_attack', 'lead_decay', 'lead_sustain', 'lead_release'])}
    </div>
    <div class="audio-section" data-sec="oscillators">
      <div class="audio-section-label">Oscillators
        <span class="head-sock">${inPort('osc_count')}</span>
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
          <span class="osc-row-n" style="color:${OSC_COLS[i % OSC_COLS.length]}">${inPort(`osc${i + 1}_type`)}${i + 1}</span>
          <div class="wave-btns" data-osc="${i}">
            ${waveBtn('sine','SIN',i)}${waveBtn('triangle','TRI',i)}
            ${waveBtn('sawtooth','SAW',i)}${waveBtn('square','SQR',i)}
          </div>
        </div>
        ${rows([`osc${i + 1}_freq`, `osc${i + 1}_detune`, `osc${i + 1}_volume`])}`).join('')}
      <div class="wave-btns" style="margin-top:4px;">
        <span class="head-sock">${inPort('shepard_lead')}</span>
        <button type="button" class="wave-btn${shep.lead ? ' on' : ''}" id="shep-lead"
             aria-pressed="${shep.lead}"
             title="Shepard tones: each oscillator becomes a stack of octaves under a fixed loudness curve, so pitch rises or falls endlessly without ever leaving its register.">SHEPARD</button>
      </div>
      <div class="osc-hint">${nOsc
        ? (shep.lead
            ? 'Shepard: sweep pitch and it climbs forever — an octave returns you to the start'
            : 'Each has its own pitch, detune and level — and a socket on each')
        : 'No lead oscillators — gesture mode plays on its own'}</div>
    </div>
    <div class="audio-section" data-sec="filter">
      <div class="audio-section-label">Filter</div>
      ${typeBtns('filt-types', 'filter_type', engine.getFilterType())}
      ${rows(['filter_freq', 'filter_q', 'osc_volume'])}
      <div class="param-group-name">LFO</div>
      ${rows(['lfo_rate', 'lfo_depth'])}
    </div>
    <div class="audio-section" data-sec="chord-filter">
      <div class="audio-section-label">Chord Filter</div>
      ${typeBtns('cfilt-types', 'chord_filter_type', engine.getChordFilterType())}
      ${rows(['chord_filter_freq', 'chord_filter_q', 'chord_volume'])}
    </div>`;

  // Onto the canvas: innerHTML above rebuilt the sections in the staging
  // area, and each becomes (again) the node it was, at the position it had.
  // Runs before the wiring below, so every handler attaches to nodes that are
  // already in their final place.
  adoptSections(panel);
  // The metronome's output sockets live in its section, which was just
  // rebuilt; the camera's and the mic's are untouched but the pass is cheap.
  buildSigPanel();
  syncControls();

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
    e.target.textContent = playalong.guide ? 'ON' : 'OFF';
  });
  // Show the saved best for the selected song+difficulty while idle, and
  // wake the delete button only over a song the player actually imported.
  ['song-select', 'diff-select'].forEach(id =>
    document.getElementById(id).addEventListener('change', () => {
      const del = document.getElementById('song-delete-btn');
      if (del) del.disabled = !isUserSong(document.getElementById('song-select').value);
      if (playalong.view.state !== 'idle') return;
      const el = document.getElementById('game-score');
      if (el) el.textContent = bestLine();
    }));

  // MIDI import: parse in the browser, keep in localStorage, list beside the
  // bundled charts. Nothing is uploaded anywhere.
  document.getElementById('song-import-btn')?.addEventListener('click', () =>
    document.getElementById('song-import-file')?.click());
  document.getElementById('song-import-file')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const song = songFromMidi(await file.arrayBuffer(),
        { name: file.name.replace(/\.midi?$/i, '') });
      const id = addUserSong(song);
      playalong.setLastSong?.(id);
      renderAudioPanel();
      toast(`Imported “${song.name}” — ${song.notes.length} notes, ${song.bpm} BPM, ${song.root} ${song.scale}`);
    } catch (err) {
      toast(`Could not import: ${err?.message ?? err}`);
    }
  });
  document.getElementById('song-delete-btn')?.addEventListener('click', () => {
    const id = document.getElementById('song-select')?.value;
    if (!isUserSong(id)) return;
    removeUserSong(id);
    renderAudioPanel();
  });
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

  // Bank size. Shrinking leaves any cable wired to a slot that no longer
  // exists in the patch, undrawn — engine.set() ignores an unknown key, so it
  // goes quiet — and it is drawn again the moment the slot is back, which is
  // what a cable-driven bank size (the OSCILLATORS socket) relies on.
  const setCount = n => {
    const before = engine.getOscCount();
    const after = engine.setOscCount(n);
    if (after === before) return;
    syncControls();
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
      syncControls();
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
      syncControls();
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
      setReadout(document.getElementById(`av-${key}`),
                 val.toFixed(p.unit === 'Hz' ? 0 : 2));
      if (KIT_PARAM_KEYS.has(key)) syncKitToCustom();
    });
  });

  // Pitch quantisation controls
  const quantToggle = document.getElementById('quant-toggle');
  const kbd = document.getElementById('quant-kbd');
  const redrawKbd = () => { panelKbd.invalidate(); panelKbd.draw(kbdOpts()); };
  // What the pitch-quantise controls show, from the engine's own state — the
  // buttons write it, and so does a cable into quant_on / key_root / key_scale.
  const syncQuantUI = () => {
    const tn = engine.getTuning();
    quantToggle.classList.toggle('on', tn.enabled);
    quantToggle.textContent = tn.enabled ? 'ON' : 'OFF';
    kbd.style.display = tn.enabled ? 'block' : 'none';
    const root = document.getElementById('scale-root'), name = document.getElementById('scale-name');
    if (root && root.value !== tn.root) root.value = tn.root;
    if (name && name.value !== tn.scale) name.value = tn.scale;
    if (tn.enabled) redrawKbd();
    else document.getElementById('quant-notes').textContent = '—';
  };
  quantToggle.addEventListener('click', () => {
    engine.setTuning({ enabled: !engine.getTuning().enabled });
    syncControls(); syncQuantUI();
  });
  document.getElementById('scale-root')
    .addEventListener('change', e => { engine.setTuning({ root: e.target.value }); syncControls(); redrawKbd(); });
  document.getElementById('scale-name')
    .addEventListener('change', e => { engine.setTuning({ scale: e.target.value }); syncControls(); redrawKbd(); });
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
  const syncVqUI = () => {
    const v = engine.getVolStep();
    vqToggle.classList.toggle('on', v.enabled);
    vqToggle.textContent = v.enabled ? 'ON' : 'OFF';
    vqGate.classList.toggle('on', v.gate);
    vqGateAt.disabled = !v.gate;
    refreshVolTicks();
    if (!v.enabled) document.getElementById('vq-level').textContent = '—';
  };
  vqToggle.addEventListener('click', () => {
    engine.setVolStep({ enabled: !engine.getVolStep().enabled });
    syncControls(); syncVqUI();
  });
  // The gate threshold's labels are percentages of full volume, so changing the
  // step count or the floor moves every one of them. Rebuilding the options
  // (rather than only the selection) keeps the numbers true; without this the
  // menu would keep advertising the thresholds of the previous ladder.
  const vqGateAt = document.getElementById('vq-gate-at');
  const refreshGateAt = () => { vqGateAt.innerHTML = gateAtOpts(engine.getVolStep()); };
  vqGate.addEventListener('click', () => {
    engine.setVolStep({ gate: !engine.getVolStep().gate });
    syncControls(); syncVqUI();
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

  // Reflect the engine's actual waveform selections (they may have just been
  // restored from a saved preset, not the factory defaults). A kit's custom
  // harmonic table ('custom:piano') matches none of the four buttons, so a
  // row can legitimately show nothing selected.
  document.querySelectorAll('.wave-btns[data-osc]').forEach(group =>
    group.querySelector(`[data-type="${engine.getOscType(+group.dataset.osc)}"]`)?.classList.add('on'));

  // A cable into a control moves the instrument; the buttons follow. One
  // subscription for the life of the page, re-pointed at each render's
  // elements by reading them fresh.
  controlFollowers = {
    filter_type: () => activateWave(document.getElementById('filt-types'), engine.getFilterType()),
    chord_filter_type: () => activateWave(document.getElementById('cfilt-types'), engine.getChordFilterType()),
    quant_on: syncQuantUI, key_root: syncQuantUI, key_scale: syncQuantUI,
    vq_on: syncVqUI, vq_gate: syncVqUI,
    // The arpeggiator's row re-renders with its state (its sliders appear
    // with it).
    arp_on: () => renderAudioPanel(), arp_pattern: () => renderAudioPanel(),
    // A mode switching on or off changes what its node shows.
    chord_on: () => renderAudioPanel(), radial_on: () => renderAudioPanel(),
  };

  if (t.enabled) redrawKbd();

  wireGestureSections(renderAudioPanel);
  wireRadialSection(renderAudioPanel);
  wireChordVoiceSection(renderAudioPanel);
  syncControls();
  wireMetronomeSection(renderAudioPanel);
  wireLooperSection();

  // Cache slider/readout refs — updateAudioSliders runs every frame and
  // shouldn't pay for per-mapping querySelector calls. The controls' own
  // sliders (tempo, the arp's) follow a cable the same way.
  sliderRefs.clear();
  document.querySelectorAll('.apr').forEach(el =>
    sliderRefs.set(el.dataset.key, { slider: el, valEl: document.getElementById(`av-${el.dataset.key}`) }));
  const extra = [['metro_bpm', 'metro-bpm', 'metro-bpm-val'], ['arp_rate', 'ck-arp-rate', null],
                 ['arp_gate', 'ck-arp-gate', null], ['arp_sustain', 'ck-arp-sus', null]];
  for (const [key, id, valId] of extra) {
    const slider = document.getElementById(id);
    if (slider) sliderRefs.set(key, { slider, valEl: valId ? document.getElementById(valId) : null });
  }
}

// Followers for the controls, replaced on every render; the subscription is
// made once.
let controlFollowers = {};
// A control with no follower of its own re-renders the panel — next tick, once
// for a burst — so a choice a cable moved is drawn as the instrument now is.
let panelRedraw = null;
const scheduleRedraw = () => {
  if (panelRedraw) return;
  panelRedraw = setTimeout(() => { panelRedraw = null; renderAudioPanel(); }, 0);
};
onControlChange(key => (controlFollowers[key] ?? scheduleRedraw)());

// PLAY needs the song and difficulty the panel shows, so it is defined here.
defineControls({
  playalong_play: {
    label: 'Play', min: 0, max: 1, trigger: true, read: () => 0,
    apply: (() => {
      let high = false;
      return v => {
        const now = v >= 0.5; if (!now || high) { high = now; return; } high = now;
        document.getElementById('game-btn')?.click();
      };
    })(),
  },
});

export function updateAudioSliders() {
  mapper.mappings.forEach(m => {
    if (!m.signal) return;
    const p = engine.PARAMS[m.audioParam];
    const r = sliderRefs.get(m.audioParam);
    if (!p || !r) return;
    r.slider.value = p.val;
    if (r.valEl) setReadout(r.valEl, p.val.toFixed(p.control ? 0 : p.unit === 'Hz' ? 0 : 2));
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
  updateChordVoicePanel();
  updateMetronomePanel();
}
