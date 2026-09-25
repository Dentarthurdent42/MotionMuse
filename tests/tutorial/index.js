// Node docs guard. There is no guided tour any more: every node explains
// itself in a short card behind its own `?` (src/ui/nodedocs.js), and each `?`
// shows whether it has been read. This boots the real app and checks what
// can silently rot:
//
//   • coverage — every node on the canvas, in every state, has a doc, and no
//     doc is written for a panel that no longer exists;
//   • read state — unread `?`s are marked, the one about how you are playing
//     pulses, opening a card marks it read, and that survives a reload;
//   • the card — it opens beside its button, fits a phone screen, and goes
//     away by ×, Escape, a tap elsewhere or the same `?` again;
//   • nothing opens by itself — not on a first visit, not after picking how
//     to play.
//
// Run:  npm run test:tutorial   (needs a Chromium; no network, no API keys)

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
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

let fail = 0;
const check = (ok, label, detail = '') => {
  if (!ok) fail++;
  console.log(`  [${ok ? ' PASS ' : ' FAIL '}]  ${label}${detail !== '' ? '  — ' + detail : ''}`);
};

const cardState = page => page.evaluate(() => {
  const p = document.getElementById('doc-pop');
  if (!p) return { exists: false, shown: false };
  const r = p.getBoundingClientRect();
  return {
    exists: true, shown: !p.hidden,
    title: p.querySelector('.doc-pop-title')?.textContent ?? '',
    doc: p.dataset.doc ?? '',
    rect: { l: r.left, t: r.top, r: r.right, b: r.bottom },
    vw: innerWidth, vh: innerHeight,
  };
});
const helpClass = (page, id) => page.evaluate(i =>
  document.querySelector(`[data-doc-for="${i}"]`)?.className ?? null, id);

// ── Coverage: every node, in every state, has a doc ─────────────────────
console.log('\nEvery node explains itself\n');
{
  const page = await b.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  // DEV brings out the panels that are under construction; a function node,
  // a shader node and a new group are the kinds the app does not ship.
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await page.waitForTimeout(100);
  await page.evaluate(() => document.getElementById('dev-btn').click());
  await page.waitForTimeout(100);
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await page.evaluate(async () => {
    const { graph } = await import('/src/graph.js');
    const { renderMapper } = await import('/src/ui/mapper-ui.js');
    graph.add('math'); graph.add('lfo');
    renderMapper();
    const { addShaderNode } = await import('/src/ui/shadernode-ui.js');
    addShaderNode('noise'); addShaderNode('palette');
  });
  await page.waitForTimeout(500);

  const r = await page.evaluate(async () => {
    const { PANEL_DOCS, docFor } = await import('/src/ui/nodedocs.js');
    const nodes = [...document.querySelectorAll('#ws .node[data-node]')];
    const missing = nodes.filter(n => !n.querySelector(':scope > .node-head [data-doc-for]'))
      .map(n => n.dataset.node);
    const noDoc = nodes.map(n => n.dataset.node).filter(id => !docFor(id));
    const kinds = [...new Set(nodes.map(n => n.dataset.node.split(':')[0]))];
    const panels = new Set(nodes.filter(n => n.dataset.node.startsWith('panel:')).map(n => n.dataset.node.slice(6)));
    const stale = Object.keys(PANEL_DOCS).filter(k => !panels.has(k));
    const thin = Object.entries(PANEL_DOCS).filter(([, d]) => !d.title || !d.body || d.body.replace(/<[^>]+>/g, '').trim().length < 60)
      .map(([k]) => k);
    const fnA = docFor(nodes.find(n => n.dataset.node.startsWith('fn:'))?.dataset.node);
    const shxA = docFor(nodes.find(n => n.dataset.node.startsWith('shx:'))?.dataset.node);
    return { count: nodes.length, missing, noDoc, kinds, stale, thin,
             fnTitle: fnA?.title ?? null, shxTitle: shxA?.title ?? null };
  });
  check(r.count >= 20, 'the canvas is populated', `${r.count} nodes`);
  check(r.missing.length === 0, 'every node on the canvas has a ? in its header', r.missing.join(', '));
  check(r.noDoc.length === 0, 'and every one of them has a doc behind it', r.noDoc.join(', '));
  check(['panel', 'group', 'fn', 'shx'].every(k => r.kinds.includes(k)),
    'panels, groups, function nodes and shader nodes are all covered', r.kinds.join(', '));
  check(r.stale.length === 0, 'no doc is written for a panel that is gone', r.stale.join(', '));
  check(r.thin.length === 0, 'every panel doc says something', r.thin.join(', '));
  check((r.fnTitle ?? '').startsWith('ƒ ') && (r.shxTitle ?? '').startsWith('▨ '),
    'a function node and a shader node get their own type’s doc', `${r.fnTitle} / ${r.shxTitle}`);
  check(errs.length === 0, 'coverage: no page errors', errs.join(' | '));
  await page.close();
}

// ── Nothing opens by itself ──────────────────────────────────────────────
console.log('\nNothing opens by itself\n');
{
  // A real first visit: the start picker shows, which headless runs skip.
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const onLoad = await cardState(page);
  const picker = await page.evaluate(() => !document.getElementById('start-pop')?.hidden);
  await page.evaluate(() => document.querySelector('#start-pop [data-start]')?.click());
  await page.waitForTimeout(700);
  const afterPick = await cardState(page);
  check(picker, 'a first visit is asked how to play');
  check(!onLoad.shown, 'no help card opens on a first visit');
  check(!afterPick.shown, 'nor after picking how to play');
  check(errs.length === 0, 'first visit: no page errors', errs.join(' | '));
  await ctx.close();
}

// ── Read state ───────────────────────────────────────────────────────────
console.log('\nRead or not, at a glance\n');
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const before = {
    cam: await helpClass(page, 'panel:camera'),
    osc: await helpClass(page, 'panel:oscillators'),
    gm:  await helpClass(page, 'panel:gesture-mode'),
    app: await page.evaluate(() => document.getElementById('tour-btn').className),
  };
  const pulsing = await page.evaluate(() =>
    [...document.querySelectorAll('.sec-help.help-now')].map(b => b.dataset.docFor));
  check(/help-unread/.test(before.osc), 'an unread ? carries the unread mark', before.osc);
  check(/help-now/.test(before.cam), 'in Tone Mode, Camera Input’s ? is the one that pulses', before.cam);
  check(pulsing.length <= 2, 'and pulsing is kept to one or two buttons, not every one', pulsing.join(', '));
  check(!/help-now/.test(before.gm), 'Gesture Mode’s does not pulse while it is off', before.gm);
  check(/tour-unread|tour-new/.test(before.app), 'the header ? is marked unread too', before.app);

  // Switching Gesture Mode on moves the pulse to it.
  await page.evaluate(() => document.getElementById('chord-toggle')?.click());
  await page.waitForTimeout(300);
  const gmOn = await helpClass(page, 'panel:gesture-mode');
  check(/help-now/.test(gmOn), 'with Gesture Mode on, its ? pulses', gmOn);
  await page.evaluate(() => document.getElementById('chord-toggle')?.click());
  await page.waitForTimeout(200);

  // Opening a card is reading it.
  await page.locator('[data-doc-for="panel:oscillators"]').click();
  await page.waitForTimeout(250);
  const open = await cardState(page);
  const osc = await helpClass(page, 'panel:oscillators');
  check(open.shown && open.title === 'Oscillators', 'the ? opens its node’s card', JSON.stringify(open.title));
  check(!/help-unread|help-now/.test(osc), 'and that ? now reads as read', osc);
  const exp = await page.evaluate(() => document.querySelector('[data-doc-for="panel:oscillators"]').getAttribute('aria-expanded'));
  check(exp === 'true', 'the button says its card is open', String(exp));

  // Read state is per kind: one Math node read is every Math node read.
  await page.keyboard.press('Escape');
  const mathIds = await page.evaluate(async () => {
    const { graph } = await import('/src/graph.js');
    const { renderMapper } = await import('/src/ui/mapper-ui.js');
    const a = graph.add('math'), c = graph.add('math');
    renderMapper();
    return [`fn:${a}`, `fn:${c}`];
  });
  await page.waitForTimeout(300);
  await page.evaluate(id => document.querySelector(`[data-doc-for="${id}"]`).click(), mathIds[0]);
  await page.waitForTimeout(200);
  const other = await helpClass(page, mathIds[1]);
  check(other !== null && !/help-unread/.test(other), 'reading one Math node reads them all', String(other));
  await page.keyboard.press('Escape');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const kept = await helpClass(page, 'panel:oscillators');
  check(kept !== null && !/help-unread/.test(kept), 'read survives a reload', String(kept));
  check(errs.length === 0, 'read state: no page errors', errs.join(' | '));
  await ctx.close();
}

// Someone who read panels in the old tour has read them.
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('motionmuse-docs'))
      localStorage.setItem('motionmuse-tour', JSON.stringify({ done: true, seen: ['sec-metronome', 'sec-oscillators'] }));
  });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const metro = await helpClass(page, 'panel:metronome');
  const filt = await helpClass(page, 'panel:filter');
  check(metro !== null && !/help-unread/.test(metro), 'a panel read in the old tour stays read', String(metro));
  check(/help-unread/.test(filt ?? ''), 'and one it never showed is still unread', String(filt));
  await ctx.close();
}

// ── The card itself ──────────────────────────────────────────────────────
for (const [w, h, touch] of [[1440, 950, false], [390, 844, true]]) {
  console.log(`\nThe card at ${w}px\n`);
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  const btn = page.locator('[data-doc-for="panel:camera"]').first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await page.waitForTimeout(250);
  const c = await cardState(page);
  const inside = c.rect.l >= 0 && c.rect.t >= 0 && c.rect.r <= c.vw && c.rect.b <= c.vh;
  check(c.shown && c.title === 'Camera Input', `${w}px: the ? opens the card`, c.title);
  check(inside, `${w}px: the card is entirely on screen`, JSON.stringify(c.rect));
  const bb = await btn.boundingBox();
  const near = bb && Math.abs((c.rect.t + c.rect.b) / 2 - (bb.y + bb.height / 2)) < h;
  check(near, `${w}px: beside its button`);

  // The × — measured as a target, since on a phone it is how the card goes.
  const x = await page.evaluate(() => {
    const e = document.querySelector('.doc-pop-close');
    const r = e.getBoundingClientRect();
    const hit = parseFloat(getComputedStyle(e, '::before').width) || 0;
    return { w: r.width, hit, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  check(x.hit >= 44 || x.w >= 44, `${w}px: the × is a thumb-sized target`, `${x.hit}px`);
  if (touch) await page.touchscreen.tap(x.cx + 14, x.cy + 14);   // off-centre, as a thumb lands
  else await page.mouse.click(x.cx, x.cy);
  await page.waitForTimeout(200);
  check(!(await cardState(page)).shown, `${w}px: × closes it`);

  await btn.click(); await page.waitForTimeout(200);
  await btn.click(); await page.waitForTimeout(200);
  check(!(await cardState(page)).shown, `${w}px: the same ? closes it again`);

  await btn.click(); await page.waitForTimeout(200);
  if (!touch) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  else { await page.touchscreen.tap(Math.round(w / 2), h - 140); await page.waitForTimeout(200); }
  check(!(await cardState(page)).shown, `${w}px: ${touch ? 'a tap elsewhere' : 'Escape'} closes it`);

  await page.locator('#tour-btn').click();
  await page.waitForTimeout(200);
  const app = await cardState(page);
  check(app.shown && app.doc === 'app', `${w}px: the header ? opens how the app works`, app.title);
  const appCls = await page.evaluate(() => document.getElementById('tour-btn').className);
  check(!/tour-unread|tour-new/.test(appCls), `${w}px: and is then read`, appCls);
  check(!(await page.evaluate(() => !!document.getElementById('tour-backdrop'))),
    `${w}px: no scrim or spotlight is left in the page`);
  check(errs.length === 0, `${w}px: no page errors`, errs.join(' | '));
  await ctx.close();
}

await b.close(); server.close();
console.log(`\n${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
