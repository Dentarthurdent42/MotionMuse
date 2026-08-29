// Every slider also takes a typed number.
//
// A slider is for finding a value; a number is for KNOWING one. "Filter at
// 3 kHz", "96 BPM", "attack 0.02 s" are all things you arrive at once and
// then want to set exactly, and hunting for them with a thumb on a 200-pixel
// track is a game, not a control. Every range in the app gets a numeric twin.
//
// Done here rather than in thirteen templates, and applied by observing the
// DOM rather than by each panel remembering to call it, so a slider added
// later is typable without anyone thinking about it.
//
// Two shapes, chosen so nothing moves on screen:
//
//   • where the slider already has a `.ctrl-val` READOUT beside it, that
//     readout becomes the input — the number you were reading is the number
//     you type into, and the layout is untouched because it is the same box;
//   • where there is none, a compact field is appended after the slider —
//     only ever into a flex row or a grid row with a free cell, which is
//     every case the app actually has.
//
// The twin writes through the SLIDER: it sets `.value` and dispatches a real
// `input` event, so every existing handler runs exactly as it does for a
// drag. Nothing had to be rewired to accept typing.

const PAIRED = 'data-num-paired';

// Units live in the readout text ("0.55s", "40%"), which a number input
// cannot hold. The suffix moves to a sibling so the value stays a number —
// and so a cable-driven value can be written back without re-parsing it.
const UNIT_RE = /([a-z%]+)\s*$/i;

// A readout can be mid-render: `updateAudioSliders` writes a formatted string
// every frame. Never fight the user's cursor.
const editing = el => document.activeElement === el;

function fieldFor(range) {
  const f = document.createElement('input');
  f.type = 'number';
  f.className = 'num-in';
  if (range.min !== '') f.min = range.min;
  if (range.max !== '') f.max = range.max;
  // `any`, never the slider's step: the field is where an exact value goes,
  // and inheriting `(max - min) / 300` would mark a typed 5000 invalid (red
  // outline, refused on submit) for missing a notch nobody can see.
  f.step = 'any';
  f.value = trim(range.value);
  // The exact value the last typing left, kept because restoring the drag
  // step rounds the slider's own value away from it.
  let taken = null;
  f.setAttribute('aria-label',
    `${range.getAttribute('aria-label') || range.dataset.key || range.id || 'value'} — type a value`);
  // Enter commits and gets out of the way; the value is already live, so this
  // is only about the keyboard, not about applying anything.
  f.addEventListener('keydown', e => { if (e.key === 'Enter') f.blur(); });
  // Drive the slider, then let its own handlers do the work. `input` rather
  // than `change` so typing is as live as dragging.
  const push = () => {
    if (f.value === '') return;                 // mid-edit, not a value yet
    const lo = range.min === '' ? -Infinity : +range.min;
    const hi = range.max === '' ? Infinity : +range.max;
    const v = Math.max(lo, Math.min(hi, Number(f.value)));
    if (!Number.isFinite(v)) return;
    // A range's value setter rounds to its step, and these steps exist for
    // DRAGGING — `(max - min) / 300` on a filter is 53 Hz, so typing 5000
    // would land on 5015.51. Typing is the exact-value control, so the write
    // AND the event happen with the step out of the way; restoring it re-snaps
    // the thumb by up to half a step, which is invisible on a 200px track and
    // costs nothing, because the handler has already taken the exact number.
    const step = range.step;
    range.step = 'any';
    range.value = String(v);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    // What the handler LEFT, read before the step comes back: a slider with
    // magnetic detents rewrites the value it was given, and the field has to
    // show what was taken rather than what was asked for.
    taken = range.value;
    range.step = step;
  };
  f.addEventListener('input', push);
  // On the way out, show what was actually taken — a value a detent moved is
  // the truth, and a field still showing what was typed would be lying about
  // it. `taken` rather than the live range value, which the restored step has
  // rounded back to the nearest notch.
  f.addEventListener('blur', () => { f.value = trim(taken ?? range.value); taken = null; });
  return f;
}

// Sliders carry absurd step precision (`(max-min)/300`), so a raw value can
// be 3000.0000000000005. Show what a person would write.
const trim = v => String(Math.round(Number(v) * 1e4) / 1e4);

export function enhanceRanges(root = document) {
  if (!root?.querySelectorAll) return;
  for (const range of root.querySelectorAll('input[type="range"]')) {
    if (range.hasAttribute(PAIRED)) continue;
    range.setAttribute(PAIRED, '1');
    const f = fieldFor(range);

    // A readout beside it becomes the field, keeping its id so every existing
    // writer still finds it (see setReadout, which writes either shape).
    const val = range.parentElement?.querySelector(':scope > .ctrl-val');
    if (val) {
      const unit = UNIT_RE.exec(val.textContent ?? '')?.[1] ?? '';
      f.id = val.id;
      f.className = `num-in ${val.className}`.trim();
      if (unit) {
        // One box in, one box out: a unit hung on as a SIBLING would be a
        // second child of whatever laid the readout out, which in the
        // column-stacked ADSR labels drops it onto its own line under the
        // number. Wrapped, the pair occupies exactly the cell the readout did.
        const wrap = document.createElement('span');
        wrap.className = `num-wrap ${val.className}`.trim();
        const u = document.createElement('span');
        u.className = 'num-unit';
        u.textContent = unit;
        val.replaceWith(wrap);
        wrap.append(f, u);
      } else {
        val.replaceWith(f);
      }
    } else {
      range.insertAdjacentElement('afterend', f);
    }
    // Dragging the slider moves the number with it.
    range.addEventListener('input', () => { if (!editing(f)) f.value = trim(range.value); });
  }
}

// What a per-frame updater calls instead of writing `.textContent`: the
// readout may now be an input, and a value the player is typing into must
// not be overwritten mid-keystroke.
export function setReadout(el, text) {
  if (!el) return;
  if (el.tagName !== 'INPUT') {
    if (el.textContent !== text) el.textContent = text;
    return;
  }
  if (editing(el)) return;
  const num = trim(String(text).replace(UNIT_RE, '').trim());
  if (el.value !== num) el.value = num;
}

// Panels rebuild their own innerHTML, so the pairing has to be re-applied —
// watching the document is what keeps that from being thirteen call sites
// and one forgotten fourteenth. Coalesced into a frame: a render is many
// mutations and they only need one pass.
let queued = false;
export function watchRanges() {
  if (!globalThis.MutationObserver) return;
  enhanceRanges(document);
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; enhanceRanges(document); });
  }).observe(document.body, { childList: true, subtree: true });
}
