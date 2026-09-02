// Layout guard: the header at every breakpoint, and the node workspace.
//
// The interface is one pan-and-zoom canvas on which every section is a node
// (src/ui/workspace.js). What can silently break, and is measured here
// rather than eyeballed:
//
//   • adoption — every authored or rendered section must end up on the
//     canvas as a node with a header, a body, a grip and an id, and none may
//     be left behind in the staging area or duplicated by a re-render;
//   • placement — the first-run layout must be a layout: nodes inside their
//     group's frame, nothing overlapping, the view fitted to it;
//   • the node chrome — fold carets that report their state, pins, closes,
//     the caret drawn rather than typed;
//   • the gestures — drag a header and the node moves by the drag divided by
//     the zoom; drag it out of its frame and it leaves the group; drag a
//     socket to a socket and a cable exists; collapse a group and its
//     members' outward sockets appear on it; pin, tidy, fullscreen, the add
//     menu, keyboard shortcuts;
//   • persistence — a moved node stays moved through the audio panel
//     rebuilding its markup and through a reload; RESET puts it all back.
//
// Plus everything the old suite guarded that is still true: the header, the
// signals panel, typed sliders, the HUD, first run, chord mode, share, saved
// setups, the camera-view controls, the keyboard overlay, gesture
// configurations, the level bars.
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
const URL_ = `http://127.0.0.1:${port}/index.html`;

// Widths chosen to land on both sides of every breakpoint in main.css
// (the mobile block, and the >=1200px desktop-sizing block).
const WIDTHS = [320, 375, 390, 430, 768, 1024, 1199, 1200, 1440, 1920];

// DEV lives in the settings popover: open ⚙, hit the toggle, close it again
// so it does not sit over the layout being measured.
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
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

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
      video: (() => {
        const el = document.getElementById('video-wrap');
        const r = el?.getBoundingClientRect();
        return r ? { w: r.width, h: r.height } : null;
      })(),
    };
  });

  // ── The workspace ──
  const nodes = await page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    const all = [...document.querySelectorAll('#ws .node')];
    const panels = all.filter(e => e.classList.contains('node-panel'));
    const shown = all.filter(e => e.getClientRects().length > 0 && !e.classList.contains('node-hidden'));
    const rectOf = e => e.getBoundingClientRect();
    // Two visible nodes (not frames) may not sit on top of each other.
    const boxes = shown.filter(e => !(e.classList.contains('node-group') && !e.classList.contains('collapsed')));
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = rectOf(boxes[i]), c = rectOf(boxes[j]);
      const w = Math.min(a.right, c.right) - Math.max(a.left, c.left);
      const h = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
      if (w <= 0 || h <= 0) continue;
      const small = Math.min(a.width * a.height, c.width * c.height);
      if (w * h > small * 0.25) overlaps.push(`${boxes[i].dataset.node}×${boxes[j].dataset.node}`);
    }
    // Every visible member sits inside its group's frame.
    const outsideFrame = [];
    for (const n of WS.allNodes()) {
      if (n.kind !== 'group' || n.collapsed) continue;
      const f = rectOf(document.querySelector(`[data-node="${n.id}"]`));
      for (const m of WS.allNodes().filter(x => x.parent === n.id)) {
        const el = document.querySelector(`[data-node="${m.id}"]`);
        if (!el || !el.getClientRects().length || m.pinned) continue;
        const r = rectOf(el);
        if (r.left < f.left - 1 || r.right > f.right + 1 || r.top < f.top - 1 || r.bottom > f.bottom + 1)
          outsideFrame.push(`${m.id} outside ${n.id}`);
      }
    }
    return {
      total: all.length,
      panels: panels.length,
      ids: panels.map(e => e.dataset.secId),
      missingHead: all.filter(e => !e.querySelector(':scope > .node-head')).map(e => e.dataset.node),
      missingBody: panels.filter(e => !e.querySelector(':scope > .node-body')).map(e => e.dataset.node),
      missingGrip: panels.filter(e => !e.querySelector(':scope > .node-grip')).map(e => e.dataset.node),
      unnamed: panels.filter(e => !e.dataset.secId || !e.dataset.node).length,
      // Nothing may be left behind where it was authored or rendered.
      staged: [...document.querySelectorAll('#ws-staging .audio-section, #ws-staging [data-sec]')]
        .map(e => e.dataset.sec ?? e.className),
      dupes: (() => {
        const seen = {};
        for (const e of all) seen[e.dataset.node] = (seen[e.dataset.node] || 0) + 1;
        return Object.entries(seen).filter(([, n]) => n > 1).map(([k]) => k);
      })(),
      unplaced: WS.allNodes().filter(n => !n.placed).map(n => n.id),
      overlaps,
      outsideFrame,
      groups: WS.allNodes().filter(n => n.kind === 'group').map(n => n.id).sort(),
      view: WS.viewTransform(),
      camOnScreen: (() => {
        const r = rectOf(document.querySelector('[data-node="panel:camera"]'));
        return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) };
      })(),
      // Nothing may pan SIDEWAYS inside a node: a node body scrolls vertically,
      // and CSS turns a visible overflow on one axis into a scrollable one on
      // the other. A container that genuinely scrolls across (the tone-picker
      // keyboard, the add menu) opts in by carrying its own scroller.
      pans: [...document.querySelectorAll('#ws .node *')]
        .filter(e => {
          if (!e.clientWidth || e.scrollWidth <= e.clientWidth + 1) return false;
          if (e.closest('.ng-freq-kbd-wrap')) return false;
          const ox = getComputedStyle(e).overflowX;
          return ox === 'auto' || ox === 'scroll';
        })
        .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} +${e.scrollWidth - e.clientWidth}px`),
      // A node given a height must actually scroll, or the height just clips.
      sizedNotScrolling: panels
        .filter(e => e.classList.contains('sized'))
        .filter(e => getComputedStyle(e.querySelector(':scope > .node-body')).overflowY !== 'auto')
        .map(e => e.dataset.node),
      // Section headers must render identically to each other: a stray
      // inline display or font-size is what WebKit's text inflation latches on.
      headerStyles: (() => {
        const seen = {};
        for (const el of document.querySelectorAll('.node > .node-head.audio-section-label')) {
          const cs = getComputedStyle(el);
          const k = `${cs.fontSize}|${cs.display}|${cs.letterSpacing}`;
          (seen[k] ??= []).push(el.textContent.trim().split('\n')[0].slice(0, 18));
        }
        return seen;
      })(),
      textSizeAdjust: getComputedStyle(document.documentElement).webkitTextSizeAdjust
                   ?? getComputedStyle(document.documentElement).textSizeAdjust,
      // A fold button has to say which state it is in…
      folds: (() => {
        const bad = [];
        for (const sec of panels) {
          const btn = sec.querySelector(':scope > .node-head > .sec-fold');
          if (!btn) continue;
          const want = String(!sec.classList.contains('folded'));
          if (btn.getAttribute('aria-expanded') !== want) bad.push(sec.dataset.node);
        }
        return bad;
      })(),
      // …after actually collapsing one, since every node starts expanded.
      foldsAfterToggle: (() => {
        const sec = document.querySelector('[data-node="panel:oscillators"]');
        const btn = sec?.querySelector(':scope > .node-head > .sec-fold');
        if (!btn) return 'no fold button on the oscillators node';
        btn.click();
        const collapsed = sec.classList.contains('folded')
                       && btn.getAttribute('aria-expanded') === 'false'
                       && sec.querySelector(':scope > .node-body').getClientRects().length === 0;
        btn.click();
        const reopened = !sec.classList.contains('folded')
                      && btn.getAttribute('aria-expanded') === 'true';
        return collapsed && reopened ? '' : `collapsed=${collapsed} reopened=${reopened}`;
      })(),
      playable: (() => {
        const vis = id => {
          const e = document.querySelector(`[data-node="panel:${id}"]`);
          return !!e && e.getClientRects().length > 0;
        };
        return { dev: document.body.classList.contains('dev'),
                 gestureMode: vis('gesture-mode'),
                 lib: (() => {
                   const d = document.getElementById('gesture-lib');
                   return !!d && d.querySelector('summary').getClientRects().length > 0;
                 })(),
                 models: vis('models'),
                 badges: document.querySelectorAll('[data-node="panel:gesture-mode"] .uc-badge').length };
      })(),
      // The oscilloscope is a node like any other, and lives outside the
      // panel that rebuilds itself so its canvas survives that.
      viz: (() => {
        const v = document.querySelector('[data-node="panel:output"]');
        return {
          exists: !!v,
          inRebuiltPanel: !!v?.closest('#audio-panel'),
          foldable: !!v?.querySelector('.sec-fold'),
          pinnable: !!v?.querySelector('.node-pin'),
          hasCanvas: !!v?.querySelector('#viz-canvas'),
        };
      })(),
      // The collapse caret is drawn from borders rather than typed as a glyph.
      caret: (() => {
        const btn = [...document.querySelectorAll('.sec-fold')].find(b => b.getClientRects().length);
        if (!btn) return null;
        const cs = getComputedStyle(btn, '::before');
        // Layout pixels: the node is on a zoomed canvas, and the size that
        // matters is the one the stylesheet declares.
        return { content: cs.content, border: parseFloat(cs.borderBottomWidth),
                 w: parseFloat(cs.width), target: Math.round(btn.offsetWidth) };
      })(),
      // The tracker toggles are inside the Camera Input node's body.
      trackers: (() => {
        const body = document.querySelector('[data-node="panel:camera"] > .node-body');
        const row = document.getElementById('tracker-row');
        const br = body?.getBoundingClientRect(), r = row?.getBoundingClientRect();
        return { inBody: !!body?.contains(row),
                 within: !!(br && r) && r.top >= br.top - 0.5 && r.bottom <= br.bottom + 0.5 };
      })(),
    };
  });

  const off = await measure();
  await page.evaluate(() => document.body.classList.add('cam-on'));
  await page.waitForTimeout(120);
  const on = await measure();

  // ── Signals panel ──
  // Registration is separable from the tracker, so take the same code path
  // cvSource.init() takes minus the model download: register, flag the
  // trackers live, build.
  await page.addScriptTag({ type: 'module', content: `
    import { cvSource }      from '/src/cv.js';
    import { faceSource }    from '/src/face.js';
    import { depthSource }   from '/src/depth.js';
    import { buildSigPanel } from '/src/ui/signals.js';
    cvSource.registerSignals();
    faceSource.registerSignals();
    depthSource.registerSignals();
    cvSource.running = true; cvSource.handsL = true; cvSource.handsR = true;
    cvSource.poseOn = true; faceSource.faceOn = true; faceSource.gazeOn = true;
    buildSigPanel();
    window.__sigBuilt = true;
  ` });
  await page.waitForFunction(() => window.__sigBuilt, null, { timeout: 20000 });
  await page.waitForTimeout(150);
  const sigPanel = await page.evaluate(() => {
    document.querySelectorAll('.sig-sec').forEach(d => { d.open = true; });
    const rows  = [...document.querySelectorAll('.sig-row')];
    const multi = rows.filter(r => r.classList.contains('sig-row-multi'));
    const bars  = [...document.querySelectorAll('.sig-bar')];
    const clickCopy = el => el.closest('[data-key]')?.dataset.key
                         ?? el.closest('.sig-row')?.dataset.key ?? '';
    const first = multi[0];
    return {
      rows: rows.length,
      multi: multi.length,
      barWidths: [...new Set(bars.map(b => Math.round(b.getBoundingClientRect().width)))],
      zeroWidth: bars.filter(b => b.getBoundingClientRect().width < 8).length,
      chans: first ? [...first.querySelectorAll('.sig-chan-name')].map(e => e.textContent.trim()) : [],
      keys: first ? {
        base: first.dataset.key,
        vel:  clickCopy(first.querySelector('.sig-bar-fill.vel')),
        disp: clickCopy(first.querySelector('.sig-bar-fill:not(.vel)')),
        name: clickCopy(first.querySelector('.sig-name')),
      } : null,
      counts: [...document.querySelectorAll('.sig-sec')].map(d =>
        [d.dataset.group, +d.querySelector('.sig-group-meta').textContent.trim().split(' ')[0],
         d.querySelectorAll('.sig-row').length, d.querySelectorAll('.sig-val').length]),
      // The readings stay inside the list; only the sockets ride out past
      // its edge, to the node's border.
      pans: (() => { const p = document.getElementById('cam-signals').getBoundingClientRect();
                     return [...document.querySelectorAll('#cam-signals .sig-bar, #cam-signals .sig-val')]
                       .some(e => e.getBoundingClientRect().right > p.right + 1); })(),
      // Every channel IS an output socket on the camera node, so any signal
      // can be wired from the list to a parameter anywhere on the canvas.
      srcs: document.querySelectorAll('#cam-signals .sig-sec-body .port-out').length,
      vals: document.querySelectorAll('#cam-signals .sig-val').length,
      // Sockets straddle the node's border: an output's ring is centred on
      // the camera node's right edge, an input's on its node's left edge.
      onEdge: (() => {
        const cam = document.querySelector('[data-node="panel:camera"]').getBoundingClientRect();
        const outs = [...document.querySelectorAll('#cam-signals .sig-sec-body .port-out')].filter(p => p.checkVisibility());
        const offOut = outs.filter(p => { const r = p.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - cam.right) > 2; });
        const ins = [...document.querySelectorAll('#ws .node-panel:not(.sized) .ctrl-row .port-in')].filter(p => p.checkVisibility());
        const offIn = ins.filter(p => {
          const n = p.closest('.node').getBoundingClientRect(), r = p.getBoundingClientRect();
          return Math.abs(r.left + r.width / 2 - n.left) > 2;
        });
        return { outs: outs.length, offOut: offOut.length, ins: ins.length, offIn: offIn.map(p => p.dataset.key) };
      })(),
    };
  });

  // Every slider takes a typed value (ui/numeric.js).
  const nums = await page.evaluate(async () => {
    const { chordmode } = await import('/src/chordmode.js');
    const { arpvoice } = await import('/src/arpvoice.js');
    const { metronome } = await import('/src/metronome.js');
    chordmode.setEnabled(true);
    chordmode.setExpression({ mode: 'hand', control: 'volume' });
    arpvoice.set({ enabled: true });
    metronome.setOn(true);
    const { renderAudioPanel } = await import('/src/ui/audio-ui.js');
    renderAudioPanel();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const ranges = [...document.querySelectorAll('input[type="range"]')];
    const paired = ranges.filter(r => r.hasAttribute('data-num-paired'));
    const { engine } = await import('/src/engine.js');
    const { paramOwner } = await import('/src/params.js');
    const f = document.getElementById('av-filter_freq');
    let typed = null;
    if (f && f.tagName === 'INPUT') {
      f.focus(); f.value = '5000';
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.blur();
      typed = Math.round(engine.PARAMS.filter_freq.val);
    }
    return {
      ranges: ranges.length, paired: paired.length,
      missing: ranges.filter(r => !r.hasAttribute('data-num-paired'))
        .map(r => r.id || r.className || 'anonymous'),
      typed,
      // The fields stay inside their nodes (the sockets on the border do not
      // count: they are meant to straddle it).
      overflow: [...document.querySelectorAll('.node-panel > .node-body')]
        .filter(e => {
          const r = e.getBoundingClientRect();
          return [...e.querySelectorAll('input, select, .ctrl-val, .sig-val')]
            .some(f => f.getClientRects().length && f.getBoundingClientRect().right > r.right + 1);
        }).length,
      // Every parameter — slider, switch or choice — carries an input socket
      // on the node that owns it, so a signal can be wired to it in place.
      unsocketed: Object.keys(engine.PARAMS).filter(k => paramOwner(k)
        && !document.querySelector(`[data-node="${paramOwner(k)}"] .port-in[data-key="${k}"]`)),
    };
  });

  results.push({ width, off, on, nodes, sigPanel, nums, errs });
  await page.close();
}

// ── The workspace's gestures ─────────────────────────────────────────────
//
// Driven with real pointer events, at one zoom, so the arithmetic that
// turns a screen drag into a world move is under test and not only the
// model behind it.
const gestures = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const { mapper } = await import('/src/mapper.js');
    const { renderMapper } = await import('/src/ui/mapper-ui.js');
    mapper.applyPreset('hands');
    renderMapper();
  });
  await page.waitForTimeout(200);

  const node = id => page.evaluate(async id =>
    (await import('/src/ui/workspace.js')).getNode(id), id);
  const headRect = id => page.evaluate(id => {
    const h = document.querySelector(`[data-node="${id}"] > .node-head`).getBoundingClientRect();
    return { x: h.left, y: h.top, w: h.width, h: h.height };
  }, id);
  const k = await page.evaluate(async () => (await import('/src/ui/workspace.js')).viewTransform().k);

  // 1. Drag a node by its header: it moves by the drag divided by the zoom,
  //    snapped to the grid, and stays in its group while it is inside the frame.
  const micBefore = await node('panel:mic');
  let hr = await headRect('panel:mic');
  await page.mouse.move(hr.x + 40, hr.y + hr.h / 2);
  await page.mouse.down();
  await page.mouse.move(hr.x + 60, hr.y + hr.h / 2 + 10);
  await page.mouse.move(hr.x + 40 + 60, hr.y + hr.h / 2 + 30, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const micAfter = await node('panel:mic');
  const drag = { dx: micAfter.x - micBefore.x, dy: micAfter.y - micBefore.y, k,
                 wantX: 60 / k, wantY: 30 / k, parent: micAfter.parent };

  // 2. Drag it well clear of the INPUTS frame (below it, where no frame is):
  //    it leaves the group. The frame's height depends on the fonts the
  //    machine has, so first pan until there is room below it on screen —
  //    a drop off the bottom of the page is no drop at all.
  const frame0 = await page.evaluate(() =>
    document.querySelector('[data-node="group:inputs"]').getBoundingClientRect().toJSON());
  await page.evaluate(async dy => {
    const WS = await import('/src/ui/workspace.js');
    const t = WS.viewTransform();
    WS.setView({ x: t.x, y: t.y - dy, k: t.k }, false);
  }, Math.max(0, frame0.bottom - 640));
  await page.waitForTimeout(150);
  const frame = await page.evaluate(() =>
    document.querySelector('[data-node="group:inputs"]').getBoundingClientRect().toJSON());
  hr = await headRect('panel:mic');
  await page.mouse.move(hr.x + 40, hr.y + hr.h / 2);
  await page.mouse.down();
  await page.mouse.move(hr.x + 40, frame.bottom + 120, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const left = { parent: (await node('panel:mic')).parent };
  // …and dropped back inside, it rejoins.
  hr = await headRect('panel:mic');
  const camHead = await headRect('panel:camera');
  await page.mouse.move(hr.x + 40, hr.y + hr.h / 2);
  await page.mouse.down();
  await page.mouse.move(camHead.x + 40, camHead.y + 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const rejoined = { parent: (await node('panel:mic')).parent };
  await page.evaluate(async () => (await import('/src/ui/workspace.js')).resetLayout());
  await page.waitForTimeout(300);

  // 3. Wire a cable by dragging socket to socket: a signal's output ● on the
  //    camera node to a parameter's input ● on the audio node that owns it.
  //    The camera's DEPTH group is folded while no camera runs; open it so
  //    its sockets are on screen.
  await page.evaluate(() => { document.querySelector('.sig-sec[data-group="depth"]').open = true; });
  await page.waitForTimeout(250);
  const socket = (side, key) => page.evaluate(([side, key]) => {
    const r = [...document.querySelectorAll(`.port[data-side="${side}"][data-key="${key}"]`)]
      .find(p => p.checkVisibility()).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, [side, key]);
  const from = await socket('out', 'hand_L_z'), to = await socket('in', 'volume');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 20);
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const wired = await page.evaluate(async () => {
    const { mapper } = await import('/src/mapper.js');
    const pop = document.getElementById('ng-editor-pop');
    return {
      signal: mapper.mappings.find(m => m.audioParam === 'volume')?.signal,
      editor: !!pop && !pop.hidden && !!pop.querySelector('.ng-editor'),
      onVolume: mapper.mappings.filter(m => m.audioParam === 'volume').length,
      cables: document.querySelectorAll('.ng-wire').length,
    };
  });
  await page.keyboard.press('Escape');          // the editor, out of the way
  await page.waitForTimeout(80);
  // Fold the group again: the wired socket moves to the summary, the cable
  // ends on it, and the cable to volume still ends on volume's ring.
  await page.evaluate(() => { document.querySelector('.sig-sec[data-group="depth"]').open = false; });
  await page.waitForTimeout(300);
  const folded = await page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    const { mapper } = await import('/src/mapper.js');
    const d = document.querySelector('.sig-sec[data-group="depth"]');
    const strip = [...d.querySelectorAll('summary .port-out')].map(p => p.dataset.key);
    const m = mapper.mappings.find(x => x.audioParam === 'volume');
    const path = document.querySelector(`.ng-wire[data-mid="${m.id}"]`);
    const nums = path.getAttribute('d').match(/-?[\d.]+/g).map(Number);
    const a = WS.toScreen(nums[0], nums[1]), b = WS.toScreen(nums[6], nums[7]);
    const centre = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const out = centre(d.querySelector('summary .port-out[data-key="hand_L_z"]'));
    const inn = centre(document.querySelector('.port-in[data-key="volume"]'));
    const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 2;
    return { strip, startsOnRing: near(a, out), endsOnRing: near(b, inn), dashed: path.classList.contains('ng-wire-edge') };
  });
  await page.evaluate(() => { document.querySelector('.sig-sec[data-group="depth"]').open = true; });
  await page.waitForTimeout(300);

  // 4. Tap a socket, then tap another: the same connection, for touch.
  const tapFrom = await socket('out', 'hand_R_z'), tapTo = await socket('in', 'lfo_depth');
  await page.mouse.click(tapFrom.x, tapFrom.y);
  await page.waitForTimeout(80);
  const armed = await page.evaluate(() => !!document.querySelector('.port.armed'));
  await page.mouse.click(tapTo.x, tapTo.y);
  await page.waitForTimeout(150);
  const tapped = await page.evaluate(async () => {
    const { mapper } = await import('/src/mapper.js');
    return { signal: mapper.mappings.find(m => m.audioParam === 'lfo_depth')?.signal,
             armedLeft: document.querySelectorAll('.port.armed').length };
  });

  // 5. Group two function nodes (Ctrl+G) and collapse the group: only the
  //    sockets whose cables cross the frame appear on it, and every cable
  //    that crosses still draws.
  const grouped = await page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    const { mapper } = await import('/src/mapper.js');
    const { renderMapper, addFnNode } = await import('/src/ui/mapper-ui.js');
    const { sigKeyOf, paramKeyOf } = await import('/src/graph.js');
    const lfo = addFnNode('lfo'), mix = addFnNode('mix');
    const li = +lfo.slice(3), mi = +mix.slice(3);
    mapper.add(paramKeyOf(mi, 'a'), sigKeyOf(li), 0, 1, 'linear', 0, false);   // stays inside
    mapper.add(paramKeyOf(mi, 'b'), 'hand_L_y',    0, 1, 'linear', 0, false);   // enters, from the camera
    mapper.mappings.filter(m => m.audioParam === 'volume').forEach(m => mapper.remove(m.id));
    mapper.add('volume', sigKeyOf(mi), 0, 1, 'linear', 0, false);               // leaves, for the output
    renderMapper();
    await new Promise(r => setTimeout(r, 100));
    WS.selectNodes([lfo, mix]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const g = WS.allNodes().find(n => n.kind === 'group' && /^group:g\d+$/.test(n.id));
    if (!g) return { made: false };
    const cablesBefore = document.querySelectorAll('.ng-wire').length;
    WS.setCollapsed(g.id, true);
    await new Promise(r => setTimeout(r, 100));
    const el = document.querySelector(`[data-node="${g.id}"]`);
    const ports = root => [...root.querySelectorAll('.port')].map(p => `${p.dataset.side}:${p.dataset.key}`).sort();
    const out = {
      made: true, id: g.id, parent: g.parent,
      want: [`in:${paramKeyOf(mi, 'b')}`, `out:${sigKeyOf(mi)}`].sort(),
      members: WS.allNodes().filter(n => n.parent === g.id).map(n => n.id).sort(),
      wantMembers: [lfo, mix].sort(),
      hidden: [lfo, mix].every(id => document.querySelector(`[data-node="${id}"]`).getClientRects().length === 0),
      ports: ports(el),
      cablesBefore, cablesAfter: document.querySelectorAll('.ng-wire').length,
    };
    // Nested frames: fold the new group into an outer one and collapse THAT —
    // the inner group goes with it, and the outer shows the same two sockets.
    WS.selectNodes([g.id]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const outer = WS.getNode(g.id).parent;
    WS.setCollapsed(outer, true);
    await new Promise(r => setTimeout(r, 100));
    out.nested = { outerPorts: ports(document.querySelector(`[data-node="${outer}"]`)),
                   cables: document.querySelectorAll('.ng-wire').length,
                   innerShown: el.getClientRects().length > 0 };
    WS.setCollapsed(outer, false);
    WS.ungroupNode(outer);
    WS.ungroupNode(g.id);
    await new Promise(r => setTimeout(r, 100));
    out.after = { gone: !WS.getNode(g.id), parent: WS.getNode(mix).parent,
                  cables: document.querySelectorAll('.ng-wire').length };
    // Leave the board as the preset had it for the steps that follow.
    const { graph } = await import('/src/graph.js');
    graph.remove(li); graph.remove(mi);           // their cables go with them
    renderMapper();
    return out;
  });

  // 6. Pin the camera: it leaves the world for the screen and comes back.
  const pinned = await page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    const cam = document.querySelector('[data-node="panel:camera"]');
    const before = cam.getBoundingClientRect();
    cam.querySelector('.node-pin').click();
    await new Promise(r => setTimeout(r, 100));
    const during = cam.getBoundingClientRect();
    WS.setView({ x: WS.viewTransform().x - 300, y: WS.viewTransform().y, k: WS.viewTransform().k }, false);
    await new Promise(r => setTimeout(r, 100));
    const panned = cam.getBoundingClientRect();
    const dock = cam.parentElement.id;
    cam.querySelector('.node-pin').click();
    await new Promise(r => setTimeout(r, 100));
    return { dock, stayed: Math.abs(during.left - panned.left) < 1 && Math.abs(before.left - during.left) < 1,
             back: cam.parentElement.id, pressed: cam.querySelector('.node-pin').getAttribute('aria-pressed') };
  });

  // 7. The add menu: right-click EMPTY canvas, search, add.
  const empty = await page.evaluate(() => {
    for (let y = 120; y < innerHeight - 40; y += 40) for (let x = 40; x < innerWidth - 40; x += 40) {
      if (!document.elementFromPoint(x, y)?.closest('.node, .ws-menu, #header')) return { x, y };
    }
    return null;
  });
  await page.mouse.click(empty.x, empty.y, { button: 'right' });
  await page.waitForTimeout(100);
  const menu = await page.evaluate(() => {
    const m = document.getElementById('ws-menu');
    return { open: !m.hidden, secs: [...m.querySelectorAll('.ws-menu-sec')].map(e => e.textContent),
             focused: document.activeElement?.classList.contains('ws-menu-search') };
  });
  await page.keyboard.type('sample');
  await page.waitForTimeout(80);
  const filtered = await page.evaluate(() =>
    [...document.querySelectorAll('#ws-menu .ws-menu-item .ws-menu-lbl')].map(e => e.textContent));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const added = await page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    const { graph } = await import('/src/graph.js');
    const fn = WS.allNodes().filter(n => n.kind === 'fn');
    return { fn: fn.map(n => n.id), types: graph.nodes().map(n => n.type),
             menuClosed: document.getElementById('ws-menu').hidden,
             ports: document.querySelectorAll('.node-fn .port').length,
             selected: WS.selectedIds() };
  });
  // Delete removes the selected node and its graph node with it.
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  const deleted = await page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    const { graph } = await import('/src/graph.js');
    return { fn: WS.allNodes().filter(n => n.kind === 'fn').length, graph: graph.nodes().length };
  });

  // 8. A closed panel comes back from the menu, at the point asked for.
  const closed = await page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    document.querySelector('[data-node="panel:metronome"] .node-close').click();
    await new Promise(r => setTimeout(r, 80));
    const hidden = document.querySelector('[data-node="panel:metronome"]').getClientRects().length === 0;
    WS.openAddMenu(600, 400);
    await new Promise(r => setTimeout(r, 80));
    const item = [...document.querySelectorAll('#ws-menu .ws-menu-item')]
      .find(b => /metronome/i.test(b.textContent));
    const listed = !!item;
    item?.click();
    await new Promise(r => setTimeout(r, 120));
    const n = WS.getNode('panel:metronome');
    const at = WS.toWorld(600, 400);
    return { hidden, listed, shown: document.querySelector('[data-node="panel:metronome"]').getClientRects().length > 0,
             near: Math.abs(n.x - at.x) < 12 && Math.abs(n.y - at.y) < 12, parent: n.parent };
  });

  // 9. TIDY leaves nothing overlapping and everything in view.
  await page.evaluate(async () => (await import('/src/ui/workspace.js')).resetLayout());
  await page.waitForTimeout(200);
  await page.click('#tidy-btn');
  await page.waitForTimeout(600);
  const tidy = await page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    const top = WS.allNodes().filter(n => !n.parent && !n.pinned)
      .map(n => document.querySelector(`[data-node="${n.id}"]`))
      .filter(e => e && e.getClientRects().length);
    const rects = top.map(e => e.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], c = rects[j];
      if (Math.min(a.right, c.right) - Math.max(a.left, c.left) > 2
       && Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top) > 2) overlaps++;
    }
    const ws = document.getElementById('ws').getBoundingClientRect();
    const inView = rects.every(r => r.left >= ws.left - 1 && r.right <= ws.right + 1
                                  && r.top >= ws.top - 1 && r.bottom <= ws.bottom + 1);
    return { count: top.length, overlaps, inView };
  });

  // 10. The wheel zooms over empty canvas and scrolls over a list that scrolls.
  const zoomed = await (async () => {
    const before = await page.evaluate(async () => (await import('/src/ui/workspace.js')).viewTransform().k);
    await page.mouse.move(1300, 800);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(150);
    const after = await page.evaluate(async () => (await import('/src/ui/workspace.js')).viewTransform().k);
    // Over a node given a height smaller than its content: its body scrolls,
    // the view holds.
    const sig = await page.evaluate(async () => {
      const WS = await import('/src/ui/workspace.js');
      const n = WS.getNode('panel:metronome');
      n.h = 120; n.auto = false;
      WS.syncWorkspace();
      WS.fitAll(['panel:metronome']);          // on screen, whatever the zoom above did
      // The fit animates; wait for the view to come to rest rather than for a
      // fixed time, since a loaded machine takes longer to get there.
      for (let last = null, i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        const t = WS.viewTransform(), now = `${t.x},${t.y},${t.k}`;
        if (now === last) break;
        last = now;
      }
      const body = document.querySelector('[data-node="panel:metronome"] > .node-body');
      const r = body.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, k: WS.viewTransform().k,
               scrollable: body.scrollHeight > body.clientHeight + 1 };
    });
    await page.mouse.move(sig.x, sig.y);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
    const held = await page.evaluate(async () => (await import('/src/ui/workspace.js')).viewTransform().k);
    const scrolled = await page.evaluate(() =>
      document.querySelector('[data-node="panel:metronome"] > .node-body').scrollTop);
    return { before, after, held, fitted: sig.k, scrolled, scrollable: sig.scrollable };
  })();

  // 11. Fake fullscreen lifts the picture out of the transformed canvas.
  const fs = await page.evaluate(async () => {
    const { fullscreen } = await import('/src/ui/fullscreen.js');
    fullscreen.open();
    await new Promise(r => setTimeout(r, 200));
    const vw = document.getElementById('video-wrap');
    const r = vw.getBoundingClientRect();
    const out = { parent: vw.parentElement.tagName, w: Math.round(r.width), h: Math.round(r.height),
                  left: Math.round(r.left), top: Math.round(r.top), vw: innerWidth, vh: innerHeight };
    document.getElementById('fs-btn').click();
    await new Promise(r => setTimeout(r, 200));
    out.back = !!vw.closest('[data-node="panel:camera"]');
    out.order = vw.previousElementSibling?.className.includes('cam-label') || vw.parentElement.firstElementChild === vw;
    return out;
  });

  // 12. Content that grows after placement re-stacks the nodes below it —
  //     a web font landing late, a list gaining rows — so auto-placed nodes
  //     never come to overlap; a node placed by hand is left alone.
  const grown = await page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    WS.resetLayout();
    await new Promise(r => setTimeout(r, 300));
    const rect = id => document.querySelector(`[data-node="${id}"]`).getBoundingClientRect();
    const below = (a, b) => rect(b).top >= rect(a).bottom - 0.5;
    const before = { pq: WS.getNode('panel:pitch-quantize').y, ordered: below('panel:looper', 'panel:pitch-quantize') };
    const filler = document.createElement('div');
    filler.style.cssText = 'height:160px';
    document.querySelector('[data-node="panel:looper"] > .node-body').appendChild(filler);
    await new Promise(r => setTimeout(r, 250));
    const after = { pq: WS.getNode('panel:pitch-quantize').y, ordered: below('panel:looper', 'panel:pitch-quantize') };
    // …but a node the user has placed is not pushed around.
    const vq = WS.getNode('panel:volume-quantize');
    vq.auto = false;
    const held = vq.y;
    filler.style.height = '320px';
    await new Promise(r => setTimeout(r, 250));
    const hand = { y: WS.getNode('panel:volume-quantize').y, held, pq: WS.getNode('panel:pitch-quantize').y };
    filler.remove();
    await new Promise(r => setTimeout(r, 250));
    return { before, after, hand };
  });

  // 13. Persistence: the layout is one localStorage key with every node in it.
  const saved = await page.evaluate(() => {
    const raw = localStorage.getItem('motionmuse-workspace');
    const s = raw ? JSON.parse(raw) : null;
    return { present: !!s, nodes: s ? Object.keys(s.nodes).length : 0,
             hasCamera: !!s?.nodes['panel:camera'], hasView: Number.isFinite(s?.view?.k) };
  });

  await ctx.close();
  return { drag, left, rejoined, wired, folded, armed, tapped, grouped, pinned, menu, filtered, added, deleted,
           closed, tidy, zoomed, fs, grown, saved, errs };
})();

// ── A moved node STAYS moved through a re-render and a reload ────────────
const persist = await (async () => {
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  // Seeded rather than dragged: the drag is a pointer-sequence concern (above);
  // what must not regress is that the stored layout is honoured.
  await page.addInitScript(() =>
    localStorage.setItem('motionmuse-workspace', JSON.stringify({ v: 1, nodes: {
      'panel:gesture-mode': { x: 1400, y: 900, parent: null, w: 340 },
      'panel:sound-kit':    { x: 40, y: 700, parent: 'group:inputs' },
      'group:inputs':       { title: 'INPUTS' },
      'group:audio':        { title: 'AUDIO ENGINE' },
      'panel:mic':          { x: 40, y: 640, parent: 'group:inputs', folded: true },
    } })));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const where = () => page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    const at = id => { const n = WS.getNode(id); return n ? `${n.parent}@${n.x},${n.y}` : null; };
    const counts = {};
    for (const e of document.querySelectorAll('#ws .node'))
      counts[e.dataset.node] = (counts[e.dataset.node] || 0) + 1;
    return {
      gestures: at('panel:gesture-mode'), kit: at('panel:sound-kit'),
      micFolded: document.querySelector('[data-node="panel:mic"]').classList.contains('folded'),
      dupes: Object.entries(counts).filter(([, n]) => n > 1).map(([k]) => k),
      apr: document.querySelectorAll('.apr').length,
      // The shipped groups still exist, and the audio one still holds the rest.
      audioMembers: WS.allNodes().filter(n => n.parent === 'group:audio').length,
    };
  });

  const fresh = await where();
  await page.evaluate(async () => (await import('/src/ui/audio-ui.js')).renderAudioPanel());
  await page.waitForTimeout(300);
  const rerendered = await where();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const reloaded = await where();

  // The moved node's controls must still drive the engine.
  const wired = await page.evaluate(async () => {
    const { engine } = await import('/src/engine.js');
    // Not the volume: that one is quantised into steps by design.
    const el = document.querySelector('#ws .apr[data-key="reverb_mix"]');
    if (!el) return false;
    const p = engine.PARAMS[el.dataset.key];
    // Two settings, so a detent the first happens to land on cannot fake it.
    const drive = f => {
      el.value = String(p.min + (p.max - p.min) * f);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return p.val;
    };
    return drive(0.42) !== drive(0.63);
  });

  await page.close();
  return { fresh, rerendered, reloaded, wired, errs };
})();

// ── RESET undoes a stored layout, in place, and it survives a reload ─────
const reset = await (async () => {
  const page = await b.newPage({ viewport: { width: 430, height: 932 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL_, { waitUntil: 'load' });
  // Seed once the app has finished its own start-up saves, so the stale
  // layout is what the reload finds and not what a late save overwrote.
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    localStorage.setItem('motionmuse-workspace', JSON.stringify({ v: 1, nodes: {
      'panel:mic':     { x: 2000, y: 2000, parent: null },
      'panel:metronome': { x: 0, y: 0, hidden: true },
      'panel:camera':  { x: 100, y: 100, parent: null, folded: true, pinned: true, px: 10, py: 10 },
    } }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);

  const state = () => page.evaluate(async () => {
    const WS = await import('/src/ui/workspace.js');
    const n = id => WS.getNode(id);
    return {
      mic: n('panel:mic')?.parent ?? null,
      metroHidden: !!n('panel:metronome')?.hidden,
      camFolded: !!n('panel:camera')?.folded,
      camPinned: !!n('panel:camera')?.pinned,
      groups: WS.allNodes().filter(x => x.kind === 'group').map(x => x.id).sort().join(','),
      key: localStorage.getItem('motionmuse-workspace') !== null,
    };
  });

  const stale = await state();
  // Two taps: the second is the confirmation.
  await page.click('#settings-btn');
  await page.waitForTimeout(250);
  await page.click('#layout-reset-btn');
  await page.waitForTimeout(120);
  await page.click('#layout-reset-btn');
  await page.waitForTimeout(600);
  const after = await state();
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  const reloaded = await state();
  await page.close();
  return { stale, after, reloaded, errs };
})();

// The inference HUD is dev-only, and each of its rows belongs to a model that
// is actually running.
const hud = await (async () => {
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  const set = (o) => page.evaluate(async (o) => {
    const { cvSource }   = await import('/src/cv.js');
    const { faceSource } = await import('/src/face.js');
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

  // Every parameter's input socket sits on the node src/params.js names as
  // its owner, at every bank size — a third oscillator brings its sockets
  // with it, an emptied bank takes them away.
  const params = await page.evaluate(async () => {
    const { renderMapper } = await import('/src/ui/mapper-ui.js');
    const { engine } = await import('/src/engine.js');
    const { paramOwner } = await import('/src/params.js');
    const { arpvoice } = await import('/src/arpvoice.js');
    arpvoice.set({ enabled: true });          // its sliders show while it runs
    const rerender = async () => {
      (await import('/src/ui/audio-ui.js')).renderAudioPanel();
      renderMapper();
    };
    const owned = () => Object.keys(engine.PARAMS).filter(k => paramOwner(k)).map(k =>
      [k, paramOwner(k), !!document.querySelector(`[data-node="${paramOwner(k)}"] .port-in[data-key="${k}"]`)]);
    const orphans = () => Object.keys(engine.PARAMS).filter(k => !paramOwner(k));
    await rerender();
    const one = { owned: owned(), orphans: orphans() };
    engine.setOscCount(3);
    await rerender();
    const three = { owned: owned(), orphans: orphans() };
    engine.setOscCount(0);
    await rerender();
    const zero = {
      owned: owned(), orphans: orphans(),
      rows: document.querySelectorAll('.osc-row').length,
      minusDisabled: document.getElementById('osc-minus').disabled,
      field: document.getElementById('osc-count').value,
      oscParams: Object.keys(engine.PARAMS).filter(k => /^osc\d+_/.test(k)).length,
      oscSockets: [...document.querySelectorAll('.port-in')].filter(e => /^osc\d+_/.test(e.dataset.key)).length,
    };
    engine.setOscCount(1);
    await rerender();
    return { one, three, zero };
  });

  // Chord mode: the list is of CHORDS, each with one handshape.
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
    const live = await page.evaluate(() => ({
      dots: document.querySelectorAll('#chord-assigns .gesture-dot').length,
      rows: document.querySelectorAll('#chord-assigns .chord-assign').length,
      vol: !!document.getElementById('chord-vol-fill'),
      readout: !!document.getElementById('chord-readout'),
    }));
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

  // Share: the QR has to be a real code of a real link.
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
  const nodev = await read();
  await toggleDev(page);
  const dev = await read();
  await set({ handsL: false, handsR: false, pose: false, face: true });
  const faceOnly = await read();
  await set({ handsL: false, handsR: false, pose: true, face: false });
  const poseOnly = await read();
  await page.evaluate(async () => {
    const { cvSource } = await import('/src/cv.js');
    cvSource.setTracking({ hands: false, pose: true });
  });
  const viaToggle = await read();

  // The screens — the camera stage and the oscilloscope — follow the theme.
  const themes = await page.evaluate(async () => {
    const { THEMES, setTheme } = await import('/src/ui/theme.js');
    const { drawViz } = await import('/src/ui/viz.js');
    const lum = css => {
      const c = document.createElement('canvas').getContext('2d');
      c.fillStyle = css; c.fillRect(0, 0, 1, 1);
      const [r, g, bl] = c.getImageData(0, 0, 1, 1).data;
      return (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
    };
    const out = [];
    for (const t of THEMES) {
      setTheme(t.id, { persist: false });
      drawViz();
      const scope = document.getElementById('viz-canvas');
      const px = scope.getContext('2d').getImageData(2, 2, 1, 1).data;
      out.push({
        id: t.id,
        dark: t.dark,
        stage: lum(getComputedStyle(document.getElementById('video-wrap')).backgroundColor),
        scope: (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255,
        ink:   lum(getComputedStyle(document.documentElement).getPropertyValue('--glass-ink').trim()),
      });
    }
    setTheme('midnight', { persist: false });
    return out;
  });

  await page.close();
  return { nodev, dev, faceOnly, poseOnly, viaToggle, params, share, chords, themes, errs };
})();

// First run: the app asks what to play.
const firstrun = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() =>
    Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  await page.goto(URL_, { waitUntil: 'networkidle' });
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
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const again = await state();
  await ctx.close();

  const ctx2 = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx2.addInitScript(() =>
    Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const p2 = await ctx2.newPage();
  p2.on('pageerror', e => errs.push(String(e)));
  await p2.goto(URL_, { waitUntil: 'networkidle' });
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
  // …and a tone preset: its cables arrive as nodes on the canvas.
  const ctx3 = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx3.addInitScript(() =>
    Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const p3 = await ctx3.newPage();
  p3.on('pageerror', e => errs.push(String(e)));
  await p3.goto(URL_, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(600);
  await p3.click('.start-item[data-start="hands"]');
  await p3.waitForTimeout(600);
  const hands = await p3.evaluate(async () => {
    const { mapper } = await import('/src/mapper.js');
    const nodeOf = (side, key) =>
      document.querySelector(`.port-${side}[data-key="${key}"]`)?.closest('[data-node]')?.dataset.node ?? null;
    await new Promise(r => setTimeout(r, 100));   // the bank grew; the node redraws on the next tick
    return { cables: mapper.mappings.length,
             wires: document.querySelectorAll('.ng-wire').length,
             ends: mapper.mappings.map(m => `${nodeOf('out', m.signal)} → ${nodeOf('in', m.audioParam)}`),
             // The patch is voiced for two oscillators: the second's row and
             // sockets appear with it, and no cable is left dashed at an edge.
             oscRows: document.querySelectorAll('.osc-row').length,
             osc2Socket: !!document.querySelector('.port-in[data-key="osc2_freq"]'),
             dashed: document.querySelectorAll('.ng-wire-edge').length };
  });
  await ctx2.close(); await ctx3.close();
  return { shown, blank, again, chords, hands, errs };
})();

// ── Saved setups: the name on the camera view, renaming, and share ───────
const presets = await (async () => {
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  await page.evaluate(async () => {
    const { saveConfig } = await import('/src/saved.js');
    const { snapshot }   = await import('/src/preset.js');
    const bare = () => { const s = snapshot(); delete s.ui; return s; };
    saveConfig('evening pads', bare());
    saveConfig('bright lead', bare());
  });

  const openMenu = async () => {
    await page.evaluate(() => {
      if (document.getElementById('preset-pop')?.hidden !== false)
        document.getElementById('preset-btn').click();
    });
    await page.waitForTimeout(150);
  };
  const names = () => page.evaluate(() =>
    [...document.querySelectorAll('#preset-pop [data-config]')].map(e => e.dataset.config));
  const badge = () => page.evaluate(() => {
    const el = document.getElementById('cam-name');
    return { text: el.textContent, hidden: el.hidden };
  });

  await openMenu();
  const listed = await names();
  await page.click('#preset-pop [data-config="evening pads"]');
  await page.waitForTimeout(300);
  const applied = await badge();

  await openMenu();
  await page.click('#preset-pop [data-ren="evening pads"]');
  await page.fill('#preset-pop .preset-rename', 'midnight pads');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const renamed = { list: await names(), badge: await badge() };

  await openMenu();
  await page.click('#preset-pop [data-ren="midnight pads"]');
  await page.fill('#preset-pop .preset-rename', 'bright lead');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const collided = await names();

  await openMenu();
  await page.click('#preset-pop [data-ren="midnight pads"]');
  await page.fill('#preset-pop .preset-rename', 'gone');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const escaped = {
    list: await names(),
    open: await page.evaluate(() => document.getElementById('preset-pop').hidden === false),
  };

  await openMenu();
  await page.click('#preset-pop [data-preset="hands"]');
  await page.waitForTimeout(400);
  const afterPreset = await badge();

  await page.click('#share-btn');
  await page.waitForTimeout(700);
  const share = await page.evaluate(() => {
    const pop = document.getElementById('share-pop');
    const c = document.getElementById('share-qr');
    const p = pop.getBoundingClientRect(), q = c.getBoundingClientRect();
    return {
      open: pop.classList.contains('open'),
      pop: { w: Math.round(p.width), h: Math.round(p.height),
             left: Math.round(p.left), top: Math.round(p.top) },
      qr: { w: Math.round(q.width), h: Math.round(q.height) },
      vw: innerWidth, vh: innerHeight,
      labelW: Math.round(document.getElementById('share-label').getBoundingClientRect().width),
    };
  });
  const want = await page.evaluate(async () => {
    const { shareableSnapshot, encodeState, shareUrl } = await import('/src/share.js');
    return shareUrl(await encodeState(shareableSnapshot()));
  });
  const shot = await page.locator('#share-qr').screenshot();
  await page.addScriptTag({ path: join(ROOT, 'node_modules/jsqr/dist/jsQR.js') });
  const decoded = await page.evaluate(async b64 => {
    const bin = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    return { w: bmp.width, h: bmp.height,
             text: globalThis.jsQR(img.data, img.width, img.height)?.data ?? null };
  }, shot.toString('base64'));
  const noCamQr = await page.evaluate(() => !document.getElementById('cam-qr'));

  await page.close();
  return { listed, applied, renamed, collided, escaped, afterPreset,
           share, want, decoded, noCamQr, errs };
})();

// ── The controls on the picture are one system ───────────────────────────
const camctl = await (async () => {
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.body.classList.add('cam-on'));

  const read = () => page.evaluate(() => {
    const wrap = document.getElementById('video-wrap');
    const frame = wrap.getBoundingClientRect();
    const cs = getComputedStyle(wrap);
    const tok = n => parseFloat(cs.getPropertyValue(n));
    // Measured through the canvas zoom, which scales every length alike.
    const k = wrap.closest('.fake-fullscreen') ? 1
      : (() => { const t = getComputedStyle(document.getElementById('ws-world')).transform;
                 const m = /matrix\(([^,]+)/.exec(t); return m ? parseFloat(m[1]) : 1; })();
    const seg = el => {
      const r = el.getBoundingClientRect();
      return {
        id: el.id, w: Math.round(r.width / k), h: Math.round(r.height / k),
        border: parseFloat(getComputedStyle(el).borderTopWidth),
        labelled: el.textContent.trim().replace(/[^\w]/g, '').length > 0,
      };
    };
    const bar = sel => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      return {
        segs: [...el.children].filter(c => c.getClientRects().length).map(seg),
        gap: parseFloat(getComputedStyle(el).gap),
        radius: parseFloat(getComputedStyle(el).borderTopLeftRadius),
        inset: { left: Math.round((r.left - frame.left) / k), top: Math.round((r.top - frame.top) / k),
                 right: Math.round((frame.right - r.right) / k), bottom: Math.round((frame.bottom - r.bottom) / k) },
      };
    };
    return {
      ctrlH: tok('--cam-ctrl-h'), inset: tok('--cam-inset'), radius: tok('--cam-radius'),
      actions: bar('.cam-actions'), toggles: bar('.cam-toggles'),
      nameH: (() => {
        const n = document.getElementById('cam-name');
        n.hidden = false; n.textContent = 'x';
        const h = Math.round(n.getBoundingClientRect().height / k);
        n.hidden = true; n.textContent = '';
        return h;
      })(),
      emptyBadge: document.getElementById('cam-name').getClientRects().length,
    };
  });

  const small = await read();
  await page.evaluate(async () => (await import('/src/ui/fullscreen.js')).fullscreen.open());
  await page.waitForTimeout(150);
  const full = await read();

  await page.close();
  return { small, full, errs };
})();

// ── The camera view at its two sizes, and what sits on it ────────────────
const camView = await (async () => {
  const out = {};
  for (const [w, h, key] of [[390, 844, 'phone'], [1440, 900, 'desktop']]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    const ratio = await page.evaluate(() => {
      const r = document.getElementById('video-wrap').getBoundingClientRect();
      return r.width / r.height;
    });

    await page.evaluate(async () => (await import('/src/ui/fullscreen.js')).fullscreen.open());
    await page.waitForTimeout(300);
    const fs = await page.evaluate(() => {
      const r = document.getElementById('video-wrap').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height),
               left: Math.round(r.left), top: Math.round(r.top),
               vw: innerWidth, vh: innerHeight };
    });

    await page.evaluate(() => document.getElementById('fskbd-btn').click());
    await page.waitForTimeout(400);
    const kbd = await page.evaluate(() => {
      const box = el => { const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
      return {
        keys: box(document.getElementById('fs-kbd')),
        actions: box(document.querySelector('.cam-actions')),
        reserved: getComputedStyle(document.getElementById('video-wrap'))
                    .getPropertyValue('--fs-kbd-h').trim(),
      };
    });
    await page.evaluate(() => document.getElementById('fs-btn').click());
    await page.waitForTimeout(300);
    const afterExit = await page.evaluate(() =>
      getComputedStyle(document.getElementById('video-wrap'))
        .getPropertyValue('--fs-kbd-h').trim());

    out[key] = { ratio, fs, kbd, afterExit, errs };
    await ctx.close();
  }
  return out;
})();

// ── Coming back to a backgrounded tab ────────────────────────────────────
const camRestore = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  const out = await page.evaluate(async () => {
    const { cvSource } = await import('/src/cv.js');
    const track = state => ({ readyState: state, stop() {} });
    const stub = trackState => {
      const el = {
        paused: true, plays: 0,
        srcObject: trackState ? { getVideoTracks: () => [track(trackState)] } : null,
        play() { this.plays++; this.paused = false; return Promise.resolve(); },
      };
      cvSource.video = el;
      cvSource.running = true;
      return el;
    };
    let acquired = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      acquired++;
      return { getVideoTracks: () => [track('live')], getTracks: () => [track('live')] };
    };
    const paused = stub('live');
    await cvSource.restore();
    const livePaused = { plays: paused.plays, acquired };
    const ended = stub('ended');
    await cvSource.restore();
    const endedTrack = { acquired, replaced: !!ended.srcObject, plays: ended.plays };
    cvSource.running = false;
    const before = acquired;
    const idle = stub('live');
    cvSource.running = false;
    await cvSource.restore();
    const whenStopped = { acquired: acquired - before, plays: idle.plays };
    const wired = stub('live');
    cvSource.running = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 60));
    const viaEvent = wired.plays;
    cvSource.running = false;
    cvSource.video = null;
    return { livePaused, endedTrack, whenStopped, viaEvent };
  });
  await ctx.close();
  return { ...out, errs };
})();

// ── Pulling a node out of the patch ──────────────────────────────────────
// Deleting a cable takes the cable and nothing else: the sockets at both
// ends belong to their nodes and stay — and the input remembers the range it
// had, so wiring it up again picks up where it left off.
const patchDelete = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const board = () => page.evaluate(async () => {
    const { mapper } = await import('/src/mapper.js');
    return { cables: mapper.mappings.length, wires: document.querySelectorAll('.ng-wire').length,
             editor: !document.getElementById('ng-editor-pop').hidden };
  });
  const socket = async (side, key) => {
    // The signal's row is inside a tracker group folded while no camera
    // runs; open it, then take the socket that is drawn.
    await page.evaluate(([side, key]) => {
      const d = document.querySelector(`.sig-sec-body .port[data-side="${side}"][data-key="${key}"]`)?.closest('details');
      if (d && !d.open) d.open = true;
    }, [side, key]);
    await page.waitForTimeout(250);
    return page.evaluate(([side, key]) => {
      const el = [...document.querySelectorAll(`.port[data-side="${side}"][data-key="${key}"]`)].find(p => p.checkVisibility());
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, [side, key]);
  };

  const pair = await page.evaluate(async () => {
    const { mapper } = await import('/src/mapper.js');
    const { renderMapper } = await import('/src/ui/mapper-ui.js');
    mapper.applyPreset('hands');
    // Its range is what the input must remember.
    const m = mapper.mappings.find(x => x.audioParam === 'lfo_depth');
    m.outMin = 0.2; m.outMax = 0.7;
    renderMapper();
    return { signal: m.signal, param: m.audioParam, id: m.id };
  });
  await page.waitForTimeout(300);
  const start = await board();

  // Right-click the wired input: its cable's editor; × deletes the cable.
  const at = await socket('in', pair.param);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForTimeout(150);
  const opened = await page.evaluate(id => ({
    editor: !document.getElementById('ng-editor-pop').hidden,
    selected: document.querySelector('.ng-wire.selected')?.dataset.mid === String(id),
  }), pair.id);
  await page.click('#ng-editor-pop .ng-del');
  await page.waitForTimeout(200);
  const afterDel = await page.evaluate(async ([sig, par]) => {
    const { mapper } = await import('/src/mapper.js');
    return { cables: mapper.mappings.length, wires: document.querySelectorAll('.ng-wire').length,
             editor: !document.getElementById('ng-editor-pop').hidden,
             stillWired: mapper.mappings.some(m => m.audioParam === par),
             sigSocket: !!document.querySelector(`.port-out[data-key="${sig}"]`),
             parSocket: !!document.querySelector(`.port-in[data-key="${par}"]`) };
  }, [pair.signal, pair.param]);

  // Wire the same pair again, by tapping: the range comes back.
  await page.waitForTimeout(250);
  const from = await socket('out', pair.signal), to = await socket('in', pair.param);
  await page.mouse.click(from.x, from.y);
  await page.waitForTimeout(80);
  await page.mouse.click(to.x, to.y);
  await page.waitForTimeout(200);
  const rewired = await page.evaluate(async par => {
    const { mapper } = await import('/src/mapper.js');
    const m = mapper.mappings.find(x => x.audioParam === par);
    return m ? { signal: m.signal, outMin: m.outMin, outMax: m.outMax } : null;
  }, pair.param);

  await ctx.close();
  return { start, pair, opened, afterDel, rewired, errs };
})();

// ── The keyboard overlay, and which hand names a chord ───────────────────
const camKeys = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(350);

  const reserved = () => page.evaluate(() =>
    getComputedStyle(document.getElementById('video-wrap'))
      .getPropertyValue('--fs-kbd-h').trim());
  const keys = async () => {
    await page.evaluate(() => document.getElementById('fskbd-btn').click());
    await page.waitForTimeout(350);
  };
  const geom = () => page.evaluate(() => {
    const c = document.getElementById('fs-kbd');
    const w = document.getElementById('video-wrap');
    const a = document.querySelector('.cam-actions');
    const cr = c.getBoundingClientRect(), wr = w.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    return {
      visible: getComputedStyle(c).display !== 'none' && cr.height > 0,
      insideFrame: Math.round(cr.bottom) <= Math.round(wr.bottom) + 1,
      clearsActions: Math.round(ar.bottom) <= Math.round(cr.top),
    };
  });

  const btnVisible = await page.evaluate(() => {
    const e = document.getElementById('fskbd-btn');
    return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  });
  await keys();
  const on = { ...(await geom()), reserved: await reserved() };
  await keys();
  const off = await reserved();

  await keys();
  await page.evaluate(async () => (await import('/src/ui/fullscreen.js')).fullscreen.open());
  await page.waitForTimeout(400);
  const fs = await reserved();
  await page.evaluate(() => document.getElementById('fs-btn').click());
  await page.waitForTimeout(400);
  const back = await reserved();

  const named = await page.evaluate(async () => {
    const { chordmode } = await import('/src/chordmode.js');
    const { renderAudioPanel } = await import('/src/ui/audio-ui.js');
    const read = () => {
      const el = document.getElementById('ck-name-hand');
      return el ? { value: el.value, disabled: el.disabled } : null;
    };
    chordmode.setEnabled(true);
    chordmode.setExpression({ mode: 'gesture' });
    renderAudioPanel();
    const free = read();
    const el = document.getElementById('ck-name-hand');
    el.value = 'R';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const applied = chordmode.getNamingHand();
    chordmode.setExpression({ mode: 'hand', hand: 'L' });
    renderAudioPanel();
    const derived = read();
    chordmode.setExpression({ mode: 'gesture' });
    chordmode.setNamingHand('any');
    renderAudioPanel();
    return { free, applied, derived };
  });

  await ctx.close();
  return { btnVisible, on, off, fs, back, named, errs };
})();

// ── Calibrating from where a gesture is CHOSEN, and gestures that are not
// handshapes ──
const gestureCfg = {};
for (const [key, vp] of [['desktop', { width: 1440, height: 900 }],
                         ['phone',   { width: 320,  height: 780 }]]) {
  const ctx = await b.newContext({ viewport: vp });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('dialog', d => d.accept('Renamed Palm'));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(350);

  const m = await page.evaluate(async () => {
    const { chordmode } = await import('/src/chordmode.js');
    const { gesture, KINDS } = await import('/src/gesture.js');
    const { cvSource } = await import('/src/cv.js');
    const { renderAudioPanel } = await import('/src/ui/audio-ui.js');
    const WS = await import('/src/ui/workspace.js');
    chordmode.setEnabled(true);
    chordmode.setDegreeGesture(0, 'palm');
    renderAudioPanel();
    // The node is on a zoomed canvas: bring it to 1:1 so the measurements
    // below are in the units the stylesheet declares.
    WS.fitAll(['panel:gesture-mode']);
    await new Promise(r => setTimeout(r, 400));

    const rows = [...document.querySelectorAll('.chord-assign')].map(r => ({
      degree: r.dataset.degree,
      gid: r.querySelector('.ch-cal')?.dataset.gid ?? null,
      disabled: r.querySelector('.ch-cal')?.disabled ?? null,
    }));
    chordmode.setDegreeGesture(0, null);
    renderAudioPanel();
    const emptyRow = (() => {
      const b = document.querySelector('.chord-assign[data-degree="0"] .ch-cal');
      return { present: !!b, disabled: !!b?.disabled, gid: b?.dataset.gid ?? null };
    })();
    chordmode.setDegreeGesture(0, 'palm');
    renderAudioPanel();

    const lib = document.getElementById('gesture-lib');
    lib.open = false;
    const statusEl = document.getElementById('chord-cal-status');
    const statusInFold = lib.contains(statusEl);
    const statusHiddenWhenIdle = getComputedStyle(statusEl).display === 'none';

    let asked = null;
    const realRecal = gesture.recalibrate.bind(gesture);
    gesture.recalibrate = (id, done) => { asked = id; done({ id, name: 'x' }); };
    Object.defineProperty(cvSource, 'running', { value: true, configurable: true });
    document.querySelector('.chord-assign[data-degree="0"] .ch-cal').click();
    await new Promise(r => setTimeout(r, 3200));
    gesture.recalibrate = realRecal;
    const statusText = statusEl.textContent;

    const wasNamed = gesture.list().find(g => g.id === 'palm').name;
    lib.open = true;
    document.querySelector('.gesture-ren[data-gid="palm"]').click();
    await new Promise(r => setTimeout(r, 150));
    const { bus } = await import('/src/bus.js');
    const renamed = {
      was: wasNamed,
      now: gesture.list().find(g => g.id === 'palm').name,
      signal: bus.signals.get('gesture_palm')?.label,
      row: document.querySelector('.gesture-row[data-gid="palm"] .gesture-name')?.textContent,
    };
    gesture.resetNames();
    renderAudioPanel();

    chordmode.setVoicing('note');
    chordmode.setExpression({ mode: 'gesture' });
    chordmode.setAccidentalGestures({ sharp: 'point', flat: 'peace' });
    renderAudioPanel();
    const accFree = ['ck-acc-sharp', 'ck-acc-flat'].map(id => {
      const b = document.getElementById(id)?.parentElement.querySelector('.ch-cal');
      return { gid: b?.dataset.gid ?? null, disabled: b?.disabled ?? null };
    });
    chordmode.setExpression({ mode: 'hand', hand: 'L' });
    renderAudioPanel();
    const accBusy = ['ck-acc-sharp', 'ck-acc-flat'].map(id =>
      document.getElementById(id)?.parentElement.querySelector('.ch-cal')?.disabled ?? null);
    chordmode.setExpression({ mode: 'gesture' });
    chordmode.setVoicing('chord');
    renderAudioPanel();

    const kindFolds = await (async () => {
      lib.open = true;
      const sel = document.getElementById('record-kind');
      sel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      return !lib.open;
    })();

    const k = WS.viewTransform().k;
    const title = document.querySelector('.gesture-lib-title');
    const rec = document.querySelector('.gesture-rec-add');
    const kindSel = document.getElementById('record-kind');
    const line = el => Math.round(el.getBoundingClientRect().height / k);
    return {
      rows, emptyRow, statusInFold, statusHiddenWhenIdle, asked, statusText, renamed,
      kindFolds, accFree, accBusy,
      heading: title?.textContent.trim(),
      titleH: line(title), oneLine: line(title),
      recH: line(rec), kindH: line(kindSel),
      kinds: [...kindSel.querySelectorAll('option')].map(o => o.value),
      declared: Object.keys(KINDS),
      overflows: document.querySelector('.gesture-lib-summary').scrollWidth
               > document.querySelector('.gesture-lib-summary').clientWidth + 1,
    };
  });
  gestureCfg[key] = { ...m, errs };
  await ctx.close();
}

// ── The live value on the cables and the function nodes ──
const ngBars = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(350);

  const m = await page.evaluate(async () => {
    const { mapper } = await import('/src/mapper.js');
    const { bus } = await import('/src/bus.js');
    const { graph, paramKeyOf } = await import('/src/graph.js');
    const { renderMapper, updateMapperBars, addFnNode } = await import('/src/ui/mapper-ui.js');
    mapper.applyPreset('hands');
    // A Mix node fed the same signal on both sides passes it through, so
    // its level bar should read what the signal reads.
    const mix = addFnNode('mix');
    const mi = +mix.slice(3);
    mapper.add(paramKeyOf(mi, 'a'), 'hand_L_open', 0, 1, 'linear', 0, false);
    mapper.add(paramKeyOf(mi, 'b'), 'hand_L_open', 0, 1, 'linear', 0, false);
    renderMapper();
    await new Promise(r => requestAnimationFrame(r));

    const wireOf = key => document.querySelector(`.ng-wire[data-mid="${mapper.mappings.find(x => x.audioParam === key).id}"]`);
    const width = key => parseFloat(wireOf(key).style.strokeWidth);
    const levelEl = document.querySelector(`[data-node="${mix}"] .ng-level`);
    const lvl = () => parseFloat(levelEl?.style.getPropertyValue('--lvl') ?? 'NaN');
    const settle = (key, target) => {
      for (let i = 0; i < 400; i++) bus.update(key, target);
      for (let i = 0; i < 5; i++) { mapper.tick(); graph.tick(i / 60); }
      updateMapperBars();
    };

    // A linear 0..1 cable delivers the signal's own level, so its width
    // (2px + 3px × level) is a readout of it.
    const cable = mapper.mappings.find(x => x.audioParam === 'osc2_volume');
    const sig = bus.signals.get(cable.signal);
    const at = f => sig.min + (sig.max - sig.min) * f;
    const socketY = () => [...document.querySelectorAll('#ws .port')].map(el => Math.round(el.getBoundingClientRect().top));
    settle(cable.signal, at(0));
    const yEmpty = socketY();
    settle(cable.signal, at(1));
    const yFull = socketY();
    const socketsMoved = yEmpty.some((v, i) => v !== yFull[i]);

    const tracks = [];
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      settle(cable.signal, at(f));
      tracks.push({ f, w: width('osc2_volume'), norm: +bus.norm(cable.signal).toFixed(3) });
    }
    const was = cable.invert;
    cable.invert = false; settle(cable.signal, at(0.8));
    const straight = width('osc2_volume');
    cable.invert = true;  settle(cable.signal, at(0.8));
    const flipped = width('osc2_volume');
    cable.invert = was;

    const msig = bus.signals.get('hand_L_open');
    const mat = f => msig.min + (msig.max - msig.min) * f;
    const levels = [];
    for (const f of [0, 0.5, 1]) {
      settle('hand_L_open', mat(f));
      levels.push({ f, lvl: lvl(), norm: +bus.norm('hand_L_open').toFixed(3) });
    }

    // A cable into the bank's own socket sizes the bank; one into a mode's
    // switch turns the mode on and off. Both redraw their node on the next
    // tick, so each settle waits one.
    const { engine } = await import('/src/engine.js');
    const { chordmode } = await import('/src/chordmode.js');
    const tick = () => new Promise(r => setTimeout(r, 80));
    const wiresNow = () => document.querySelectorAll('.ng-wire').length;
    const before = wiresNow();
    const cnt = mapper.add('osc_count', 'hand_R_y', 0, 3, 'linear', 4, false);
    const csig = bus.signals.get('hand_R_y');
    const cat = f => csig.min + (csig.max - csig.min) * f;
    settle('hand_R_y', cat(1)); await tick();
    const grown = { count: engine.getOscCount(), rows: document.querySelectorAll('.osc-row').length,
                    sock3: !!document.querySelector('.port-in[data-key="osc3_freq"]') };
    settle('hand_R_y', cat(0)); await tick();
    const emptied = { count: engine.getOscCount(), rows: document.querySelectorAll('.osc-row').length,
                      kept: mapper.mappings.filter(m => !engine.PARAMS[m.audioParam]).length,
                      drawn: wiresNow(), before: before + 1 };
    settle('hand_R_y', cat(1)); await tick();
    const back = { count: engine.getOscCount(), drawn: wiresNow() };
    mapper.remove(cnt);
    const sw = mapper.add('chord_on', 'hand_L_y', 0, 1, 'linear', 2, false);
    const ssig = bus.signals.get('hand_L_y');
    const sat = f => ssig.min + (ssig.max - ssig.min) * f;
    settle('hand_L_y', sat(1)); await tick();
    const on = { enabled: chordmode.enabled, pill: document.getElementById('chord-toggle')?.textContent.trim() };
    settle('hand_L_y', sat(0)); await tick();
    const off = { enabled: chordmode.enabled, pill: document.getElementById('chord-toggle')?.textContent.trim() };
    mapper.remove(sw);

    return { socketsMoved, tracks, straight, flipped, levels, grown, emptied, back, on, off,
             hasLevel: !!levelEl, positioned: levelEl ? getComputedStyle(levelEl).position : null };
  });

  await ctx.close();
  return { ...m, errs };
})();

// ── The keyboard overlay under the arpeggiator ──
const arpKbd = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 1024, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(350);

  const m = await page.evaluate(async () => {
    const { chordmode } = await import('/src/chordmode.js');
    const { arpvoice } = await import('/src/arpvoice.js');
    const { updateFsOverlay } = await import('/src/ui/fullscreen.js');
    chordmode.setEnabled(true);
    document.getElementById('fskbd-btn').click();
    await new Promise(r => setTimeout(r, 250));

    const shot = () => {
      const c = document.getElementById('fs-kbd');
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.join(',');
    };
    const ink = () => {
      const c = document.getElementById('fs-kbd');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i + 1] - d[i];
        if (v > 4) sum += v;
      }
      return Math.round(sum / 1000);
    };
    const redraw = async () => {
      updateFsOverlay();
      await new Promise(r => requestAnimationFrame(r));
      updateFsOverlay();
    };

    const CHORD = [261.63, 329.63, 392.0];
    Object.defineProperty(arpvoice, 'enabled', { get: () => true, configurable: true });

    arpvoice.voices = () => [];
    await redraw();
    const baseline = ink();
    arpvoice.voices = () => [{ freq: CHORD[0], level: 1 }];
    await redraw();
    const oneNote = ink();
    const oneShot = shot();
    arpvoice.voices = () => CHORD.map(f => ({ freq: f, level: 1 }));
    await redraw();
    const wholeChord = ink();
    arpvoice.voices = () => [{ freq: CHORD[0], level: 0.35 }];
    await redraw();
    const faded = ink();
    const fadedShot = shot();
    arpvoice.voices = () => [];
    await redraw();
    const silent = ink();

    return { baseline, oneNote, wholeChord, faded, silent,
             fadeChangedPicture: fadedShot !== oneShot };
  });

  await ctx.close();
  return { ...m, errs };
})();

await b.close(); server.close();

let fail = 0;
const check = (ok, label, detail = '') => {
  if (!ok) fail++;
  console.log(`  [${ok ? ' PASS ' : ' FAIL '}]  ${label}${detail !== '' ? '  — ' + detail : ''}`);
};

console.log('\nHeader and workspace — every breakpoint, camera off and on\n');

for (const { width, off, on, nodes: n, sigPanel, nums, errs } of results) {
  const w = `${width}px`;
  check(errs.length === 0, `${w}: no page errors`, errs.join(' | '));

  // ── Adoption ──
  check(n.panels >= 17, `${w}: every section is a node`, `${n.panels} panel nodes: ${n.ids.join(' ')}`);
  check(n.staged.length === 0, `${w}: nothing is left behind in the staging area`, n.staged.join(' '));
  check(n.dupes.length === 0, `${w}: no node exists twice`, n.dupes.join(' '));
  check(n.missingHead.length === 0, `${w}: every node has a header to drag it by`, n.missingHead.join(' '));
  check(n.missingBody.length === 0, `${w}: every panel node has a body`, n.missingBody.join(' '));
  check(n.missingGrip.length === 0, `${w}: every panel node has a resize grip`, n.missingGrip.join(' '));
  check(n.unnamed === 0, `${w}: every panel node carries its section id and node id`, String(n.unnamed));

  // ── Placement ──
  check(n.unplaced.length === 0, `${w}: every node has been placed`, n.unplaced.join(' '));
  check(n.overlaps.length === 0, `${w}: no two nodes sit on top of each other`, n.overlaps.join(' '));
  check(n.outsideFrame.length === 0, `${w}: every member sits inside its group's frame`, n.outsideFrame.join(' '));
  check(n.groups.join(',') === 'group:audio,group:inputs',
    `${w}: the shipped groups exist — INPUTS, AUDIO ENGINE`, n.groups.join(','));
  check(n.view.k >= 0.15 && n.view.k <= 1, `${w}: the first view is fitted to the layout`, `k=${n.view.k.toFixed(2)}`);
  if (width < 769) {
    // A phone opens on the camera at a usable size, not on a smear of the
    // whole canvas: the picture spans most of the screen.
    check(n.camOnScreen.w >= Math.min(width * 0.6, 440) && n.camOnScreen.left >= -1 && n.camOnScreen.right <= width + 1,
      `${w} phone: the camera is on screen at a usable size`,
      `${n.camOnScreen.w}px wide at ${n.camOnScreen.left}..${n.camOnScreen.right}`);
  }
  check(n.pans.length === 0, `${w}: nothing pans sideways inside a node`, n.pans.join(' | '));
  check(n.sizedNotScrolling.length === 0,
    `${w}: a node given a height scrolls rather than clipping`, n.sizedNotScrolling.join(' '));

  // ── Chrome ──
  check(n.folds.length === 0, `${w}: every fold button reports its state`, n.folds.join(' '));
  check(n.foldsAfterToggle === '', `${w}: and still reports it after folding and reopening`, n.foldsAfterToggle);
  const hStyles = Object.keys(n.headerStyles);
  check(hStyles.length <= 1, `${w}: every section header renders identically`,
    hStyles.map(k => `${k} → ${n.headerStyles[k].join(',')}`).join(' | '));
  check(n.textSizeAdjust === '100%', `${w}: text auto-inflation is off`, String(n.textSizeAdjust));
  const pl = n.playable;
  check(!pl.dev, `${w}: measured outside dev mode`);
  check(pl.gestureMode, `${w}: gesture mode needs no DEV`);
  check(pl.lib, `${w}: and its handshape library is reachable inside it`);
  check(pl.badges === 0, `${w}: and carries no under-construction badge`, String(pl.badges));
  check(!pl.models, `${w}: while MODELS is still dev-only`);
  const v = n.viz;
  check(v.exists && v.hasCanvas, `${w}: the oscilloscope lives in the OUTPUT node`);
  check(!v.inRebuiltPanel, `${w}: which sits outside the panel that rebuilds itself`);
  check(v.foldable && v.pinnable, `${w}: it folds and pins like every node`);
  if (n.caret) {
    check(n.caret.content === '""' || n.caret.content === 'none',
      `${w}: the caret is drawn, not a font glyph`, n.caret.content);
    check(n.caret.border >= 1.5 && n.caret.w >= 6, `${w}: the caret has a visible stroke`,
      `${n.caret.border}px stroke, ${n.caret.w}px box`);
    check(n.caret.target >= 18, `${w}: the caret's hit target is large enough`, `${n.caret.target}px`);
  }
  check(n.trackers.inBody && n.trackers.within,
    `${w}: the tracker toggles are inside the Camera Input node`,
    `inBody=${n.trackers.inBody} withinBox=${n.trackers.within}`);

  // ── Signals panel: two channels per measure, one ruler ──
  const sp = sigPanel;
  check(sp.rows > 60, `${w}: the signals panel lists its signals`, `${sp.rows} rows`);
  check(sp.multi > 40, `${w}: most measures carry a velocity channel`, `${sp.multi} of ${sp.rows}`);
  check(sp.barWidths.length === 1, `${w}: every signal bar is the same length`, sp.barWidths.join(' / '));
  check(sp.zeroWidth === 0, `${w}: no bar is squeezed to nothing`, String(sp.zeroWidth));
  check(sp.chans.join(',') === 'displacement,velocity',
    `${w}: a two-channel measure names both channels`, sp.chans.join(','));
  check(sp.keys && sp.keys.vel === `${sp.keys.base}_vel`,
    `${w}: clicking the velocity channel copies the velocity key`, sp.keys?.vel);
  check(sp.keys && sp.keys.disp === sp.keys.base && sp.keys.name === sp.keys.base,
    `${w}: the displacement channel and the measure's name copy the measure`,
    `${sp.keys?.disp} / ${sp.keys?.name}`);
  const miscount = sp.counts.filter(([, said, rows]) => said !== rows);
  check(miscount.length === 0, `${w}: group headings count measures, not channels`,
    sp.counts.map(([g, said, rows, ch]) => `${g} says ${said}, ${rows} rows / ${ch} channels`).join(' | '));
  check(sp.counts.some(([, , rows, ch]) => ch > rows),
    `${w}: and at least one group carries more channels than measures`);
  check(!sp.pans, `${w}: the signals panel does not pan sideways`);
  check(sp.srcs === sp.vals && sp.srcs > 0,
    `${w}: every channel of the camera's list is an output socket`, `${sp.srcs} sockets for ${sp.vals} channels`);
  check(sp.onEdge.outs > 0 && sp.onEdge.offOut === 0,
    `${w}: every output socket is centred on the camera node's right border`, `${sp.onEdge.offOut} of ${sp.onEdge.outs} off the edge`);
  check(sp.onEdge.ins > 0 && sp.onEdge.offIn.length === 0,
    `${w}: every slider's input socket is centred on its node's left border`, sp.onEdge.offIn.join(' '));

  check(nums.ranges > 0, `${w}: there are sliders to check`, String(nums.ranges));
  check(nums.paired === nums.ranges, `${w}: every slider takes a typed value`, nums.missing.join(' '));
  check(nums.typed === 5000, `${w}: a typed value reaches the parameter exactly`, `filter_freq = ${nums.typed}`);
  check(nums.overflow === 0, `${w}: the typed fields do not overflow their nodes`, `${nums.overflow} node(s)`);
  check(nums.unsocketed.length === 0, `${w}: every parameter's input socket sits on the node that owns it`, nums.unsocketed.join(' '));

  check(off.escapees.length === 0, `${w} camera off: every control inside the header`, off.escapees.join(' '));
  check(on.escapees.length === 0,  `${w} camera on:  every control inside the header`, on.escapees.join(' '));
  check(!off.hOverflow && !on.hOverflow, `${w}: no horizontal overflow`);
  check(off.face !== null && off.gaze !== null, `${w}: FACE/GAZE present with the camera off`);
  check(on.face !== null && on.gaze !== null,   `${w}: FACE/GAZE present with the camera on`);
  check(Math.abs(on.mainTop - on.header.bottom) < 1.5,
    `${w}: the canvas starts where the header ends`,
    `header.bottom ${Math.round(on.header.bottom)} vs main.top ${Math.round(on.mainTop)}`);
  check(Math.abs(on.header.height - off.header.height) < 0.5,
    `${w}: the header holds its height when the camera starts`,
    `${Math.round(off.header.height)} → ${Math.round(on.header.height)}`);
  if (off.video) {
    const ratio = off.video.w / off.video.h;
    check(Math.abs(ratio - 4 / 3) < 0.02, `${w}: the camera box holds 4:3 (overlay alignment)`, ratio.toFixed(3));
  }
}

// ── Gestures ──
console.log('\nWorkspace gestures\n');
{
  const g = gestures;
  check(g.errs.length === 0, 'no page errors', g.errs.join(' | '));
  const near = (a, b, tol = 9) => Math.abs(a - b) <= tol;   // an 8px grid snap either way
  check(near(g.drag.dx, g.drag.wantX) && near(g.drag.dy, g.drag.wantY),
    'dragging a header moves the node by the drag divided by the zoom',
    `moved ${g.drag.dx.toFixed(0)},${g.drag.dy.toFixed(0)} for ${g.drag.wantX.toFixed(0)},${g.drag.wantY.toFixed(0)} at k=${g.drag.k.toFixed(2)}`);
  check(g.drag.parent === 'group:inputs', 'and it stays in its group while inside the frame', String(g.drag.parent));
  check(g.left.parent === null, 'dragged out of the frame, it leaves the group', String(g.left.parent));
  check(g.rejoined.parent === 'group:inputs', 'dropped back in, it rejoins', String(g.rejoined.parent));

  check(g.wired.signal === 'hand_L_z', 'dragging a camera output ● to a parameter input ● wires a cable', String(g.wired.signal));
  check(g.wired.editor, 'and opens the cable editor');
  check(g.wired.onVolume === 1 && g.wired.cables === 7, 'one cable per input — the old one is replaced',
    `${g.wired.onVolume} on volume, ${g.wired.cables} cables`);
  check(g.folded.strip.includes('hand_L_z') && g.folded.startsOnRing && g.folded.endsOnRing && !g.folded.dashed,
    'folding the group keeps the wired output in its summary, and the cable ends ring to ring', JSON.stringify(g.folded));
  check(g.armed, 'tapping a socket arms it');
  check(g.tapped.signal === 'hand_R_z' && g.tapped.armedLeft === 0,
    'and tapping the other end completes the connection', `${g.tapped.signal}, ${g.tapped.armedLeft} left armed`);

  check(g.grouped.made, 'Ctrl+G groups the selection');
  check(g.grouped.parent === null, 'at the level the selection was on — the top', String(g.grouped.parent));
  check(g.grouped.members.join(',') === g.grouped.wantMembers.join(','), 'with exactly those members', g.grouped.members.join(','));
  check(g.grouped.hidden, 'collapsing it hides the members');
  check(g.grouped.ports.join(',') === g.grouped.want.join(','),
    'and only the sockets whose cables cross the frame appear on the group', g.grouped.ports.join(','));
  check(g.grouped.cablesBefore === 9 && g.grouped.cablesAfter === 8,
    'the cable between the members goes with them; every other one still draws, to the group',
    `${g.grouped.cablesBefore} → ${g.grouped.cablesAfter}`);
  check(g.grouped.nested.cables === 8 && g.grouped.nested.outerPorts.join() === g.grouped.want.join()
     && !g.grouped.nested.innerShown,
    'a group inside a collapsed group goes with it, and the outer one shows the same crossing sockets',
    JSON.stringify(g.grouped.nested));
  check(g.grouped.after.gone && g.grouped.after.parent === null && g.grouped.after.cables === 9,
    'ungrouping frees the members back to the top level with their cables', JSON.stringify(g.grouped.after));

  check(g.pinned.dock === 'ws-dock' && g.pinned.stayed, 'a pinned node holds its screen position while the view pans');
  check(g.pinned.back === 'ws-nodes' && g.pinned.pressed === 'false', 'and unpinning puts it back on the canvas');

  check(g.menu.open && g.menu.focused, 'right-clicking the canvas opens the add menu, search focused');
  check(g.menu.secs.includes('Function') && !g.menu.secs.some(s => /^(Signal|Parameter) ·/.test(s)),
    'listing the function nodes — signals and parameters live on their nodes, not in the menu', g.menu.secs.join(' | '));
  check(g.filtered.length >= 1 && g.filtered.every(l => /sample/i.test(l)), 'typing filters it', g.filtered.join(' | '));
  check(g.added.fn.length === 1 && g.added.types.includes('hold') && g.added.menuClosed,
    'Enter adds the first match — a function node with a graph node behind it', JSON.stringify(g.added));
  check(g.added.ports === 3, 'with its sockets on it (in, gate, out)', `${g.added.ports}`);
  check(g.added.selected.join() === g.added.fn.join(), 'and selected');
  check(g.deleted.fn === 0 && g.deleted.graph === 0, 'Delete removes it, graph node and all', JSON.stringify(g.deleted));

  check(g.closed.hidden && g.closed.listed, 'a closed panel is hidden and offered under Panels in the menu');
  check(g.closed.shown && g.closed.near && g.closed.parent === null,
    'and comes back where the menu was opened', JSON.stringify(g.closed));

  check(g.tidy.count >= 2 && g.tidy.overlaps === 0, 'TIDY leaves nothing overlapping', `${g.tidy.count} nodes, ${g.tidy.overlaps} overlaps`);
  check(g.tidy.inView, 'and fits the result in view');

  check(g.zoomed.after > g.zoomed.before, 'the wheel zooms over empty canvas', `${g.zoomed.before.toFixed(2)} → ${g.zoomed.after.toFixed(2)}`);
  check(g.zoomed.scrollable && g.zoomed.held === g.zoomed.fitted && g.zoomed.scrolled > 0,
    'and scrolls a list that scrolls instead of zooming', `k held ${g.zoomed.held === g.zoomed.fitted}, scrolled ${g.zoomed.scrolled}px`);

  check(g.fs.parent === 'BODY' && g.fs.w === g.fs.vw && g.fs.h === g.fs.vh && g.fs.left === 0 && g.fs.top === 0,
    'the CSS fullscreen lifts the picture out of the canvas and fills the screen', JSON.stringify(g.fs));
  check(g.fs.back, 'and puts it back into the camera node on exit');

  check(g.grown.before.ordered && g.grown.after.ordered && g.grown.after.pq >= g.grown.before.pq + 150,
    'a node that grows after placement pushes the auto-placed nodes below it down',
    `pitch-quantize y ${g.grown.before.pq} → ${g.grown.after.pq}`);
  check(g.grown.hand.y === g.grown.hand.held && g.grown.hand.pq > g.grown.after.pq,
    'while a node placed by hand stays where it was put',
    `volume-quantize held at ${g.grown.hand.held} (now ${g.grown.hand.y})`);

  check(g.saved.present && g.saved.nodes >= 20 && g.saved.hasCamera && g.saved.hasView,
    'the layout persists as one key with every node and the view', JSON.stringify(g.saved));
}

// ── Persistence ──
console.log('\nA moved node stays moved\n');
{
  const { fresh, rerendered, reloaded, wired, errs } = persist;
  const stages = [['on load', fresh], ['after renderAudioPanel()', rerendered], ['after reload', reloaded]];
  for (const [label, st] of stages) {
    check(st.gestures === 'null@1400,900', `${label}: GESTURE MODE is where it was left, out of its group`, String(st.gestures));
    check(st.kit === 'group:inputs@40,700', `${label}: SOUND KIT is in the INPUTS group where it was dropped`, String(st.kit));
    check(st.micFolded, `${label}: the microphone stays folded`);
    check(st.dupes.length === 0, `${label}: no duplicated nodes`, st.dupes.join(' '));
    check(st.apr > 0, `${label}: parameter sliders exist`, String(st.apr));
    check(st.audioMembers >= 10, `${label}: the rest of the engine is still in its group`, String(st.audioMembers));
  }
  check(wired, 'a relocated node\'s sliders still drive the engine');
  check(errs.length === 0, 'no page errors while placing nodes', errs.join(' | '));
}

console.log('\nLayout reset\n');
{
  check(reset.errs.length === 0, 'reset: no page errors', reset.errs.join(' | '));
  check(reset.stale.mic === null && reset.stale.metroHidden && reset.stale.camFolded && reset.stale.camPinned,
    'reset: a stale layout really does scatter, hide, fold and pin', JSON.stringify(reset.stale));
  check(reset.after.mic === 'group:inputs', 'reset: RESET puts the microphone back in INPUTS', String(reset.after.mic));
  check(!reset.after.metroHidden && !reset.after.camFolded && !reset.after.camPinned,
    'reset: and reopens, unfolds and unpins');
  check(reset.after.groups === 'group:audio,group:inputs', 'reset: the shipped groups are back', reset.after.groups);
  check(reset.reloaded.mic === 'group:inputs' && !reset.reloaded.metroHidden && !reset.reloaded.camPinned,
    'reset: and it survives a reload', JSON.stringify(reset.reloaded));
}

console.log('\nInference HUD\n');
{
  const { nodev, dev, faceOnly, poseOnly, viaToggle, errs } = hud;
  check(nodev.bar === 'none', 'the HUD is hidden outside DEV, camera or not', nodev.bar);
  check(dev.bar !== 'none', 'the HUD appears in DEV with the camera running', dev.bar);
  check(dev.hand && dev.pose && dev.face && dev.total && dev.model,
    'every row shows when every model is running', JSON.stringify(dev));
  check(!faceOnly.hand && !faceOnly.pose, 'HAND/POSE are absent when only the face is tracked', JSON.stringify(faceOnly));
  check(faceOnly.face, 'FACE is shown when the face is tracked');
  check(!faceOnly.total, 'TOTAL (the hand/pose loop) goes with them');
  check(!faceOnly.model, 'MODEL names the pose backend, so it goes with POSE');
  check(poseOnly.pose && poseOnly.model && poseOnly.total && !poseOnly.hand && !poseOnly.face,
    'pose alone shows POSE/MODEL/TOTAL and nothing else', JSON.stringify(poseOnly));
  check(!viaToggle.hand && viaToggle.pose, 'the tracking toggles drive the rows, not only the internal sync', JSON.stringify(viaToggle));
  check(errs.length === 0, 'no page errors while driving the HUD', errs.join(' | '));
}

console.log('\nFirst run\n');
{
  const { shown, blank, again, chords, hands, errs } = firstrun;
  check(shown.open, 'a fresh visit is asked how to play');
  check(shown.onTop >= 200, 'the picker is above every node and popover', String(shown.onTop));
  check(shown.choices.includes('chords') && shown.choices.includes('blank'),
    'gesture mode and blank are among the choices', shown.choices.join(','));
  check(shown.choices.length >= 7, 'every mapping preset is offered too', `${shown.choices.length}`);
  check(blank.modal === false, 'choosing dismisses it');
  check(blank.cables === 0 && blank.oscs === 0, 'blank leaves nothing wired and no oscillator', `${blank.cables} cables, ${blank.oscs} osc`);
  check(!blank.hands && !blank.pose, 'blank leaves the trackers off');
  check(again.modal === false, 'a returning visit is not asked again');
  check(chords.chord, 'gesture mode is switched on');
  check(!chords.dev, 'without needing DEV — gesture mode is not an experiment');
  check(chords.oscs === 0, 'with no lead oscillator droning under the chords', `${chords.oscs}`);
  check(chords.hands && !chords.pose, 'hands tracked, pose not');
  check(hands.cables === 7 && hands.wires === 7,
    'the Hands patch arrives as seven cables, every one drawn', JSON.stringify(hands));
  check(hands.ends.every(e => e.startsWith('panel:camera → panel:')),
    'each from an output socket on the camera node to an input socket on the node that owns the parameter',
    hands.ends.join(' | '));
  check(hands.oscRows === 2 && hands.osc2Socket && hands.dashed === 0,
    'the second oscillator the patch is voiced for appears with its sockets, so no cable ends dashed at an edge',
    `${hands.oscRows} rows, osc2 socket ${hands.osc2Socket}, ${hands.dashed} dashed`);
  check(errs.length === 0, 'no page errors on the first-run path', errs.join(' | '));
}

console.log('\nChord mode\n');
{
  const { initial, after, taken, state } = hud.chords;
  check(initial.length === 8, 'seven chords in the key, plus RELEASE', `${initial.length} rows`);
  check(initial.every(r => r.hasSelect), 'every row picks a handshape');
  check(initial.some(r => r.d === 'release'), 'the release is one of the rows');
  check(/^I\b/.test(initial[0]?.label ?? ''), 'rows are labelled by degree', initial[0]?.label);
  check(!!taken, 'the tonic starts with a handshape on it', String(taken));
  check(after.find(r => r.d === 'release')?.handshape === taken, 'the release took the shape', after.find(r => r.d === 'release')?.handshape);
  check(after.find(r => r.d === '0')?.handshape === '', 'and it left the chord it was playing', after.find(r => r.d === '0')?.handshape);
  check(!state.releaseHasChord, 'the release shape holds no chord');
  check(new Set(state.degrees).size === state.degrees.length, 'no chord is claimed by two handshapes', state.degrees.join(','));
  check(new Set(state.ids).size === state.ids.length, 'no handshape claims two chords', state.ids.join(','));
}

console.log('\nChord live state\n');
{
  const l = hud.chords.live;
  check(l.dots === l.rows, 'every chord row has an indicator', `${l.dots} dots / ${l.rows} rows`);
  check(l.vol, 'the chord volume is shown');
  check(l.readout, 'and which chord is sounding');
}

console.log('\nChord expression\n');
{
  const [byHandshape, byHand, byBrow] = hud.chords.expr;
  check(byHandshape.mode === 'gesture' && byHandshape.handOff && byHandshape.ctlOff,
    'handshape mode: the hand and control pickers do not apply', JSON.stringify(byHandshape));
  check(!byHandshape.meter, 'and there is no range to calibrate');
  check(byHand.mode === 'hand' && !byHand.handOff && !byHand.ctlOff, 'two-handed mode: both pickers live', JSON.stringify(byHand));
  check(byHand.meter, 'and a live meter to calibrate the range against');
  check(byBrow.mode === 'brow' && byBrow.handOff && !byBrow.ctlOff, 'eyebrow mode: no hand to choose, but still a control', JSON.stringify(byBrow));
  check(byBrow.hi < byHand.hi && byBrow.lo < byHand.lo, "eyebrows get their own range, not the hand's",
    `hand ${byHand.lo}..${byHand.hi} vs brow ${byBrow.lo}..${byBrow.hi}`);
  check(byHand.lo > 0.3, 'the hand range starts above a closed fist', String(byHand.lo));
  check(byHand.deadzone > 0, 'and the bottom of the travel rounds down to silence');
  check(byBrow.relOff === true && byHandshape.relOff === false, 'RELEASE applies to handshape mode only',
    `gesture ${byHandshape.relOff}, brow ${byBrow.relOff}`);
}

console.log('\nShare\n');
{
  const s = hud.share;
  check(s.open, 'the SHARE popover opens');
  check(!s.hidden && s.w > 200, 'a QR code was drawn', `${s.w}x${s.h}`);
  check(s.w === s.h, 'the code is square', `${s.w}x${s.h}`);
  check(!s.warn, 'the default setup fits comfortably in a scannable code', s.note);
  check(s.darkFraction > 0.2 && s.darkFraction < 0.7, 'the code is a pattern, not a blank or filled square',
    `${(s.darkFraction * 100).toFixed(0)}% dark`);
}

console.log('\nParameter sockets\n');
{
  const { one, three, zero } = hud.params;
  for (const [label, st] of [['1 oscillator', one], ['3 oscillators', three], ['no oscillator', zero]]) {
    const missing = st.owned.filter(([, , ok]) => !ok);
    check(st.owned.length > 0 && missing.length === 0,
      `${label}: every parameter's input socket sits on the node that owns it`,
      missing.map(([k, o]) => `${k} → ${o}`).join(' '));
    check(st.orphans.length === 0, `${label}: and every parameter has an owner`, st.orphans.join(' '));
  }
  check(three.owned.some(([k]) => k === 'osc3_freq'), 'a third oscillator brings its own sockets');
  check(zero.oscParams === 0 && zero.rows === 0 && zero.oscSockets === 0,
    'the bank can be emptied for gesture-mode-only play, sockets and all',
    `${zero.oscParams} params, ${zero.rows} rows, ${zero.oscSockets} sockets`);
  check(zero.minusDisabled && zero.field === '0', 'the stepper bottoms out at zero', `disabled=${zero.minusDisabled} field=${zero.field}`);
}

console.log('\nGlass (camera stage + oscilloscope)\n');
for (const t of hud.themes) {
  const want = t.dark ? 'dark' : 'light';
  check(t.dark ? t.stage < 0.1 : t.stage > 0.7, `${t.id}: the camera stage is ${want}`, `luminance ${t.stage.toFixed(3)}`);
  check(t.dark ? t.scope < 0.1 : t.scope > 0.7, `${t.id}: the oscilloscope paints on ${want} glass`, `luminance ${t.scope.toFixed(3)}`);
  check(t.dark ? t.ink > 0.7 : t.ink < 0.3, `${t.id}: the overlay's neutral ink opposes the stage`, `luminance ${t.ink.toFixed(3)}`);
}

console.log('\nSaved setups\n');
{
  const p = presets;
  check(p.errs.length === 0, 'no page errors', p.errs.join(' | '));
  check(p.listed.join('|') === 'bright lead|evening pads', 'your setups are listed, newest first', p.listed.join('|'));
  check(p.renamed.list.join('|') === 'bright lead|midnight pads', 'a rename does not reorder the list — renaming is not saving', p.renamed.list.join('|'));
  check(p.applied.text === 'evening pads' && !p.applied.hidden, 'loading a setup names the camera view', `“${p.applied.text}” hidden=${p.applied.hidden}`);
  check(p.renamed.list.includes('midnight pads') && !p.renamed.list.includes('evening pads'),
    'renaming replaces the name rather than adding a second row', p.renamed.list.join('|'));
  check(p.renamed.badge.text === 'midnight pads', 'the camera view follows the rename', `“${p.renamed.badge.text}”`);
  check(p.collided.length === 2 && p.collided.includes('midnight pads') && p.collided.includes('bright lead'),
    'renaming onto a name in use is refused, and neither setup is lost', p.collided.join('|'));
  check(p.escaped.list.includes('midnight pads') && !p.escaped.list.includes('gone'), 'Escape abandons the edit', p.escaped.list.join('|'));
  check(p.escaped.open, 'Escape closes the field, not the menu behind it');
  check(p.afterPreset.hidden && p.afterPreset.text === '', 'a built-in patch clears the name — it is not one of yours',
    `“${p.afterPreset.text}” hidden=${p.afterPreset.hidden}`);
  const sh = p.share;
  check(p.noCamQr, 'the setup is no longer drawn onto the camera view');
  check(sh.open, 'SHARE opens');
  check(sh.pop.w === sh.vw && sh.pop.h === sh.vh && sh.pop.left === 0 && sh.pop.top === 0, 'and takes the whole screen',
    `${sh.pop.w}x${sh.pop.h} at ${sh.pop.left},${sh.pop.top} in ${sh.vw}x${sh.vh}`);
  check(sh.qr.w === sh.qr.h, 'the code is square', `${sh.qr.w}x${sh.qr.h}`);
  check(sh.qr.w > 300, 'and is bigger than the card that used to hold it', `${sh.qr.w}px`);
  check(sh.qr.w <= sh.vw && sh.qr.h <= sh.vh, 'while still fitting on the screen', `${sh.qr.w}px in ${sh.vw}x${sh.vh}`);
  check(sh.labelW < sh.vw, 'the rest of the sheet keeps a readable measure', `name field ${sh.labelW}px of ${sh.vw}px`);
  check(p.decoded.text === p.want, 'and a screenshot of it decodes back to this setup’s link',
    p.decoded.text === null ? `no code found in ${p.decoded.w}x${p.decoded.h}px`
      : `${p.decoded.text.length} chars, ${p.decoded.text === p.want ? 'match' : 'MISMATCH'}`);
}

console.log('\nCamera-view controls\n');
{
  check(camctl.errs.length === 0, 'no page errors', camctl.errs.join(' | '));
  for (const [view, m] of [['windowed', camctl.small], ['fullscreen', camctl.full]]) {
    const segs = [...m.actions.segs, ...m.toggles.segs];
    check(segs.length >= 6, `${view}: both strips have their controls`, `${segs.length} segments`);
    const heights = [...new Set(segs.map(s => s.h))];
    check(heights.length === 1 && heights[0] === m.ctrlH, `${view}: every control is exactly one height`,
      `${heights.join('/')} against --cam-ctrl-h ${m.ctrlH}`);
    check(m.nameH === m.ctrlH, `${view}: the name caption shares it, so the top edge is one line`, `${m.nameH} vs ${m.ctrlH}`);
    const icons = segs.filter(s => !s.labelled);
    check(icons.length >= 3 && icons.every(s => s.w === m.ctrlH), `${view}: a control with no label is a square`,
      icons.map(s => `${s.id} ${s.w}x${s.h}`).join(' '));
    check(segs.filter(s => s.labelled).every(s => s.w > m.ctrlH), `${view}: a labelled one grows sideways only`);
    const stacked = [...new Set(m.toggles.segs.map(s => s.w))];
    check(stacked.length === 1, `${view}: the stacked strip has one width`, stacked.join('/'));
    check(segs.every(s => s.border === 0), `${view}: segments carry no border of their own`,
      segs.filter(s => s.border !== 0).map(s => s.id).join(' '));
    check(m.actions.gap === 1 && m.toggles.gap === 1, `${view}: dividers are hairlines`, `${m.actions.gap} / ${m.toggles.gap}`);
    check(m.actions.radius === m.radius && m.toggles.radius === m.radius, `${view}: one corner radius`,
      `${m.actions.radius} / ${m.toggles.radius} vs ${m.radius}`);
    check(m.actions.inset.left === m.inset && m.actions.inset.bottom === m.inset
       && m.toggles.inset.right === m.inset && m.toggles.inset.top === m.inset,
      `${view}: both strips sit at the shared inset`, `${JSON.stringify(m.actions.inset)} ${JSON.stringify(m.toggles.inset)}`);
    check(m.emptyBadge === 0, `${view}: an unnamed setup leaves no empty badge on the picture`);
  }
  check(camctl.full.ctrlH > camctl.small.ctrlH && camctl.full.inset > camctl.small.inset,
    'fullscreen scales the system rather than replacing it',
    `${camctl.small.ctrlH}px→${camctl.full.ctrlH}px, inset ${camctl.small.inset}→${camctl.full.inset}`);
}

console.log('\nCamera view — fullscreen and the keyboard\n');
for (const [label, m] of Object.entries(camView)) {
  check(m.errs.length === 0, `${label}: no page errors`, m.errs.join(' | '));
  check(Math.abs(m.ratio - 4 / 3) < 0.02, `${label}: the camera box holds 4:3`, m.ratio.toFixed(3));
  check(m.fs.w === m.fs.vw && m.fs.h === m.fs.vh && m.fs.left === 0 && m.fs.top === 0, `${label}: fullscreen fills the screen`,
    `${m.fs.w}x${m.fs.h} at ${m.fs.left},${m.fs.top} in ${m.fs.vw}x${m.fs.vh}`);
  check(m.kbd.actions.bottom <= m.kbd.keys.top, `${label}: the controls sit above the keyboard, not on it`,
    `actions end ${m.kbd.actions.bottom}, keys start ${m.kbd.keys.top}`);
  check(parseFloat(m.kbd.reserved) > 0, `${label}: and the space they clear is the keyboard's own height`, m.kbd.reserved);
  check(parseFloat(m.afterExit) > 0 && parseFloat(m.afterExit) < parseFloat(m.kbd.reserved),
    `${label}: leaving fullscreen resizes that space rather than keeping it`, `${m.kbd.reserved} → ${m.afterExit || '(unset)'}`);
}

console.log('\nCamera restore after losing focus\n');
{
  const m = camRestore;
  check(m.errs.length === 0, 'no page errors', m.errs.join(' | '));
  check(m.livePaused.plays === 1, 'a paused element is played again — that is the black frame', `play() called ${m.livePaused.plays}×`);
  check(m.livePaused.acquired === 0, 'and a live track is reused rather than the camera being taken again', `${m.livePaused.acquired} getUserMedia calls`);
  check(m.endedTrack.acquired === 1 && m.endedTrack.replaced, 'an ENDED track is replaced',
    `${m.endedTrack.acquired} getUserMedia calls, stream replaced=${m.endedTrack.replaced}`);
  check(m.endedTrack.plays === 1, 'and the new stream is played');
  check(m.whenStopped.acquired === 0 && m.whenStopped.plays === 0, 'with no camera running it does nothing',
    `${m.whenStopped.acquired} getUserMedia, ${m.whenStopped.plays} play()`);
  check(m.viaEvent === 1, 'and a real visibilitychange drives it, not just a direct call', `play() called ${m.viaEvent}×`);
}

console.log('\nCable deletion\n');
{
  const p = patchDelete;
  check(p.errs.length === 0, 'no page errors', p.errs.join(' | '));
  check(p.start.cables === 7 && p.start.wires === 7, 'the default patch has cables to work on', JSON.stringify(p.start));
  check(p.opened.editor && p.opened.selected, 'right-clicking a wired input opens its cable in the editor', JSON.stringify(p.opened));
  check(p.afterDel.cables === p.start.cables - 1 && p.afterDel.wires === p.start.wires - 1 && !p.afterDel.stillWired,
    'the editor\u2019s × deletes exactly that cable', JSON.stringify(p.afterDel));
  check(!p.afterDel.editor, 'and closes the editor with it');
  check(p.afterDel.sigSocket && p.afterDel.parSocket, 'both sockets stay on their nodes to be re-wired');
  check(p.rewired?.signal === p.pair.signal, 'tapping the two sockets wires the pair again', JSON.stringify(p.rewired));
  check(p.rewired?.outMin === 0.2 && p.rewired?.outMax === 0.7, 'and the input remembers the range it had', JSON.stringify(p.rewired));
}

console.log('\nKeyboard overlay and the naming hand\n');
{
  const m = camKeys;
  check(m.errs.length === 0, 'no page errors', m.errs.join(' | '));
  check(m.btnVisible, '🎹 KEYS is reachable without going fullscreen first');
  check(m.on.visible, 'and it shows the keyboard in the windowed view');
  check(m.on.insideFrame, 'inside the frame, not hanging off the bottom');
  check(m.on.clearsActions, 'with the controls riding above it, as in fullscreen');
  check(parseFloat(m.on.reserved) > 0, 'the space it takes is reserved', m.on.reserved);
  check(parseFloat(m.off) === 0, 'and given back when the keyboard is switched off', m.off);
  check(parseFloat(m.fs) > parseFloat(m.on.reserved), 'fullscreen still gets its own, larger keyboard', `${m.on.reserved} → ${m.fs}`);
  check(m.back === m.on.reserved, 'and the windowed size comes back on the way out', `${m.fs} → ${m.back}`);
  check(m.named.free?.value === 'any' && m.named.free?.disabled === false, 'NAMED BY offers a choice, defaulting to EITHER',
    JSON.stringify(m.named.free));
  check(m.named.applied === 'R', 'and choosing a hand reaches chord mode', m.named.applied);
  check(m.named.derived?.disabled === true && m.named.derived?.value === 'R',
    'in hand-expression mode it shows the hand PLAY WITH already decided', JSON.stringify(m.named.derived));
}

console.log('\nGesture configurations — calibrating in place, and non-hand kinds\n');
for (const [label, m] of Object.entries(gestureCfg)) {
  check(m.errs.length === 0, `${label}: no page errors`, m.errs.join(' | '));
  check(m.rows.length === 8, `${label}: seven degrees and RELEASE`, `${m.rows.length} rows`);
  check(m.rows.every(r => r.gid !== null), `${label}: every row that names a chord can calibrate what names it`,
    JSON.stringify(m.rows.filter(r => r.gid === null)));
  check(m.rows.every(r => r.disabled === false), `${label}: and they are live wherever a gesture is assigned`,
    JSON.stringify(m.rows.filter(r => r.disabled)));
  check(m.emptyRow.present && m.emptyRow.disabled, `${label}: an unassigned row offers nothing to calibrate`, JSON.stringify(m.emptyRow));
  check(m.statusInFold === false, `${label}: it reports outside the library, which may well be shut`);
  check(m.statusHiddenWhenIdle, `${label}: and takes no room while nothing is calibrating`);
  check(m.asked === 'palm', `${label}: the button calibrates ITS OWN row's gesture`, m.asked);
  check(/Open Palm/.test(m.statusText) && /✓/.test(m.statusText), `${label}: naming the gesture and saying when it is done`, m.statusText);
  check(m.renamed.now === 'Renamed Palm' && m.renamed.was !== m.renamed.now, `${label}: a gesture can be renamed`, JSON.stringify(m.renamed));
  check(m.renamed.signal === 'ASL 5 · Renamed Palm', `${label}: the gloss survives it, and the signal label follows`, m.renamed.signal);
  check(m.renamed.row === '5 · Renamed Palm', `${label}: and so does the row`, m.renamed.row);
  check(m.heading === 'GESTURE CONFIGURATIONS', `${label}: the library is no longer only handshapes`, m.heading);
  check(m.kinds.join() === 'hand,face,body' && m.kinds.join() === m.declared.join(),
    `${label}: REC offers every kind the recogniser actually has`, `${m.kinds.join()} vs ${m.declared.join()}`);
  check(m.titleH <= 20, `${label}: the heading stays on one line`, `${m.titleH}px`);
  check(m.recH <= m.kindH + 4, `${label}: REC stays beside the picker that says what it will record`, `rec ${m.recH}px vs picker ${m.kindH}px`);
  check(!m.overflows, `${label}: and the heading does not run out of the node`);
  check(!m.kindFolds, `${label}: choosing a kind does not fold the library it sits in`);
  check(m.accFree.every(a => a.gid && a.disabled === false), `${label}: the accidental pickers calibrate their own gesture too`, JSON.stringify(m.accFree));
  check(m.accBusy.every(d => d === true), `${label}: and stand down with the picker when the other hand is busy`, JSON.stringify(m.accBusy));
}

console.log('\nLive values on the cables and the function nodes\n');
{
  const m = ngBars;
  check(m.errs.length === 0, 'no page errors', m.errs.join(' | '));
  const near = (a, b, tol = 0.1) => Math.abs(a - b) <= tol;
  check(m.tracks.every(t => near(t.w, 2 + 3 * t.norm)), 'a cable\u2019s width follows the value it delivers', JSON.stringify(m.tracks));
  check(near(m.tracks[0].norm, 0, 0.02) && near(m.tracks.at(-1).norm, 1, 0.02), 'across the signal\u2019s full travel', JSON.stringify(m.tracks));
  check(near(m.straight + m.flipped, 7), 'INVERT mirrors it', `${m.straight} + ${m.flipped}`);
  check(!m.socketsMoved, 'and driving a value from empty to full moves no socket, so no cable moves');
  check(m.hasLevel && m.positioned === 'absolute', 'a function node carries a level bar, out of flow so it cannot resize the node', String(m.positioned));
  check(m.levels.every(l => near(l.lvl, l.norm, 0.05)), 'reading what the node puts out', JSON.stringify(m.levels));
  check(m.grown.count === 3 && m.grown.rows === 3 && m.grown.sock3,
    'a cable into the OSCILLATORS socket grows the bank — rows and sockets with it', JSON.stringify(m.grown));
  check(m.emptied.count === 0 && m.emptied.rows === 0 && m.emptied.kept === 3 && m.emptied.drawn === m.emptied.before - 3,
    'and shrinks it: cables to the slots that went are kept in the patch but not drawn', JSON.stringify(m.emptied));
  check(m.back.count === 3 && m.back.drawn === m.emptied.before,
    'and they are drawn again when the slots come back', JSON.stringify(m.back));
  check(m.on.enabled && m.on.pill === 'ON' && !m.off.enabled && m.off.pill === 'OFF',
    'a cable into GESTURE MODE\u2019s switch turns it on and off, and its pill follows', JSON.stringify({ on: m.on, off: m.off }));
}

console.log('\nKeyboard overlay while the arpeggiator runs\n');
{
  const m = arpKbd;
  check(m.errs.length === 0, 'no page errors', m.errs.join(' | '));
  check(m.oneNote > m.baseline, 'a struck note lights the keyboard', `${m.oneNote} vs empty ${m.baseline}`);
  check(m.wholeChord > m.oneNote * 1.5, 'and one note is visibly less than the whole chord', `${m.oneNote} vs ${m.wholeChord} ink`);
  check(m.faded < m.oneNote && m.faded > m.baseline, 'a note part-way through its release is dimmer than a struck one, and still lit',
    `${m.faded} vs struck ${m.oneNote}, empty ${m.baseline}`);
  check(m.fadeChangedPicture, 'so the level reaches the canvas rather than being rounded to on/off');
  check(m.silent === m.baseline, 'and a note that has faded out leaves the keyboard exactly as it found it', `${m.silent} vs empty ${m.baseline}`);
}

console.log(`\n${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
