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
import { devmode }                   from '../devmode.js';
import { buildInfo, buildLabel }        from '../build.js';
import { keyLabel, getBinding, setBinding, captureNextKey } from './hotkeys.js';
import { uicontrol } from '../uicontrol.js';
import { resetLayout }               from './sections.js';

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
    <!-- DEV lives here rather than in the header. It is a control for the
         TOOL — what the app shows you — which is exactly what this panel is
         for, and a permanent top-level button for a mode most people never
         turn on spent header room on the rarest thing in it. -->
    <label class="set-row">DEV MODE
      <button class="wave-btn${devmode.enabled ? ' on' : ''}" id="dev-btn" type="button"
              aria-pressed="${devmode.enabled}"
              title="Developer mode — reveals experimental, under-construction features">${devmode.enabled ? 'ON' : 'OFF'}</button>
    </label>
    <label class="set-row">MUTE KEY
      <button class="wave-btn" id="mute-key-btn" type="button"
              title="Click, then press the key you want. Esc cancels.">${keyLabel(getBinding('mute'))}</button>
    </label>
    <label class="set-row uc-feature">HAND CURSOR <span class="uc-badge">under construction</span>
      <button class="wave-btn" id="uic-toggle" type="button" aria-pressed="${uicontrol.enabled}"
              title="Drive the UI with a hand: clap, then hold up the hand(s) to arm. The armed hand stops playing the instrument until you toggle it back.">${uicontrol.enabled ? 'ON' : 'OFF'}</button>
    </label>
    <label class="set-row uc-feature">CURSOR REACH
      <select id="uic-reach" title="How much of the camera frame maps to the whole screen — higher reach means smaller hand movements">
        ${[['0.10', 'wide'], ['0.15', 'normal'], ['0.22', 'close']].map(([v, l]) =>
          `<option value="${v}"${Math.abs(uicontrol.margin - +v) < 0.01 ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </label>
    <label class="set-row uc-feature">CURSOR KEY
      <button class="wave-btn" id="cursor-key-btn" type="button"
              title="Opens the arming window; disarms everything when armed. Click, then press the key you want. Esc cancels.">${keyLabel(getBinding('cursor'))}</button>
    </label>
    <!-- The only way back to the authored layout. Section positions, heights
         and fold states persist across four localStorage keys, so an
         arrangement made against one build follows you into every build after
         it — including ones that moved the sections it names. Without this the
         only cure is clearing site data, which also takes your gestures,
         patches and presets with it. -->
    <label class="set-row">LAYOUT
      <button class="wave-btn" id="layout-reset-btn" type="button"
              title="Put every section back where the app puts it, forgetting any you have moved, resized or collapsed. Gestures, patches and presets are untouched.">RESET</button>
    </label>
    <!-- Which build is on screen. Here rather than only in the console because
         the question it answers — "am I looking at a cached copy?" — comes up
         most on a phone, where there is no console to check. -->
    <div class="set-build" id="set-build" title="The deployed build this page is running. If it does not match what you just deployed, you are on a cached copy.">build …</div>`;
  document.body.appendChild(el);

  buildInfo().then(b => {
    const out = el.querySelector('#set-build');
    if (out) out.textContent = `build ${buildLabel(b)}`;
  });

  el.querySelector('#theme-select').addEventListener('change', e => setTheme(e.target.value));

  // Two taps, because it discards work and there is no undo — the second tap
  // is the confirmation, and moving away from the button cancels it.
  const resetBtn = el.querySelector('#layout-reset-btn');
  resetBtn.addEventListener('click', () => {
    if (resetBtn.classList.contains('on')) { resetLayout(); return; }
    resetBtn.classList.add('on');
    resetBtn.textContent = 'SURE?';
  });
  resetBtn.addEventListener('pointerleave', () => {
    resetBtn.classList.remove('on');
    resetBtn.textContent = 'RESET';
  });

  // One rebind pattern for every bound action, so a third hotkey is a table
  // row rather than a fourth copy of this closure.
  const wireKeyBtn = (id, action) => {
    const keyBtn = el.querySelector(id);
    keyBtn.addEventListener('click', () => {
      if (keyBtn.classList.contains('on')) return;    // already listening
      keyBtn.classList.add('on');
      keyBtn.textContent = 'PRESS A KEY';
      captureNextKey(code => {
        if (code) setBinding(action, code);
        keyBtn.classList.remove('on');
        keyBtn.textContent = keyLabel(getBinding(action));
      });
    });
  };
  wireKeyBtn('#mute-key-btn', 'mute');
  wireKeyBtn('#cursor-key-btn', 'cursor');

  // Reflect dev mode both ways: the toggle sets it, and `onChange` keeps the
  // button honest when something else does — the tour turns it on to show the
  // sections it reveals, and a stale OFF caption here would be a lie.
  const devBtn = el.querySelector('#dev-btn');
  devBtn.addEventListener('click', () => devmode.toggle());
  devmode.onChange(on => {
    devBtn.classList.toggle('on', on);
    devBtn.setAttribute('aria-pressed', String(on));
    devBtn.textContent = on ? 'ON' : 'OFF';
  });

  const uicBtn = el.querySelector('#uic-toggle');
  uicBtn.addEventListener('click', () => {
    uicontrol.setEnabled(!uicontrol.enabled);
    uicBtn.textContent = uicontrol.enabled ? 'ON' : 'OFF';
    uicBtn.setAttribute('aria-pressed', String(uicontrol.enabled));
  });
  el.querySelector('#uic-reach').addEventListener('change', e =>
    uicontrol.setMargin(parseFloat(e.target.value)));
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
    if (pop?.classList.contains('open')) close(); else open();
  });
  document.addEventListener('click', e => {
    if (pop?.classList.contains('open') && !pop.contains(e.target)) close();
  });
  document.addEventListener('keydown', e => {
    // Not while rebinding — Escape there means "cancel the capture", and the
    // hotkey module has already swallowed it.
    if (e.key === 'Escape' && pop?.classList.contains('open')
        && !pop.querySelector('#mute-key-btn.on, #cursor-key-btn.on')) close();
  });
  window.addEventListener('resize', () => { if (pop?.classList.contains('open')) open(); });
}
