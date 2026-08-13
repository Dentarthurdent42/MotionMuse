// Tutorial staleness guard. The guided tour is data (src/ui/tutorial.js
// TOUR_STEPS); the UI it points at changes often. This test boots the real
// app, puts it in every state the steps declare they need, and FAILS if any
// step's target no longer resolves to visible UI — so a redesign that orphans
// a tutorial step turns CI red instead of shipping a tour that points at
// nothing. It then drives the tour end-to-end through the real engine.
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
const port = server.address().port;

const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const p = await b.newPage();
const pageErrors = [];
p.on('pageerror', e => pageErrors.push(String(e)));
await p.setViewportSize({ width: 1440, height: 950 });
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });

// Put the app in every state a step can declare via `needs`. Playwright
// clicks count as user gestures, so this genuinely resumes the audio context
// (the engine itself now starts with the page, muted).
await p.click('#dev-btn');        // 'dev'
await p.click('#audio-btn');      // 'audio' — builds the audio panel sections
await p.waitForTimeout(400);
await p.click('#chord-toggle');   // 'chord'
await p.waitForTimeout(200);

const r = await p.evaluate(async () => {
  const { TOUR_STEPS, tour, unseenSteps } = await import('/src/ui/tutorial.js');
  const out = { stale: [], dupIds: [], visited: [], total: TOUR_STEPS.length };

  // ── Data integrity ──
  const ids = TOUR_STEPS.map(s => s.id);
  out.dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  out.badShape = TOUR_STEPS.filter(s => !s.id || !s.title || !s.body).map(s => s.id ?? '(missing id)');

  // ── The core guard: every target must resolve to visible UI ──
  for (const s of TOUR_STEPS) {
    if (!s.target) continue;
    const el = document.querySelector(s.target);
    if (!el || el.getClientRects().length === 0) {
      out.stale.push(`${s.id} → ${s.target}${el ? ' (present but hidden)' : ' (not found)'}`);
    }
  }

  // ── Drive the real engine through every step ──
  out.freshBefore = unseenSteps().length;
  tour.start();
  for (let guard = 0; guard < TOUR_STEPS.length + 2; guard++) {
    const title = document.querySelector('.tour-title')?.textContent;
    const count = document.querySelector('.tour-count')?.textContent;
    if (!title) break;
    out.visited.push(`${count} ${title}`);
    const nextBtn = document.getElementById('tour-next');
    const done = nextBtn.textContent === 'DONE';
    nextBtn.click();
    if (done) break;
    await new Promise(rq => requestAnimationFrame(rq));
  }
  out.closedCleanly = !document.getElementById('tour-card');
  out.ringGone = !document.getElementById('tour-ring');
  out.freshAfter = unseenSteps().length;
  out.stateSaved = (() => {
    try { return JSON.parse(localStorage.getItem('motionmuse-tour')).done === true; }
    catch { return false; }
  })();
  return out;
});

await b.close(); server.close();

let fail = 0;
const check = (ok, label, detail = '') => {
  if (!ok) fail++;
  console.log(`  [${ok ? ' PASS ' : ' FAIL '}]  ${label}${detail ? '  — ' + detail : ''}`);
};

console.log(`\nTutorial staleness guard — ${r.total} steps\n`);
check(r.stale.length === 0, 'every step targets visible UI',
  r.stale.length ? `stale: ${r.stale.join('; ')} (update TOUR_STEPS in src/ui/tutorial.js)` : '');
check(r.dupIds.length === 0, 'step ids are unique', r.dupIds.join(', '));
check(r.badShape.length === 0, 'every step has id/title/body', r.badShape.join(', '));
check(r.visited.length === r.total, 'tour walks every step end-to-end',
  `visited ${r.visited.length}/${r.total}`);
check(r.closedCleanly && r.ringGone, 'tour tears down after DONE');
check(r.stateSaved, 'completion persists to localStorage');
check(r.freshBefore === r.total && r.freshAfter === 0, '"new steps" tracking flips seen→0',
  `${r.freshBefore}→${r.freshAfter}`);
check(pageErrors.length === 0, 'no page errors', pageErrors.join('; '));

for (const v of r.visited) console.log(`      ${v}`);
console.log(`\n${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
