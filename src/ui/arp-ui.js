// The arpeggiator's row — ONE component, rendered into both play modes'
// panels. The arp itself is shared (arpvoice.js): the same state, the same
// clock, whichever mode owns the chord bank. Two hand-written copies of this
// row would disagree within a month, which is the same argument that moved
// the arp out of gesture mode in the first place.
//
// `p` is the panel's id prefix ('ck' in Gesture Mode, 'rk' in Radial Mode),
// so both instances can stand in one document.

import { engine }    from '../engine.js';
import { metronome } from '../metronome.js';
import { arpvoice, ARP_SYNCS } from '../arpvoice.js';
import { ARP_PATTERNS, ARP_MAX_OCTAVES } from '../arp.js';

const PATTERN_LABEL = {
  up: 'UP', down: 'DOWN', updown: 'UP · DOWN', downup: 'DOWN · UP', random: 'RANDOM',
};
const SYNC_LABEL = s => (s === 0 ? 'FREE' : `${s}/BEAT`);

export function arpRowHTML(p) {
  const a = arpvoice.state();
  const arpRate = engine.PARAMS.arp_rate, arpGate = engine.PARAMS.arp_gate;
  const synced = a.sync > 0 && metronome.on;
  return `
    <div class="chord-arp">
      <span class="chord-key-lbl">ARP</span>
      <button class="wave-btn${a.enabled ? ' on' : ''}" id="${p}-arp" aria-pressed="${a.enabled}"
              title="Play the held chord one note at a time instead of as a block. Same chord, same input, same expression — the notes just take turns. One arpeggiator serves both play modes.">${a.enabled ? 'ON' : 'OFF'}</button>
      <select id="${p}-arp-pattern" aria-label="Arpeggio pattern" ${a.enabled ? '' : 'disabled'}
              title="The order the chord's notes are played in. UP · DOWN turns at the ends without playing them twice.">
        ${ARP_PATTERNS.map(k => `<option value="${k}"${k === a.pattern ? ' selected' : ''}>${PATTERN_LABEL[k]}</option>`).join('')}
      </select>
      <select id="${p}-arp-oct" aria-label="Arpeggio octave range" ${a.enabled ? '' : 'disabled'}
              title="How many octaves the run covers. More octaves means more notes before the pattern repeats.">
        ${Array.from({ length: ARP_MAX_OCTAVES }, (_, i) => i + 1).map(o =>
          `<option value="${o}"${o === a.octaves ? ' selected' : ''}>${o} OCT</option>`).join('')}
      </select>
    </div>
    ${a.enabled ? `
    <div class="chord-arp-cal">
      <label class="ctrl-lbl" title="Notes per second. Also a patchbay output — wire a signal to Arp Rate and your hand drives the tempo. Dimmed while SYNC follows the metronome instead.">RATE
        <input type="range" id="${p}-arp-rate" min="${arpRate.min}" max="${arpRate.max}" step="0.1" value="${arpRate.val}"${synced ? ' disabled' : ''}>
      </label>
      <label class="ctrl-lbl" title="How long each note rings, in steps: below 1 is staccato, 1 runs notes wall-to-wall, above 1 lets each note ring under the ones that follow. Also a patchbay output.">GATE
        <input type="range" id="${p}-arp-gate" min="${arpGate.min}" max="${arpGate.max}" step="0.01" value="${arpGate.val}">
      </label>
      <label class="ctrl-lbl" title="Lock the run to the metronome: steps per beat, taking effect while the metronome is ON. FREE uses the RATE slider.">SYNC
        <select id="${p}-arp-sync" aria-label="Sync the arpeggio to the metronome">
          ${ARP_SYNCS.map(v => `<option value="${v}"${v === a.sync ? ' selected' : ''}>${SYNC_LABEL(v)}</option>`).join('')}
        </select>
      </label>
      <div class="arp-read quant-notes" id="${p}-arp-read">—</div>
    </div>` : ''}`;
}

export function wireArpRow(p, rerender) {
  // Toggling and the selects re-render (the sliders appear and disappear with
  // the toggle, RATE dims with SYNC); the sliders themselves mutate in place —
  // a re-render mid-drag drops the pointer capture.
  document.getElementById(`${p}-arp`)?.addEventListener('click', () => {
    arpvoice.set({ enabled: !arpvoice.enabled });
    rerender();
  });
  document.getElementById(`${p}-arp-pattern`)?.addEventListener('change', e =>
    arpvoice.set({ pattern: e.target.value }));
  document.getElementById(`${p}-arp-oct`)?.addEventListener('change', e =>
    arpvoice.set({ octaves: Number(e.target.value) }));
  document.getElementById(`${p}-arp-sync`)?.addEventListener('change', e => {
    arpvoice.set({ sync: Number(e.target.value) });
    rerender();
  });
  document.getElementById(`${p}-arp-rate`)?.addEventListener('input', e =>
    engine.set('arp_rate', +e.target.value));
  document.getElementById(`${p}-arp-gate`)?.addEventListener('input', e =>
    engine.set('arp_gate', +e.target.value));
}

// Per-frame readout. Rate is a patchbay output, so it can be moving without
// anyone touching the slider — the number has to come from the parameter
// every frame, not from the last thing the thumb did. `poolSize` comes from
// the calling panel: which chord the pattern walks is the one question only
// the play mode can answer.
export function updateArpRow(p, poolSize) {
  const arpRead = document.getElementById(`${p}-arp-read`);
  if (!arpRead) return;
  const a = arpvoice.state();
  const synced = a.sync > 0 && metronome.on;
  const rate = synced ? (metronome.config().bpm / 60) * a.sync : engine.PARAMS.arp_rate.val;
  const gate = engine.PARAMS.arp_gate.val;
  const step = arpvoice.sounding();
  const where = poolSize ? ` · ${step >= 0 ? step + 1 : '–'}/${poolSize}` : '';
  // Percent while the note lives inside its step; multiples once it rings
  // past it, because "gate 250%" reads as an error and "×2.5" as a length.
  const gateTxt = gate <= 1 ? `${Math.round(gate * 100)}%` : `×${gate.toFixed(1)}`;
  const sync = synced ? ` · ♩ ${SYNC_LABEL(a.sync)}` : '';
  const txt = `${rate.toFixed(1)}/s · ≈${Math.round(rate * 30)} BPM · gate ${gateTxt}${sync}${where}`;
  if (arpRead.textContent !== txt) arpRead.textContent = txt;
  // A slider left behind by a cable driving the same parameter is worse than
  // no slider: it says the rate is one thing while you hear another.
  const rs = document.getElementById(`${p}-arp-rate`);
  if (rs && document.activeElement !== rs && +rs.value !== engine.PARAMS.arp_rate.val) rs.value = engine.PARAMS.arp_rate.val;
  const gs = document.getElementById(`${p}-arp-gate`);
  if (gs && document.activeElement !== gs && +gs.value !== gate) gs.value = gate;
}
