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
  const { TOUR_STEPS, tour, unseenSteps, stepsForMode, MODES,
          stepsForSection, sectionsWithHelp, appSteps } =
    await import('/src/ui/tutorial.js');
  const out = { stale: [], dupIds: [], visited: [], total: TOUR_STEPS.length,
                perMode: {}, orphans: [] };

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

  // ── Every step belongs to at least one mode ──
  // The tour is scoped per way of playing now, so the failure to guard against
  // is a step that is tagged for a mode that does not exist and is therefore
  // never shown to anyone.
  const covered = new Set(MODES.flatMap(m => stepsForMode(m).map(t => t.id)));
  out.orphans = TOUR_STEPS.filter(t => !covered.has(t.id)).map(t => t.id);

  // Captured before ANY tour runs: every run below marks its steps seen, and
  // the per-panel runs alone would eat a third of them before the baseline.
  out.freshBefore = unseenSteps().length;

  // ── Per-panel help ──
  // A step tagged for a panel that does not exist is a `?` that never appears,
  // so the help is written and unreachable. And a panel whose `?` opens nothing
  // is worse than no `?` at all.
  out.sectionsWanted = sectionsWithHelp();
  out.sectionsMissingPanel = out.sectionsWanted.filter(id =>
    !document.querySelector(`.sec[data-sec-id="${id}"]`));
  out.sectionsMissingButton = out.sectionsWanted.filter(id =>
    !document.querySelector(`.sec[data-sec-id="${id}"] .sec-help`));
  out.emptyHelpButtons = [...document.querySelectorAll('.sec .sec-help')]
    .map(b => b.closest('.sec').dataset.secId)
    .filter(id => stepsForSection(id).length === 0);
  out.appStepCount = appSteps().length;

  // Each panel's `?` opens only that panel's steps.
  out.sectionRuns = {};
  for (const id of out.sectionsWanted) {
    document.querySelector(`.sec[data-sec-id="${id}"] .sec-help`)?.click();
    out.sectionRuns[id] = {
      want: stepsForSection(id).length,
      shown: document.querySelector('.tour-count')?.textContent ?? '(none)',
      title: document.querySelector('.tour-title')?.textContent ?? '',
    };
    tour.close();
  }

  // ── Drive the real engine through EACH mode's tour ──
  const walk = async (mode) => {
    const expected = stepsForMode(mode).length;
    const seen = [];
    tour.start(mode);
    for (let guard = 0; guard < expected + 2; guard++) {
      const title = document.querySelector('.tour-title')?.textContent;
      const count = document.querySelector('.tour-count')?.textContent;
      if (!title) break;
      seen.push(`${count} ${title}`);
      const nextBtn = document.getElementById('tour-next');
      const done = nextBtn.textContent === 'DONE';
      nextBtn.click();
      if (done) break;
      await new Promise(rq => requestAnimationFrame(rq));
    }
    return { expected, seen };
  };
  for (const m of MODES) out.perMode[m] = await walk(m);
  out.visited = out.perMode[MODES[MODES.length - 1]].seen;

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

console.log(`\nTutorial staleness guard — ${r.total} steps across ${Object.keys(r.perMode).length} modes\n`);
check(r.stale.length === 0, 'every step targets visible UI',
  r.stale.length ? `stale: ${r.stale.join('; ')} (update TOUR_STEPS in src/ui/tutorial.js)` : '');
check(r.dupIds.length === 0, 'step ids are unique', r.dupIds.join(', '));
check(r.badShape.length === 0, 'every step has id/title/body', r.badShape.join(', '));
check(r.orphans.length === 0, 'every step belongs to at least one mode',
  r.orphans.join(' '));

// ── Per-panel help ──
check(r.sectionsMissingPanel.length === 0,
  'every step tagged for a panel targets a panel that exists',
  r.sectionsMissingPanel.join(' '));
check(r.sectionsMissingButton.length === 0,
  'and every one of those panels grew a ?', r.sectionsMissingButton.join(' '));
check(r.emptyHelpButtons.length === 0,
  'no ? opens an empty tour', r.emptyHelpButtons.join(' '));
check(r.appStepCount > 0 && r.appStepCount < r.total,
  'the header ? keeps the steps that belong to no panel',
  `${r.appStepCount} of ${r.total}`);
for (const [id, run] of Object.entries(r.sectionRuns)) {
  check(run.shown === `1/${run.want}`, `${id}: its ? opens only its own steps`,
    `${run.shown} (want 1/${run.want}) — ${run.title}`);
}
for (const [mode, m] of Object.entries(r.perMode)) {
  check(m.seen.length === m.expected, `${mode} tour walks every one of its steps`,
    `visited ${m.seen.length}/${m.expected}`);
  check(m.expected < r.total, `${mode} tour is scoped, not the whole thing`,
    `${m.expected} of ${r.total}`);
}
check(r.closedCleanly && r.ringGone, 'tour tears down after DONE');
check(r.stateSaved, 'completion persists to localStorage');
// Between them the two tours show everything, so after walking both there is
// nothing left unseen.
check(r.freshBefore === r.total && r.freshAfter === 0,
  '"new steps" tracking flips seen→0 once both tours have run',
  `${r.freshBefore}→${r.freshAfter}`);
check(pageErrors.length === 0, 'no page errors', pageErrors.join('; '));

for (const v of r.visited) console.log(`      ${v}`);
console.log(`\n${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
