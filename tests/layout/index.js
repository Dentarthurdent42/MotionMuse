// Header layout guard.
//
// The header has now broken three separate times in the same way: it holds a
// variable number of rows (the FACE/GAZE line appears with the camera) and
// every breakpoint has its own opinion about its height. The failures were all
// invisible to the existing tests because they only show up in one state —
// camera ON — at one width, and nothing measured that combination:
//
//   1. `flex-wrap: wrap` + the mobile `flex-direction: column` made wrapping
//      create a new *column*, putting FACE/GAZE off the right edge.
//   2. `#app { grid-template-rows: 52px 1fr }` at >=1200px pinned the header
//      to one row's height, so the FACE/GAZE row overflowed and painted over
//      the panel beneath it.
//
// So: measure real rectangles, at every breakpoint, in both camera states. The
// camera state is driven by `body.cam-on`, which is exactly what cv.js toggles
// — so this needs no webcam and stays deterministic.
//
// Run:  npm run test:layout   (needs a Chromium; no network, no API keys)

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
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

// Widths chosen to land on both sides of every breakpoint in main.css
// (the mobile block, and the >=1200px desktop-sizing block).
const WIDTHS = [320, 375, 390, 430, 768, 1024, 1199, 1200, 1440, 1920];

const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const results = [];

for (const width of WIDTHS) {
  const page = await b.newPage({ viewport: { width, height: 860 } });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);

  const measure = () => page.evaluate(() => {
    const header = document.getElementById('header');
    const hb = header.getBoundingClientRect();
    const main = document.getElementById('main').getBoundingClientRect();
    const vis = el => el && el.getClientRects().length > 0;
    const btns = [...document.querySelectorAll('#header button')].filter(vis);
    const rect = id => {
      const el = document.getElementById(id);
      return vis(el) ? el.getBoundingClientRect().toJSON() : null;
    };
    return {
      header: hb.toJSON(),
      mainTop: main.top,
      // Does any header control extend past the header's own box, or past the
      // viewport? Either means it is drawing somewhere it does not belong.
      escapees: btns
        .map(el => ({ id: el.id, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.bottom > hb.bottom + 0.5 || r.top < hb.top - 0.5
                        || r.left < -0.5 || r.right > innerWidth + 0.5)
        .map(({ id, r }) => `${id}@${Math.round(r.left)},${Math.round(r.top)}`),
      face: rect('face-btn'),
      gaze: rect('gaze-btn'),
      cv: rect('cv-btn'),
      audio: rect('audio-btn'),
      hOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      panels: Object.fromEntries(['sig', 'cam', 'map', 'aud'].map(k => {
        const el = document.querySelector(`.panel-${k}`);
        return [k, el ? el.getBoundingClientRect().toJSON() : null];
      })),
      video: (() => {
        const el = document.getElementById('video-wrap');
        const r = el?.getBoundingClientRect();
        return r ? { w: r.width, h: r.height } : null;
      })(),
    };
  });

  // Sections are wrapped at runtime (src/ui/sections.js), and panels that rebuild
// their innerHTML have to get their wrappers back. A section that loses them
// loses its scroller and its grip while still looking roughly right, so it is
// checked rather than eyeballed.
const sections = await page.evaluate(() => {
  const all = [...document.querySelectorAll('.sec')];
  return {
    total: all.length,
    ids: all.map(e => e.dataset.secId),
    missingBody: all.filter(e => !e.querySelector(':scope > .sec-body')).map(e => e.dataset.secId),
    missingGrip: all.filter(e => !e.querySelector(':scope > .sec-grip')).map(e => e.dataset.secId),
    unnamed: all.filter(e => !e.dataset.secId).length,
    // A section given a height must actually scroll, or the height just clips.
    pinnedNotScrolling: all
      .filter(e => {
        const b = e.querySelector(':scope > .sec-body.sec-scroll');
        return b && getComputedStyle(b).overflowY !== 'auto';
      }).map(e => e.dataset.secId),
  };
});

// Portrait pins the camera to the top of the scroll, for everyone — not just
// dev mode. It is easy to break from a distance: an ancestor gaining
// `overflow: hidden` turns it into a scroll container and `position: sticky`
// then silently does nothing, which is exactly how this failed the first time.
// So it is measured by actually scrolling, not by reading the property.
const camSticky = await page.evaluate(async () => {
  const cam = document.querySelector('.panel-cam');
  const pos = getComputedStyle(cam).position;
  const before = cam.getBoundingClientRect().top;
  window.scrollTo(0, 700);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const scrolled = Math.round(window.scrollY);
  const after = cam.getBoundingClientRect().top;
  window.scrollTo(0, 0);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { pos, before: Math.round(before), after: Math.round(after), scrolled,
           dev: document.body.classList.contains('dev') };
});

const off = await measure();
  // `cam-on` is what cv.js sets when the camera starts; driving it directly
  // exercises the same CSS without needing a webcam.
  await page.evaluate(() => document.body.classList.add('cam-on'));
  await page.waitForTimeout(120);
  const on = await measure();

  results.push({ width, off, on, sections, camSticky });
  await page.close();
}

await b.close(); server.close();

let fail = 0;
const check = (ok, label, detail = '') => {
  if (!ok) fail++;
  console.log(`  [${ok ? ' PASS ' : ' FAIL '}]  ${label}${detail !== '' ? '  — ' + detail : ''}`);
};

console.log('\nHeader layout — every breakpoint, camera off and on\n');

for (const { width, off, on, sections, camSticky } of results) {
  const w = `${width}px`;

  check(sections.total >= 12, `${w}: sections are wrapped`, `${sections.total} found`);
  check(sections.missingBody.length === 0, `${w}: every section has a scrollable body`, sections.missingBody.join(' '));
  check(sections.missingGrip.length === 0, `${w}: every section has a resize grip`, sections.missingGrip.join(' '));
  check(sections.unnamed === 0, `${w}: every section has an id (so its height can persist)`, String(sections.unnamed));
  check(sections.pinnedNotScrolling.length === 0,
    `${w}: a section given a height scrolls rather than clipping`, sections.pinnedNotScrolling.join(' '));

  check(off.escapees.length === 0, `${w} camera off: every control inside the header`, off.escapees.join(' '));
  check(on.escapees.length === 0,  `${w} camera on:  every control inside the header`, on.escapees.join(' '));

  check(!off.hOverflow && !on.hOverflow, `${w}: no horizontal overflow`);

  // FACE/GAZE are camera-only, and must be real controls when they appear.
  check(off.face === null && off.gaze === null, `${w}: FACE/GAZE hidden with the camera off`);
  check(on.face !== null && on.gaze !== null,   `${w}: FACE/GAZE present with the camera on`);

  if (on.face && on.cv) {
    // The request they came from: below the main buttons, not beside them.
    check(on.face.top >= on.cv.bottom - 0.5,
      `${w}: FACE sits below the main buttons`,
      `face.top ${Math.round(on.face.top)} vs cv.bottom ${Math.round(on.cv.bottom)}`);
    check(on.face.right <= width + 0.5 && on.face.left >= -0.5,
      `${w}: FACE is on-screen horizontally`,
      `${Math.round(on.face.left)}..${Math.round(on.face.right)}`);
  }

  // The header must actually grow to hold the extra row rather than letting it
  // spill: the panel below has to start at the header's new bottom edge.
  check(Math.abs(on.mainTop - on.header.bottom) < 1.5,
    `${w}: the panel starts where the header ends`,
    `header.bottom ${Math.round(on.header.bottom)} vs main.top ${Math.round(on.mainTop)}`);
  check(on.header.height >= off.header.height,
    `${w}: the header grows (or holds) when the camera row appears`,
    `${Math.round(off.header.height)} → ${Math.round(on.header.height)}`);

  // ── Panel arrangement ──
  // Landscape is SIGNALS | CAMERA over PATCHBAY | AUDIO; portrait keeps source
  // order. Both are asserted, because the whole point of placing the landscape
  // panels explicitly is that rearranging one must not disturb the other.
  const { sig, cam, map, aud } = off.panels;
  const present = sig && cam && map && aud;
  check(present, `${w}: all four panels present`);
  if (!present) continue;

  const mid = r => r.left + r.width / 2;
  if (width >= 769) {
    check(mid(sig) < mid(cam), `${w} landscape: SIGNALS is left of the camera column`);
    check(mid(aud) > mid(cam), `${w} landscape: AUDIO is right of the camera column`);
    check(Math.abs(mid(cam) - mid(map)) < 1.5,
      `${w} landscape: PATCHBAY shares the camera's column`);
    check(map.top >= cam.bottom - 1.5,
      `${w} landscape: PATCHBAY sits below the camera`,
      `map.top ${Math.round(map.top)} vs cam.bottom ${Math.round(cam.bottom)}`);
    // The camera moved into the wide column; if the 4:3 cap ever comes off it
    // eats the patchbay it now sits above.
    check(map.height > 200, `${w} landscape: the patchbay keeps usable height`,
      `${Math.round(map.height)}px`);
    if (off.video) {
      const ratio = off.video.w / off.video.h;
      check(Math.abs(ratio - 4 / 3) < 0.02,
        `${w} landscape: the camera box holds 4:3 (overlay alignment)`, ratio.toFixed(3));
    }
  } else {
    // Sticky camera, and specifically NOT gated on dev mode.
    check(camSticky.dev === false, `${w} portrait: measured outside dev mode`);
    check(camSticky.pos === 'sticky', `${w} portrait: the camera is sticky`, camSticky.pos);
    if (camSticky.scrolled > 0)
      check(camSticky.after <= camSticky.before + 0.5 && camSticky.after <= 1,
        `${w} portrait: the camera stays pinned while the page scrolls`,
        `top ${camSticky.before} → ${camSticky.after} after ${camSticky.scrolled}px`);

    const stacked = [['cam', cam], ['sig', sig], ['map', map], ['aud', aud]];
    const order = [...stacked].sort((a, b) => a[1].top - b[1].top).map(([k]) => k).join('→');
    check(order === 'cam→sig→map→aud',
      `${w} portrait: panels stack camera→signals→patchbay→audio`, order);
  }
}

console.log(`\n${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
