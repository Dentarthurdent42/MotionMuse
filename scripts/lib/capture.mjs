// The one capture recipe for the README hero shot, shared by
// `npm run screenshot` (scripts/screenshot.mjs) and the staleness sync
// (scripts/screenshot-sync.mjs) — so the picture and the check that guards it
// can never drift apart.
//
// The capture is deliberately of the real just-loaded app: camera off (there
// is no webcam in CI, and a fake device renders a spinning test pattern that
// would misrepresent the product), audio started and muted, which is the
// genuine first-run state.

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '../..');
export const SHOT = join(ROOT, 'docs/screenshot.png');
export const VIEWPORT = { width: 1440, height: 780 };
export const SCALE = 2;                    // legible on a HiDPI display without upscaling

const CHROME = process.env.CHROME
  ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' };

function serve() {
  const server = createServer((req, res) => {
    const p = join(ROOT, req.url.split('?')[0]);
    let body;
    try { body = readFileSync(p); }
    catch { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

// Everything in the shot is laid out deterministically except the oscilloscope,
// which draws whatever the engine's analyser holds at the instant of capture —
// so two runs of an unchanged UI differ only inside this box. Reported in
// device pixels so a comparison can mask it out; measured from the live element
// rather than hard-coded, so moving the panel does not silently unmask it.
async function liveBox(page) {
  const r = await page.evaluate(() => {
    const c = document.getElementById('viz-canvas');
    if (!c) return null;
    const { x, y, width, height } = c.getBoundingClientRect();
    return { x, y, width, height };
  });
  if (!r) return [0, 0, 0, 0];
  const pad = 6;                           // the trace's 4px glow stroke bleeds past the canvas edge
  return [
    Math.max(0, Math.floor((r.x - pad) * SCALE)),
    Math.max(0, Math.floor((r.y - pad) * SCALE)),
    Math.ceil((r.width  + pad * 2) * SCALE),
    Math.ceil((r.height + pad * 2) * SCALE),
  ];
}

/**
 * Render the app and screenshot it.
 *
 * @param {{compareTo?: Buffer}} opts  When `compareTo` is a PNG buffer, the
 *        fresh capture is diffed against it in the same browser, ignoring the
 *        oscilloscope box.
 * @returns {{png: Buffer, live: number[], diff?: {changed: number, total: number, sizeChanged: boolean}}}
 */
export async function capture({ compareTo } = {}) {
  const { server, port } = await serve();
  const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  try {
    const page = await b.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
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

    // Let the fonts land, the audio panel render and the canvas lay out.
    await page.waitForSelector('#ws .ng-wire', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1200);

    // The tour auto-offers on a first visit; it is not part of the product shot.
    await page.evaluate(() => document.querySelector('.tour-card')?.remove());
    await page.evaluate(() => document.querySelector('.tour-ring')?.remove());

    const live = await liveBox(page);
    const png  = await page.screenshot();
    const diff = compareTo ? await compare(b, compareTo, png, live) : undefined;
    return { png, live, diff };
  } finally {
    await b.close();
    server.close();
  }
}

// Decoding PNGs is the browser's job — doing it here keeps the repo at zero
// runtime dependencies. A blank page, not the app one, so the app's animation
// loops are not competing for the main thread during the pixel walk.
async function compare(browser, aPng, bPng, mask) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([a, c, m]) => {
      const load = src => new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
      });
      const [A, B] = await Promise.all([load(a), load(c)]);
      if (A.width !== B.width || A.height !== B.height)
        return { changed: 1, total: 1, sizeChanged: true };
      const px = im => {
        const cv = document.createElement('canvas');
        cv.width = im.width; cv.height = im.height;
        const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
        return g.getImageData(0, 0, cv.width, cv.height).data;
      };
      const P = px(A), Q = px(B);
      const [mx, my, mw, mh] = m;
      let changed = 0;
      for (let i = 0; i < P.length; i += 4) {
        const p = i >> 2, x = p % A.width, y = (p / A.width) | 0;
        if (x >= mx && x < mx + mw && y >= my && y < my + mh) continue;
        // 8 levels of slack absorbs subpixel-AA jitter without hiding a real
        // colour change — the dimmest UI strokes here differ by far more.
        if (Math.abs(P[i] - Q[i]) > 8 || Math.abs(P[i + 1] - Q[i + 1]) > 8 || Math.abs(P[i + 2] - Q[i + 2]) > 8)
          changed++;
      }
      return { changed, total: (P.length / 4) - mw * mh, sizeChanged: false };
    }, ['data:image/png;base64,' + aPng.toString('base64'),
        'data:image/png;base64,' + bPng.toString('base64'), mask]);
  } finally {
    await page.close();
  }
}
