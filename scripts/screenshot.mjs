// Regenerate the README hero screenshot: docs/screenshot.png
//
//   npm run screenshot          force a fresh capture
//   npm run screenshot:check    fail if the committed shot is out of date
//
// A screenshot of an actively developed UI goes stale the same way a tutorial
// step does, so this is a script rather than a file someone once dragged in.
// The README's image was dead for the repo's entire history because it was a
// link to a file that no one ever generated; a committed generator is what
// stops that recurring — and scripts/screenshot-sync.mjs is what stops anyone
// having to remember to run it.

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { capture, ROOT, SHOT, VIEWPORT, SCALE } from './lib/capture.mjs';

const { png } = await capture();
mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(SHOT, png);

console.log(`docs/screenshot.png written — ${VIEWPORT.width}x${VIEWPORT.height} @${SCALE}x, ${Math.round(png.length / 1024)} KB`);
