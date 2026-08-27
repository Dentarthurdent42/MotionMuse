// Node-graph mapper — inputs (signals) on the left, outputs (parameters) on
// the right, wired together with cables. The point is INPUT REUSE: each signal
// is a single node with one output socket that fans out to as many parameter
// nodes as you like (à la Blender geometry nodes / UE Blueprints). Each output
// parameter takes a single incoming cable (it can only be driven by one thing
// at a time). Drag between two nodes to connect, or tap one socket then the
// other. Tapping a pill's *body* (or clicking its cable) selects it and shows
// its range/curve/steps; the editor stays hidden otherwise to keep the graph
// uncluttered.

import { bus }    from '../bus.js';
import { engine } from '../engine.js';
import { mapper } from '../mapper.js';
import { mtof, parseNote, midiName }        from '../scale.js';
import { STEP_OPTS }                       from '../dynamics.js';
import { drawKeyboard, midiAtPoint, midiOf } from './keyboard.js';
import { isDesktop } from './viewport.js';

const PARAM_KEYS = Object.keys(engine.PARAMS);

const CURVE_OPTS = [
  ['linear', 'Linear'], ['quad', 'Quadratic'], ['cubic', 'Cubic'],
  ['log', 'Logarithmic'], ['sqrt', 'Square Root'], ['inv', 'Invert'],
  ['invquad', 'Invert + Ease'],
].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

// Signals are all registered at startup, so a label is normally there. The
// fallback humanises the key rather than leaking `hand_R_open` into the UI —
// a bus key is an internal name and should never be shown as prose.
const humanizeKey = k => String(k)
  .split('_')
  .map(w => w.length === 1 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ');
const sigLabel = k => bus.signals.get(k)?.label ?? humanizeKey(k);

// Optional per-cable quantisation: turn a continuous signal into N discrete
// levels (applied after the curve, so pair with log/quad for perceptual steps).
const STEP_SEL_OPTS = ['<option value="0">off</option>',
  ...STEP_OPTS.map(s => `<option value="${s}">${s}</option>`)].join('');

// Output parameters grouped into meaningful categories for the picker.
// Exported for tests/unit/param-cats.test.js: a param key missing from this
// table silently vanishes from the add-output picker.
// A function, not a constant: the oscillator bank is resizable, so its keys are
// only knowable at call time. Everything below the bank is fixed.
export const PARAM_CATS = () => [
  ['Oscillators', Array.from({ length: engine.getOscCount() }, (_, i) =>
    [`osc${i + 1}_freq`, `osc${i + 1}_detune`, `osc${i + 1}_volume`]).flat()],
  ['Filter',      ['filter_freq', 'filter_q', 'osc_volume']],
  ['Gesture Mode', ['chord_filter_freq', 'chord_filter_q', 'chord_volume', 'arp_rate', 'arp_gate']],
  ['LFO',         ['lfo_rate', 'lfo_depth']],
  ['Output',      ['reverb_mix', 'volume', 'loop_volume']],
];

// Grouped <optgroup> option lists so the pickers stay categorized, not flat.
function groupedSignalOptions(exclude) {
  const groups = new Map();
  bus.signals.forEach((s, k) => {
    if (exclude.includes(k)) return;
    const g = s.group || 'misc';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(`<option value="${k}">${s.label}</option>`);
  });
  let o = '';
  groups.forEach((opts, g) => { o += `<optgroup label="${g}">${opts.join('')}</optgroup>`; });
  return o;
}
function groupedParamOptions(exclude) {
  let o = '';
  for (const [cat, keys] of PARAM_CATS()) {
    const av = keys.filter(k => !exclude.includes(k));
    if (av.length) o += `<optgroup label="${cat}">${av.map(k => `<option value="${k}">${engine.PARAMS[k].label}</option>`).join('')}</optgroup>`;
  }
  return o;
}

// Stable, legible cable/socket colour per signal (OKLab hue from a hash).
function sigHue(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}
const sigColor = key => key ? `oklch(0.78 0.14 ${sigHue(key)})` : 'oklch(0.6 0 0)';

let selectedId = null;          // selected cable (mapping id)
const wireRefs = new Map();     // mapping id → <path>, cached per drawWires (per-frame lookups)
let addedInputs = new Set();    // input nodes with no cable yet (user-added)
let addedOutputs = new Set();   // output nodes with no cable yet (user-added)
let wiring = null;              // in-progress connection { side, key, moved }

// Musical default ranges for freshly-wired outputs (else the param's full range).
// Every oscillator's pitch gets the same octave-and-a-bit span.
const defaultRange = key => (isFreqParam(key) ? [220, 880] : null);

// Outputs remember how they were configured. Re-wiring a different input into
// a parameter (or unplugging and re-plugging it) used to rebuild the mapping
// from defaults, silently throwing away the range/curve/steps you'd set up.
// The range and curve describe how that *parameter* is driven, so they should
// outlive a change of source.
const lastSettings = new Map();   // param key → { outMin, outMax, curve, steps, invert }
const rememberSettings = m => {
  if (!m?.audioParam) return;
  lastSettings.set(m.audioParam,
    { outMin: m.outMin, outMax: m.outMax, curve: m.curve, steps: m.steps, invert: m.invert });
};

// ── Frequency-range picker state (oscillator-frequency cables only) ──────
// Pick the min/max of the range as *tones*: click the labeled piano, play
// QWERTY keys (A W S E D F T G Y H U J, Z/X octave), or type "A4" in the
// fields. `fpArm` is which endpoint the next pick sets.
const isFreqParam = k => /^osc\d+_freq$/.test(k);
const clampFreq = f => Math.round(Math.max(40, Math.min(2000, f)) * 10) / 10;
let fpArm = 'min';
let fpOct = 4;

// Nodes shown = endpoints used by a mapping ∪ user-added — so the canvas
// isn't cluttered with every possible output up front.
function inputKeys() {
  const used = mapper.mappings.filter(m => m.signal).map(m => m.signal);
  return [...new Set([...used, ...addedInputs])];
}
function outputKeys() {
  const used = mapper.mappings.filter(m => m.signal).map(m => m.audioParam);
  return PARAM_KEYS.filter(k => used.includes(k) || addedOutputs.has(k));
}

export function renderMapper() {
  const rows = document.getElementById('mapper-rows');

  const inputs = inputKeys();
  const outputs = outputKeys();

  // The × sits on the *outer* edge of each pill, opposite its socket, so a
  // fat finger reaching for one can't hit the other.
  const inNodes = inputs.map(k => `
    <div class="ng-node ng-in" data-key="${k}" style="--wire:${sigColor(k)}">
      <button class="ng-node-del" data-kind="in" data-key="${k}" aria-label="Remove ${sigLabel(k)}">×</button>
      <span class="ng-node-title" title="${sigLabel(k)}">${sigLabel(k)}</span>
      <button class="ng-socket ng-out" data-side="out" data-key="${k}"
              aria-label="Output of ${sigLabel(k)} — connect to a parameter"></button>
    </div>`).join('');

  const outNodes = outputs.map(k => {
    const wired = mapper.mappings.find(m => m.audioParam === k && m.signal);
    return `
    <div class="ng-node ng-out${wired ? ' wired' : ''}" data-key="${k}"
         style="${wired ? `--wire:${sigColor(wired.signal)}` : ''}">
      <button class="ng-socket ng-in" data-side="in" data-key="${k}"
              aria-label="Input of ${engine.PARAMS[k].label}"></button>
      <span class="ng-node-title">${engine.PARAMS[k].label}</span>
      <button class="ng-node-del" data-kind="out" data-key="${k}" aria-label="Remove ${engine.PARAMS[k].label}">×</button>
    </div>`;
  }).join('');

  const sel = selectedId != null ? mapper.mappings.find(m => m.id === selectedId) : null;
  const isFreq = sel && isFreqParam(sel.audioParam);
  // Frequency cables use text inputs (they accept note names like "A4") plus
  // a click/QWERTY-playable labeled piano; everything else keeps number inputs.
  const editor = sel ? `
    <div id="ng-editor"${isFreq ? ' data-freq="1"' : ''}>
      <span class="ng-edit-label">${sigLabel(sel.signal)} → ${engine.PARAMS[sel.audioParam].label}</span>
      <label>min <input type="${isFreq ? 'text' : 'number'}" class="m-min" value="${sel.outMin}"
        ${isFreq ? `title="${midiName(midiOf(sel.outMin))} — Hz or a note name like A4"` : 'step="any"'}></label>
      <label>max <input type="${isFreq ? 'text' : 'number'}" class="m-max" value="${sel.outMax}"
        ${isFreq ? `title="${midiName(midiOf(sel.outMax))} — Hz or a note name like A4"` : 'step="any"'}></label>
      <label>curve <select class="m-curve">${CURVE_OPTS.replace(`value="${sel.curve}"`, `value="${sel.curve}" selected`)}</select></label>
      <label>steps <select class="m-steps">${STEP_SEL_OPTS.replace(`value="${sel.steps ?? 0}"`, `value="${sel.steps ?? 0}" selected`)}</select></label>
      <button class="wave-btn m-invert${sel.invert ? ' on' : ''}" aria-pressed="${sel.invert ? 'true' : 'false'}"
              title="Reverse the connection: the input's high end drives the output's low end">⇅ INVERT</button>
      <button class="rm-btn" id="ng-del" aria-label="Delete cable">×</button>
      ${isFreq ? `
      <div class="ng-freq-picker">
        <div class="ng-freq-bar">
          <button class="wave-btn${fpArm === 'min' ? ' on' : ''}" id="fp-min" aria-pressed="${fpArm === 'min'}">SET MIN</button>
          <button class="wave-btn${fpArm === 'max' ? ' on' : ''}" id="fp-max" aria-pressed="${fpArm === 'max'}">SET MAX</button>
          <button class="wave-btn ng-freq-nudge" id="fp-down" aria-label="Down a semitone">−</button>
          <button class="wave-btn ng-freq-nudge" id="fp-up" aria-label="Up a semitone">+</button>
          <span class="ng-freq-oct" id="fp-oct">oct ${fpOct} · Z/X</span>
        </div>
        <div class="ng-freq-kbd-wrap">
          <canvas id="fp-kbd" class="ng-freq-kbd"
                  aria-label="Piano keyboard — tap a key to set the ${fpArm === 'min' ? 'minimum' : 'maximum'} frequency"></canvas>
        </div>
        <div class="ng-freq-hint">tap a key or play A W S E D F T G Y H U J · − / + nudge a semitone · type "C#4" or Hz above · ● min ● max</div>
      </div>` : ''}
    </div>` : '';

  rows.innerHTML = `
    <div id="nodegraph">
      <svg id="ng-wires" aria-hidden="true"></svg>
      <div class="ng-col ng-col-in">${inNodes || '<div class="ng-hint">add an input ↓</div>'}</div>
      <div class="ng-col ng-col-out">${outNodes || '<div class="ng-hint">add an output ↓</div>'}</div>
    </div>
    <div class="ng-addbar">
      <select id="ng-add-input" aria-label="Add an input signal">
        <option value="">+ add input…</option>
        ${groupedSignalOptions(inputs)}
      </select>
      <select id="ng-add-output" aria-label="Add an output parameter">
        <option value="">+ add output…</option>
        ${groupedParamOptions(outputs)}
      </select>
    </div>
    ${editor}`;

  wireHandlers(rows);
  // A re-render mid-gesture (selecting a node while armed for tap-to-connect)
  // rebuilds the sockets, so re-apply the armed highlight to the new DOM.
  if (wiring) {
    rows.querySelector(`.ng-socket.ng-${wiring.side}[data-key="${wiring.key}"]`)
      ?.classList.add('armed');
  }
  ensureRedrawObserver();
  requestAnimationFrame(() => { drawWires(); drawFreqKbd(); });
}

// ── Frequency picker internals ────────────────────────────────────────────
const selMapping = () => mapper.mappings.find(m => m.id === selectedId);

// Must mirror .ng-freq-kbd's CSS height at each breakpoint — drawKeyboard
// sizes the bitmap from this, so a mismatch stretches the drawing. On narrow
// screens the canvas is also wider than its scroll container (see CSS), which
// is what makes individual keys big enough to tap.
const fpKbdHeight = () =>
  globalThis.matchMedia?.('(max-width: 768px)').matches ? 88
    : isDesktop() ? 72 : 56;

function drawFreqKbd() {
  const s = selMapping(), c = document.getElementById('fp-kbd');
  if (!s || !c || !isFreqParam(s.audioParam)) return;
  // m1 (purple) marks the range MIN, m2 (cyan) the range MAX.
  drawKeyboard(c, { height: fpKbdHeight(), labels: true, scale: null,
                    m1: midiOf(s.outMin), m2: midiOf(s.outMax) });
}

function armEndpoint(which) {
  fpArm = which;
  document.getElementById('fp-min')?.classList.toggle('on', fpArm === 'min');
  document.getElementById('fp-max')?.classList.toggle('on', fpArm === 'max');
  document.getElementById('fp-min')?.setAttribute('aria-pressed', String(fpArm === 'min'));
  document.getElementById('fp-max')?.setAttribute('aria-pressed', String(fpArm === 'max'));
  document.getElementById('fp-kbd')?.setAttribute('aria-label',
    `Piano keyboard — tap a key to set the ${fpArm === 'min' ? 'minimum' : 'maximum'} frequency`);
}

// Apply a picked tone to the armed endpoint. Mutates the mapping + field in
// place (no renderMapper — a full innerHTML rebuild would kill the
// interaction mid-gesture) and auditions the tone.
//
// The armed endpoint deliberately does NOT advance after a pick: staying on
// MIN lets you audition and correct it (tap a neighbour, nudge a semitone)
// until you explicitly press SET MAX.
function pickMidi(m) {
  const s = selMapping();
  if (!s || !isFreqParam(s.audioParam)) return;
  const f = clampFreq(mtof(m));
  const field = document.querySelector(fpArm === 'min' ? '#ng-editor .m-min' : '#ng-editor .m-max');
  if (fpArm === 'min') s.outMin = f; else s.outMax = f;
  if (field) { field.value = f; field.title = `${midiName(m)} — Hz or a note name like A4`; }
  engine.playTone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.1 });
  drawFreqKbd();
}

// Shift the armed endpoint by a semitone — precise correction after an
// approximate tap, which is what fingers land on a 5-octave keyboard.
function nudgeArmed(delta) {
  const s = selMapping();
  if (!s || !isFreqParam(s.audioParam)) return;
  pickMidi(midiOf(fpArm === 'min' ? s.outMin : s.outMax) + delta);
}

// QWERTY note entry — one document-level listener (module scope survives
// renderMapper rebuilds; it re-queries the DOM per event). Active only while
// a frequency cable's editor is open and focus isn't in a form field.
const FP_KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11 };
// Guarded so the module stays importable in node (unit tests).
if (globalThis.document !== undefined) document.addEventListener('keydown', e => {
  if (!document.querySelector('#ng-editor[data-freq]')) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'x') {
    fpOct = Math.max(1, Math.min(7, fpOct + (k === 'x' ? 1 : -1)));
    const o = document.getElementById('fp-oct');
    if (o) o.textContent = `oct ${fpOct} · Z/X`;
    e.preventDefault();
    return;
  }
  if (k in FP_KEYMAP) {
    e.preventDefault();
    pickMidi(12 * (fpOct + 1) + FP_KEYMAP[k]);
  }
});

function wireHandlers(rows) {
  rows.querySelector('#ng-add-input')?.addEventListener('change', e => {
    if (e.target.value) { addedInputs.add(e.target.value); renderMapper(); }
  });
  rows.querySelector('#ng-add-output')?.addEventListener('change', e => {
    if (e.target.value) { addedOutputs.add(e.target.value); renderMapper(); }
  });

  // Remove a node entirely (and any cable attached to it). Works even in the
  // minimal one-in/one-out case.
  rows.querySelectorAll('.ng-node-del').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    removeNode(btn.dataset.kind, btn.dataset.key);
  }));

  // Connect by dragging between nodes, or tap-to-arm then tap the target
  // (touch- and keyboard-friendly). Fat-finger friendly in three ways:
  // the whole pill starts a wire (not just the 15px socket), the socket
  // carries an invisible oversized tap halo, and the drop point resolves to
  // the *nearest* eligible socket within a fingertip's radius. On touch the
  // pointer is implicitly captured by the origin, so the drop target is
  // resolved from coordinates rather than the target's own pointerup.
  rows.querySelectorAll('.ng-node').forEach(node => {
    const sock = node.querySelector('.ng-socket');
    if (!sock) return;
    const side = sock.dataset.side, key = sock.dataset.key;

    node.addEventListener('pointerdown', e => {
      if (e.target.closest('.ng-node-del')) return;   // the × owns its own taps
      e.preventDefault();
      if (wiring && wiring.side !== side) { finishWire(sock); return; }  // 2nd tap
      if (wiring && wiring.key === key)   { cancelWire();   return; }    // same node → cancel
      // Where the press landed decides what a *tap* means (a drag always
      // wires, from anywhere on the pill): on the socket it arms a
      // tap-to-connect, on the pill body it just inspects the node. Without
      // that split, tapping two nodes to read their settings would silently
      // rewire them.
      wiring = { side, key, moved: false, id: e.pointerId,
                 fromBody: !e.target.closest('.ng-socket') };
      sock.classList.add('armed');
      try { node.setPointerCapture(e.pointerId); } catch { /* ok */ }
    });
    node.addEventListener('pointermove', e => {
      if (!wiring || wiring.id !== e.pointerId) return;
      wiring.moved = true;
      drawPreview(e.clientX, e.clientY);
      markDropTarget(socketAt(e.clientX, e.clientY, wiring.side === 'out' ? 'in' : 'out'));
    });
    node.addEventListener('pointerup', e => {
      if (!wiring || wiring.id !== e.pointerId) return;
      // Fuzzy drop resolution belongs to *drags* only. A stationary tap must
      // not consume it: the columns can sit closer together than the tolerance
      // (34px gap vs 48px radius on mobile), so a tap would otherwise wire
      // itself to whatever happened to be nearest across the gap.
      const tgt = wiring.moved
        ? socketAt(e.clientX, e.clientY, wiring.side === 'out' ? 'in' : 'out')
        : null;
      if (tgt) { finishWire(tgt); return; }
      if (wiring.moved) { cancelWire(); return; }    // dragged to nowhere → cancel
      // A stationary tap. Either way it points the editor at this node's cable
      // — otherwise the fields keep showing whichever cable was last clicked.
      // A body tap is *only* an inspect, so drop the arm; a socket tap stays
      // armed so the next socket completes the connection.
      if (wiring.fromBody) cancelWire();
      if (selectCableAt(side, key)) renderMapper();
    });
    sock.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); node.dispatchEvent(new PointerEvent('pointerdown', { pointerId: -1, bubbles: true })); }
    });
  });

  // Range fields. Frequency cables also accept note names ("A4", "C#3") —
  // parsed to Hz on commit; garbage restores the previous value.
  const parseField = (raw, isFreq) => {
    if (isFreq) {
      const m = parseNote(raw);
      if (m != null) return clampFreq(mtof(m));
    }
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };
  const fieldHandler = which => e => {
    const s = sel();
    if (!s) return;
    const isFreq = isFreqParam(s.audioParam);
    const v = parseField(e.target.value, isFreq);
    if (v == null) { e.target.value = which === 'min' ? s.outMin : s.outMax; return; }
    if (which === 'min') s.outMin = v; else s.outMax = v;
    e.target.value = v;   // note names echo back as the resolved Hz
    if (isFreq) {
      e.target.title = `${midiName(midiOf(v))} — Hz or a note name like A4`;
      engine.playTone({ freq: v, dur: 0.3, type: 'triangle', gain: 0.1 });
      drawFreqKbd();
    }
  };
  rows.querySelectorAll('.m-min').forEach(el => el.addEventListener('change', fieldHandler('min')));
  rows.querySelectorAll('.m-max').forEach(el => el.addEventListener('change', fieldHandler('max')));
  rows.querySelectorAll('.m-curve').forEach(el => el.addEventListener('change', e => {
    if (sel()) sel().curve = e.target.value;
  }));
  rows.querySelectorAll('.m-invert').forEach(el => el.addEventListener('click', e => {
    const s = sel();
    if (!s) return;
    s.invert = !s.invert;
    e.currentTarget.classList.toggle('on', s.invert);
    e.currentTarget.setAttribute('aria-pressed', String(s.invert));
  }));
  rows.querySelectorAll('.m-steps').forEach(el => el.addEventListener('change', e => {
    const s = sel();
    if (!s) return;
    s.steps = Math.max(0, parseInt(e.target.value, 10) || 0);
    delete s._stepIdx;      // stale sticky index belongs to the old level count
  }));
  rows.querySelector('#ng-del')?.addEventListener('click', () => {
    if (selectedId != null) disconnect(selectedId);
  });

  // Frequency picker: arm buttons, semitone nudges, and a tappable piano.
  rows.querySelector('#fp-min')?.addEventListener('click', () => armEndpoint('min'));
  rows.querySelector('#fp-max')?.addEventListener('click', () => armEndpoint('max'));
  rows.querySelector('#fp-down')?.addEventListener('click', () => nudgeArmed(-1));
  rows.querySelector('#fp-up')?.addEventListener('click', () => nudgeArmed(+1));

  // Pick on pointer*up*, and only when the pointer barely moved — on narrow
  // screens the keyboard is wider than its container and scrolls, so a
  // horizontal drag must pan rather than silently pick whatever it started on.
  const kbd = rows.querySelector('#fp-kbd');
  if (kbd) {
    let down = null;
    kbd.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, id: e.pointerId }; });
    kbd.addEventListener('pointercancel', () => { down = null; });
    kbd.addEventListener('pointerup', e => {
      if (!down || down.id !== e.pointerId) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 10) return;                       // that was a scroll, not a tap
      const r = kbd.getBoundingClientRect();
      pickMidi(midiAtPoint(r.width, r.height, e.clientX - r.left, e.clientY - r.top));
    });
  }

  function sel() { return mapper.mappings.find(m => m.id === selectedId); }
}

// Remove just the cable, but keep both endpoint nodes on the canvas so they
// can be re-wired — disconnecting shouldn't make the nodes vanish.
function disconnect(id) {
  const m = mapper.mappings.find(x => x.id === id);
  if (m) {
    if (m.signal)     addedInputs.add(m.signal);
    if (m.audioParam) addedOutputs.add(m.audioParam);
    rememberSettings(m);              // re-plugging restores these
    mapper.remove(id);
  }
  selectedId = null;
  renderMapper();
}

// Remove a node and any cable attached to it.
function removeNode(kind, key) {
  if (kind === 'in') {
    addedInputs.delete(key);
    mapper.mappings.filter(m => m.signal === key).forEach(m => {
      addedOutputs.add(m.audioParam);   // keep the far end's node
      rememberSettings(m);
      mapper.remove(m.id);
    });
  } else {
    addedOutputs.delete(key);
    mapper.mappings.filter(m => m.audioParam === key).forEach(m => { rememberSettings(m); mapper.remove(m.id); });
  }
  selectedId = null;
  renderMapper();
}

// Point the editor at the cable belonging to a node. An input node can fan out
// to several outputs, so its first cable wins; an output has at most one. A
// node with no cable clears the editor rather than leaving someone else's
// settings on screen. Returns whether the selection actually moved.
function selectCableAt(side, key) {
  const m = side === 'out'
    ? mapper.mappings.find(x => x.signal === key)        // input node's socket is an output
    : mapper.mappings.find(x => x.audioParam === key);   // output node
  const next = m?.id ?? null;
  if (next === selectedId) return false;
  selectedId = next;
  fpArm = 'min';                 // a different cable starts at its min endpoint
  return true;
}

// ── Drop-target resolution ──
// A fingertip is ~40px across; a socket is 15px. Resolve a release point to
// an eligible socket generously: exact hit → the enclosing pill's socket →
// nearest socket within a fingertip's radius.
const DROP_TOL = 48;

function socketAt(x, y, wantSide) {
  const el = document.elementFromPoint(x, y);
  const direct = el?.closest?.('.ng-socket');
  if (direct && direct.dataset.side === wantSide) return direct;
  const viaNode = el?.closest?.('.ng-node')?.querySelector(`.ng-socket[data-side="${wantSide}"]`);
  if (viaNode) return viaNode;
  let best = null, bestD = DROP_TOL;
  document.querySelectorAll(`.ng-socket[data-side="${wantSide}"]`).forEach(s => {
    const r = s.getBoundingClientRect();
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < bestD) { best = s; bestD = d; }
  });
  return best;
}

// Highlight where the wire would land, so an imprecise drag shows its intent.
function markDropTarget(sock) {
  document.querySelectorAll('.ng-socket.drop-target')
    .forEach(s => { if (s !== sock) s.classList.remove('drop-target'); });
  sock?.classList.add('drop-target');
}

// ── Connection logic ──
function connect(sigKey, paramKey) {
  // One incoming cable per output: replace whatever was driving this param,
  // but keep the displaced signal's node on the canvas (it just loses a cable).
  mapper.mappings.filter(m => m.audioParam === paramKey).forEach(m => {
    if (m.signal && m.signal !== sigKey) addedInputs.add(m.signal);
    rememberSettings(m);              // keep this output's range/curve/steps
    mapper.remove(m.id);
  });
  const prev = lastSettings.get(paramKey);
  const [lo, hi] = prev ? [prev.outMin, prev.outMax]
    : (defaultRange(paramKey) ?? [engine.PARAMS[paramKey].min, engine.PARAMS[paramKey].max]);
  const id = mapper.add(paramKey, sigKey, lo, hi, prev?.curve ?? 'linear', prev?.steps ?? 0,
                        prev?.invert ?? false);
  addedInputs.delete(sigKey);
  addedOutputs.delete(paramKey);
  selectedId = id;
  fpArm = 'min';   // a fresh cable's picker starts at the min endpoint
  renderMapper();
}

function finishWire(sock) {
  const sig   = wiring.side === 'out' ? wiring.key : sock.dataset.key;
  const param = wiring.side === 'out' ? sock.dataset.key : wiring.key;
  cancelWire();
  connect(sig, param);
}
function cancelWire() {
  wiring = null;
  document.querySelectorAll('.ng-socket.armed').forEach(s => s.classList.remove('armed'));
  document.querySelectorAll('.ng-socket.drop-target').forEach(s => s.classList.remove('drop-target'));
  document.getElementById('ng-preview')?.remove();
}
function drawPreview(clientX, clientY) {
  const g = document.getElementById('nodegraph'), svg = document.getElementById('ng-wires');
  if (!g || !svg || !wiring) return;
  const box = g.getBoundingClientRect();
  const from = g.querySelector(`.ng-socket.ng-${wiring.side}[data-key="${wiring.key}"]`)?.getBoundingClientRect();
  if (!from) return;
  const x1 = from.left + from.width / 2 - box.left, y1 = from.top + from.height / 2 - box.top;
  const x2 = clientX - box.left, y2 = clientY - box.top;
  let path = document.getElementById('ng-preview');
  if (!path) {
    path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.id = 'ng-preview'; path.setAttribute('fill', 'none');
    path.setAttribute('stroke', sigColor(wiring.side === 'out' ? wiring.key : ''));
    path.setAttribute('stroke-width', '2.5'); path.setAttribute('stroke-dasharray', '5 4');
    svg.appendChild(path);
  }
  const dx = Math.max(20, Math.abs(x2 - x1) * 0.5) * (wiring.side === 'out' ? 1 : -1);
  path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
}

// ── Draw cables ──
function drawWires() {
  const g   = document.getElementById('nodegraph');
  const svg = document.getElementById('ng-wires');
  if (!g || !svg) return;
  const box = g.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.setAttribute('width', box.width); svg.setAttribute('height', box.height);

  const pin = (side, key) => {
    const el = g.querySelector(`.ng-socket.ng-${side}[data-key="${key}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top };
  };

  let paths = '';
  mapper.mappings.forEach(m => {
    if (!m.signal) return;
    const a = pin('out', m.signal), b = pin('in', m.audioParam);
    if (!a || !b) return;
    const dx = Math.max(30, (b.x - a.x) * 0.5);
    const d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    const col = sigColor(m.signal);
    paths += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${m.id === selectedId ? 4 : 2.5}"
      stroke-linecap="round" data-mid="${m.id}" class="ng-wire" style="opacity:0.85"/>`;
  });
  svg.innerHTML = paths;

  wireRefs.clear();
  svg.querySelectorAll('.ng-wire').forEach(w => {
    wireRefs.set(parseInt(w.dataset.mid), w);
    w.style.pointerEvents = 'stroke';
    w.addEventListener('click', () => {
      const id = parseInt(w.dataset.mid);
      selectedId = selectedId === id ? null : id;
      fpArm = 'min';   // fresh selection → picker starts at the min endpoint
      renderMapper();
    });
    w.addEventListener('mouseenter', () => highlightWire(parseInt(w.dataset.mid)));
    w.addEventListener('mouseleave', () => highlightWire(null));
  });
}

function highlightWire(id) {
  const svg = document.getElementById('ng-wires');
  if (!svg) return;
  svg.querySelectorAll('.ng-wire').forEach(w =>
    w.style.opacity = id == null ? 0.85 : (w.dataset.mid == id ? 1 : 0.15));
}

let _ro = null;
function ensureRedrawObserver() {
  if (_ro || globalThis.ResizeObserver === undefined) return;
  const el = document.getElementById('mapper-rows');
  if (!el) return;
  _ro = new ResizeObserver(() => drawWires());
  _ro.observe(el);
}

export function updateMapperBars() {
  if (!wireRefs.size) return;
  mapper.mappings.forEach(m => {
    const w = wireRefs.get(m.id);
    if (!w || !m.signal) return;
    const p = engine.PARAMS[m.audioParam];
    const norm = p ? Math.max(0, Math.min(1, (p.val - p.min) / (p.max - p.min))) : 0;
    if (m.id !== selectedId) w.style.strokeWidth = (2 + norm * 3).toFixed(2);
    w.style.opacity = (0.55 + norm * 0.45).toFixed(2);
  });
}
