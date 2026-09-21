// The markup of an INPUT socket, for the panels' own templates: put it beside
// the control it feeds, and the cable machinery (src/ui/mapper-ui.js) finds
// it by its key. Its node is the parameter's owner (src/params.js).
//
// A module of its own, with no DOM of its own, so a panel can be rendered as
// a string anywhere — including under node, where the unit tests run.

import { engine } from '../engine.js';

const humanize = k => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
export const paramLabel = k => engine.PARAMS[k]?.label ?? humanize(k);

export const inPort = (key, label = paramLabel(key)) => `
  <button type="button" class="port port-in" data-side="in" data-key="${key}"
          aria-label="Input ${label} — connect a signal here"
          title="Input: ${key} — drag a signal's ● here, or drag from here to one"></button>`;
