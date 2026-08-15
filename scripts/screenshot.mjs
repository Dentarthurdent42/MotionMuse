// Regenerate the README hero screenshot: docs/screenshot.png
//
//   npm run screenshot
//
// A screenshot of an actively developed UI goes stale the same way a tutorial
// step does, so this is a script rather than a file someone once dragged in —
// re-run it after a visible change and commit the result. The README's image
// was dead for the repo's entire history because it was a link to a file that
// no one ever generated; a committed generator is what stops that recurring.
//
// The capture is deliberately of the real just-loaded app: camera off (there
// is no webcam in CI, and a fake device renders a spinning test pattern that
// would misrepresent the product), audio started and muted, which is the
// genuine first-run state.

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT  = join(ROOT, 'docs/screenshot.png');
const CHROME = process.env.CHROME
  ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = join(ROOT, req.url.split('?')[0]);
  let body;
  try { body = readFileSync(p); }
  catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await b.newPage({
  viewport: { width: 1440, height: 780 },
  deviceScaleFactor: 2,          // legible on a HiDPI display without upscaling
});
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });

// A first visit has no saved session, so the patchbay is genuinely empty —
// truthful, but it shows none of the wiring the app is for. Load the default
// Hands patch, which is exactly what the PRESET button puts there in one
// click, so the shot is representative without being staged.
await page.evaluate(async () => {
  const { mapper } = await import('/src/mapper.js');
  mapper.applyPreset();
});
await page.evaluate(async () => {
  const { renderMapper } = await import('/src/ui/mapper-ui.js');
  renderMapper();
});

// Let the fonts land, the audio panel render and the node graph lay out.
await page.waitForSelector('#mapper-rows .ng-node', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1200);

// The tour auto-offers on a first visit; it is not part of the product shot.
await page.evaluate(() => document.querySelector('.tour-card')?.remove());
await page.evaluate(() => document.querySelector('.tour-ring')?.remove());

mkdirSync(join(ROOT, 'docs'), { recursive: true });
await page.screenshot({ path: OUT });
await b.close(); server.close();

const kb = Math.round(readFileSync(OUT).length / 1024);
console.log(`docs/screenshot.png written — 1440x780 @2x, ${kb} KB`);
