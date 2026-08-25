// PRESET button → a menu of named starting patches.
//
// A dropdown that applied on `change` would be a trap: presets replace the
// entire patch, and scrolling a <select> on a phone fires change events. This
// is an explicit popover — open it, read what each preset does and what it
// needs switched on, then choose.

import { mapper, PRESETS } from '../mapper.js';

// Human-readable prerequisite, so a preset can't leave you with a silent patch
// and no clue why.
const NEEDS_LABEL = {
  camera: 'START CAMERA',
  face:   '☺ FACE',
  gaze:   '◉ GAZE',
};

// What the user still has to do themselves.
//
// Face and gaze used to be listed here, because applying a preset left them
// untouched and a face patch with the face model off is silent. Applying a
// preset now switches every model to what the patch actually uses (see
// trackersFor in mapper.js), so the only prerequisite left is the one the app
// will not take for you: the camera. Turning someone's webcam on because they
// browsed a menu is not a decision this should make.
export function missingFor(preset, { camera }) {
  return (preset.needs ?? []).filter(n => n === 'camera' && !camera);
}

export function initPresetMenu({ onApply, state }) {
  const btn = document.getElementById('preset-btn');
  if (!btn) return;

  const pop = document.createElement('div');
  pop.id = 'preset-pop';
  pop.setAttribute('role', 'menu');
  pop.hidden = true;
  btn.parentElement.appendChild(pop);

  const render = () => {
    const s = state();
    pop.innerHTML = `<div class="preset-title">STARTING PATCHES</div>` +
      PRESETS.map(p => {
        const missing = missingFor(p, s).map(n => NEEDS_LABEL[n] ?? n);
        return `
        <button class="preset-item" role="menuitem" data-preset="${p.id}">
          <span class="preset-name">${p.name}</span>
          <span class="preset-hint">${p.hint}</span>
          ${missing.length ? `<span class="preset-needs">needs ${missing.join(' + ')}</span>` : ''}
        </button>`;
      }).join('');
    pop.querySelectorAll('.preset-item').forEach(el =>
      el.addEventListener('click', () => {
        const preset = mapper.applyPreset(el.dataset.preset);
        setOpen(false);
        // The caller switches the models and reports what changed — it is the
        // one that knows. Reporting here as well would race it and say less.
        onApply?.(preset, missingFor(preset, state()).map(n => NEEDS_LABEL[n] ?? n));
      }));
  };

  const setOpen = open => {
    if (open) render();          // re-read camera/face/gaze state each time
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };

  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', e => { e.stopPropagation(); setOpen(pop.hidden); });
  document.addEventListener('click', e => {
    if (!pop.hidden && !pop.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !pop.hidden) setOpen(false);
  });
}
