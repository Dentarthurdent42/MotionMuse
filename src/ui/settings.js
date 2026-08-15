// Settings popover — where aesthetic and operational controls live.
//
// The rule this establishes: a control that changes how the app *looks* or how
// you *drive* it belongs here, not in the audio column. Theme and the mute
// hotkey were sitting between Volume Quantize and Osc 1 Waveform, which put
// "what colour is the UI" in the middle of the signal chain. The audio column
// should read as the instrument; this is the workshop around it.
//
// Anything added here should meet the same test: it configures the tool, not
// the sound.

import { THEMES, getTheme, setTheme } from './theme.js';
import { keyLabel, getBinding, setBinding, captureNextKey } from './hotkeys.js';

let pop = null;

function build() {
  const el = document.createElement('div');
  el.id = 'settings-pop';
  el.setAttribute('role', 'menu');
  el.innerHTML = `
    <div class="donate-title">SETTINGS</div>
    <label class="set-row">THEME
      <select id="theme-select" title="Colour theme — every one is contrast-checked in CI">
        ${THEMES.map(t => `<option value="${t.id}"${t.id === getTheme() ? ' selected' : ''}>${t.label} · ${t.dark ? 'dark' : 'light'}</option>`).join('')}
      </select>
    </label>
    <label class="set-row">MUTE KEY
      <button class="wave-btn" id="mute-key-btn" type="button"
              title="Click, then press the key you want. Esc cancels.">${keyLabel(getBinding('mute'))}</button>
    </label>`;
  document.body.appendChild(el);

  el.querySelector('#theme-select').addEventListener('change', e => setTheme(e.target.value));

  const keyBtn = el.querySelector('#mute-key-btn');
  keyBtn.addEventListener('click', () => {
    if (keyBtn.classList.contains('on')) return;      // already listening
    keyBtn.classList.add('on');
    keyBtn.textContent = 'PRESS A KEY';
    captureNextKey(code => {
      if (code) setBinding('mute', code);
      keyBtn.classList.remove('on');
      keyBtn.textContent = keyLabel(getBinding('mute'));
    });
  });
  return el;
}

export function initSettings() {
  const btn = document.getElementById('settings-btn');
  if (!btn) return;

  const close = () => {
    pop?.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    pop ??= build();
    // Anchored to the button rather than the header: the header is a
    // containing block for its own popovers, and on mobile it wraps to three
    // rows, which would drag the menu down with it.
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    pop.style.right = `${Math.round(window.innerWidth - r.right)}px`;
    pop.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    pop?.classList.contains('open') ? close() : open();
  });
  document.addEventListener('click', e => {
    if (pop?.classList.contains('open') && !pop.contains(e.target)) close();
  });
  document.addEventListener('keydown', e => {
    // Not while rebinding — Escape there means "cancel the capture", and the
    // hotkey module has already swallowed it.
    if (e.key === 'Escape' && pop?.classList.contains('open')
        && !pop.querySelector('#mute-key-btn')?.classList.contains('on')) close();
  });
  window.addEventListener('resize', () => { if (pop?.classList.contains('open')) open(); });
}
