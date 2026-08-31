// UI for the Gesture Mode panel section. Markup + handlers + cheap per-frame
// live updates (match dots, chord readout). Kept separate so audio-ui.js stays
// focused on the synth panel.
//
// Gesture Mode and the gesture library used to be two sections — "Chord Mode"
// assigned shapes to degrees, "Gestures" defined the shapes — and each grew
// read-only echoes of the other to stay legible: chips on the shape rows
// saying what a shape played, `· est` riding along in the assignment selects.
// They are one section now, because they were always one subject: what your
// body means. The assignments sit on top (they are the instrument); the
// library folds away underneath as GESTURE CONFIGURATIONS, where a gesture is
// calibrated, recorded, renamed and removed. The chips died with the split
// that made them necessary.
//
// It is not only handshapes any more — a gesture declares a kind, and the face
// and pose models publish channel sets the same matcher runs over (see KINDS
// in gesture.js) — which is why the fold is named for gestures rather than for
// hands, and why calibrating no longer means going and finding the shape in
// it: every assignment row calibrates its own.

import { gesture, gestureLabel, KINDS, kindOf } from '../gesture.js';
import { arpRowHTML, wireArpRow, updateArpRow } from './arp-ui.js';
import { setReadout } from './numeric.js';
import { chordmode, DEGREES, EXPRESSION_MODES, EXPRESSION_CONTROLS,
         VOICINGS, accidentalSign } from '../chordmode.js';
import { diatonicChord, DEGREE_SCALES } from '../chords.js';
import { NOTE_NAMES } from '../scale.js';
import { cvSource }   from '../cv.js';
import { engine }     from '../engine.js';
import { radial }     from '../radial.js';
import { toast }      from './status.js';
import { buildSigPanel } from './signals.js';

const opt = (v, sel) => `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`;

// What you are asked to hold, per kind — "hold the pose" is wrong advice for
// an expression, and "your own hand" is wrong for a stance.
const KIND_NOUN = { hand: 'hand', face: 'face', body: 'body' };
const KIND_HOLD = { hand: 'hold the pose', face: 'hold the expression',
                    body: 'hold the stance' };
// Which tracker has to be running before a kind can be read at all.
const KIND_NEEDS = { hand: 'hands', face: 'the face tracker', body: 'pose tracking' };

// Whether the library is unfolded, same pattern as above. Starts
// unresolved rather than false: until the user has an opinion it follows the
// mode — folded while the mode is on (the assignments above are the playing
// surface, and doubling the section's length by default buries the ADSR),
// open while it is off (with no assignments showing, the library IS the
// section).
let gestureLibOpen = null;

// The key select is narrow; scale.js's full names ("major (ionian)") get
// clipped mid-word, so shorten them for this one control.
const MODE_LABELS = {
  'major (ionian)':   'major',
  'natural minor':    'minor',
  'harmonic minor':   'harm min',
  'major pentatonic': 'maj pent',
  'minor pentatonic': 'min pent',
};

export function gestureModeSection() {
  const gestures = gesture.list();
  const relId = chordmode.getReleaseGesture();
  const env = engine.getChordEnv();
  const on = chordmode.enabled;

  const row = g => {
    const label = gestureLabel(g);
    // The panel column is narrow, so the row shows "6 · Pinky Touch" and keeps
    // the spelled-out "ASL 6" for the tooltip, the signals panel and the chord
    // readout, where there's room. Gloss first either way: it is what the list
    // is sorted by, so it belongs in the column the eye runs down. Only
    // `custom` earns a tag of its own — "built-in" on nine of eleven rows is
    // noise that squeezes out the name.
    const short = g.asl ? `${g.asl} · ${g.name}`
                : g.sem ? `${g.sem} · ${g.name}` : g.name;
    const kind = kindOf(g);
    const tag = g.est
      ? `<span class="gesture-tag est" title="Estimated template — calibrate it on your own hand">est</span>`
      : (g.builtin ? '' : `<span class="gesture-tag">custom</span>`);
    // Only the non-hand kinds are badged: "hand" on nine of eleven rows is the
    // same noise "built-in" was, and a gesture read from somewhere other than
    // your hands is exactly the thing you cannot tell from the name.
    const kindTag = kind === 'hand' ? ''
      : `<span class="gesture-tag kind" title="Read from your ${KIND_NOUN[kind]}, not your hands — needs ${KIND_NEEDS[kind]} switched on">${kind}</span>`;
    // Illustration — DEV ONLY, and under construction.
    //
    // These are rendered from each template's own feature vector
    // (scripts/handshapes.mjs) on the theory that a picture derived from the
    // data cannot disagree with it. The theory outran the rig: most of the
    // renders do not currently show the shape they claim to, because the
    // procedural hand's thumb placement and contact handling are cruder than
    // the templates they are posed from.
    //
    // A wrong picture is worse than no picture — it teaches a handshape that
    // will not match — so they are behind `uc-feature` (DEV) rather than shown
    // to players. They stay VISIBLE inside DEV, badged, precisely so the wrong
    // ones can be identified and the rig fixed against them; hiding them would
    // make that impossible.
    const pic = g.builtin && g.f && kind === 'hand'
      ? `<span class="gesture-pic-wrap uc-feature">
           <img class="gesture-pic" src="icons/handshapes/${g.id}.png" alt=""
                width="34" height="34" loading="lazy">
           <span class="gesture-pic-wip" aria-hidden="true"
                 title="Under construction — this render may not match the handshape it is labelled with">🚧</span>
         </span>`
      : '<span class="gesture-pic-wrap gesture-pic-none uc-feature" aria-hidden="true"></span>';
    return `
    <div class="gesture-row" data-gid="${g.id}" title="${label}${g.builtin ? ' (built-in)' : ''}">
      <span class="gesture-dot" id="gdot-${g.id}"></span>
      ${pic}
      <span class="gesture-name">${short}</span>
      ${kindTag}
      ${tag}
      <button class="rm-btn gesture-ren" data-gid="${g.id}"
              title="Rename ${label}" aria-label="Rename ${label}">✎</button>
      <button class="rm-btn gesture-cal" data-gid="${g.id}"
              title="Calibrate ${label} on your own ${KIND_NOUN[kind]}"
              aria-label="Calibrate ${label}">⊙</button>
      <button class="rm-btn gesture-del" data-gid="${g.id}"
              title="Remove ${label}" aria-label="Remove ${label}">×</button>
    </div>`;
  };
  // One list, in ASL gloss order (see orderByGloss in gesture.js). The number
  // handshapes used to fold away into their own ASL NUMBERS group, on the
  // theory that they were a set you opted into — but that split the library
  // by an accident of which shapes happen to have descriptive names as well
  // as glosses, and it put 1, 2, 5 and 10 above the fold while 0 and 3-9 sat
  // below it. Ordering them all by gloss is the thing that makes one list
  // scannable, so the group had nothing left to do.
  const est = gesture.estimated().length;
  const gestureRows = gestures.map(row).join('');
  const restore = gesture.hiddenCount()
    ? `<button class="btn gesture-restore" style="margin-top:4px;width:100%;">RESTORE BUILT-IN GESTURES</button>` : '';
  const calibrate = est
    ? `<button class="btn gesture-cal-all" style="margin-top:4px;width:100%;"
               title="Record each estimated handshape from your own hand, one at a time">CALIBRATE ${est} HANDSHAPE${est > 1 ? 'S' : ''}</button>` : '';

  // One option list serves every picker — degrees, RELEASE and the two
  // accidentals — because they all ask the same question of the same shapes.
  // Every shape is offered everywhere, including ones already on a degree: an
  // accidental is read from the hand that is NOT naming the note, so one shape
  // can do both jobs without the two ever being asked at once. `· est` rides
  // along with the name: whether a shape is calibrated is exactly what you
  // want to know at the moment you wire it to something.
  const gestureOptions = sel => `<option value=""${!sel ? ' selected' : ''}>—</option>`
    + gestures.map(g =>
        `<option value="${g.id}"${g.id === sel ? ' selected' : ''}>`
        + `${gestureLabel(g)}${g.est ? ' · est' : ''}</option>`).join('');

  const key  = chordmode.key();
  const eff  = chordmode.effectiveKey();
  const sevenths = chordmode.sevenths();
  const flw  = chordmode.isFollowing();   // armed *and* actually overriding
  const keyRow = `
    <div class="chord-key">
      <span class="chord-key-lbl">KEY</span>
      <select id="ck-root" ${flw ? 'disabled' : ''} aria-label="Chord key root"
              title="${flw ? 'Following Pitch Quantize' : 'Root of the key chords are built in'}"
        >${NOTE_NAMES.map(n => opt(n, eff.root)).join('')}</select>
      <select id="ck-mode" ${flw ? 'disabled' : ''} aria-label="Chord key mode"
        >${DEGREE_SCALES.map(s => `<option value="${s}"${s === eff.mode ? ' selected' : ''}>${MODE_LABELS[s] ?? s}</option>`).join('')}</select>
      <select id="ck-oct" aria-label="Chord octave" title="Octave of the chord roots"
        >${[2, 3, 4, 5].map(o => opt(o, key.octave)).join('')}</select>
      <button class="wave-btn${key.follow ? ' on' : ''}" id="ck-follow" aria-pressed="${key.follow}"
              title="${key.follow && !flw
                ? 'Following Pitch Quantize — inactive until quantise is on'
                : 'Take the key from Pitch Quantize, so chords match the melody'}">FOLLOW</button>
    </div>`;

  // ── Voicing: the chord, or the single note it is built on ───────────────
  //
  // The switch is deliberately here rather than in its own panel section: it
  // changes what the rows below SOUND, not what they mean, and every setting
  // around it — the key, the shapes, the expression, the arpeggiator — applies
  // either way.
  const ex = chordmode.expression();
  const voicing = chordmode.getVoicing();
  const isNote = voicing === 'note';
  const accG = chordmode.accidentalGestures();
  const VOICING_LABEL = { chord: 'CHORDS', note: 'SINGLE NOTES' };
  // Accidentals need a free hand, and in 'other hand — openness' expression
  // there is not one: that hand is already the volume. Say so rather than
  // leaving two live-looking selects that quietly do nothing.
  const accBusy = ex.mode === 'hand';
  // Calibrating from where the gesture is CHOSEN, not only from the library.
  // The library is where a gesture is defined, but the moment you find out a
  // template is wrong is the moment a chord will not sound — and that is this
  // row, with the fold below it very possibly shut. Disabled with no gesture
  // on the row, because there is then nothing to calibrate.
  const calBtn = (gid, busy = false) => {
    const g = gid ? gestures.find(x => x.id === gid) : null;
    const what = g ? gestureLabel(g) : null;
    const off = !g || busy;
    return `<button class="rm-btn ch-cal" data-gid="${gid || ''}" ${off ? 'disabled' : ''}
            title="${!g ? 'Choose a gesture first'
                        : busy ? 'Unavailable while the picker beside it is'
                        : `Re-record ${what} from your own ${KIND_NOUN[kindOf(g)]}`}"
            aria-label="${what ? `Calibrate ${what}` : 'Calibrate'}">⊙</button>`;
  };

  const voicingRow = `
    <div class="chord-voicing">
      <span class="chord-key-lbl">PLAY</span>
      <select id="ck-voicing" aria-label="Whether a handshape sounds a chord or one note"
              title="The same handshapes and the same key, sounding either the whole chord on a degree or just that degree's own note.">
        ${VOICINGS.map(v => `<option value="${v}"${v === voicing ? ' selected' : ''}>${VOICING_LABEL[v]}</option>`).join('')}
      </select>
      <span class="acc-read" id="ck-acc-read"
            title="What your other hand is saying about the note right now.">${isNote ? '♮' : '—'}</span>
    </div>
    ${!isNote ? '' : `
    <div class="chord-expr-cal chord-acc">
      <label class="ctrl-lbl" title="${accBusy
        ? 'Unavailable while the other hand is playing the volume — switch PLAY WITH to a handshape or eyebrows'
        : 'Hold this on your other hand to raise the note a semitone'}">♯ SHARP
        <select id="ck-acc-sharp" ${accBusy ? 'disabled' : ''}
                aria-label="Gesture that sharpens the note">${gestureOptions(accG.sharp)}</select>
        ${calBtn(accG.sharp, accBusy)}
      </label>
      <label class="ctrl-lbl" title="${accBusy
        ? 'Unavailable while the other hand is playing the volume — switch PLAY WITH to a handshape or eyebrows'
        : 'Hold this on your other hand to lower the note a semitone'}">♭ FLAT
        <select id="ck-acc-flat" ${accBusy ? 'disabled' : ''}
                aria-label="Gesture that flattens the note">${gestureOptions(accG.flat)}</select>
        ${calBtn(accG.flat, accBusy)}
      </label>
      <div class="quant-notes" style="grid-column:1 / -1;margin:0;">${accBusy
        ? 'The other hand is playing the volume, so every note sounds natural.'
        : 'Neither shape held is natural. The hand that is not naming the note is the one that bends it.'}</div>
    </div>`}`;

  // Every control renders whether the mode is ON or not — switching to
  // radial mode must not hide the place a chord's 7th or the key is set, and
  // setting a mode up BEFORE switching to it is half the point of having two.
  // Only the live readout stays gated: it reports a sound that is not there.
  // One row per CHORD, not per handshape.
  //
  // It was the other way round, and that let the same shape be a chord *and*
  // the release — a configuration the panel would happily show and the tick
  // loop then had to break by fiat, so what you saw was not what you heard.
  // Listing the chords instead makes the mapping a function by construction:
  // seven degrees plus RELEASE, one handshape each, and choosing a shape takes
  // it off whatever it was doing before.

  const chordRow = i => {
    const c = diatonicChord(eff.root, eff.octave, eff.mode, i, sevenths[i]);
    const gid = chordmode.gestureFor(i);
    // In note voicing the row shows the pitch that will sound, octave and all
    // — the degree is the same, but "C4" is the answer to what you are about
    // to hear and "C major" is not.
    // …and by the note's OWN numeral, which carries no 7th: the row would
    // otherwise read "iii7 · E4" while sounding one E.
    const n = isNote ? chordmode.noteAt(i) : null;
    return `
    <div class="chord-assign" data-degree="${i}">
      <span class="gesture-dot" id="cdot-${i}"></span>
      <span class="chord-degree" title="${n ? `${n.numeral} · ${n.name}` : `${c.numeral} · ${c.rootName} ${c.quality}`}"
        >${n ? `${n.numeral} · ${n.name}` : `${c.numeral} · ${c.rootName}`}</span>
      <select class="ch-shape" data-degree="${i}"
              aria-label="Gesture that plays ${c.numeral}"
        >${gestureOptions(gid)}</select>
      ${calBtn(gid)}
      <button class="wave-btn ch-sev${sevenths[i] ? ' on' : ''}" data-degree="${i}"
              aria-pressed="${sevenths[i]}" ${isNote ? 'disabled' : ''}
              title="${isNote
                ? 'A single note has no 7th to add — switch back to CHORDS for this'
                : 'Add the diatonic 7th'}">7th</button>
    </div>`;
  };

  const MODE_LABEL = {
    gesture: 'Handshape holds it',
    hand:    'Other hand — openness',
    brow:    'Eyebrows',
    beat:    'Metronome beats',
  };
  const CONTROL_LABEL = { gate: 'ATTACK / RELEASE', volume: 'VOLUME' };
  // In `hand` expression mode the naming hand is already decided — it is the
  // one not playing — so this shows that rather than offering a second, and
  // possibly contradicting, opinion about it.
  const nameHand = chordmode.getNamingHand();
  const nameFixed = ex.mode === 'hand';
  const nameShown = nameFixed ? (ex.hand === 'L' ? 'R' : 'L') : nameHand;
  const nameRow = `
    <div class="chord-expr">
      <span class="chord-key-lbl">NAMED BY</span>
      <select id="ck-name-hand" aria-label="Which hand names the chord"
              ${nameFixed ? 'disabled' : ''}
              title="${nameFixed
                ? 'Set by PLAY WITH: the hand that is not playing names the chord.'
                : 'Which hand a handshape is read from. Naming one hand frees the other to drive a cable — an open hand held out to move a filter is a handshape whether or not you meant it as one, and EITHER reads both.'}">
        ${[['any', 'EITHER hand'], ['L', 'LEFT hand'], ['R', 'RIGHT hand']].map(([v, l]) =>
          `<option value="${v}"${v === nameShown ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>`;
  const exprRow = `
    <div class="chord-expr">
      <span class="chord-key-lbl">PLAY WITH</span>
      <select id="ck-expr-mode" aria-label="What makes the chord sound"
              title="What sounds the chord once a handshape has named it. Two-handed play frees the shape from doing two jobs at once.">
        ${EXPRESSION_MODES.map(m => `<option value="${m}"${m === ex.mode ? ' selected' : ''}>${MODE_LABEL[m]}</option>`).join('')}
      </select>
      <select id="ck-expr-hand" aria-label="Which hand expresses"
              ${ex.mode === 'hand' ? '' : 'disabled'}
              title="The hand that plays; the other names the chord.">
        ${[['L', 'LEFT plays'], ['R', 'RIGHT plays']].map(([v, l]) =>
          `<option value="${v}"${v === ex.hand ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <select id="ck-expr-control" aria-label="How the signal is read"
              ${ex.mode === 'hand' || ex.mode === 'brow' ? '' : 'disabled'}
              title="ATTACK / RELEASE runs the envelope past a threshold. VOLUME makes the signal the level itself — there is no envelope to run, you are the envelope.">
        ${EXPRESSION_CONTROLS.map(c => `<option value="${c}"${c === ex.control ? ' selected' : ''}>${CONTROL_LABEL[c]}</option>`).join('')}
      </select>
    </div>
    ${ex.mode === 'beat' ? `
    <div class="quant-notes">the shape held when a SAMPLE beat lands is struck then — set the beats in the Metronome section, and switch it on</div>` : ''}
    ${ex.mode === 'gesture' || ex.mode === 'beat' ? '' : `
    <div class="chord-expr-cal">
      <label class="ctrl-lbl">OFF AT<input type="range" id="ck-expr-lo" min="0" max="1" step="0.01" value="${ex.lo}"></label>
      <label class="ctrl-lbl">FULL AT<input type="range" id="ck-expr-hi" min="0" max="1" step="0.01" value="${ex.hi}"></label>
      <div class="expr-meter" id="ck-expr-meter" title="Live: the raw signal, and where it lands after the range above. If the bar never empties, raise OFF AT.">
        <div class="expr-fill" id="ck-expr-fill"></div>
        <span class="expr-read" id="ck-expr-read">—</span>
      </div>
    </div>`}`;

  // ── Arpeggiator ────────────────────────────────────────────────────────
  //
  // The arpeggiator row is shared with Radial Mode (ui/arp-ui.js) — one arp,
  // one row, two panels.
  const arpRow = arpRowHTML('ck');

  // Five rows over a pentatonic key, seven over a diatonic one. A shape
  // assigned to a degree beyond the count keeps its assignment — dormant, and
  // back the moment the mode is — so the rows that disappear here are not
  // deletions.
  const assignRows =
    Array.from({ length: chordmode.degreeCount() }, (_, i) => chordRow(i)).join('') + `
    <div class="chord-assign${ex.mode === 'gesture' ? '' : ' dimmed'}" data-degree="release">
      <span class="gesture-dot" id="cdot-release"></span>
      <span class="chord-degree" title="${ex.mode === 'gesture'
        ? 'Holding this shape lets a held chord go'
        : 'Only used when a handshape holds the chord — here the signal above does the releasing'}"
        >RELEASE</span>
      <select class="ch-shape" data-degree="release" ${ex.mode === 'gesture' ? '' : 'disabled'}
              aria-label="Gesture that releases a held chord"
        >${gestureOptions(relId)}</select>
      ${calBtn(relId)}
      <span class="ch-sev-gap"></span>
    </div>`;

  // The instrument on top, the library folded underneath. The mode's rows are
  // what you look at while playing; GESTURE CONFIGURATIONS is where a gesture
  // is defined — calibrated, illustrated, recorded, renamed, removed — which is
  // setup, not performance, so it earns a fold rather than a second section.
  // (Calibration is the one part of it that ALSO lives upstairs, on the rows:
  // it is the only one you reach for mid-play.)
  const libOpen = gestureLibOpen ?? !on;
  return `
    <div class="audio-section" data-sec="gesture-mode">
      <div class="audio-section-label">
        Gesture Mode
        <button class="wave-btn${on ? ' on' : ''}" id="chord-toggle" aria-pressed="${on}"
             style="flex:0 0 auto;margin-left:auto;padding:2px 9px;">${on ? 'ON' : 'OFF'}</button>
      </div>
      ${keyRow}
      ${voicingRow}
      ${exprRow}
      ${nameRow}
      <div id="chord-assigns">${assignRows}</div>
      <div id="chord-cal-status" class="quant-notes" role="status" aria-live="polite"></div>
      ${arpRow}
      <div class="scale-grid" style="grid-template-columns:1fr 1fr 1fr 1fr;margin-top:6px;">
        ${['attack', 'decay', 'sustain', 'release'].map(k => `
          <label class="ctrl-lbl" style="display:flex;flex-direction:column;gap:2px;">
            ${k.slice(0, 3).toUpperCase()}
            <input type="range" class="ck-env" data-env="${k}"
              min="${engine.CHORD_ENV_RANGE[k][0]}" max="${engine.CHORD_ENV_RANGE[k][1]}"
              step="0.005" value="${env[k]}">
            <span class="ctrl-val" id="ck-env-${k}">${k === 'sustain' ? Math.round(env[k] * 100) + '%' : env[k].toFixed(2) + 's'}</span>
          </label>`).join('')}
      </div>
      <div class="wave-btns" style="margin-top:4px;">
        <button type="button" class="wave-btn${engine.getShepard().chord ? ' on' : ''}" id="shep-chord"
             aria-pressed="${engine.getShepard().chord}"
             title="Shepard tones: every chord note becomes a stack of octaves under a fixed loudness curve, so a progression can climb without ever running out of register.">SHEPARD</button>
      </div>
      <div class="chord-live" id="chord-live" style="display:${on ? 'grid' : 'none'}">
        <div id="chord-readout" class="quant-notes" role="status" aria-live="polite">—</div>
        <div class="chord-vol" title="How loud the chord is right now">
          <div class="chord-vol-fill" id="chord-vol-fill"></div>
          <span class="chord-vol-read" id="chord-vol-read">—</span>
        </div>
      </div>
      ${on ? '' : `<div class="quant-notes">switch on to play a ${isNote ? 'note' : 'chord'} by holding its handshape</div>`}
      <details class="gesture-group" id="gesture-lib"${libOpen ? ' open' : ''}>
        <summary class="gesture-lib-summary"><span class="gesture-lib-title">GESTURE CONFIGURATIONS</span>
          <span class="gesture-tag">${gestures.length}</span>
          ${est ? `<span class="gesture-tag est" title="${est} still estimated — calibrate them on your own hand">${est} est</span>` : ''}
          <span class="gesture-rec-add">
            <select id="record-kind" aria-label="What the new gesture is read from"
                    title="A gesture does not have to be a handshape: the same template matching runs over the face model's expression channels and the pose model's joint angles.">
              ${Object.entries(KINDS).map(([k, v]) =>
                  `<option value="${k}">${v.label.toUpperCase()}</option>`).join('')}
            </select>
            <button type="button" class="wave-btn" id="record-gesture-btn"
                 title="Record a new gesture from the camera"
                 style="flex:0 0 auto;padding:2px 9px;">● REC</button>
          </span>
        </summary>
        <div id="gesture-list">${gestureRows}</div>
        <div id="gesture-cal-status" class="quant-notes"></div>
        ${calibrate}
        ${restore}
      </details>
    </div>`;
}

// How to make each shape, shown during calibration. A template recorded from
// the wrong pose is worse than the estimate it replaces, so the prompt has to
// say exactly what to hold.
const HOW_TO = {
  palm:  'Open hand, all five fingers spread',
  horns: 'Index and pinky up, middle and ring down, thumb tucked',
  gun:   'Index pointing forward, thumb up and clear of the palm — an L',
  asl3:  'Thumb, index and middle up — ring and pinky folded down',
  asl4:  'Four fingers up, thumb folded across the palm',
  asl6:  'Pinky tip touching the thumb, other three fingers up',
  asl7:  'Ring tip touching the thumb, other three fingers up',
  asl8:  'Middle tip touching the thumb, other three fingers up',
  asl9:  'Index tip touching the thumb, other three fingers up',
  asl0:  'All fingertips curved to meet the thumb in an O',
};

// A recording only completes once ~10 frames of features arrive, and features
// only arrive while the model that produces them is running. Switch the face
// tracker off and a face recording waits forever — no error, just a countdown
// that never resolves. Give up out loud instead.
const CAPTURE_TIMEOUT = 5000;
function watchCapture(kind, onGiveUp) {
  return setTimeout(() => {
    if (!gesture.recordingActive) return;
    gesture.cancelRecord();
    onGiveUp(`Nothing to read — switch ${KIND_NEEDS[kind]} on and stay in frame`);
  }, CAPTURE_TIMEOUT);
}

// Countdown → record, shared by the single-gesture button, the chord rows and
// the walkthrough. `onDone` receives true when a template was captured.
function runCalibration(id, statusEl, onDone) {
  const g = gesture.list().find(x => x.id === id);
  const label = g ? gestureLabel(g) : id;
  const kind = kindOf(g);
  const how = HOW_TO[id] ?? KIND_HOLD[kind];
  const say = t => { if (statusEl) statusEl.textContent = t; };
  let n = 3;
  say(`${label} — ${how} … ${n}`);
  const iv = setInterval(() => {
    if (--n > 0) { say(`${label} — ${how} … ${n}`); return; }
    clearInterval(iv);
    say(`${label} — hold still…`);
    const bail = watchCapture(kind, msg => { say(msg); toast(msg); onDone(false); });
    gesture.recalibrate(id, () => {
      clearTimeout(bail); say(`${label} ✓`); onDone(true);
    });
  }, 900);
}

// rerender: renderAudioPanel (used for structural changes).
export function wireGestureSections(rerender) {
  const recBtn = document.getElementById('record-gesture-btn');
  const status = document.getElementById('gesture-cal-status');

  // Remember the folds so a re-render puts them back the way you left them.
  // The library records on summary CLICK, not on the toggle event: a details
  // rendered with the `open` attribute fires toggle too, which would take the
  // adaptive default for a user's choice on the very first paint and pin it
  // forever. A click is a person by definition. (`open` still holds the
  // pre-toggle value inside the click handler, so the choice being made is
  // its negation. REC lives in this summary and stops propagation, so a
  // recording press never reads as a fold.)
  document.querySelector('#gesture-lib > summary')
    ?.addEventListener('click', e => { gestureLibOpen = !e.currentTarget.parentElement.open; });

  const calGuard = () => {
    if (gesture.recordingActive) return false;
    if (!cvSource.running) { toast('Start the camera first'); return false; }
    return true;
  };

  document.querySelectorAll('.gesture-cal').forEach(b =>
    b.addEventListener('click', () => {
      if (!calGuard()) return;
      runCalibration(b.dataset.gid, status, () => rerender());
    }));

  // The same calibration, started from the chord row that uses the gesture.
  // It reports into its own status line rather than the library's, which may
  // well be folded shut underneath.
  const chordStatus = document.getElementById('chord-cal-status');
  document.querySelectorAll('.ch-cal').forEach(b =>
    b.addEventListener('click', e => {
      e.preventDefault();     // the accidental buttons sit inside their <label>
      if (!b.dataset.gid || !calGuard()) return;
      runCalibration(b.dataset.gid, chordStatus, () => rerender());
    }));

  // Renaming. Built-in or custom, an ASL gloss survives it — the gloss is what
  // the shape IS and what the list is ordered by; the name is what you call it.
  document.querySelectorAll('.gesture-ren').forEach(b =>
    b.addEventListener('click', () => {
      const g = gesture.list().find(x => x.id === b.dataset.gid);
      if (!g) return;
      const next = prompt(`Rename "${g.name}" to:`, g.name);
      if (next === null) return;
      if (!gesture.rename(g.id, next)) { toast('Name unchanged'); return; }
      buildSigPanel();      // the signal's label carries the new name too
      rerender();
    }));

  document.querySelector('.gesture-cal-all')?.addEventListener('click', () => {
    if (!calGuard()) return;
    const queue = gesture.estimated();
    const step = () => {
      const id = queue.shift();
      if (!id) {
        toast('Calibration complete');
        rerender();               // clears the `est` badges and the button
        return;
      }
      // Re-render between steps would tear down this handler mid-walkthrough,
      // so the list is only rebuilt once the queue is empty.
      runCalibration(id, status, step);
    };
    step();
  });
  // The kind picker sits inside the summary, so its clicks would fold the
  // library out from under the choice being made.
  const kindSel = document.getElementById('record-kind');
  ['click', 'keydown'].forEach(ev =>
    kindSel?.addEventListener(ev, e => e.stopPropagation()));

  recBtn?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (gesture.recordingActive) return;
    if (!cvSource.running) { toast('Start the camera first'); return; }
    const kind = kindSel?.value && KINDS[kindSel.value] ? kindSel.value : 'hand';
    const name = prompt(`Name this ${KIND_NOUN[kind]} gesture:`);
    if (name === null) return;
    let n = 3;
    recBtn.classList.add('on');
    recBtn.textContent = `${n}…`;
    const reset = () => { recBtn.classList.remove('on'); recBtn.textContent = '● REC'; };
    const iv = setInterval(() => {
      n--;
      if (n > 0) { recBtn.textContent = `${n}…`; return; }
      clearInterval(iv);
      recBtn.textContent = '● REC…';
      const bail = watchCapture(kind, msg => { toast(msg); reset(); });
      gesture.record(name.trim() || 'Gesture', g => {
        clearTimeout(bail);
        toast(`Recorded "${g.name}"`);
        buildSigPanel();     // new gesture_<id> signal appears in the panel + mapper
        rerender();
      }, 'any', null, kind);
    }, 700);
  });

  document.querySelectorAll('.gesture-del').forEach(b =>
    b.addEventListener('click', () => {
      gesture.remove(b.dataset.gid);
      chordmode.unassign(b.dataset.gid);
      buildSigPanel();
      rerender();
    }));

  document.querySelector('.gesture-restore')?.addEventListener('click', () => {
    gesture.restoreBuiltins();
    buildSigPanel();
    rerender();
  });

  document.getElementById('chord-toggle')?.addEventListener('click', () => {
    const on = !chordmode.enabled;
    // One instrument on the chord bank at a time — radial mode voices
    // through the same chord bank, and radial.setEnabled enforces the same
    // rule from its own side.
    if (on) radial.setEnabled(false);
    chordmode.setEnabled(on);
    rerender();
  });

  // Key changes re-render: every degree option's label ("V · G") depends on
  // the key, so the whole assignment list has to be rebuilt.
  const setKey = partial => { chordmode.setKey(partial); rerender(); };
  document.getElementById('ck-root')?.addEventListener('change', e => setKey({ root: e.target.value }));
  document.getElementById('ck-mode')?.addEventListener('change', e => setKey({ mode: e.target.value }));
  document.getElementById('ck-oct') ?.addEventListener('change', e => setKey({ octave: Number(e.target.value) }));
  // ADSR sliders mutate in place: a re-render mid-drag would drop the pointer
  // capture and the slider would stop following the finger.
  document.getElementById('shep-chord')?.addEventListener('click', () => {
    engine.setShepard({ chord: !engine.getShepard().chord });
    rerender();
  });
  document.querySelectorAll('.ck-env').forEach(el => {
    el.addEventListener('input', e => {
      const k = e.target.dataset.env;
      const v = engine.setChordEnv({ [k]: +e.target.value })[k];
      setReadout(document.getElementById(`ck-env-${k}`),
                 k === 'sustain' ? `${Math.round(v * 100)}%` : `${v.toFixed(2)}s`);
    });
  });

  wireArpRow('ck', rerender);

  // Re-renders: the accidental pickers appear with SINGLE NOTES, the 7ths go
  // dead, and every row relabels from a chord to the pitch it will sound.
  document.getElementById('ck-voicing')?.addEventListener('change', e => {
    chordmode.setVoicing(e.target.value);
    rerender();
  });
  document.getElementById('ck-acc-sharp')?.addEventListener('change', e => {
    chordmode.setAccidentalGestures({ sharp: e.target.value || null });
    rerender();   // taking a shape for ♯ may have freed it from ♭
  });
  document.getElementById('ck-acc-flat')?.addEventListener('change', e => {
    chordmode.setAccidentalGestures({ flat: e.target.value || null });
    rerender();
  });

  document.getElementById('ck-follow')?.addEventListener('click', () => {
    // Turning follow off keeps whatever key was being followed, so the sound
    // doesn't jump the moment you take manual control.
    const eff = chordmode.effectiveKey();
    setKey(chordmode.key().follow
      ? { follow: false, root: eff.root, mode: eff.mode }
      : { follow: true });
  });

  // Expression: every one of these changes which other controls are live (the
  // hand select only matters in two-handed play, the control select not at all
  // in gesture mode), so they all re-render.
  const setExpr = partial => { chordmode.setExpression(partial); rerender?.(); };
  document.getElementById('ck-expr-mode')?.addEventListener('change', e => setExpr({ mode: e.target.value }));
  // Re-render: the row dims and re-reads when PLAY WITH decides the hand for it.
  document.getElementById('ck-name-hand')?.addEventListener('change', e => {
    chordmode.setNamingHand(e.target.value);
    rerender();
  });
  document.getElementById('ck-expr-hand')?.addEventListener('change', e => setExpr({ hand: e.target.value }));
  document.getElementById('ck-expr-control')?.addEventListener('change', e => setExpr({ control: e.target.value }));
  // The range sliders mutate in place — a re-render mid-drag drops the pointer
  // capture, and these are exactly the controls you want to adjust while
  // watching the meter move.
  document.getElementById('ck-expr-lo')?.addEventListener('input', e =>
    chordmode.setExpression({ lo: +e.target.value }));
  document.getElementById('ck-expr-hi')?.addEventListener('input', e =>
    chordmode.setExpression({ hi: +e.target.value }));

  // Choosing a handshape for a chord (or for RELEASE) always re-renders:
  // the shape is taken off whatever it was doing, so at least one other row
  // changes too. Updating only the row that was touched is what would let the
  // panel disagree with the state again.
  document.querySelectorAll('.ch-shape').forEach(sel =>
    sel.addEventListener('change', e => {
      const where = e.target.dataset.degree;
      const id = e.target.value || null;
      if (where === 'release') chordmode.setReleaseGesture(id);
      else chordmode.setDegreeGesture(Number(where), id);
      rerender?.();
    }));

  // The 7th belongs to the chord, so no re-render — but two things DO carry the
  // numeral it changes, and both are patched in place. Rebuilding the panel
  // instead would drop the pointer mid-click and reset the scroll position of
  // a list you are working down.
  document.querySelectorAll('.ch-sev').forEach(btn =>
    btn.addEventListener('click', () => {
      const d = Number(btn.dataset.degree);
      const on = !chordmode.sevenths()[d];
      chordmode.setSeventh(d, on);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      // The row label carries the quality ("V" vs "V7"), so it moves with it.
      const lbl = btn.parentElement?.querySelector('.chord-degree');
      const c = chordmode.chordAt(d);
      if (lbl && c) { lbl.textContent = `${c.numeral} · ${c.rootName}`; lbl.title = `${c.numeral} · ${c.rootName} ${c.quality}`; }
    }));
}

// Cheap per-frame update: light the dot of each currently-held gesture and
// show the active gesture→chord.
export function updateGesturePanel() {
  const active = new Set(gesture.current());
  gesture.list().forEach(g => {
    const dot = document.getElementById(`gdot-${g.id}`);
    if (dot) dot.classList.toggle('on', active.has(g.id));
  });
  if (chordmode.enabled) {
    const el = document.getElementById('chord-readout');
    if (el) {
      const txt = chordmode.currentLabel() || '—';
      if (el.textContent !== txt) el.textContent = txt;
    }
    // Which chord is sounding, lit on its own row — the same dot the gestures
    // list uses, because it answers the same question ("is this the one?") and
    // a second visual language for it would be noise.
    // Two states, because latched-but-silent is a real one: in volume mode a
    // chord stays selected while your hand is closed. A single lit dot at 0%
    // volume would read as "this is playing" and be wrong.
    // A SET, because two hands can name two degrees at once and lighting only
    // the first of them would say the second one is not playing.
    const sounding = new Set(chordmode.soundingDegrees());
    const lead = chordmode.soundingDegree();
    const audible = chordmode.chordLevel() > 0.001;
    for (let i = 0; i < DEGREES; i++) {
      const d = document.getElementById(`cdot-${i}`);
      if (!d) continue;
      const named = sounding.has(i) || i === lead;
      d.classList.toggle('on',  named && audible);
      d.classList.toggle('sel', named && !audible);
    }
    const rel = document.getElementById('cdot-release');
    if (rel) rel.classList.toggle('on', chordmode.releaseHeld());

    // What the off hand is saying, live. Worth its own indicator rather than
    // only appearing inside the readout: a sharp that is not being recognized
    // is invisible until you play a note and hear the wrong one, and this says
    // so while your hand is still up.
    const accEl = document.getElementById('ck-acc-read');
    if (accEl) {
      const a = chordmode.currentAccidental();
      // An em dash in chord voicing: there is no accidental to be at, and a
      // standing ♮ would claim otherwise.
      const txt = chordmode.getVoicing() === 'note' ? accidentalSign(a) || '♮' : '—';
      if (accEl.textContent !== txt) accEl.textContent = txt;
      accEl.classList.toggle('on', a !== 0);
    }

    // …and how loud it actually is. The expression meter above shows the input;
    // this shows the result, which is not the same number once an ADSR is in
    // between — during a release the input is already at zero and the chord is
    // still sounding.
    const lvl = audible ? chordmode.chordLevel() : 0;
    const fillV = document.getElementById('chord-vol-fill');
    if (fillV) {
      const pct = `${Math.round(lvl * 100)}%`;
      if (fillV.style.width !== pct) fillV.style.width = pct;
      fillV.classList.toggle('on', lvl > 0.001);
      const r = document.getElementById('chord-vol-read');
      if (r && r.textContent !== pct) r.textContent = pct;
    }

    updateArpRow('ck', chordmode.arpPoolSize());

    // Live expression meter. Without it, calibrating the range is guesswork:
    // you cannot see that a closed fist still reads 0.38 and so never reaches
    // silence, which is the whole reason the range exists.
    const fill = document.getElementById('ck-expr-fill');
    if (fill) {
      const { raw, level, gateOpen } = chordmode.expressionLevel();
      const pct = `${Math.round(level * 100)}%`;
      if (fill.style.width !== pct) fill.style.width = pct;
      fill.classList.toggle('on', gateOpen);
      const read = document.getElementById('ck-expr-read');
      const txt = `${raw.toFixed(2)} → ${Math.round(level * 100)}%`;
      if (read && read.textContent !== txt) read.textContent = txt;
    }
  }
}
