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

// DEV moved into the settings popover, so reaching it is two clicks: open ⚙,
// hit the toggle, and close the menu again so it does not sit over the layout
// being measured.
const toggleDev = async page => {
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await page.waitForTimeout(120);
  await page.evaluate(() => document.getElementById('dev-btn').click());
  await page.waitForTimeout(120);
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await page.waitForTimeout(120);
};

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
    // Nothing may pan SIDEWAYS. These panels scroll vertically, and CSS
    // computes a `visible` axis to `auto` when the other one scrolls — so an
    // element poking a few pixels past the edge silently turns its whole
    // column into a horizontal scroller, and every section in it slides off
    // its own left edge. It cost exactly 8px of one header's ? button once.
    // A container that genuinely scrolls across (the tone-picker keyboard)
    // opts in by carrying its own scroller.
    pans: [...document.querySelectorAll('*')]
      .filter(e => {
        if (!e.clientWidth || e.scrollWidth <= e.clientWidth + 1) return false;
        if (e.closest('.ng-freq-kbd-wrap')) return false;      // opted in
        const ox = getComputedStyle(e).overflowX;
        return ox === 'auto' || ox === 'scroll';
      })
      .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}`
              + `${e.dataset.secId ? '[' + e.dataset.secId + ']' : ''}`
              + ` +${e.scrollWidth - e.clientWidth}px`),
    // A section may not be taller than its own content: a height past that is a
    // box of empty space with a scrollbar attached, which is what applyHeight's
    // ceiling exists to prevent.
    tallerThanContent: all
      .filter(e => {
        const b = e.querySelector(':scope > .sec-body.sec-scroll');
        return b && b.scrollHeight <= b.clientHeight + 1;
      }).map(e => e.dataset.secId),
    // Cross-column moves: every column contributes exactly one drop host, and
    // every section sitting in one is draggable and knows where it was born.
    hosts: [...document.querySelectorAll('[data-sec-host]')].map(e => e.dataset.secHost).sort(),
    inHost: all.filter(e => e.parentElement?.dataset.secHost).map(e => e.dataset.secId),
    noBirth: all.filter(e => e.parentElement?.dataset.secHost && !e.dataset.secBirth)
                .map(e => e.dataset.secId),
    notDraggable: all.filter(e => e.parentElement?.dataset.secHost && !e.dataset.reorder)
                     .map(e => e.dataset.secId),
    // A host with nothing in it still has to be aimable during a drag, or the
    // column it belongs to cannot receive anything. `body.reordering` is
    // exactly the state the drag puts the page in.
    unaimableHosts: (() => {
      document.body.classList.add('reordering');
      const bad = [...document.querySelectorAll('[data-sec-host]')]
        .filter(e => e.getBoundingClientRect().height < 12)
        .map(e => e.dataset.secHost);
      document.body.classList.remove('reordering');
      return bad;
    })(),
    // Section headers must render identically to each other. They did not: four
    // of them carried an inline `display:flex` (they hold an ON/OFF pill), and
    // WebKit's text auto-inflation boosts block containers while skipping flex
    // ones — so on a zoomed-out phone those four stayed small and the rest grew.
    // Measuring the computed values catches both halves: a stray inline display
    // and a stray font-size.
    headerStyles: (() => {
      const seen = {};
      for (const el of document.querySelectorAll('.sec > .audio-section-label')) {
        const cs = getComputedStyle(el);
        const k = `${cs.fontSize}|${cs.display}|${cs.letterSpacing}`;
        (seen[k] ??= []).push(el.textContent.trim().split('\n')[0].slice(0, 18));
      }
      return seen;
    })(),
    // A fold button has to say which state it is in. The attribute was set once
    // at creation and then updated through a selector that matched nothing, so
    // it read "expanded" in both states — the caret was the only signal, and a
    // caret is not one a screen reader can see.
    folds: (() => {
      const bad = [];
      for (const sec of document.querySelectorAll('.sec[data-sec-id]')) {
        const btn = sec.querySelector(':scope > * > .sec-fold');
        if (!btn) continue;
        const want = String(!sec.classList.contains('folded'));
        if (btn.getAttribute('aria-expanded') !== want) bad.push(sec.dataset.secId);
      }
      return bad;
    })(),
    // …after actually collapsing one, since every section starts expanded and
    // a stuck "true" is indistinguishable from a correct one until then.
    foldsAfterToggle: (() => {
      const sec = document.querySelector('.panel-aud[data-sec-id], [data-sec-id="audio-engine"]');
      const btn = sec?.querySelector(':scope > * > .sec-fold');
      if (!btn) return 'no fold button on the audio engine';
      btn.click();
      const collapsed = sec.classList.contains('folded')
                     && btn.getAttribute('aria-expanded') === 'false';
      btn.click();
      const reopened = !sec.classList.contains('folded')
                    && btn.getAttribute('aria-expanded') === 'true';
      return collapsed && reopened ? '' : `collapsed=${collapsed} reopened=${reopened}`;
    })(),
    // The camera panel is sticky in portrait, and everything inside it rides
    // along. The dev-only sections must therefore live OUTSIDE it there, or
    // they sit pinned under the video occupying a screen you cannot scroll
    // past — and back inside in landscape, where #main's grid would otherwise
    // auto-place a stray child into whatever cell was free.
    camExtras: (() => {
      const ex = document.getElementById('cam-extras');
      if (!ex) return null;
      // Out of the sticky panel is the whole invariant; which box it lands in
      // beside it is not, and naming the acceptable ones has now been wrong
      // twice (it was #main, then the column, and is now the Inputs list).
      return ex.parentElement.classList.contains('panel-cam') ? 'panel-cam' : 'outside';
    })(),
    // …and the inflation heuristic itself is off, so the authored size is what
    // ships at every zoom level rather than a per-container guess.
    textSizeAdjust: getComputedStyle(document.documentElement).webkitTextSizeAdjust
                 ?? getComputedStyle(document.documentElement).textSizeAdjust,
    // Gestures and chord mode are visible without DEV. They were behind it,
    // which meant the one way of playing that needs no wiring was the one
    // nobody could find. What IS still dev-only is checked elsewhere in this
    // suite (the inference HUD) — so this is not "nothing is gated any more".
    playable: (() => {
      const vis = id => {
        const e = document.querySelector(`.sec[data-sec-id="${id}"]`);
        return !!e && e.getClientRects().length > 0;
      };
      return { dev: document.body.classList.contains('dev'),
               gestures: vis('gestures'), chords: vis('chord-mode'),
               models: vis('models'),
               badges: document.querySelectorAll(
                 '.sec[data-sec-id="gestures"] .uc-badge, .sec[data-sec-id="chord-mode"] .uc-badge').length };
    })(),
    // The oscilloscope is a section like any other: it folds, and it can be
    // dragged to another column. It has to live OUTSIDE #audio-panel to do so —
    // that panel rebuilds its innerHTML, which would recreate the canvas and
    // drop the click-to-mute handler.
    viz: (() => {
      const v = document.querySelector('.sec[data-sec-id="visualizer"]');
      return {
        exists: !!v,
        inRebuiltPanel: !!v?.closest('#audio-panel'),
        foldable: !!v?.querySelector('.sec-fold'),
        movable: v?.dataset.reorder === '1',
        hasCanvas: !!v?.querySelector('#viz-canvas'),
      };
    })(),
    // The collapse caret is drawn from borders rather than typed as a glyph, so
    // it looks the same on every platform. Empty content + a real border is the
    // signature of that; a character caret would show up as content text.
    caret: (() => {
      const btn = [...document.querySelectorAll('.sec-fold')].find(b => b.getClientRects().length);
      if (!btn) return null;
      const cs = getComputedStyle(btn, '::before');
      return { content: cs.content, border: parseFloat(cs.borderBottomWidth),
               w: parseFloat(cs.width), target: Math.round(btn.getBoundingClientRect().width) };
    })(),
  };
});

// Portrait pins the camera to the top of the scroll, for everyone — not just
// dev mode. It is easy to break from a distance: an ancestor gaining
// `overflow: hidden` turns it into a scroll container and `position: sticky`
// then silently does nothing, which is exactly how this failed the first time.
// So it is measured by actually scrolling, not by reading the property.
const camSticky = await page.evaluate(async () => {
  const cam = document.querySelector('.panel-cam');
  const vid = document.getElementById('video-wrap');
  const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const pos = getComputedStyle(cam).position;
  const before = cam.getBoundingClientRect().top;
  window.scrollTo(0, 700);
  await settle();
  const scrolled = Math.round(window.scrollY);
  const after = cam.getBoundingClientRect().top;
  // …and all the way down. Scrolling 700px only proves the pin survives its
  // own column: position:sticky pins within the PARENT's box, and while the
  // columns were blocks that box ended where the camera column did, so the
  // picture came unstuck the moment SIGNALS began — still most of the page
  // from the bottom, and exactly where you want to see your hands. Nothing
  // caught it, because 700px is still inside the camera column.
  window.scrollTo(0, document.documentElement.scrollHeight);
  await settle();
  const deep = Math.round(window.scrollY);
  const atEnd = vid.getBoundingClientRect().top;
  // Sticky nesting: walking down the page, the sections you are inside should
  // pin at the top and stack, the way an IDE keeps the enclosing scopes on
  // screen. Sampled across the scroll rather than at one position, because
  // which section is pinned depends on where you stop.
  const headOf = s => s.querySelector(':scope > .audio-section-label, :scope > .ph');
  const camBottom = (() => {
    if (getComputedStyle(cam).position !== 'sticky') return 0;
    const label = cam.querySelector(':scope > .cam-label');
    return cam.getBoundingClientRect().height - (label?.getBoundingClientRect().height ?? 0);
  })();
  let maxStack = 0, behindCamera = [], depths = [];
  const span = document.documentElement.scrollHeight - window.innerHeight;
  for (let i = 1; i <= 8; i++) {
    window.scrollTo(0, Math.round(span * i / 9));
    await settle();
    const now = [];
    for (const sec of document.querySelectorAll('.sec.stick')) {
      const h = headOf(sec);
      if (!h) continue;
      const want = parseFloat(sec.style.getPropertyValue('--stick')) || 0;
      const top = h.getBoundingClientRect().top;
      if (Math.abs(top - want) > 1.5) continue;         // in flow, not pinned
      now.push({ id: sec.dataset.secId, d: +(sec.style.getPropertyValue('--stick-d') || 0) });
      // A header pinned above the camera's bottom edge is a header nobody can
      // see: the picture is painted over it.
      if (top < camBottom - 1.5 && !behindCamera.includes(sec.dataset.secId))
        behindCamera.push(sec.dataset.secId);
    }
    if (now.length > maxStack) { maxStack = now.length; depths = now.map(n => n.d); }
  }
  window.scrollTo(0, 0);
  await settle();
  return { pos, before: Math.round(before), after: Math.round(after), scrolled,
           deep, atEnd: Math.round(atEnd),
           maxStack, depths, behindCamera, camBottom: Math.round(camBottom),
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

// A relocated section has to STAY relocated through the two things that
// destroy it: the audio panel rebuilding its innerHTML, and a reload. Both are
// exercised here rather than trusted, because the failure mode is silent — the
// section simply reappears in its birth column, and a user reads that as the
// drag not having worked.
const relocation = await (async () => {
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  // Seeded rather than dragged: the drag itself is a pointer-sequence concern,
  // while what must not regress is that the stored map is honoured.
  await page.addInitScript(() =>
    localStorage.setItem('motionmuse-sec-home', JSON.stringify({ gestures: 'map', 'sound-kit': 'cam' })));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const where = () => page.evaluate(() => {
    const at = id => document.querySelector(`.sec[data-sec-id="${id}"]`)?.parentElement?.dataset.secHost ?? null;
    const counts = {};
    for (const e of document.querySelectorAll('.sec[data-sec-id]'))
      counts[e.dataset.secId] = (counts[e.dataset.secId] || 0) + 1;
    return {
      gestures: at('gestures'), kit: at('sound-kit'),
      dupes: Object.entries(counts).filter(([, n]) => n > 1).map(([k]) => k),
      // Sliders are wired by renderAudioPanel; if it scopes its queries to the
      // panel, a section that has moved out of it loses every handler.
      apr: document.querySelectorAll('.apr').length,
    };
  });

  const fresh = await where();
  await page.evaluate(async () => (await import('/src/ui/audio-ui.js')).renderAudioPanel());
  await page.waitForTimeout(300);
  const rerendered = await where();
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const reloaded = await where();

  // The moved section's controls must still drive the engine.
  const wired = await page.evaluate(async () => {
    const { engine } = await import('/src/engine.js');
    const el = document.querySelector('.apr');
    if (!el) return false;
    const p = engine.PARAMS[el.dataset.key];
    const before = p.val;
    el.value = String(p.min + (p.max - p.min) * 0.42);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return p.val !== before;
  });

  await page.close();
  return { fresh, rerendered, reloaded, wired, errs };
})();

// Resetting the layout has to actually undo a stored arrangement, because a
// stored arrangement outlives the build it was made against. A patchbay someone
// dragged into the camera column kept that home across the release that
// regrouped the inputs, and landed between Camera Input and the microphone —
// splitting the group it was dropped into. The layout looked broken; the
// stored layout was just old, and there was no way to clear it short of
// wiping site data, which takes gestures, patches and presets with it.
// A NARROW COLUMN is where sideways play actually appeared: the columns are
// user-resizable and the width persists, so a column well below the default
// is an ordinary state to be in — and it was the state where one header's ?
// button was pushed 8px past the edge, setting the whole audio column
// panning. The per-width loop above runs at default column widths and would
// never have caught it.
const narrow = await (async () => {
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('motionmuse-panel-widths', JSON.stringify({ l: 320, r: 240 }));
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('#start-pop button')?.click());
  await page.waitForTimeout(200);
  // Chord mode on: its expression rows are the densest thing in that column.
  await page.evaluate(() => {
    const t = document.querySelector('[data-sec="chord-mode"] .wave-btn');
    if (t && !t.classList.contains('on')) t.click();
  });
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => ({
    pans: [...document.querySelectorAll('*')]
      .filter(e => {
        if (!e.clientWidth || e.scrollWidth <= e.clientWidth + 1) return false;
        if (e.closest('.ng-freq-kbd-wrap')) return false;
        const ox = getComputedStyle(e).overflowX;
        return ox === 'auto' || ox === 'scroll';
      })
      .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} +${e.scrollWidth - e.clientWidth}px`),
    // The trailing ? must still be INSIDE the panel it belongs to, not merely
    // un-scrollable-to: clipping it would trade a layout bug for a dead control.
    helpOutside: [...document.querySelectorAll('#audio-panel .sec-help')]
      .filter(h => {
        const p = document.getElementById('audio-panel');
        return h.getBoundingClientRect().right
             > p.getBoundingClientRect().left + p.clientWidth + 0.5;
      }).length,
  }));
  await page.close();
  return { ...out, errs };
})();

const reset = await (async () => {
  const page = await b.newPage({ viewport: { width: 430, height: 932 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.evaluate(() => {
    localStorage.setItem('motionmuse-sec-home', JSON.stringify({ patchbay: 'cam' }));
    localStorage.setItem('motionmuse-sec-folded', JSON.stringify(['signals']));
    localStorage.setItem('motionmuse-sections', JSON.stringify({ gestures: 120 }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);

  const state = () => page.evaluate(() => ({
    order: [...document.querySelectorAll('[data-sec-id]')]
      .filter(e => e.getClientRects().length)
      .map(e => ({ id: e.dataset.secId, y: e.getBoundingClientRect().top }))
      .sort((a, b) => a.y - b.y).map(o => o.id).slice(0, 3).join(' '),
    folded: !!document.querySelector('[data-sec-id="signals"]')?.classList.contains('folded'),
    keys: ['motionmuse-sec-home', 'motionmuse-sec-order', 'motionmuse-sections']
      .filter(k => localStorage.getItem(k) !== null).length,
  }));

  const stale = await state();
  // Two taps: the second is the confirmation.
  await page.click('#settings-btn, #set-btn, [title*="ettings" i]').catch(() => {});
  await page.waitForTimeout(250);
  await page.click('#layout-reset-btn');
  await page.waitForTimeout(120);
  await page.click('#layout-reset-btn');
  await page.waitForTimeout(600);
  const after = await state();
  // …and it has to survive the reload, or it only looked reset.
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  const reloaded = await state();
  await page.close();
  return { stale, after, reloaded, errs };
})();

// The inference HUD is dev-only, and each of its rows belongs to a model that
// is actually running. Both halves have failed before in the same way: a number
// on screen that looks live and is not. The camera itself can't run here (no
// device, and the model CDN is out of reach), so the tracker flags are set
// directly — which is exactly what the toggles do — and the display logic is
// what gets measured.
const hud = await (async () => {
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`http://${'127.0.0.1'}:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  const set = (o) => page.evaluate(async (o) => {
    const { cvSource }   = await import('/src/cv.js');
    const { faceSource } = await import('/src/face.js');
    // What startCamera() does to the bar, minus the camera.
    document.getElementById('latency-bar').style.display = 'flex';
    cvSource.handsL = o.handsL; cvSource.handsR = o.handsR; cvSource.poseOn = o.pose;
    cvSource._syncLatRows();
    faceSource._running = o.face;
    faceSource._syncLatRow();
  }, o);

  const read = () => page.evaluate(() => {
    const vis = id => {
      const e = document.getElementById(id);
      return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
    };
    return {
      bar: getComputedStyle(document.getElementById('latency-bar')).display,
      hand: vis('lat-hand-wrap'), pose: vis('lat-pose-wrap'), face: vis('lat-face-wrap'),
      total: vis('lat-total-wrap'), model: vis('lat-model-wrap'),
    };
  });

  const params = await page.evaluate(async () => {
    const { renderMapper } = await import('/src/ui/mapper-ui.js');
    const { engine } = await import('/src/engine.js');
    const grab = () => {
      const sec = document.querySelector('.sec[data-sec-id="sliders"]');
      return [...sec.querySelectorAll('.param-group')].map(g => [
        g.querySelector('.param-group-name').textContent,
        [...g.querySelectorAll('.apr')].map(e => e.dataset.key)]);
    };
    // Read the picker's REAL rendered optgroups rather than re-deriving them
    // from the shared table: re-deriving would mean the test agreeing with
    // itself, and it did — an empty category (no oscillators) is dropped when
    // the <select> is built, which a naive re-derivation kept.
    const cats = () => [...document.querySelectorAll('#ng-add-output optgroup')]
      .map(g => [g.label, [...g.querySelectorAll('option')].map(o => o.value)]);
    const one = { groups: grab(), picker: cats() };
    // The bank is resizable, so the grouping has to follow it — a table read
    // once at first render would go stale the moment an oscillator was added.
    engine.setOscCount(3);
    (await import('/src/ui/audio-ui.js')).renderAudioPanel();
    renderMapper();
    const three = { groups: grab(), picker: cats() };
    const shown = three.groups.flatMap(([, ks]) => ks);
    // Zero is a legal bank size — chord mode is a complete instrument on its
    // own — so the panel has to survive having no oscillator params at all.
    engine.setOscCount(0);
    (await import('/src/ui/audio-ui.js')).renderAudioPanel();
    renderMapper();
    const zero = {
      groups: grab(), picker: cats(),
      rows: document.querySelectorAll('.osc-row').length,
      minusDisabled: document.getElementById('osc-minus').disabled,
      field: document.getElementById('osc-count').value,
      oscParams: Object.keys(engine.PARAMS).filter(k => /^osc\d+_/.test(k)).length,
    };
    engine.setOscCount(1);
    (await import('/src/ui/audio-ui.js')).renderAudioPanel();
    renderMapper();
    return { one, three, zero,
             missing: Object.keys(engine.PARAMS).filter(k => !shown.includes(k)),
             dupes: shown.filter((k, i) => shown.indexOf(k) !== i) };
  });

  // Chord mode: the list is of CHORDS, each with one handshape, so the same
  // shape cannot be a chord and the release at once. That was possible before,
  // and the panel showed it while the tick loop played something else.
  const chords = await (async () => {
    await toggleDev(page);
    await page.evaluate(() => document.getElementById('chord-toggle')?.click());
    await page.waitForTimeout(250);
    const read = () => page.evaluate(() =>
      [...document.querySelectorAll('#chord-assigns .chord-assign')].map(r => ({
        d: r.dataset.degree,
        label: r.querySelector('.chord-degree')?.textContent ?? '',
        handshape: r.querySelector('.ch-shape')?.value ?? '',
        hasSelect: !!r.querySelector('.ch-shape'),
      })));
    const initial = await read();
    // Live state: a dot per chord row (the same indicator the gestures list
    // uses) and a volume bar showing the chord's real loudness.
    const live = await page.evaluate(() => ({
      dots: document.querySelectorAll('#chord-assigns .gesture-dot').length,
      rows: document.querySelectorAll('#chord-assigns .chord-assign').length,
      vol: !!document.getElementById('chord-vol-fill'),
      readout: !!document.getElementById('chord-readout'),
    }));
    // Expression: what sounds the chord. Switching modes must enable exactly
    // the controls that apply, and re-seed the range for the new signal — a
    // hand's span is meaningless for eyebrows.
    const expr = [];
    for (const mode of ['gesture', 'hand', 'brow']) {
      await page.selectOption('#ck-expr-mode', mode);
      await page.waitForTimeout(200);
      expr.push(await page.evaluate(async () => {
        const { chordmode } = await import('/src/chordmode.js');
        const d = id => document.getElementById(id)?.disabled ?? null;
        return { ...chordmode.expression(),
                 handOff: d('ck-expr-hand'), ctlOff: d('ck-expr-control'),
                 relOff: document.querySelector('.ch-shape[data-degree="release"]')?.disabled ?? null,
                 meter: !!document.getElementById('ck-expr-meter') };
      }));
    }
    await page.selectOption('#ck-expr-mode', 'gesture');
    await page.waitForTimeout(200);
    // Hand the release the shape that plays the first chord.
    const taken = initial.find(r => r.d === '0')?.handshape;
    if (taken) {
      await page.selectOption('.ch-shape[data-degree="release"]', taken);
      await page.waitForTimeout(200);
    }
    const after = await read();
    const state = await page.evaluate(async () => {
      const { chordmode } = await import('/src/chordmode.js');
      const a = chordmode.assignments();
      return { release: chordmode.getReleaseGesture(),
               releaseHasChord: !!chordmode.chordFor(chordmode.getReleaseGesture()),
               degrees: Object.values(a), ids: Object.keys(a) };
    });
    await toggleDev(page);
    return { initial, after, taken, state, expr, live };
  })();

  // Share: the QR has to be a real, scannable code of a real link. Decoding is
  // out of scope here (tests/unit/qr.test.js round-trips through jsQR); this
  // checks the button exists, the popover opens, and it produced a code rather
  // than the "too big" fallback.
  const share = await (async () => {
    await page.click('#share-btn');
    await page.waitForTimeout(400);
    const out = await page.evaluate(() => {
      const c = document.getElementById('share-qr');
      const note = document.getElementById('share-note');
      const ctx = c?.getContext('2d');
      let dark = 0;
      if (ctx && c.width) {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      }
      return {
        open: document.getElementById('share-pop')?.classList.contains('open'),
        w: c?.width ?? 0, h: c?.height ?? 0,
        hidden: c?.style.display === 'none',
        note: note?.textContent ?? '',
        warn: note?.classList.contains('warn') ?? false,
        darkFraction: c?.width ? dark / (c.width * c.height) : 0,
      };
    });
    await page.keyboard.press('Escape');
    return out;
  })();

  const all = { handsL: true, handsR: true, pose: true, face: true };
  await set(all);
  const nodev = await read();                       // camera "on", DEV off
  await toggleDev(page);
  const dev = await read();
  await set({ handsL: false, handsR: false, pose: false, face: true });
  const faceOnly = await read();
  await set({ handsL: false, handsR: false, pose: true, face: false });
  const poseOnly = await read();
  // …and the toggles themselves must drive it, not just the internal helper.
  await page.evaluate(async () => {
    const { cvSource } = await import('/src/cv.js');
    cvSource.setTracking({ hands: false, pose: true });
  });
  const viaToggle = await read();
  await page.close();
  return { nodev, dev, faceOnly, poseOnly, viaToggle, params, share, chords, errs };
})();

// First run: the app asks what to play instead of opening on one oscillator
// with nothing wired to it. Every headless suite starts with empty storage, so
// the picker is skipped under automation for the same reason the tour is — and
// that means the real path is only exercised by pretending not to be
// automation, which is what the override below does.
const firstrun = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() =>
    Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  const url = `http://127.0.0.1:${port}/index.html`;

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const shown = await page.evaluate(() => {
    const el = document.getElementById('start-pop');
    return {
      open: !!el,
      onTop: el ? +getComputedStyle(el).zIndex : 0,
      choices: [...(el?.querySelectorAll('.start-item') ?? [])].map(b => b.dataset.start),
    };
  });

  const state = () => page.evaluate(async () => {
    const { mapper }    = await import('/src/mapper.js');
    const { engine }    = await import('/src/engine.js');
    const { cvSource }  = await import('/src/cv.js');
    const { chordmode } = await import('/src/chordmode.js');
    return { cables: mapper.mappings.length, oscs: engine.getOscCount(),
             hands: cvSource.handsOn, pose: cvSource.poseOn,
             chord: chordmode.enabled, dev: document.body.classList.contains('dev'),
             modal: !!document.getElementById('start-pop') };
  });

  await page.click('.start-item[data-start="blank"]');
  await page.waitForTimeout(400);
  const blank = await state();

  // Asked once. A reload has a saved session now, so the question is settled.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const again = await state();
  await ctx.close();

  // …and a second fresh visit picking chord mode.
  const ctx2 = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx2.addInitScript(() =>
    Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const p2 = await ctx2.newPage();
  p2.on('pageerror', e => errs.push(String(e)));
  await p2.goto(url, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(600);
  await p2.click('.start-item[data-start="chords"]');
  await p2.waitForTimeout(500);
  const chords = await p2.evaluate(async () => {
    const { mapper }    = await import('/src/mapper.js');
    const { engine }    = await import('/src/engine.js');
    const { cvSource }  = await import('/src/cv.js');
    const { chordmode } = await import('/src/chordmode.js');
    return { cables: mapper.mappings.length, oscs: engine.getOscCount(),
             hands: cvSource.handsOn, pose: cvSource.poseOn,
             chord: chordmode.enabled, dev: document.body.classList.contains('dev') };
  });
  await ctx2.close();
  return { shown, blank, again, chords, errs };
})();

await b.close(); server.close();

let fail = 0;
const check = (ok, label, detail = '') => {
  if (!ok) fail++;
  console.log(`  [${ok ? ' PASS ' : ' FAIL '}]  ${label}${detail !== '' ? '  — ' + detail : ''}`);
};

console.log('\nHeader layout — every breakpoint, camera off and on\n');

// ── Layout reset ──
check(narrow.errs.length === 0, 'narrow column: no page errors', narrow.errs.join(' | '));
check(narrow.pans.length === 0, 'narrow column: nothing pans sideways', narrow.pans.join(' | '));
check(narrow.helpOutside === 0, 'narrow column: every ? stays inside its panel',
      String(narrow.helpOutside));

check(reset.errs.length === 0, 'reset: no page errors', reset.errs.join(' | '));
check(reset.stale.order === 'camera patchbay mic',
  'reset: a stale home really does split the inputs', reset.stale.order);
check(reset.stale.folded, 'reset: and a stale fold really does collapse a section');
check(reset.after.order === 'camera mic patchbay',
  'reset: RESET puts the sections back in authored order', reset.after.order);
check(!reset.after.folded, 'reset: and reopens what was collapsed');
check(reset.after.keys === 0, 'reset: and forgets every stored layout key',
  `${reset.after.keys} still set`);
check(reset.reloaded.order === 'camera mic patchbay',
  'reset: and it survives a reload', reset.reloaded.order);

for (const { width, off, on, sections, camSticky } of results) {
  const w = `${width}px`;

  check(sections.total >= 12, `${w}: sections are wrapped`, `${sections.total} found`);
  check(sections.missingBody.length === 0, `${w}: every section has a scrollable body`, sections.missingBody.join(' '));
  check(sections.missingGrip.length === 0, `${w}: every section has a resize grip`, sections.missingGrip.join(' '));
  check(sections.unnamed === 0, `${w}: every section has an id (so its height can persist)`, String(sections.unnamed));
  check(sections.pans.length === 0, `${w}: nothing pans sideways`, sections.pans.join(' | '));
  check(sections.pinnedNotScrolling.length === 0,
    `${w}: a section given a height scrolls rather than clipping`, sections.pinnedNotScrolling.join(' '));
  check(sections.tallerThanContent.length === 0,
    `${w}: no section is taller than its contents`, sections.tallerThanContent.join(' '));

  // ── Cross-column moves ──
  // Every column can receive a dropped section. The audio column has two: the
  // synth list (which renderAudioPanel rebuilds) and the panel around it, which
  // is where the oscilloscope lives so its canvas survives that rebuild.
  // col-l / col-c / col-r are the three columns themselves. They are hosts so
  // that the panels which used to BE the columns — SIGNALS, the camera, the
  // AUDIO ENGINE — have somewhere to be dropped, and so any section can be
  // dragged out to sit beside them as a column-level panel.
  // `inputs` is the list inside the Inputs section that holds the four
  // sources, so a section can be dropped among them rather than only beside.
  check(sections.hosts.join(',') === 'aud,audio,cam,col-c,col-l,col-r,inputs,map,sig',
    `${w}: every column can receive a section`, sections.hosts.join(','));
  check(sections.inHost.length >= 12, `${w}: sections live in hosts`, `${sections.inHost.length}`);
  check(sections.noBirth.length === 0,
    `${w}: every movable section records its birth column`, sections.noBirth.join(' '));
  check(sections.notDraggable.length === 0,
    `${w}: every section in a host is draggable`, sections.notDraggable.join(' '));
  check(sections.unaimableHosts.length === 0,
    `${w}: every host is aimable mid-drag`, sections.unaimableHosts.join(' '));
  check(sections.folds.length === 0,
    `${w}: every fold button reports its state`, sections.folds.join(' '));
  check(sections.foldsAfterToggle === '',
    `${w}: and still reports it after collapsing and reopening`,
    sections.foldsAfterToggle);

  // ── Header typography parity ──
  const hStyles = Object.keys(sections.headerStyles);
  check(hStyles.length <= 1, `${w}: every section header renders identically`,
    hStyles.map(k => `${k} → ${sections.headerStyles[k].join(',')}`).join(' | '));
  check(sections.textSizeAdjust === '100%',
    `${w}: text auto-inflation is off`, String(sections.textSizeAdjust));
  const pl = sections.playable;
  check(!pl.dev, `${w}: measured outside dev mode`);
  check(pl.gestures && pl.chords, `${w}: gestures and chord mode need no DEV`,
    `gestures ${pl.gestures}, chords ${pl.chords}`);
  check(pl.badges === 0, `${w}: and carry no under-construction badge`, String(pl.badges));
  check(!pl.models, `${w}: while MODELS is still dev-only`);

  const v = sections.viz;
  check(v.exists && v.hasCanvas, `${w}: the oscilloscope is its own section`);
  check(!v.inRebuiltPanel, `${w}: and sits outside the panel that rebuilds itself`);
  check(v.foldable, `${w}: it can be minimized`);
  check(v.movable, `${w}: and moved to another column`);
  check(sections.camExtras === (width < 769 ? 'outside' : 'panel-cam'),
    `${w}: the camera column's extra sections are ${width < 769 ? 'outside' : 'inside'} the sticky panel`,
    String(sections.camExtras));
  if (sections.caret) {
    check(sections.caret.content === '""' || sections.caret.content === 'none',
      `${w}: the caret is drawn, not a font glyph`, sections.caret.content);
    check(sections.caret.border >= 1.5 && sections.caret.w >= 6,
      `${w}: the caret has a visible stroke`,
      `${sections.caret.border}px stroke, ${sections.caret.w}px box`);
    check(sections.caret.target >= 18, `${w}: the caret's hit target is large enough`,
      `${sections.caret.target}px`);
  }

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
    // Enclosing sections pin and stack, and none of them hides behind the
    // picture — a header pinned above the camera's bottom edge is a header
    // nobody can see.
    check(camSticky.maxStack >= 2,
      `${w} portrait: enclosing sections stack at the top while you scroll`,
      `${camSticky.maxStack} pinned at once, depths ${camSticky.depths.join(',')}`);
    check(camSticky.behindCamera.length === 0,
      `${w} portrait: and none of them pins behind the camera`,
      camSticky.behindCamera.join(' '));
    // The picture stays in sight for the WHOLE page, not just its own column.
    if (camSticky.deep > camSticky.scrolled)
      check(camSticky.atEnd >= -1 && camSticky.atEnd <= 40,
        `${w} portrait: the camera is still pinned at the bottom of the page`,
        `video top ${camSticky.atEnd} after ${camSticky.deep}px`);
    if (camSticky.scrolled > 0)
      check(camSticky.after <= camSticky.before + 0.5 && camSticky.after <= 1,
        `${w} portrait: the camera stays pinned while the page scrolls`,
        `top ${camSticky.before} → ${camSticky.after} after ${camSticky.scrolled}px`);

    const stacked = [['cam', cam], ['sig', sig], ['map', map], ['aud', aud]];
    const order = [...stacked].sort((a, b) => a[1].top - b[1].top).map(([k]) => k).join('→');
    // The camera still leads — it is what you watch while playing, and what you
    // pull down on to get back to the header. Patchbay follows it now rather
    // than signals: the two share the middle column, and columns stack whole
    // now that they are real containers instead of a per-panel grid placement.
    check(order === 'cam→map→sig→aud',
      `${w} portrait: panels stack camera→patchbay→signals→audio`, order);
  }
}

// ── Cross-column placement survives a re-render and a reload ──
console.log('\nCross-column section placement\n');
{
  const { fresh, rerendered, reloaded, wired, errs } = relocation;
  const stages = [['on load', fresh], ['after renderAudioPanel()', rerendered], ['after reload', reloaded]];
  for (const [label, st] of stages) {
    check(st.gestures === 'map', `${label}: GESTURES is in the patchbay column`, String(st.gestures));
    check(st.kit === 'cam', `${label}: SOUND KIT is in the camera column`, String(st.kit));
    check(st.dupes.length === 0, `${label}: no duplicated sections`, st.dupes.join(' '));
    check(st.apr > 0, `${label}: parameter sliders exist`, String(st.apr));
  }
  check(wired, 'a relocated panel\'s sliders still drive the engine');
  check(errs.length === 0, 'no page errors while placing sections', errs.join(' | '));
}

// ── Inference HUD (dev-only, per-tracker rows) ──
console.log('\nInference HUD\n');
{
  const { nodev, dev, faceOnly, poseOnly, viaToggle, errs } = hud;
  check(nodev.bar === 'none', 'the HUD is hidden outside DEV, camera or not', nodev.bar);
  check(dev.bar !== 'none', 'the HUD appears in DEV with the camera running', dev.bar);
  check(dev.hand && dev.pose && dev.face && dev.total && dev.model,
    'every row shows when every model is running', JSON.stringify(dev));
  check(!faceOnly.hand && !faceOnly.pose, 'HAND/POSE are absent when only the face is tracked',
    JSON.stringify(faceOnly));
  check(faceOnly.face, 'FACE is shown when the face is tracked');
  check(!faceOnly.total, 'TOTAL (the hand/pose loop) goes with them');
  check(!faceOnly.model, 'MODEL names the pose backend, so it goes with POSE');
  check(poseOnly.pose && poseOnly.model && poseOnly.total && !poseOnly.hand && !poseOnly.face,
    'pose alone shows POSE/MODEL/TOTAL and nothing else', JSON.stringify(poseOnly));
  check(!viaToggle.hand && viaToggle.pose,
    'the tracking toggles drive the rows, not only the internal sync',
    JSON.stringify(viaToggle));
  check(errs.length === 0, 'no page errors while driving the HUD', errs.join(' | '));
}

// ── First run ──
console.log('\nFirst run\n');
{
  const { shown, blank, again, chords, errs } = firstrun;
  check(shown.open, 'a fresh visit is asked how to play');
  check(shown.onTop >= 200, 'the picker is above every panel and popover', String(shown.onTop));
  check(shown.choices.includes('chords') && shown.choices.includes('blank'),
    'chord mode and blank are among the choices', shown.choices.join(','));
  check(shown.choices.length >= 7, 'every mapping preset is offered too', `${shown.choices.length}`);

  check(blank.modal === false, 'choosing dismisses it');
  check(blank.cables === 0 && blank.oscs === 0,
    'blank leaves nothing wired and no oscillator', `${blank.cables} cables, ${blank.oscs} osc`);
  check(!blank.hands && !blank.pose, 'blank leaves the trackers off');
  check(again.modal === false, 'a returning visit is not asked again');

  check(chords.chord, 'chord mode is switched on');
  // It used to have to switch DEV on as well, because chord mode was hidden
  // behind it. Asserting the opposite now: needing a developer toggle to reach
  // the one starting point that requires no wiring was the bug.
  check(!chords.dev, 'without needing DEV — chord mode is not an experiment');
  check(chords.oscs === 0, 'with no lead oscillator droning under the chords', `${chords.oscs}`);
  check(chords.hands && !chords.pose, 'hands tracked, pose not');
  check(errs.length === 0, 'no page errors on the first-run path', errs.join(' | '));
}

// ── Chord mode: one handshape, one job ──
console.log('\nChord mode\n');
{
  const { initial, after, taken, state } = hud.chords;
  check(initial.length === 8, 'seven chords in the key, plus RELEASE', `${initial.length} rows`);
  check(initial.every(r => r.hasSelect), 'every row picks a handshape');
  check(initial.some(r => r.d === 'release'), 'the release is one of the rows');
  check(/^I\b/.test(initial[0]?.label ?? ''), 'rows are labelled by degree', initial[0]?.label);
  check(!!taken, 'the tonic starts with a handshape on it', String(taken));
  check(after.find(r => r.d === 'release')?.handshape === taken,
    'the release took the shape', after.find(r => r.d === 'release')?.handshape);
  check(after.find(r => r.d === '0')?.handshape === '',
    'and it left the chord it was playing', after.find(r => r.d === '0')?.handshape);
  check(!state.releaseHasChord, 'the release shape holds no chord');
  check(new Set(state.degrees).size === state.degrees.length,
    'no chord is claimed by two handshapes', state.degrees.join(','));
  check(new Set(state.ids).size === state.ids.length,
    'no handshape claims two chords', state.ids.join(','));
}

// ── Chord mode: live state ──
console.log('\nChord live state\n');
{
  const l = hud.chords.live;
  check(l.dots === l.rows, 'every chord row has an indicator', `${l.dots} dots / ${l.rows} rows`);
  check(l.vol, 'the chord volume is shown');
  check(l.readout, 'and which chord is sounding');
}

// ── Chord expression ──
console.log('\nChord expression\n');
{
  const [byHandshape, byHand, byBrow] = hud.chords.expr;
  check(byHandshape.mode === 'gesture' && byHandshape.handOff && byHandshape.ctlOff,
    'handshape mode: the hand and control pickers do not apply', JSON.stringify(byHandshape));
  check(!byHandshape.meter, 'and there is no range to calibrate');
  check(byHand.mode === 'hand' && !byHand.handOff && !byHand.ctlOff,
    'two-handed mode: both pickers live', JSON.stringify(byHand));
  check(byHand.meter, 'and a live meter to calibrate the range against');
  check(byBrow.mode === 'brow' && byBrow.handOff && !byBrow.ctlOff,
    'eyebrow mode: no hand to choose, but still a control', JSON.stringify(byBrow));
  check(byBrow.hi < byHand.hi && byBrow.lo < byHand.lo,
    "eyebrows get their own range, not the hand's",
    `hand ${byHand.lo}..${byHand.hi} vs brow ${byBrow.lo}..${byBrow.hi}`);
  // Openness bottoms out near 0.38 with a closed fist, so a range starting at
  // zero would put silence out of reach entirely.
  check(byHand.lo > 0.3, 'the hand range starts above a closed fist', String(byHand.lo));
  check(byHand.deadzone > 0, 'and the bottom of the travel rounds down to silence');
  check(byBrow.relOff === true && byHandshape.relOff === false,
    'RELEASE applies to handshape mode only',
    `gesture ${byHandshape.relOff}, brow ${byBrow.relOff}`);
}

// ── Share ──
console.log('\nShare\n');
{
  const s = hud.share;
  check(s.open, 'the SHARE popover opens');
  check(!s.hidden && s.w > 200, 'a QR code was drawn', `${s.w}x${s.h}`);
  check(s.w === s.h, 'the code is square', `${s.w}x${s.h}`);
  check(!s.warn, 'the default setup fits comfortably in a scannable code', s.note);
  // A blank or all-black canvas would satisfy every check above.
  check(s.darkFraction > 0.2 && s.darkFraction < 0.7,
    'the code is a pattern, not a blank or filled square',
    `${(s.darkFraction * 100).toFixed(0)}% dark`);
}

// ── Parameter sliders are grouped exactly as the patchbay picker groups them ──
// Both read the same table, so this pins that they still do: a second,
// hand-maintained copy of the grouping is how the two would drift apart.
console.log('\nParameter grouping\n');
{
  const { one, three, missing, dupes } = hud.params;
  for (const [label, st] of [['1 oscillator', one], ['3 oscillators', three]]) {
    check(JSON.stringify(st.groups) === JSON.stringify(st.picker),
      `${label}: the Parameters groups match the patchbay's output picker`,
      `panel ${JSON.stringify(st.groups)} vs picker ${JSON.stringify(st.picker)}`);
  }
  check(missing.length === 0, 'every engine param has a slider', missing.join(' '));
  check(dupes.length === 0, 'no parameter is listed twice', dupes.join(' '));

  const z = hud.params.zero;
  check(z.oscParams === 0 && z.rows === 0,
    'the bank can be emptied for chord-mode-only play',
    `${z.oscParams} params, ${z.rows} rows`);
  check(z.minusDisabled && z.field === '0', 'the stepper bottoms out at zero',
    `disabled=${z.minusDisabled} field=${z.field}`);
  check(JSON.stringify(z.groups) === JSON.stringify(z.picker),
    'with no oscillators the Oscillators group is absent from both lists',
    `panel ${JSON.stringify(z.groups.map(g => g[0]))} vs picker ${JSON.stringify(z.picker.map(g => g[0]))}`);
}

console.log(`\n${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
