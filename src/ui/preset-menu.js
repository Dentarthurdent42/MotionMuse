// PRESET button → a menu of named starting patches.
//
// A dropdown that applied on `change` would be a trap: presets replace the
// entire patch, and scrolling a <select> on a phone fires change events. This
// is an explicit popover — open it, read what each preset does and what it
// needs switched on, then choose.

import { mapper, PRESETS } from '../mapper.js';
import { toast } from './status.js';

// Human-readable prerequisite, so a preset can't leave you with a silent patch
// and no clue why.
const NEEDS_LABEL = {
  camera: 'START CAMERA',
  face:   '☺ FACE',
  gaze:   '◉ GAZE',
};

// What still needs switching on for this preset to make sound.
export function missingFor(preset, { camera, face, gaze }) {
  const have = { camera, face, gaze };
  return (preset.needs ?? []).filter(n => !have[n]);
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
        onApply?.(preset);
        const missing = missingFor(preset, state()).map(n => NEEDS_LABEL[n] ?? n);
        toast(missing.length
          ? `${preset.name} loaded — switch on ${missing.join(' + ')}`
          : `${preset.name} loaded — ${preset.hint}`);
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
