// The shader's output panel — the picture itself.
//
// Everything that decides what the picture LOOKS like is now a node on the
// canvas (src/shadergraph.js, drawn by src/ui/shadernode-ui.js), so this
// panel is down to what a screen is: the canvas the GPU draws into, a line
// of status under it, and the two buttons that are about the picture rather
// than about any one node.
//
// The status line is not decoration. A node graph that compiles to a shader
// can be wired into something a driver refuses, and when that happens the
// last working program keeps drawing — so without a message the app would
// look like it had simply ignored the edit. The line says what the driver
// said, and the picture above it is visibly the older one.

import { shader }         from '../shader.js';
import { shadergraph }    from '../shadergraph.js';
import { shaderChanged }  from './shadernode-ui.js';

// The section label decides the node's id on the canvas
// (ui/workspace.js sectionIdOf), and DEFAULT_COLUMNS places
// `panel:shader-visual-output` in the middle column. Keep the words.
export function shaderSectionHTML() {
  return `
    <div class="audio-section">
      <div class="audio-section-label">Shader — Visual Output</div>
      <div class="shader-frame">
        <canvas id="shader-canvas" class="shader-canvas" aria-label="Shader output"></canvas>
        <p id="shader-empty" class="shader-empty" hidden>
          No shader nodes yet.<br><b>STARTER</b> builds one, <b>+ NODE</b> adds your own.
        </p>
      </div>
      <div id="shader-status" class="shader-status" role="status" aria-live="polite"></div>
      <div class="scale-grid" style="grid-template-columns:1fr 1fr;margin-top:4px;">
        <button type="button" id="shader-add" class="wave-btn"
                title="Open the add menu on the shader nodes">+ NODE</button>
        <button type="button" id="shader-reset" class="wave-btn"
                title="Build a small worked example: cloud, palette, time, output">STARTER</button>
      </div>
    </div>`;
}

let initedCanvas = null;
let dropStatus = null;

// What to do when + NODE is pressed. main.js supplies it, because opening the
// add menu is the canvas's business and this module does not import it.
let onAddNode = () => {};
export function setShaderAddHandler(fn) { onAddNode = fn; }

function showStatus(err) {
  const el = document.getElementById('shader-status');
  if (el) {
    el.textContent = err ? `⚠ ${String(err).split('\n')[0].slice(0, 120)}` : '';
    el.classList.toggle('bad', !!err);
  }
  // An empty graph is not an error and should not read as one — a panel with
  // nothing wired into it says what to press instead of showing a black
  // rectangle and leaving you to guess.
  const empty = document.getElementById('shader-empty');
  if (empty) empty.hidden = shadergraph.nodes().length > 0;
}

// The graph changed from somewhere — keep the empty state honest.
export function refreshShaderPanel() { showStatus(shader.error); }

export function wireShaderSection() {
  const c = document.getElementById('shader-canvas');
  if (!c) return;
  // The panel (and its canvas) is recreated on every audio start — rebind
  // the GL context whenever a fresh canvas appears. A context bound to a
  // canvas that has left the document draws nowhere.
  if (c !== initedCanvas) {
    dropStatus?.();
    shader.init('shader-canvas');
    dropStatus = shader.onStatus(showStatus);
    initedCanvas = c;
    showStatus(shader.error);
  }
  shader.setActive(true);
  document.getElementById('shader-add')?.addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    onAddNode(r.left, r.bottom);
  });
  document.getElementById('shader-reset')?.addEventListener('click', () => {
    shadergraph.reset();
    shaderChanged();          // the canvas gains the starter nodes
    showStatus(shader.error);
  });
}
