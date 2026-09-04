// One slider row per engine parameter, with the parameter's INPUT socket on
// the node's edge — the row every panel uses for a continuous value, so a
// cable from any signal's output ● lands on it and the slider follows.
//
// Shared by the panels rather than owned by audio-ui.js, because the chord
// voice, the modes and the loop pedal render rows of their own; audio-ui's
// one delegated listener on `.apr` and its per-frame slider refresh then
// cover every row on the page.

import { engine } from '../engine.js';
import { inPort } from './ports.js';

// Tick marks at the snap values, drawn on the track as background gradients
// (native <datalist> ticks are suppressed by our -webkit-appearance:none).
export const tickCss = p => !p.snaps?.length ? '' : p.snaps.map(s => {
  const f = ((s - p.min) / (p.max - p.min) * 100).toFixed(2);
  return `linear-gradient(90deg,transparent calc(${f}% - 1.5px),var(--dim) calc(${f}% - 1.5px),var(--dim) calc(${f}% + 1.5px),transparent calc(${f}% + 1.5px))`;
}).join(',');

const tickBg = p => tickCss(p) ? ` style="background-image:${tickCss(p)}"` : '';

export const rangeRow = (key, p = engine.PARAMS[key]) => `
    <div class="ctrl-row">
      <span class="ctrl-lbl">${inPort(key)}${p.label}</span>
      <input type="range" class="apr" data-key="${key}"
        min="${p.min}" max="${p.max}" value="${p.val}"
        step="${((p.max - p.min) / 300).toPrecision(3)}"${tickBg(p)}>
      <span class="ctrl-val" id="av-${key}">${p.val.toFixed(p.unit === 'Hz' ? 0 : 2)}</span>
    </div>`;

// Rows for the keys the engine has right now; a key it does not (an
// oscillator slot past the bank) is simply absent.
export const rows = keys => keys.filter(k => engine.PARAMS[k]).map(k => rangeRow(k)).join('');
