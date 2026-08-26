// PRESET button → a menu of named starting patches.
//
// A dropdown that applied on `change` would be a trap: presets replace the
// entire patch, and scrolling a <select> on a phone fires change events. This
// is an explicit popover — open it, read what each preset does and what it
// needs switched on, then choose.

import { mapper, PRESETS } from '../mapper.js';
import { savedConfigs, deleteConfig } from '../saved.js';

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

// When a configuration was kept, in words a person reads at a glance. Exact
// timestamps are for logs; "yesterday" is what someone scanning a list of their
// own setups actually wants.
export function savedWhen(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '';
  const days = Math.floor((now - t) / 86400000);
  if (days < 0) return 'just now';        // a clock that moved backwards
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} wk ago`;
  return `${Math.floor(days / 30)} mo ago`;
}

// `onApplyConfig` restores a whole saved snapshot rather than a patch, so it is
// a different callback from `onApply`: the caller has to refresh the panels and
// decide whether the UI keys it carries mean a reload, exactly as LOAD does.
export function initPresetMenu({ onApply, onApplyConfig, state }) {
  const btn = document.getElementById('preset-btn');
  if (!btn) return;

  const pop = document.createElement('div');
  pop.id = 'preset-pop';
  pop.setAttribute('role', 'menu');
  pop.hidden = true;
  btn.parentElement.appendChild(pop);

  // A name in an attribute and a name in text both come from the sharer's URL
  // or the user's own keyboard, so neither is trusted markup.
  const esc = t => String(t).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const render = () => {
    const s = state();
    // Your own setups first. They are the ones you named, and a list that made
    // you scroll past five built-ins to reach them would be sorted for the app
    // rather than for the person.
    const saved = savedConfigs();
    pop.innerHTML =
      (saved.length ? `<div class="preset-title">YOUR SETUPS</div>` + saved.map(c => `
        <div class="preset-row">
          <button class="preset-item" role="menuitem" data-config="${esc(c.name)}">
            <span class="preset-name">${esc(c.name)}</span>
            <span class="preset-hint">Your saved setup${savedWhen(c.saved) ? ` · ${savedWhen(c.saved)}` : ''}</span>
          </button>
          <button class="rm-btn preset-del" type="button" data-del="${esc(c.name)}"
                  title="Forget this setup" aria-label="Forget ${esc(c.name)}">×</button>
        </div>`).join('') : '') +
      `<div class="preset-title">STARTING PATCHES</div>` +
      PRESETS.map(p => {
        const missing = missingFor(p, s).map(n => NEEDS_LABEL[n] ?? n);
        return `
        <button class="preset-item" role="menuitem" data-preset="${p.id}">
          <span class="preset-name">${p.name}</span>
          <span class="preset-hint">${p.hint}</span>
          ${missing.length ? `<span class="preset-needs">needs ${missing.join(' + ')}</span>` : ''}
        </button>`;
      }).join('');
    pop.querySelectorAll('[data-preset]').forEach(el =>
      el.addEventListener('click', () => {
        const preset = mapper.applyPreset(el.dataset.preset);
        setOpen(false);
        // The caller switches the models and reports what changed — it is the
        // one that knows. Reporting here as well would race it and say less.
        onApply?.(preset, missingFor(preset, state()).map(n => NEEDS_LABEL[n] ?? n));
      }));
    pop.querySelectorAll('[data-config]').forEach(el =>
      el.addEventListener('click', () => {
        setOpen(false);
        onApplyConfig?.(el.dataset.config);
      }));
    // Forgetting is immediate and does not close the menu: the list is the
    // feedback, and someone pruning three stale setups should not have to
    // reopen it twice.
    pop.querySelectorAll('[data-del]').forEach(el =>
      el.addEventListener('click', e => {
        e.stopPropagation();
        deleteConfig(el.dataset.del);
        render();
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
